import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Logger } from 'pino';
import { withTransaction, type Database, type QueryExecutor } from '../../db/pool';
import type { ScheduledMailer } from '../corridas/scheduled-mailer';
import type { RequisitionRow } from './requisicao.schemas';
import type { MailConfig } from '../../config/env';
import { prepareAccessEmail } from './access-email';
import { enqueuePush, type NotificacaoService } from '../notificacoes/notificacao.service';
import { parcelOrigin } from '../corridas/parcel';

export const travelSubjects = {
  PENDENTE: 'Viagem aguardando aprovação',
  AUTORIZADA: 'Viagem autorizada', REJEITADA: 'Viagem não autorizada',
  SOLICITADA: 'Viagem solicitada', FINALIZADA: 'Viagem concluída', CANCELADA: 'Viagem cancelada',
};
type TravelEvent = keyof typeof travelSubjects;
type PassengerContact = { id: string; nome: string; email: string | null; usuario_id: string | null; origem?: string; destino?: string };
const summariesByEvent: Record<TravelEvent, string> = {
  PENDENTE: 'A requisição foi registrada e aguarda decisão do gestor.',
  AUTORIZADA: 'A viagem foi aprovada. A portaria pode conferir e solicitar a corrida.',
  REJEITADA: 'O gestor não autorizou a viagem.',
  SOLICITADA: 'A portaria conferiu os dados. A corrida aguarda um motorista.',
  FINALIZADA: 'A corrida foi finalizada.',
  CANCELADA: 'A corrida foi cancelada.',
};
export class TravelEmails {
  private running?: Promise<number>;
  private timer?: ReturnType<typeof setInterval>;
  private stopping = false;
  constructor(private readonly database: Database, private readonly logger: Pick<Logger,'warn'|'error'>,
    private readonly mailer?: ScheduledMailer,
    private readonly accessMail?: Pick<MailConfig,'resetUrl'|'resetTtlMinutes'>,
    private readonly push?: Pick<NotificacaoService, 'processTravelPush' | 'processAndroidPush'>) {}

  async enqueue(client: QueryExecutor, request: RequisitionRow, event: TravelEvent): Promise<void> {
    const parcel = request.dados.encomenda;
    const directToGate = event === 'AUTORIZADA' && request.decisor_id === null;
    const subject = directToGate ? `${parcel ? 'Encomenda' : 'Viagem'} aguardando conferência`
      : parcel ? travelSubjects[event].replace('Viagem', 'Encomenda') : travelSubjects[event];
    const message = directToGate ? 'A requisição foi encaminhada diretamente para a conferência da portaria.'
      : parcel ? summariesByEvent[event].replace(/viagem|corrida/g, 'encomenda') : summariesByEvent[event];
    const contact = `SELECT f.id,f.nome,COALESCE(u.email::text,NULLIF(trim(f.email::text),'')) AS email,u.id AS usuario_id`;
    const access = `LEFT JOIN admtaxi.usuarios_autenticacao u
      ON u.empresa_id=f.empresa_id AND u.id=f.usuario_id AND u.perfil='FUNCIONARIO' AND u.ativo`;
    // Once dispatched, read the actual registered passengers and their own addresses.
    const employees = request.corrida_id
      ? await client.query<PassengerContact>(`${contact},o.descricao AS origem,d.descricao AS destino
         FROM admtaxi.corrida_participacoes p
         JOIN admtaxi.funcionarios f ON f.empresa_id=p.empresa_id AND f.id=p.funcionario_id
         JOIN admtaxi.corrida_paradas o ON o.empresa_id=p.empresa_id AND o.corrida_id=p.corrida_id AND o.id=p.embarque_id
         JOIN admtaxi.corrida_paradas d ON d.empresa_id=p.empresa_id AND d.corrida_id=p.corrida_id AND d.id=p.desembarque_id
         ${access} WHERE p.empresa_id=$1 AND p.corrida_id=$2 AND f.ativo`, [request.empresa_id,request.corrida_id])
      : await client.query<PassengerContact>(`${contact} FROM admtaxi.funcionarios f ${access}
         WHERE f.empresa_id=$1 AND f.id=ANY($2::uuid[]) AND f.ativo AND NOT f.avulso`,
        [request.empresa_id,request.dados.participantes.flatMap(p => p.funcionarioId ? [p.funcionarioId] : [])]);
    const operators = await client.query<{ id: string; email: string }>(`SELECT u.id,a.email::text FROM admtaxi.usuarios u
      JOIN admtaxi.usuarios_autenticacao a ON a.id=u.id AND a.empresa_id=u.empresa_id
      WHERE u.empresa_id=$1 AND u.ativo AND ((u.perfil='GESTOR' AND u.recebe_avisos_viagem)
        OR (u.perfil='GERENTE' AND u.id=$2 AND $3<>'PENDENTE')
        OR (u.perfil='PORTARIA' AND $3 IN ('AUTORIZADA','SOLICITADA','FINALIZADA','CANCELADA')))`,
      [request.empresa_id,request.solicitante_id,event]);
    const company = await client.query<{ nome: string }>('SELECT COALESCE(nome_fantasia,razao_social) AS nome FROM admtaxi.empresas WHERE id=$1', [request.empresa_id]);
    const summaries = new Map(employees.rows.map(person => {
      const data = request.dados.participantes.find(p => p.funcionarioId === person.id);
      return [person.id, `${person.nome}\nOrigem: ${person.origem ?? data?.origem?.descricao ?? 'A confirmar pela portaria'}\nDestino: ${person.destino ?? data?.destino?.descricao ?? 'A confirmar pela portaria'}`];
    }));
    if (parcel) summaries.set('encomenda', `${parcel.tipo === 'ENVIO' ? 'Envio' : 'Retirada'}: ${parcel.descricao}\n${parcelOrigin(parcel)}: ${parcel.origem.descricao}\nEntrega: ${parcel.destino.descricao}`);
    const recipients = new Map<string,string>();
    for (const data of request.dados.participantes) if (!request.corrida_id && data.avulso) summaries.set(data.avulso.id,
      `${data.avulso.nome} (pre-cadastro)\nTelefone: ${data.avulso.telefone ?? 'A confirmar pela portaria'}\nOrigem: ${data.origem?.descricao ?? 'A confirmar pela portaria'}\nDestino: ${data.destino?.descricao ?? 'A confirmar pela portaria'}`);
    const appRecipients = new Map<string, string>();
    for (const person of employees.rows) {
      const email = person.email?.trim().toLowerCase();
      if (email && z.email().safeParse(email).success) recipients.set(email, summaries.get(person.id)!);
      if (person.usuario_id) appRecipients.set(person.usuario_id, request.corrida_id ? `/app/corridas/${request.corrida_id}` : '/app/notificacoes');
    }
    for (const operator of operators.rows) {
      const email = operator.email?.trim().toLowerCase();
      if (email && z.email().safeParse(email).success && !recipients.has(email)) recipients.set(email, [...summaries.values()].join('\n\n'));
      appRecipients.set(operator.id, '/app/requisicoes');
    }
    for (const [usuarioId, destination] of appRecipients) {
      await enqueuePush(client, { empresaId: request.empresa_id, usuarioId, corridaId: request.corrida_id,
        event: `VIAGEM_${event}`, title: subject, body: message,
        destination, dedupeKey: `${request.empresa_id}:${request.id}:VIAGEM_${event}:${usuarioId}` });
    }
    const when = request.dados.tipo === 'AGENDADA' && request.dados.agendadaPara
      ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(request.dados.agendadaPara)) + ' (Brasilia)' : 'Imediata';
    for (const [email, summary] of recipients) {
      const text = `${subject}\nEmpresa: ${company.rows[0]?.nome ?? ''}\nRequisicao: ${request.id}\nHorario: ${when}\n\n${summary}${request.motivo ? `\n\nMotivo: ${request.motivo}` : ''}\n\nConsulte o aplicativo para acompanhar o atendimento.`;
      await client.query(`INSERT INTO admtaxi.emails_viagem(empresa_id,requisicao_id,evento,destinatario,assunto,corpo)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(requisicao_id,evento,destinatario) DO NOTHING`,
      [request.empresa_id,request.id,event,email,subject,text]);
    }
  }
  async closed(client: QueryExecutor, empresaId: string, corridaId: string, event: 'FINALIZADA' | 'CANCELADA', reason?: string): Promise<boolean> {
    const result = await client.query<RequisitionRow>('SELECT * FROM admtaxi.requisicoes_viagem WHERE empresa_id=$1 AND corrida_id=$2', [empresaId,corridaId]);
    if (!result.rows[0]) return false;
    await this.enqueue(client,{ ...result.rows[0], motivo: reason ?? null },event);
    return true;
  }
  start(): void { this.stopping = false; if (!this.timer) { void this.kick(); this.timer = setInterval(() => void this.kick(),30_000); this.timer.unref(); } }
  async stop(): Promise<void> { this.stopping = true; clearInterval(this.timer); this.timer = undefined; await this.running; }
  async kick(): Promise<void> {
    if (this.stopping) return;
    void this.process().catch(() => this.logger.error('Falha ao processar emails de viagem.'));
    void this.push?.processTravelPush().catch(() => this.logger.error('Falha ao processar notificacoes de viagem.'));
    if (!this.push) return;
    // Give FCM time to dispatch with Cloud Run request CPU, without blocking the saved request on delivery.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.push.processAndroidPush(),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 2500); })]);
    } catch { this.logger.warn('Falha ao processar notificacoes Android de viagem.'); }
    finally { clearTimeout(timer); }
  }
  process(): Promise<number> {
    if (!this.mailer || this.stopping) return Promise.resolve(0);
    return this.running ??= this.batch().finally(() => { this.running = undefined; });
  }
  private async batch(): Promise<number> {
    await this.database.query(`UPDATE admtaxi.emails_viagem SET status='FALHOU',ultimo_erro='RESERVA_EXPIRADA'
      WHERE status='ENVIANDO' AND reservada_ate<CURRENT_TIMESTAMP AND tentativas>=5`);
    let count = 0;
    for (; count<20 && !this.stopping; count++) {
      const row = await withTransaction(this.database,async client => {
        const selected = await client.query<{ id: string }>(`SELECT id FROM admtaxi.emails_viagem WHERE tentativas<5 AND
          ((status='PENDENTE' AND proxima_tentativa_em<=CURRENT_TIMESTAMP) OR (status='ENVIANDO' AND reservada_ate<CURRENT_TIMESTAMP))
          ORDER BY proxima_tentativa_em,id LIMIT 1 FOR UPDATE SKIP LOCKED`);
        if (!selected.rows[0]) return null;
        const result = await client.query<{ id: string; reserva: string; destinatario: string; assunto: string; corpo: string; tentativas: number; evento:string; empresa_id:string }>(
          `UPDATE admtaxi.emails_viagem SET status='ENVIANDO',tentativas=tentativas+1,reserva=$2,
            reservada_ate=CURRENT_TIMESTAMP+INTERVAL '2 minutes' WHERE id=$1 RETURNING *`, [selected.rows[0].id,randomUUID()]);
        return result.rows[0]!;
      });
      if (!row) break;
      let tokenHash: string|undefined;
      try {
        let text=row.corpo;
        if (/^(PRIMEIRO_ACESSO|ACESSO_EXISTENTE):/.test(row.evento)) {
          const prepared=await prepareAccessEmail(this.database,row,this.accessMail);
          text=prepared.text;tokenHash=prepared.tokenHash;
        }
        await this.mailer!.send({ id: row.id,to: row.destinatario,subject: row.assunto,text });
      }
      catch {
        if(tokenHash) await this.database.query('UPDATE admtaxi.recuperacoes_senha SET usado_em=CURRENT_TIMESTAMP WHERE token_hash=$1',[tokenHash]);
        await this.database.query(`UPDATE admtaxi.emails_viagem SET status=$3,ultimo_erro='FALHA_SMTP',reserva=NULL,reservada_ate=NULL,
          proxima_tentativa_em=CURRENT_TIMESTAMP+($4::integer*INTERVAL '1 minute') WHERE id=$1 AND reserva=$2`,
        [row.id,row.reserva,row.tentativas>=5 ? 'FALHOU' : 'PENDENTE',2 ** (row.tentativas-1)]);
        this.logger.warn({ emailId: row.id },'Falha SMTP; nova tentativa registrada.'); continue;
      }
      await this.database.query(`UPDATE admtaxi.emails_viagem SET status='ENVIADO',enviado_em=CURRENT_TIMESTAMP,
        reserva=NULL,reservada_ate=NULL,ultimo_erro=NULL WHERE id=$1 AND reserva=$2`, [row.id,row.reserva]);
    }
    return count;
  }
}
