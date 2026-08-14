import { randomUUID } from 'node:crypto';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, type MulticastMessage } from 'firebase-admin/messaging';

import type { Database } from '../../db/pool';
import { forbidden, notFound } from '../../shared/errors/app-error';
import type { AuthContext } from '../auth/auth.types';
import type { CorridaRecord } from '../corridas/corrida.types';
import type { DispositivoPushInput } from './notificacao.schemas';

type DeviceRow = { id: string; token: string };
type UserRow = { usuario_id: string };

export type RideNotificationEvent =
  | 'ACEITA'
  | 'DESLOCAMENTO_INICIADO'
  | 'CHEGADA_AO_EMBARQUE'
  | 'CORRIDA_INICIADA'
  | 'FINALIZADA'
  | 'CANCELADA'
  | 'ATRIBUICAO_ALTERADA';

export type PushDevice = {
  id: string;
  plataforma: string;
  nomeDispositivo: string | null;
  ativo: boolean;
  ultimoUsoEm: Date;
  criadoEm: Date;
  atualizadoEm: Date;
};

export interface EmployeeUserResolver {
  resolveEmployeeUser(empresaId: string, funcionarioId: string): Promise<string | null>;
}

export interface CorridaNotificationPublisher {
  publishRideCreated(ride: CorridaRecord): void;
  publishRideUpdate(ride: CorridaRecord, event: RideNotificationEvent): void;
  publishProviderRide(ride: CorridaRecord, event: 'ATRIBUIDA' | 'ALTERADA' | 'REMOVIDA' | 'CANCELADA'): void;
}

export class NotificacaoService implements CorridaNotificationPublisher {
  constructor(
    private readonly database: Database,
    private readonly firebaseProjectId?: string,
    private readonly allowDevelopmentTest = false,
    private readonly employeeUsers?: EmployeeUserResolver,
  ) {}

  async register(auth: AuthContext, input: DispositivoPushInput): Promise<PushDevice> {
    const result = await this.database.query<{
      id: string; plataforma: string; nome_dispositivo: string | null; ativo: boolean;
      ultimo_uso_em: Date; criado_em: Date; atualizado_em: Date;
    }>(
      `INSERT INTO admtaxi.dispositivos_push
         (empresa_id, usuario_id, token, plataforma, nome_dispositivo)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (token) DO UPDATE SET
         empresa_id = EXCLUDED.empresa_id, usuario_id = EXCLUDED.usuario_id,
         plataforma = EXCLUDED.plataforma, nome_dispositivo = EXCLUDED.nome_dispositivo,
         ativo = TRUE, ultimo_uso_em = CURRENT_TIMESTAMP
       RETURNING id, plataforma, nome_dispositivo, ativo, ultimo_uso_em, criado_em, atualizado_em`,
      [auth.empresaId, auth.usuarioId, input.token, input.plataforma, input.nomeDispositivo ?? null],
    );
    return this.mapDevice(result.rows[0]!);
  }

  async listDevices(auth: AuthContext): Promise<PushDevice[]> {
    const result = await this.database.query<{
      id: string; plataforma: string; nome_dispositivo: string | null; ativo: boolean;
      ultimo_uso_em: Date; criado_em: Date; atualizado_em: Date;
    }>(
      `SELECT id, plataforma, nome_dispositivo, ativo, ultimo_uso_em, criado_em, atualizado_em
         FROM admtaxi.dispositivos_push
        WHERE empresa_id = $1 AND usuario_id = $2
        ORDER BY ativo DESC, ultimo_uso_em DESC`,
      [auth.empresaId, auth.usuarioId],
    );
    return result.rows.map((row) => this.mapDevice(row));
  }

  async revoke(auth: AuthContext, id: string): Promise<void> {
    const result = await this.database.query(
      `UPDATE admtaxi.dispositivos_push SET ativo = FALSE
        WHERE empresa_id = $1 AND usuario_id = $2 AND id = $3 AND ativo = TRUE`,
      [auth.empresaId, auth.usuarioId, id],
    );
    if (result.rowCount !== 1) throw notFound('Dispositivo');
  }

  async sendTest(auth: AuthContext): Promise<void> {
    if (auth.perfil !== 'GESTOR' && !this.allowDevelopmentTest) throw forbidden();
    await this.sendRecipient({
      empresaId: auth.empresaId,
      usuarioId: auth.usuarioId,
      corridaId: null,
      event: 'TESTE',
      title: 'Notificação de teste',
      body: 'As notificações deste dispositivo estão funcionando.',
      destination: '/app/perfil',
      dedupeKey: `${auth.empresaId}:TESTE:${auth.usuarioId}:${randomUUID()}`,
    });
  }

  publishRideCreated(ride: CorridaRecord): void {
    void Promise.all([this.sendAvailableRide(ride), this.sendEmployeeRide(ride, 'SOLICITADA')]).catch(() => undefined);
  }

  publishRideUpdate(ride: CorridaRecord, event: RideNotificationEvent): void {
    void Promise.all([
      this.sendRequesterRide(ride, event),
      this.sendEmployeeRide(ride, event),
    ]).catch(() => undefined);
  }

  publishProviderRide(ride: CorridaRecord, event: 'ATRIBUIDA' | 'ALTERADA' | 'REMOVIDA' | 'CANCELADA'): void {
    void this.sendProviderRide(ride, event).catch(() => undefined);
  }

  private async sendAvailableRide(ride: CorridaRecord): Promise<void> {
    const recipients = await this.database.query<UserRow>(
      `SELECT DISTINCT p.usuario_id
         FROM admtaxi.prestadores p
         JOIN admtaxi.usuarios u ON u.empresa_id = p.empresa_id AND u.id = p.usuario_id
        WHERE p.empresa_id = $1 AND p.ativo = TRUE AND p.disponivel = TRUE
          AND p.usuario_id IS NOT NULL AND u.ativo = TRUE AND u.perfil = 'PRESTADOR'`,
      [ride.empresaId],
    );
    await Promise.all(recipients.rows.map((recipient) => this.sendRecipient({
      empresaId: ride.empresaId,
      usuarioId: recipient.usuario_id,
      corridaId: ride.id,
      event: 'CORRIDA_DISPONIVEL',
      title: 'Nova corrida disponível',
      body: 'Nova corrida disponível para atendimento.',
      destination: `/app/corridas/${ride.id}`,
      dedupeKey: `${ride.empresaId}:${ride.id}:CORRIDA_DISPONIVEL:${recipient.usuario_id}`,
    })));
  }

  private async sendRequesterRide(ride: CorridaRecord, event: RideNotificationEvent): Promise<void> {
    const authorized = await this.database.query<{ id: string }>(
      `SELECT u.id FROM admtaxi.usuarios u
       WHERE u.empresa_id=$1 AND u.id=$2 AND u.ativo=TRUE AND (
         u.perfil='GESTOR' OR (
           u.perfil='GERENTE' AND EXISTS (
             SELECT 1 FROM admtaxi.gerente_centros_custo gcc
             JOIN admtaxi.centros_custo cc
               ON cc.empresa_id=gcc.empresa_id AND cc.id=gcc.centro_custo_id AND cc.ativo=TRUE
             JOIN admtaxi.setores s
               ON s.empresa_id=cc.empresa_id AND s.id=cc.setor_id AND s.ativo=TRUE
             JOIN admtaxi.gerente_setores gs
               ON gs.empresa_id=gcc.empresa_id AND gs.gerente_usuario_id=gcc.gerente_usuario_id
              AND gs.setor_id=cc.setor_id
             WHERE gcc.empresa_id=u.empresa_id AND gcc.gerente_usuario_id=u.id
               AND gcc.centro_custo_id=$3
           )
         )
       )`,
      [ride.empresaId, ride.solicitanteUsuarioId, ride.centroCustoId],
    );
    if (authorized.rowCount !== 1) return;
    const message = this.rideMessage(event);
    await this.sendRecipient({
      empresaId: ride.empresaId,
      usuarioId: ride.solicitanteUsuarioId,
      corridaId: ride.id,
      event,
      title: message.title,
      body: message.body,
      destination: `/app/corridas/${ride.id}`,
      dedupeKey: `${ride.empresaId}:${ride.id}:${event}:${ride.solicitanteUsuarioId}`,
    });
  }

  private async sendEmployeeRide(ride: CorridaRecord, event: RideNotificationEvent | 'SOLICITADA'): Promise<void> {
    const userId = this.employeeUsers
      ? await this.employeeUsers.resolveEmployeeUser(ride.empresaId, ride.funcionarioId)
      : (await this.database.query<UserRow>(
        `SELECT f.usuario_id FROM admtaxi.funcionarios f
         JOIN admtaxi.usuarios u ON u.empresa_id=f.empresa_id AND u.id=f.usuario_id
         WHERE f.empresa_id=$1 AND f.id=$2 AND f.ativo=TRUE AND u.ativo=TRUE`,
        [ride.empresaId, ride.funcionarioId],
      )).rows[0]?.usuario_id ?? null;
    if (!userId) return;
    const message = event === 'SOLICITADA'
      ? { title: 'Nova corrida solicitada', body: 'Uma nova corrida foi solicitada para você.' }
      : this.rideMessage(event);
    await this.sendRecipient({
      empresaId: ride.empresaId,
      usuarioId: userId,
      corridaId: ride.id,
      event: `FUNCIONARIO_${event}`,
      title: message.title,
      body: message.body,
      destination: `/app/corridas/${ride.id}`,
      dedupeKey: `${ride.empresaId}:${ride.id}:FUNCIONARIO_${event}:${userId}`,
    });
  }

  private async sendProviderRide(
    ride: CorridaRecord,
    event: 'ATRIBUIDA' | 'ALTERADA' | 'REMOVIDA' | 'CANCELADA',
  ): Promise<void> {
    if (!ride.prestadorId) return;
    const recipient = await this.database.query<UserRow>(
      `SELECT p.usuario_id FROM admtaxi.prestadores p
         JOIN admtaxi.usuarios u ON u.empresa_id = p.empresa_id AND u.id = p.usuario_id
        WHERE p.empresa_id = $1 AND p.id = $2 AND p.ativo = TRUE
          AND p.usuario_id IS NOT NULL AND u.ativo = TRUE`,
      [ride.empresaId, ride.prestadorId],
    );
    const usuarioId = recipient.rows[0]?.usuario_id;
    if (!usuarioId) return;
    const title = event === 'CANCELADA' ? 'Corrida cancelada'
      : event === 'REMOVIDA' ? 'Atribuição de corrida alterada'
        : event === 'ALTERADA' ? 'Corrida atualizada' : 'Nova corrida atribuída';
    const body = event === 'CANCELADA' ? 'A corrida atribuída a você foi cancelada.'
      : event === 'REMOVIDA' ? 'Esta corrida não está mais atribuída a você.'
        : 'Abra o aplicativo para consultar os detalhes da corrida.';
    await this.sendRecipient({
      empresaId: ride.empresaId,
      usuarioId,
      corridaId: ride.id,
      event,
      title,
      body,
      destination: event === 'REMOVIDA' ? '/app/corridas' : `/app/corridas/${ride.id}`,
      dedupeKey: `${ride.empresaId}:${ride.id}:${event}:${ride.status}:${ride.prestadorId}`,
    });
  }

  private async sendRecipient(input: {
    empresaId: string; usuarioId: string; corridaId: string | null; event: string;
    title: string; body: string; destination: string; dedupeKey: string;
  }): Promise<void> {
    const inserted = await this.database.query<{ id: string }>(
      `INSERT INTO admtaxi.notificacoes_push
         (empresa_id, usuario_id, corrida_id, evento, titulo, corpo, chave_deduplicacao)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (chave_deduplicacao) DO NOTHING RETURNING id`,
      [input.empresaId, input.usuarioId, input.corridaId, input.event, input.title, input.body, input.dedupeKey],
    );
    const notificationId = inserted.rows[0]?.id;
    if (!notificationId) return;
    const devices = await this.database.query<DeviceRow>(
      `SELECT id, token FROM admtaxi.dispositivos_push
        WHERE empresa_id = $1 AND usuario_id = $2 AND ativo = TRUE`,
      [input.empresaId, input.usuarioId],
    );
    if (!this.firebaseProjectId || devices.rows.length === 0) {
      await this.finishLog(notificationId, 'IGNORADA', { dispositivos: devices.rows.length },
        this.firebaseProjectId ? null : 'Firebase não configurado.');
      return;
    }
    try {
      if (getApps().length === 0) initializeApp({ credential: applicationDefault(), projectId: this.firebaseProjectId });
      const message: MulticastMessage = {
        tokens: devices.rows.map((device) => device.token),
        data: {
          corridaId: input.corridaId ?? '', destino: input.destination,
          titulo: input.title, corpo: input.body,
        },
        webpush: { headers: { Urgency: 'high' } },
      };
      const response = await getMessaging().sendEachForMulticast(message);
      const invalidTokens = response.responses.flatMap((item, index) => {
        const code = item.error?.code ?? '';
        return code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')
          ? [devices.rows[index]!.token] : [];
      });
      if (invalidTokens.length) {
        await this.database.query(
          `UPDATE admtaxi.dispositivos_push SET ativo = FALSE
            WHERE empresa_id = $1 AND token = ANY($2::text[])`,
          [input.empresaId, invalidTokens],
        );
      }
      const status = response.failureCount === 0 ? 'ENVIADA' : response.successCount === 0 ? 'FALHA' : 'PARCIAL';
      await this.finishLog(notificationId, status, {
        enviados: response.successCount, falhas: response.failureCount, tokensInativados: invalidTokens.length,
      }, response.failureCount ? 'Um ou mais dispositivos recusaram a notificação.' : null);
    } catch {
      await this.finishLog(notificationId, 'FALHA', {}, 'Falha ao enviar notificação pelo Firebase.');
    }
  }

  private rideMessage(event: RideNotificationEvent): { title: string; body: string } {
    const messages: Record<RideNotificationEvent, { title: string; body: string }> = {
      ACEITA: { title: 'Corrida aceita', body: 'O prestador aceitou a corrida.' },
      DESLOCAMENTO_INICIADO: { title: 'Prestador a caminho', body: 'O prestador está a caminho do local de embarque.' },
      CHEGADA_AO_EMBARQUE: { title: 'Prestador no embarque', body: 'O prestador chegou ao local de embarque.' },
      CORRIDA_INICIADA: { title: 'Corrida iniciada', body: 'A corrida foi iniciada.' },
      FINALIZADA: { title: 'Corrida finalizada', body: 'A corrida foi finalizada.' },
      CANCELADA: { title: 'Corrida cancelada', body: 'A corrida foi cancelada.' },
      ATRIBUICAO_ALTERADA: { title: 'Corrida atualizada', body: 'O prestador ou veículo da corrida foi alterado.' },
    };
    return messages[event];
  }

  private mapDevice(row: {
    id: string; plataforma: string; nome_dispositivo: string | null; ativo: boolean;
    ultimo_uso_em: Date; criado_em: Date; atualizado_em: Date;
  }): PushDevice {
    return {
      id: row.id, plataforma: row.plataforma, nomeDispositivo: row.nome_dispositivo,
      ativo: row.ativo, ultimoUsoEm: row.ultimo_uso_em, criadoEm: row.criado_em, atualizadoEm: row.atualizado_em,
    };
  }

  private async finishLog(id: string, status: string, result: Record<string, unknown>, error: string | null): Promise<void> {
    await this.database.query(
      `UPDATE admtaxi.notificacoes_push
          SET status = $2, tentada_em = CURRENT_TIMESTAMP, resultado = $3, erro = $4
        WHERE id = $1`,
      [id, status, result, error],
    );
  }
}
