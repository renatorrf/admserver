import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Logger } from 'pino';
import type { WhatsAppConfig } from '../../config/env';
import type { QueryExecutor } from '../../db/pool';
import type { AuthContext } from '../auth/auth.types';
import { whatsappPhone } from './requisition-access';
import { issuePassengerTracking } from './public-tracking';

type Job = { id: string; empresa_id: string; requisicao_id: string; funcionario_id: string;
  conferente_id: string; telefone_hash: string; tipo: 'CORRIDA' | 'PRIMEIRO_ACESSO'; tentativas: number };
type Contact = { nome: string; telefone: string | null; origem: string; destino: string; agendada_para: Date | null };
type Result = { status: 'ACEITO'; messageId: string } | { status: 'FALHOU' | 'INCERTO' | 'PENDENTE' | 'IGNORADO'; messageId?: undefined };

const installed = `EXISTS (SELECT 1 FROM admtaxi.usuarios conta JOIN admtaxi.usuarios vinculo
    ON (vinculo.id=conta.id OR (conta.conta_funcionario_id IS NOT NULL AND vinculo.conta_funcionario_id=conta.conta_funcionario_id))
  WHERE conta.empresa_id=f.empresa_id AND conta.id=f.usuario_id
    AND (vinculo.app_instalado_em IS NOT NULL OR EXISTS(SELECT 1 FROM admtaxi.dispositivos_usuario d
      WHERE d.empresa_id=vinculo.empresa_id AND d.usuario_id=vinculo.id
        AND (d.modo_acesso='PWA' OR (d.plataforma='ANDROID' AND d.navegador='Android WebView (APK)')))))`;
const phoneHash = (phone: string) => createHash('sha256').update(phone).digest('hex');
const messageId = z.object({ messages: z.array(z.object({ id: z.string().min(1).max(512) })).min(1) });
const textParameter = (value: string) => ({ type: 'text', text: value.replace(/\s+/g,' ').trim().slice(0,1000) });

export class WhatsAppDelivery {
  private running?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private stopping = false;

  constructor(private readonly db: QueryExecutor, private readonly logger: Pick<Logger,'warn'>,
    private readonly config: WhatsAppConfig,
    private readonly send: typeof fetch = fetch) {}

  async enqueue(client: QueryExecutor, auth: AuthContext, requestId: string, rideId: string, employeeIds: string[]): Promise<void> {
    await client.query(`UPDATE admtaxi.usuarios u SET whatsapp_autorizado_em=COALESCE(whatsapp_autorizado_em,CURRENT_TIMESTAMP)
      FROM admtaxi.funcionarios f JOIN admtaxi.corrida_participacoes p ON p.empresa_id=f.empresa_id AND p.funcionario_id=f.id
      WHERE u.empresa_id=$1 AND f.empresa_id=u.empresa_id AND f.usuario_id=u.id
        AND p.corrida_id=$2 AND f.id=ANY($3::uuid[])`,[auth.empresaId,rideId,employeeIds]);
    const contacts = await client.query<{id: string; telefone: string | null; primeiro_acesso: boolean}>(`
      SELECT DISTINCT f.id,f.telefone,COALESCE(u.ativo AND u.deve_alterar_senha AND EXISTS (
        SELECT 1 FROM admtaxi.emails_viagem m WHERE m.empresa_id=f.empresa_id AND m.requisicao_id=$4
          AND m.evento='PRIMEIRO_ACESSO:' || u.id::text AND m.destinatario=u.email
      ),FALSE) AS primeiro_acesso
      FROM admtaxi.corrida_participacoes p
      JOIN admtaxi.funcionarios f ON f.empresa_id=p.empresa_id AND f.id=p.funcionario_id
      LEFT JOIN admtaxi.usuarios_autenticacao u ON u.empresa_id=f.empresa_id AND u.id=f.usuario_id AND u.perfil='FUNCIONARIO'
      WHERE p.empresa_id=$1 AND p.corrida_id=$2 AND (f.id=ANY($3::uuid[]) OR EXISTS (
        SELECT 1 FROM admtaxi.usuarios a WHERE a.empresa_id=f.empresa_id AND a.id=f.usuario_id AND a.whatsapp_autorizado_em IS NOT NULL))
        AND f.ativo AND NOT ${installed}`,
    [auth.empresaId,rideId,employeeIds,requestId]);
    for (const contact of contacts.rows) {
      const phone = whatsappPhone(contact.telefone);
      if (!phone) continue;
      await client.query(`INSERT INTO admtaxi.whatsapp_viagem(empresa_id,requisicao_id,funcionario_id,conferente_id,telefone_hash,tipo)
        SELECT $1,$2,$3,$4,$5,tipo FROM unnest($6::text[]) AS tipos(tipo)
        ON CONFLICT(requisicao_id,funcionario_id,tipo) DO NOTHING`,
      [auth.empresaId,requestId,contact.id,auth.usuarioId,phoneHash(phone),contact.primeiro_acesso ? ['CORRIDA','PRIMEIRO_ACESSO'] : ['CORRIDA']]);
    }
  }

  start(): void {
    if (this.timer) return;
    void this.kick();
    this.timer = setInterval(() => void this.kick(),30_000);
    this.timer.unref();
  }
  async stop(): Promise<void> { this.stopping = true; clearInterval(this.timer); await this.running; }

  kick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.running ??= this.process().catch(() => {
      this.logger.warn('Falha ao processar fila WhatsApp.');
    }).finally(() => { this.running = undefined; });
    return this.running;
  }

  private async process(): Promise<void> {
    await this.processAccounts();
    // An interrupted HTTP send may already have reached Meta; never resend it blindly.
    await this.db.query(`UPDATE admtaxi.whatsapp_viagem SET status='INCERTO',atualizado_em=CURRENT_TIMESTAMP
      WHERE status='ENVIANDO' AND atualizado_em < CURRENT_TIMESTAMP-INTERVAL '5 minutes'`);
    await this.db.query(`UPDATE admtaxi.whatsapp_viagem w SET status='IGNORADO',atualizado_em=CURRENT_TIMESTAMP
      WHERE status='PENDENTE' AND (criado_em<CURRENT_TIMESTAMP-INTERVAL '1 day' OR (tipo='PRIMEIRO_ACESSO'
        AND EXISTS (SELECT 1 FROM admtaxi.whatsapp_viagem r WHERE r.requisicao_id=w.requisicao_id
          AND r.funcionario_id=w.funcionario_id AND r.tipo='CORRIDA' AND r.status IN ('FALHOU','IGNORADO'))))`);
    // The second batch can pick up the account notice after the ride message was accepted.
    for (let batch = 0; batch < 2; batch++) {
      const jobs = await this.db.query<Job>(`WITH candidatos AS (
        SELECT w.id FROM admtaxi.whatsapp_viagem w WHERE w.status='PENDENTE' AND w.tentar_em<=CURRENT_TIMESTAMP
          AND (w.tipo='CORRIDA' OR EXISTS (SELECT 1 FROM admtaxi.whatsapp_viagem r WHERE r.requisicao_id=w.requisicao_id
            AND r.funcionario_id=w.funcionario_id AND r.tipo='CORRIDA' AND r.status IN ('ACEITO','ENVIADO','ENTREGUE','LIDO')))
        ORDER BY w.tentar_em,w.id LIMIT 16 FOR UPDATE OF w SKIP LOCKED
      ) UPDATE admtaxi.whatsapp_viagem w SET status='ENVIANDO',tentativas=w.tentativas+1,atualizado_em=CURRENT_TIMESTAMP
        FROM candidatos c WHERE w.id=c.id RETURNING w.*`);
      if (!jobs.rows.length) break;
      await Promise.allSettled(jobs.rows.map(job => this.deliver(job))).then(results => {
        if (results.some(r => r.status==='rejected')) this.logger.warn('Falha ao atualizar entrega WhatsApp.');
      });
    }
  }

  private async deliver(job: Job): Promise<void> {
    const result = await this.sendJob(job);
    await this.db.query(`UPDATE admtaxi.whatsapp_viagem SET status=$2,mensagem_id=$3,atualizado_em=CURRENT_TIMESTAMP,
      tentar_em=CASE WHEN $2='PENDENTE' THEN CURRENT_TIMESTAMP+INTERVAL '1 minute'*tentativas ELSE tentar_em END
      WHERE id=$1 AND status='ENVIANDO'`, [job.id,result.status,result.messageId ?? null]);
  }

  private async sendJob(job: Job): Promise<Result> {
    const contact = (await this.db.query<Contact>(`SELECT f.nome,f.telefone,o.descricao AS origem,d.descricao AS destino,c.agendada_para
      FROM admtaxi.requisicoes_viagem r
      JOIN admtaxi.corridas c ON c.empresa_id=r.empresa_id AND c.id=r.corrida_id
      JOIN admtaxi.corrida_participacoes p ON p.empresa_id=c.empresa_id AND p.corrida_id=c.id
      JOIN admtaxi.funcionarios f ON f.empresa_id=p.empresa_id AND f.id=p.funcionario_id
      JOIN admtaxi.corrida_paradas o ON o.empresa_id=p.empresa_id AND o.corrida_id=p.corrida_id AND o.id=p.embarque_id
      JOIN admtaxi.corrida_paradas d ON d.empresa_id=p.empresa_id AND d.corrida_id=p.corrida_id AND d.id=p.desembarque_id
      JOIN admtaxi.empresas e ON e.id=r.empresa_id
      WHERE r.empresa_id=$1 AND r.id=$2 AND f.id=$3 AND f.ativo AND e.ativo
        AND c.status NOT IN ('CANCELADA','FINALIZADA') AND p.estado NOT IN ('AUSENTE','CANCELADO','DESEMBARCADO')
        AND NOT ${installed}
        AND ($4 <> 'PRIMEIRO_ACESSO' OR EXISTS (
          SELECT 1 FROM admtaxi.usuarios_autenticacao u JOIN admtaxi.emails_viagem m
            ON m.empresa_id=u.empresa_id AND m.requisicao_id=r.id
            AND m.evento='PRIMEIRO_ACESSO:' || u.id::text AND m.destinatario=u.email
          WHERE u.empresa_id=f.empresa_id AND u.id=f.usuario_id
            AND u.perfil='FUNCIONARIO' AND u.ativo AND u.deve_alterar_senha
        ))`, [job.empresa_id,job.requisicao_id,job.funcionario_id,job.tipo])).rows[0];
    const phone = whatsappPhone(contact?.telefone ?? null);
    if (!contact || !phone || phoneHash(phone)!==job.telefone_hash) return { status:'IGNORADO' };
    const isAccountNotice = job.tipo==='PRIMEIRO_ACESSO';
    const template = isAccountNotice ? this.config.firstAccessTemplate : this.config.rideTemplate;
    const when = contact.agendada_para
      ? new Intl.DateTimeFormat('pt-BR',{ timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short' }).format(contact.agendada_para)
      : 'Imediata';
    const link = isAccountNotice ? null : await issuePassengerTracking(this.db,job.empresa_id,job.requisicao_id,job.funcionario_id,this.config.appUrl);
    const params = isAccountNotice ? [contact.nome] : [contact.nome,when,contact.origem,contact.destino,link!];
    return this.sendTemplate(job.id,phone,template,params,job.tentativas);
  }

  private async processAccounts(): Promise<void> {
    await this.db.query(`UPDATE admtaxi.whatsapp_cadastros SET status='INCERTO',atualizado_em=CURRENT_TIMESTAMP
      WHERE status='ENVIANDO' AND atualizado_em<CURRENT_TIMESTAMP-INTERVAL '5 minutes'`);
    const jobs = await this.db.query<{id:string;empresa_id:string;usuario_id:string;telefone_hash:string;tentativas:number}>(`
      WITH candidatos AS (SELECT id FROM admtaxi.whatsapp_cadastros WHERE status='PENDENTE' AND tentar_em<=CURRENT_TIMESTAMP
        ORDER BY tentar_em,id LIMIT 16 FOR UPDATE SKIP LOCKED)
      UPDATE admtaxi.whatsapp_cadastros w SET status='ENVIANDO',tentativas=tentativas+1,atualizado_em=CURRENT_TIMESTAMP
        FROM candidatos c WHERE w.id=c.id RETURNING w.*`);
    const results = await Promise.allSettled(jobs.rows.map(async job => {
      const user = (await this.db.query<{nome:string;telefone:string|null}>(`SELECT u.nome,u.telefone FROM admtaxi.usuarios u
        JOIN admtaxi.empresas e ON e.id=u.empresa_id WHERE u.empresa_id=$1 AND u.id=$2
        AND u.ativo AND e.ativo AND u.deve_alterar_senha AND u.whatsapp_autorizado_em IS NOT NULL
        AND EXISTS(SELECT 1 FROM admtaxi.whatsapp_cadastros w WHERE w.id=$3 AND w.criado_em>CURRENT_TIMESTAMP-INTERVAL '1 day')`,
      [job.empresa_id,job.usuario_id,job.id])).rows[0];
      const phone = whatsappPhone(user?.telefone ?? null);
      const result: Result = user && phone && phoneHash(phone)===job.telefone_hash
        ? await this.sendTemplate(job.id,phone,this.config.firstAccessTemplate,[user.nome],job.tentativas)
        : {status:'IGNORADO'};
      await this.db.query(`UPDATE admtaxi.whatsapp_cadastros SET status=$2,mensagem_id=$3,atualizado_em=CURRENT_TIMESTAMP,
        tentar_em=CURRENT_TIMESTAMP+INTERVAL '1 minute'*tentativas WHERE id=$1 AND status='ENVIANDO'`,
      [job.id,result.status,result.messageId ?? null]);
    }));
    if (results.some(result=>result.status==='rejected')) this.logger.warn('Falha ao atualizar aviso de cadastro WhatsApp.');
  }

  private async sendTemplate(id: string, phone: string, template: string, params: string[], attempts: number): Promise<Result> {
    try {
      const response = await this.send(`https://graph.facebook.com/${this.config.version}/${this.config.phoneNumberId}/messages`,{
        method:'POST', redirect:'error', signal:AbortSignal.timeout(5000),
        headers:{ Authorization:`Bearer ${this.config.accessToken}`,'Content-Type':'application/json' },
        body:JSON.stringify({ messaging_product:'whatsapp',to:phone,type:'template',biz_opaque_callback_data:id,
          template:{ name:template,language:{ code:this.config.language },
            components:[{ type:'body',parameters:params.map(textParameter) }] } }),
      });
      if (response.status===429 && attempts<3) return { status:'PENDENTE' };
      if (!response.ok) return { status:response.status>=500 ? 'INCERTO' : 'FALHOU' };
      const parsed = messageId.safeParse(await response.json());
      return parsed.success ? { status:'ACEITO',messageId:parsed.data.messages[0]!.id } : { status:'INCERTO' };
    } catch { return { status:'INCERTO' }; }
  }
}
