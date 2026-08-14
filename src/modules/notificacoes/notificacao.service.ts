import { randomUUID } from 'node:crypto';

import webpush from 'web-push';

import type { PushConfig } from '../../config/env';
import type { Database } from '../../db/pool';
import { forbidden, notFound, unavailable } from '../../shared/errors/app-error';
import type { AuthContext } from '../auth/auth.types';
import type { CorridaRecord } from '../corridas/corrida.types';
import type { PushSubscriptionInput } from './notificacao.schemas';

type SubscriptionRow = {
  id: string; empresa_id: string; usuario_id: string; endpoint: string; p256dh: string; auth: string;
  expiration_time: string | null; user_agent: string | null; dispositivo_descricao: string | null;
  ativo: boolean; ultimo_sucesso_em: Date | null; ultima_falha_em: Date | null;
  codigo_ultima_falha: string | null; criado_em: Date; atualizado_em: Date;
};
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
  dispositivoDescricao: string | null;
  navegador: string | null;
  endpointHost: string;
  ativo: boolean;
  ultimoSucessoEm: Date | null;
  ultimaFalhaEm: Date | null;
  codigoUltimaFalha: string | null;
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

let vapidInitialized = false;

export class NotificacaoService implements CorridaNotificationPublisher {
  constructor(
    private readonly database: Database,
    private readonly pushConfig?: PushConfig,
    private readonly employeeUsers?: EmployeeUserResolver,
  ) {
    if (pushConfig && !vapidInitialized) {
      webpush.setVapidDetails(pushConfig.subject, pushConfig.publicKey, pushConfig.privateKey);
      vapidInitialized = true;
    }
  }

  publicKey(): string {
    if (!this.pushConfig) throw unavailable('As notificacoes Web Push ainda nao foram configuradas no servidor.');
    return this.pushConfig.publicKey;
  }

  async register(auth: AuthContext, input: PushSubscriptionInput, userAgent: string | null): Promise<PushDevice> {
    const result = await this.database.query<SubscriptionRow>(
      `INSERT INTO admtaxi.push_subscriptions
         (empresa_id,usuario_id,endpoint,p256dh,auth,expiration_time,user_agent,dispositivo_descricao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (endpoint) DO UPDATE SET
         empresa_id=EXCLUDED.empresa_id,usuario_id=EXCLUDED.usuario_id,p256dh=EXCLUDED.p256dh,
         auth=EXCLUDED.auth,expiration_time=EXCLUDED.expiration_time,user_agent=EXCLUDED.user_agent,
         dispositivo_descricao=EXCLUDED.dispositivo_descricao,ativo=TRUE,codigo_ultima_falha=NULL
       RETURNING *`,
      [auth.empresaId, auth.usuarioId, input.endpoint, input.keys.p256dh, input.keys.auth,
        input.expirationTime ?? null, userAgent, input.dispositivoDescricao ?? null],
    );
    return this.mapDevice(result.rows[0]!);
  }

  async status(auth: AuthContext) {
    const subscriptions = await this.listDevices(auth);
    return { configurado: !!this.pushConfig, ativo: subscriptions.some((item) => item.ativo), subscriptions };
  }

  async listDevices(auth: AuthContext): Promise<PushDevice[]> {
    const result = await this.database.query<SubscriptionRow>(
      `SELECT * FROM admtaxi.push_subscriptions
        WHERE empresa_id=$1 AND usuario_id=$2 ORDER BY ativo DESC,atualizado_em DESC`,
      [auth.empresaId, auth.usuarioId],
    );
    return result.rows.map((row) => this.mapDevice(row));
  }

  async revoke(auth: AuthContext, id: string): Promise<void> {
    const result = await this.database.query(
      `UPDATE admtaxi.push_subscriptions SET ativo=FALSE
        WHERE empresa_id=$1 AND usuario_id=$2 AND id=$3 AND ativo=TRUE`,
      [auth.empresaId, auth.usuarioId, id],
    );
    if (result.rowCount !== 1) throw notFound('Inscricao Web Push');
  }

  async sendTest(auth: AuthContext): Promise<void> {
    await this.sendRecipient({
      empresaId: auth.empresaId, usuarioId: auth.usuarioId, corridaId: null,
      event: 'TESTE', title: 'Notificacao de teste',
      body: 'As notificacoes deste dispositivo estao funcionando.',
      destination: this.pushConfig?.defaultOpenUrl ?? '/app/perfil',
      dedupeKey: `${auth.empresaId}:TESTE:${auth.usuarioId}:${randomUUID()}`,
    });
  }

  async diagnostics(auth: AuthContext) {
    if (auth.perfil !== 'GESTOR') throw forbidden();
    const result = await this.database.query<SubscriptionRow & {
      usuario_nome: string; usuario_email: string; usuario_perfil: string; vinculo_ativo: boolean;
      ultimo_envio_em: Date | null; ultimo_envio_status: string | null;
    }>(
      `SELECT ps.*,u.nome AS usuario_nome,u.email::text AS usuario_email,u.perfil::text AS usuario_perfil,
        (CASE WHEN u.perfil='PRESTADOR' THEN EXISTS (
          SELECT 1 FROM admtaxi.prestadores p WHERE p.empresa_id=u.empresa_id AND p.usuario_id=u.id AND p.ativo=TRUE
        ) WHEN u.perfil='FUNCIONARIO' THEN EXISTS (
          SELECT 1 FROM admtaxi.funcionarios f WHERE f.empresa_id=u.empresa_id AND f.usuario_id=u.id AND f.ativo=TRUE
        ) ELSE u.ativo END) AS vinculo_ativo,
        last_attempt.tentada_em AS ultimo_envio_em,last_attempt.status AS ultimo_envio_status
       FROM admtaxi.usuarios u LEFT JOIN admtaxi.push_subscriptions ps
         ON ps.empresa_id=u.empresa_id AND ps.usuario_id=u.id
       LEFT JOIN LATERAL (
         SELECT pt.tentada_em,pt.status FROM admtaxi.push_tentativas pt
          WHERE pt.empresa_id=ps.empresa_id AND pt.subscription_id=ps.id
          ORDER BY pt.criado_em DESC LIMIT 1
       ) last_attempt ON TRUE
       WHERE u.empresa_id=$1 ORDER BY u.nome,ps.ativo DESC,ps.atualizado_em DESC`,
      [auth.empresaId],
    );
    return result.rows.map((row) => ({
      id: row.id ?? null,
      usuario: { nome: row.usuario_nome, email: row.usuario_email, perfil: row.usuario_perfil },
      vinculoAtivo: row.vinculo_ativo, dispositivo: row.id ? this.mapDevice(row) : null,
      ultimoEnvioEm: row.ultimo_envio_em, ultimoEnvioStatus: row.ultimo_envio_status,
    }));
  }

  async sendDiagnosticTest(auth: AuthContext, subscriptionId: string): Promise<void> {
    if (auth.perfil !== 'GESTOR') throw forbidden();
    const target = await this.database.query<{ usuario_id: string }>(
      `SELECT usuario_id FROM admtaxi.push_subscriptions
        WHERE empresa_id=$1 AND id=$2 AND ativo=TRUE`, [auth.empresaId, subscriptionId],
    );
    const userId = target.rows[0]?.usuario_id;
    if (!userId) throw notFound('Inscricao Web Push');
    await this.sendRecipient({
      empresaId: auth.empresaId, usuarioId: userId, corridaId: null,
      event: 'DIAGNOSTICO', title: 'Teste de notificacao ADM-Taxi',
      body: 'O dispositivo recebeu o teste enviado pelo gestor.',
      destination: this.pushConfig?.defaultOpenUrl ?? '/app',
      dedupeKey: `${auth.empresaId}:DIAGNOSTICO:${subscriptionId}:${randomUUID()}`,
      subscriptionId,
    });
  }

  publishRideCreated(ride: CorridaRecord): void {
    void Promise.all([this.sendAvailableRide(ride), this.sendEmployeeRide(ride, 'SOLICITADA')]).catch(() => undefined);
  }

  publishRideUpdate(ride: CorridaRecord, event: RideNotificationEvent): void {
    void Promise.all([
      this.sendRequesterRide(ride, event), this.sendEmployeeRide(ride, event), this.sendGestorsRide(ride, event),
    ]).catch(() => undefined);
  }

  publishProviderRide(ride: CorridaRecord, event: 'ATRIBUIDA' | 'ALTERADA' | 'REMOVIDA' | 'CANCELADA'): void {
    void this.sendProviderRide(ride, event).catch(() => undefined);
  }

  private async sendAvailableRide(ride: CorridaRecord): Promise<void> {
    const recipients = await this.database.query<UserRow>(
      `SELECT DISTINCT p.usuario_id
         FROM admtaxi.prestadores p
         JOIN admtaxi.usuarios u ON u.empresa_id=p.empresa_id AND u.id=p.usuario_id
         JOIN admtaxi.empresas e ON e.id=p.empresa_id
        WHERE p.empresa_id=$1 AND p.ativo=TRUE AND p.disponivel=TRUE
          AND p.usuario_id IS NOT NULL AND u.ativo=TRUE AND u.perfil='PRESTADOR'
          AND COALESCE(p.cidade_operacao,e.cidade_padrao)=e.cidade_padrao
          AND COALESCE(p.estado_operacao,e.estado_padrao)=e.estado_padrao`,
      [ride.empresaId],
    );
    await Promise.all(recipients.rows.map((recipient) => this.sendRecipient({
      empresaId: ride.empresaId, usuarioId: recipient.usuario_id, corridaId: ride.id,
      event: 'CORRIDA_OFERTADA', title: 'Nova corrida disponivel',
      body: 'Existe uma nova corrida na sua regiao.', destination: this.rideUrl(ride.id),
      dedupeKey: `${ride.empresaId}:${ride.id}:CORRIDA_OFERTADA:${recipient.usuario_id}`,
    })));
  }

  private async sendRequesterRide(ride: CorridaRecord, event: RideNotificationEvent): Promise<void> {
    const authorized = await this.database.query<{ id: string }>(
      `SELECT u.id FROM admtaxi.usuarios u WHERE u.empresa_id=$1 AND u.id=$2 AND u.ativo=TRUE AND (
        u.perfil='GESTOR' OR (u.perfil='GERENTE' AND EXISTS (
          SELECT 1 FROM admtaxi.gerente_centros_custo gcc
          JOIN admtaxi.centros_custo cc ON cc.empresa_id=gcc.empresa_id AND cc.id=gcc.centro_custo_id AND cc.ativo=TRUE
          JOIN admtaxi.setores s ON s.empresa_id=cc.empresa_id AND s.id=cc.setor_id AND s.ativo=TRUE
          JOIN admtaxi.gerente_setores gs ON gs.empresa_id=gcc.empresa_id
            AND gs.gerente_usuario_id=gcc.gerente_usuario_id AND gs.setor_id=cc.setor_id
          WHERE gcc.empresa_id=u.empresa_id AND gcc.gerente_usuario_id=u.id AND gcc.centro_custo_id=$3
        )))`, [ride.empresaId, ride.solicitanteUsuarioId, ride.centroCustoId],
    );
    if (authorized.rowCount !== 1) return;
    await this.sendRideMessage(ride, ride.solicitanteUsuarioId, event, event);
  }

  private async sendGestorsRide(ride: CorridaRecord, event: RideNotificationEvent): Promise<void> {
    const users = await this.database.query<UserRow>(
      `SELECT id AS usuario_id FROM admtaxi.usuarios
        WHERE empresa_id=$1 AND perfil='GESTOR' AND ativo=TRUE AND id<>$2`,
      [ride.empresaId, ride.solicitanteUsuarioId],
    );
    await Promise.all(users.rows.map((user) => this.sendRideMessage(ride, user.usuario_id, `GESTOR_${event}`, event)));
  }

  private async sendEmployeeRide(ride: CorridaRecord, event: RideNotificationEvent | 'SOLICITADA'): Promise<void> {
    const userId = this.employeeUsers
      ? await this.employeeUsers.resolveEmployeeUser(ride.empresaId, ride.funcionarioId)
      : (await this.database.query<UserRow>(
        `SELECT f.usuario_id FROM admtaxi.funcionarios f JOIN admtaxi.usuarios u
          ON u.empresa_id=f.empresa_id AND u.id=f.usuario_id
         WHERE f.empresa_id=$1 AND f.id=$2 AND f.ativo=TRUE AND u.ativo=TRUE`,
        [ride.empresaId, ride.funcionarioId],
      )).rows[0]?.usuario_id ?? null;
    if (!userId) return;
    const message = event === 'SOLICITADA'
      ? { title: 'Nova corrida solicitada', body: 'Uma nova corrida foi solicitada para voce.' }
      : this.rideMessage(event);
    await this.sendRecipient({
      empresaId: ride.empresaId, usuarioId: userId, corridaId: ride.id,
      event: `FUNCIONARIO_${event}`, title: message.title, body: message.body,
      destination: this.rideUrl(ride.id),
      dedupeKey: `${ride.empresaId}:${ride.id}:FUNCIONARIO_${event}:${userId}`,
    });
  }

  private async sendProviderRide(
    ride: CorridaRecord, event: 'ATRIBUIDA' | 'ALTERADA' | 'REMOVIDA' | 'CANCELADA',
  ): Promise<void> {
    if (!ride.prestadorId) return;
    const recipient = await this.database.query<UserRow>(
      `SELECT p.usuario_id FROM admtaxi.prestadores p JOIN admtaxi.usuarios u
        ON u.empresa_id=p.empresa_id AND u.id=p.usuario_id
       WHERE p.empresa_id=$1 AND p.id=$2 AND p.ativo=TRUE AND p.usuario_id IS NOT NULL AND u.ativo=TRUE`,
      [ride.empresaId, ride.prestadorId],
    );
    const userId = recipient.rows[0]?.usuario_id;
    if (!userId) return;
    const title = event === 'CANCELADA' ? 'Corrida cancelada'
      : event === 'REMOVIDA' ? 'Atribuicao de corrida alterada'
        : event === 'ALTERADA' ? 'Corrida atualizada' : 'Nova corrida atribuida';
    const body = event === 'CANCELADA' ? 'A corrida atribuida a voce foi cancelada.'
      : event === 'REMOVIDA' ? 'Esta corrida nao esta mais atribuida a voce.'
        : 'Abra o aplicativo para consultar os detalhes da corrida.';
    await this.sendRecipient({
      empresaId: ride.empresaId, usuarioId: userId, corridaId: ride.id, event, title, body,
      destination: event === 'REMOVIDA' ? '/app/corridas' : this.rideUrl(ride.id),
      dedupeKey: `${ride.empresaId}:${ride.id}:${event}:${ride.status}:${ride.prestadorId}`,
    });
  }

  private sendRideMessage(ride: CorridaRecord, userId: string, logEvent: string, messageEvent: RideNotificationEvent): Promise<void> {
    const message = this.rideMessage(messageEvent);
    return this.sendRecipient({
      empresaId: ride.empresaId, usuarioId: userId, corridaId: ride.id,
      event: logEvent, title: message.title, body: message.body, destination: this.rideUrl(ride.id),
      dedupeKey: `${ride.empresaId}:${ride.id}:${logEvent}:${userId}`,
    });
  }

  private async sendRecipient(input: {
    empresaId: string; usuarioId: string; corridaId: string | null; event: string;
    title: string; body: string; destination: string; dedupeKey: string; subscriptionId?: string;
  }): Promise<void> {
    const destination = this.safeOpenUrl(input.destination);
    const inserted = await this.database.query<{ id: string }>(
      `INSERT INTO admtaxi.notificacoes_push
         (empresa_id,usuario_id,corrida_id,evento,titulo,corpo,chave_deduplicacao,url_abertura,tipo_payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (chave_deduplicacao) DO NOTHING RETURNING id`,
      [input.empresaId, input.usuarioId, input.corridaId, input.event, input.title, input.body,
        input.dedupeKey, destination, input.event],
    );
    const notificationId = inserted.rows[0]?.id;
    if (!notificationId) return;
    const values: unknown[] = [input.empresaId, input.usuarioId];
    const idFilter = input.subscriptionId ? ' AND id=$3' : '';
    if (input.subscriptionId) values.push(input.subscriptionId);
    const subscriptions = await this.database.query<SubscriptionRow>(
      `SELECT * FROM admtaxi.push_subscriptions
        WHERE empresa_id=$1 AND usuario_id=$2 AND ativo=TRUE${idFilter}`, values,
    );
    if (!this.pushConfig || subscriptions.rows.length === 0) {
      await this.finishLog(notificationId, 'IGNORADA', { dispositivos: subscriptions.rows.length },
        this.pushConfig ? null : 'Web Push VAPID nao configurado.');
      return;
    }
    const payload = JSON.stringify({
      title: input.title, body: input.body,
      icon: this.pushConfig.notificationIconUrl, badge: this.pushConfig.notificationBadgeUrl,
      tag: `${input.event.toLowerCase()}-${input.corridaId ?? notificationId}`,
      data: { type: input.event, corridaId: input.corridaId, openUrl: destination },
    });
    const results = await Promise.all(subscriptions.rows.map((subscription) =>
      this.sendSubscription(notificationId, subscription, payload)));
    const sent = results.filter(Boolean).length;
    const status = sent === results.length ? 'ENVIADA' : sent === 0 ? 'FALHA' : 'PARCIAL';
    await this.finishLog(notificationId, status, { enviados: sent, falhas: results.length - sent },
      sent === results.length ? null : 'Uma ou mais inscricoes recusaram a notificacao.');
  }

  private async sendSubscription(notificationId: string, subscription: SubscriptionRow, payload: string): Promise<boolean> {
    const attempt = await this.database.query<{ id: string }>(
      `INSERT INTO admtaxi.push_tentativas (empresa_id,notificacao_id,subscription_id)
       VALUES ($1,$2,$3) ON CONFLICT (notificacao_id,subscription_id) DO NOTHING RETURNING id`,
      [subscription.empresa_id, notificationId, subscription.id],
    );
    const attemptId = attempt.rows[0]?.id;
    if (!attemptId) return true;
    try {
      await this.sendWithRetry(subscription, payload);
      await Promise.all([
        this.database.query(
          `UPDATE admtaxi.push_tentativas SET status='ENVIADA',codigo_http=201,tentada_em=CURRENT_TIMESTAMP WHERE id=$1`,
          [attemptId],
        ),
        this.database.query(
          `UPDATE admtaxi.push_subscriptions SET ultimo_sucesso_em=CURRENT_TIMESTAMP,codigo_ultima_falha=NULL WHERE id=$1`,
          [subscription.id],
        ),
      ]);
      return true;
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number }).statusCode ?? 0);
      const expired = statusCode === 404 || statusCode === 410;
      const errorCode = statusCode ? `HTTP_${statusCode}` : 'ENVIO_FALHOU';
      await Promise.all([
        this.database.query(
          `UPDATE admtaxi.push_tentativas SET status=$2,codigo_http=$3,codigo_erro=$4,tentada_em=CURRENT_TIMESTAMP WHERE id=$1`,
          [attemptId, expired ? 'EXPIRADA' : 'FALHA', statusCode || null, errorCode],
        ),
        this.database.query(
          `UPDATE admtaxi.push_subscriptions SET ativo=CASE WHEN $2 THEN FALSE ELSE ativo END,
            ultima_falha_em=CURRENT_TIMESTAMP,codigo_ultima_falha=$3 WHERE id=$1`,
          [subscription.id, expired, errorCode],
        ),
      ]);
      return false;
    }
  }

  private async sendWithRetry(subscription: SubscriptionRow, payload: string): Promise<void> {
    const target = { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } };
    try {
      await webpush.sendNotification(target, payload, { TTL: 300, urgency: 'high' });
    } catch (error) {
      const status = Number((error as { statusCode?: number }).statusCode ?? 0);
      if (status !== 429 && status < 500) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
      await webpush.sendNotification(target, payload, { TTL: 300, urgency: 'high' });
    }
  }

  private safeOpenUrl(value: string): string {
    if (value.startsWith('/') && !value.startsWith('//')) return value;
    if (!this.pushConfig) return '/app';
    try {
      const candidate = new URL(value);
      if (candidate.origin !== new URL(this.pushConfig.appUrl).origin) return this.pushConfig.defaultOpenUrl;
      return candidate.toString();
    } catch {
      return this.pushConfig.defaultOpenUrl;
    }
  }

  private rideUrl(rideId: string): string {
    const base = this.pushConfig?.rideOpenUrl ?? '/app/corridas';
    return `${base.replace(/\/$/, '')}/${rideId}`;
  }

  private rideMessage(event: RideNotificationEvent): { title: string; body: string } {
    return {
      ACEITA: { title: 'Corrida aceita', body: 'O prestador aceitou a corrida.' },
      DESLOCAMENTO_INICIADO: { title: 'Prestador a caminho', body: 'O prestador esta a caminho do embarque.' },
      CHEGADA_AO_EMBARQUE: { title: 'Prestador no embarque', body: 'O prestador chegou ao local de embarque.' },
      CORRIDA_INICIADA: { title: 'Corrida iniciada', body: 'A corrida foi iniciada.' },
      FINALIZADA: { title: 'Corrida finalizada', body: 'A corrida foi finalizada.' },
      CANCELADA: { title: 'Corrida cancelada', body: 'A corrida foi cancelada.' },
      ATRIBUICAO_ALTERADA: { title: 'Corrida atualizada', body: 'O prestador ou veiculo foi alterado.' },
    }[event];
  }

  private mapDevice(row: SubscriptionRow): PushDevice {
    let endpointHost = 'push-service';
    try { endpointHost = new URL(row.endpoint).host; } catch { /* Stored endpoints are validated on input. */ }
    return {
      id: row.id, dispositivoDescricao: row.dispositivo_descricao,
      navegador: row.user_agent ? row.user_agent.slice(0, 120) : null, endpointHost,
      ativo: row.ativo, ultimoSucessoEm: row.ultimo_sucesso_em, ultimaFalhaEm: row.ultima_falha_em,
      codigoUltimaFalha: row.codigo_ultima_falha, criadoEm: row.criado_em, atualizadoEm: row.atualizado_em,
    };
  }

  private async finishLog(id: string, status: string, result: Record<string, unknown>, error: string | null): Promise<void> {
    await this.database.query(
      `UPDATE admtaxi.notificacoes_push
        SET status=$2,tentada_em=CURRENT_TIMESTAMP,resultado=$3,erro=$4 WHERE id=$1`,
      [id, status, result, error],
    );
  }
}
