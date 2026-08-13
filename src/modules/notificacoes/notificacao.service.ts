import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, type MulticastMessage } from 'firebase-admin/messaging';
import type { Database } from '../../db/pool';
import { notFound } from '../../shared/errors/app-error';
import type { AuthContext } from '../auth/auth.types';
import type { CorridaRecord } from '../corridas/corrida.types';
import type { DispositivoPushInput } from './notificacao.schemas';

type DeviceRow = { id: string; token: string };

export interface CorridaNotificationPublisher {
  publishProviderRide(ride: CorridaRecord, event: 'ATRIBUIDA' | 'ALTERADA' | 'REMOVIDA' | 'CANCELADA'): void;
}

export class NotificacaoService implements CorridaNotificationPublisher {
  constructor(private readonly database: Database, private readonly firebaseProjectId?: string) {}

  async register(auth: AuthContext, input: DispositivoPushInput): Promise<Record<string, unknown>> {
    const result = await this.database.query<{
      id: string; plataforma: string; nome_dispositivo: string | null; ativo: boolean; atualizado_em: Date;
    }>(
      `INSERT INTO admtaxi.dispositivos_push
         (empresa_id, usuario_id, token, plataforma, nome_dispositivo)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (token) DO UPDATE SET
         empresa_id = EXCLUDED.empresa_id, usuario_id = EXCLUDED.usuario_id,
         plataforma = EXCLUDED.plataforma, nome_dispositivo = EXCLUDED.nome_dispositivo,
         ativo = TRUE, ultimo_uso_em = CURRENT_TIMESTAMP
       RETURNING id, plataforma, nome_dispositivo, ativo, atualizado_em`,
      [auth.empresaId, auth.usuarioId, input.token, input.plataforma, input.nomeDispositivo ?? null],
    );
    const row = result.rows[0]!;
    return { id: row.id, plataforma: row.plataforma, nomeDispositivo: row.nome_dispositivo, ativo: row.ativo, atualizadoEm: row.atualizado_em };
  }

  async revoke(auth: AuthContext, id: string): Promise<void> {
    const result = await this.database.query(
      `UPDATE admtaxi.dispositivos_push SET ativo = FALSE
        WHERE empresa_id = $1 AND usuario_id = $2 AND id = $3 AND ativo = TRUE`,
      [auth.empresaId, auth.usuarioId, id],
    );
    if (result.rowCount !== 1) throw notFound('Dispositivo');
  }

  publishProviderRide(ride: CorridaRecord, event: 'ATRIBUIDA' | 'ALTERADA' | 'REMOVIDA' | 'CANCELADA'): void {
    void this.sendProviderRide(ride, event).catch(() => undefined);
  }

  private async sendProviderRide(ride: CorridaRecord, event: 'ATRIBUIDA' | 'ALTERADA' | 'REMOVIDA' | 'CANCELADA'): Promise<void> {
    if (!ride.prestadorId) return;
    const recipient = await this.database.query<{ usuario_id: string }>(
      `SELECT usuario_id FROM admtaxi.prestadores
        WHERE empresa_id = $1 AND id = $2 AND ativo = TRUE AND usuario_id IS NOT NULL`,
      [ride.empresaId, ride.prestadorId],
    );
    const usuarioId = recipient.rows[0]?.usuario_id;
    if (!usuarioId) return;
    const dedupeKey = `${ride.empresaId}:${ride.id}:${event}:${ride.status}:${ride.prestadorId}`;
    const title = event === 'CANCELADA' ? 'Corrida cancelada'
      : event === 'REMOVIDA' ? 'Atribuicao de corrida alterada'
        : event === 'ALTERADA' ? 'Corrida atualizada' : 'Nova corrida atribuida';
    const body = event === 'CANCELADA' ? 'A corrida atribuida a voce foi cancelada.'
      : event === 'REMOVIDA' ? 'Esta corrida nao esta mais atribuida a voce.'
        : 'Abra o aplicativo para consultar os detalhes da corrida.';
    const destination = event === 'REMOVIDA' ? '/app/corridas' : `/app/corridas/${ride.id}`;
    const inserted = await this.database.query<{ id: string }>(
      `INSERT INTO admtaxi.notificacoes_push
         (empresa_id, usuario_id, corrida_id, evento, titulo, corpo, chave_deduplicacao)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (chave_deduplicacao) DO NOTHING RETURNING id`,
      [ride.empresaId, usuarioId, ride.id, event, title, body, dedupeKey],
    );
    const notificationId = inserted.rows[0]?.id;
    if (!notificationId) return;
    const devices = await this.database.query<DeviceRow>(
      `SELECT id, token FROM admtaxi.dispositivos_push
        WHERE empresa_id = $1 AND usuario_id = $2 AND ativo = TRUE`,
      [ride.empresaId, usuarioId],
    );
    if (!this.firebaseProjectId || devices.rows.length === 0) {
      await this.finishLog(notificationId, 'IGNORADA', { dispositivos: devices.rows.length },
        this.firebaseProjectId ? null : 'Firebase nao configurado.');
      return;
    }
    try {
      if (getApps().length === 0) initializeApp({ credential: applicationDefault(), projectId: this.firebaseProjectId });
      const message: MulticastMessage = {
        tokens: devices.rows.map((device) => device.token),
        data: { corridaId: ride.id, destino: destination, titulo: title, corpo: body },
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
          [ride.empresaId, invalidTokens],
        );
      }
      const status = response.failureCount === 0 ? 'ENVIADA' : response.successCount === 0 ? 'FALHA' : 'PARCIAL';
      await this.finishLog(notificationId, status, {
        enviados: response.successCount, falhas: response.failureCount, tokensInativados: invalidTokens.length,
      }, response.failureCount ? 'Um ou mais dispositivos recusaram a notificacao.' : null);
    } catch {
      await this.finishLog(notificationId, 'FALHA', {}, 'Falha ao enviar notificacao pelo Firebase.');
    }
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
