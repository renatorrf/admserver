import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Message } from 'firebase-admin/messaging';
import { z } from 'zod';
import type { Logger } from 'pino';
import { withTransaction, type Database } from '../../db/pool';
import type { AuthContext } from '../auth/auth.types';
import { forbidden, unavailable } from '../../shared/errors/app-error';

export const nativeDeviceSchema = z.object({
  token: z.string().min(20).max(4096).regex(/^[A-Za-z0-9_:.-]+$/),
  instalacaoId: z.string().uuid(), vinculoId: z.string().uuid(),
}).strict();
export const nativeBindingSchema = z.object({ vinculoId: z.string().uuid() }).strict();
export interface FcmSender { send(message: Message): Promise<string> }
export function createFcmSender(projectId: string): FcmSender {
  const app = getApps().find(a => a.name === 'android-push') ?? initializeApp({
    projectId, credential: applicationDefault(),
  }, 'android-push');
  return getMessaging(app);
}

export class FcmService {
  private running?: Promise<number>;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly db: Database, private readonly logger: Pick<Logger, 'warn'>,
    private readonly sender?: FcmSender) {}

  async register(auth: AuthContext, input: z.infer<typeof nativeDeviceSchema>) {
    if (auth.perfil !== 'PRESTADOR') throw forbidden();
    if (!this.sender) throw unavailable('Notificacoes Android ainda nao configuradas no servidor.');
    await withTransaction(this.db, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('fcm-dispositivos'),0)");
      // A token belongs to exactly one installation/account. Rebind atomically on login.
      await client.query(`UPDATE admtaxi.dispositivos_push SET ativo=FALSE,instalacao_id=NULL
        WHERE instalacao_id=$1 AND token<>$2`, [input.instalacaoId,input.token]);
      await client.query(`INSERT INTO admtaxi.dispositivos_push
        (empresa_id,usuario_id,token,plataforma,nome_dispositivo,instalacao_id,vinculo_id,senha_versao)
        VALUES($1,$2,$3,'ANDROID','ADM Taxi Android (FCM)',$4,$5,$6)
        ON CONFLICT(token) DO UPDATE SET empresa_id=EXCLUDED.empresa_id,usuario_id=EXCLUDED.usuario_id,
          instalacao_id=EXCLUDED.instalacao_id,vinculo_id=EXCLUDED.vinculo_id,senha_versao=EXCLUDED.senha_versao,
          ativo=TRUE,ultimo_uso_em=CURRENT_TIMESTAMP,codigo_ultima_falha=NULL`,
      [auth.empresaId,auth.usuarioId,input.token,input.instalacaoId,input.vinculoId,auth.senhaVersao ?? 0]);
    });
    return { ativo: true };
  }

  async revoke(auth: AuthContext, binding: string): Promise<void> {
    await this.db.query(`UPDATE admtaxi.dispositivos_push SET ativo=FALSE WHERE usuario_id=$1 AND empresa_id=$2 AND vinculo_id=$3`,
      [auth.usuarioId,auth.empresaId,binding]);
  }
  async status(auth: AuthContext, binding: string) {
    const result = await this.db.query(`SELECT 1 FROM admtaxi.fcm_destinatarios
      WHERE destino_empresa_id=$1 AND destino_usuario_id=$2 AND vinculo_id=$3`, [auth.empresaId,auth.usuarioId,binding]);
    return { configurado: !!this.sender, ativo: !!this.sender && !!result.rowCount };
  }
  start(): void {
    if (!this.sender || this.timer) return;
    this.timer = setInterval(() => this.kick(), 15_000); this.timer.unref(); this.kick();
  }
  kick(): void { void this.process().catch(() => this.logger.warn('Falha ao processar fila FCM; sera tentada novamente.')); }
  async stop(): Promise<void> { clearInterval(this.timer); await this.running; }
  process(): Promise<number> {
    if (!this.sender) return Promise.resolve(0);
    this.running ??= this.batch().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async batch(): Promise<number> {
    let count = 0;
    // Row locks prevent two Cloud Run instances from sending the same job concurrently.
    for (let i = 0; i < 30; i++) {
      const found = await withTransaction(this.db, async client => {
        const selected = await client.query<{ id: string; notificacao_id: string; dispositivo_id: string; vinculo_id: string;
          tentativas: number; expira_em: Date; empresa_id: string; usuario_id: string; corrida_id: string | null; titulo: string; corpo: string }>(
          `SELECT j.*,n.empresa_id,n.usuario_id,n.corrida_id,n.titulo,n.corpo FROM admtaxi.fcm_entregas j
           JOIN admtaxi.notificacoes_push n ON n.id=j.notificacao_id WHERE j.status='PENDENTE'
           AND j.proxima_tentativa_em<=CURRENT_TIMESTAMP ORDER BY j.proxima_tentativa_em,j.id
           LIMIT 1 FOR UPDATE OF j SKIP LOCKED`);
        const job = selected.rows[0]; if (!job) return false;
        const devices = await client.query<{ token: string }>(`SELECT token FROM admtaxi.fcm_destinatarios
          WHERE id=$1 AND vinculo_id=$2 AND destino_empresa_id=$3 AND destino_usuario_id=$4`,
        [job.dispositivo_id,job.vinculo_id,job.empresa_id,job.usuario_id]);
        const device = devices.rows[0];
        if (!device || new Date(job.expira_em).getTime() <= Date.now()) {
          await client.query("UPDATE admtaxi.fcm_entregas SET status='EXPIRADA',codigo_erro='VINCULO_OU_PRAZO_ENCERRADO' WHERE id=$1", [job.id]);
          return true;
        }
        try {
          await this.sender!.send({ token: device.token, android: { priority: 'high', ttl: 300_000, restrictedPackageName: 'com.admbrasil.taxi' },
            data: { notificationId: job.notificacao_id, vinculoId: job.vinculo_id, corridaId: job.corrida_id ?? '',
              title: job.titulo, body: job.corpo, expiresAt: String(new Date(job.expira_em).getTime()) } });
          await client.query("UPDATE admtaxi.fcm_entregas SET status='ENVIADA',enviada_em=CURRENT_TIMESTAMP,tentativas=tentativas+1 WHERE id=$1", [job.id]);
          await client.query('UPDATE admtaxi.dispositivos_push SET ultimo_sucesso_em=CURRENT_TIMESTAMP,codigo_ultima_falha=NULL WHERE id=$1 AND vinculo_id=$2', [job.dispositivo_id,job.vinculo_id]);
        } catch (error) {
          const raw = (error as { code?: string }).code ?? '';
          const code = /^messaging\/[a-z-]+$/.test(raw) ? raw : 'ENVIO_FALHOU';
          const expired = ['messaging/registration-token-not-registered','messaging/invalid-registration-token'].includes(code);
          const transient = ['messaging/server-unavailable','messaging/internal-error','messaging/quota-exceeded','messaging/unknown-error','ENVIO_FALHOU'].includes(code);
          const retry = transient && job.tentativas < 4;
          await client.query(`UPDATE admtaxi.fcm_entregas SET status=$2,tentativas=tentativas+1,codigo_erro=$3,
            proxima_tentativa_em=CURRENT_TIMESTAMP + ($4::int * INTERVAL '1 second') WHERE id=$1`,
          [job.id,expired ? 'EXPIRADA' : retry ? 'PENDENTE' : 'FALHA',code,Math.min(120,15 * 2 ** job.tentativas)]);
          await client.query(`UPDATE admtaxi.dispositivos_push SET ativo=CASE WHEN $3 THEN FALSE ELSE ativo END,
            codigo_ultima_falha=$4 WHERE id=$1 AND vinculo_id=$2`, [job.dispositivo_id,job.vinculo_id,expired,code]);
          this.logger.warn({ entregaId: job.id, codigo: code }, 'Envio FCM nao concluido');
        }
        return true;
      });
      if (!found) break; count++;
    }
    return count;
  }
}
