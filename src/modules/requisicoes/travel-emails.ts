import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Logger } from 'pino';
import { withTransaction, type Database, type QueryExecutor } from '../../db/pool';
import type { ScheduledMailer } from '../corridas/scheduled-mailer';
import type { RequisitionRow } from './requisicao.schemas';

export const travelSubjects: Record<string,string> = {
  PENDENTE: 'Requisicao de viagem - pendente de autorizacao',
  AUTORIZADA: 'Requisicao de viagem - autorizada', REJEITADA: 'Requisicao de viagem - nao autorizada',
  SOLICITADA: 'Viagem solicitada - aguardando prestador', FINALIZADA: 'Viagem concluida - corrida finalizada',
};
export class TravelEmails {
  private running?: Promise<number>;
  private timer?: ReturnType<typeof setInterval>;
  private stopping = false;
  constructor(private readonly database: Database, private readonly logger: Pick<Logger,'warn'|'error'>,
    private readonly mailer?: ScheduledMailer) {}

  async enqueue(client: QueryExecutor, request: RequisitionRow, event: string): Promise<void> {
    const employees = await client.query<{ id: string; nome: string; email: string | null }>(
      `SELECT f.id,f.nome,COALESCE(NULLIF(trim(f.email::text),''),u.email::text) AS email FROM admtaxi.funcionarios f
       LEFT JOIN admtaxi.usuarios u ON u.empresa_id=f.empresa_id AND u.id=f.usuario_id
       WHERE f.empresa_id=$1 AND f.id=ANY($2::uuid[]) AND f.ativo`,
      [request.empresa_id,request.dados.participantes.map(p => p.funcionarioId)]);
    const operators = await client.query<{ email: string }>(`SELECT email::text FROM admtaxi.usuarios
      WHERE empresa_id=$1 AND ativo AND (perfil IN ('GESTOR','PORTARIA') OR id=$2)`, [request.empresa_id,request.solicitante_id]);
    const company = await client.query<{ nome: string }>('SELECT COALESCE(nome_fantasia,razao_social) AS nome FROM admtaxi.empresas WHERE id=$1', [request.empresa_id]);
    const summaries = new Map(employees.rows.map(person => {
      const data = request.dados.participantes.find(p => p.funcionarioId === person.id)!;
      return [person.id, `${person.nome}\nOrigem: ${data.origem?.descricao ?? 'A confirmar pela portaria'}\nDestino: ${data.destino?.descricao ?? 'A confirmar pela portaria'}`];
    }));
    const recipients = new Map<string,string>();
    for (const data of request.dados.participantes) if (data.avulso) summaries.set(data.avulso.id,
      `${data.avulso.nome} (avulso)\nTelefone: ${data.avulso.telefone}\nOrigem: ${data.origem?.descricao ?? 'A confirmar pela portaria'}\nDestino: ${data.destino?.descricao ?? 'A confirmar pela portaria'}`);
    // Each employee receives only their own addresses. Administrative recipients receive the full summary.
    for (const person of employees.rows) {
      const email = person.email?.trim().toLowerCase();
      if (email && z.email().safeParse(email).success) recipients.set(email, summaries.get(person.id)!);
    }
    for (const operator of operators.rows) {
      const email = operator.email?.trim().toLowerCase();
      if (email && z.email().safeParse(email).success) recipients.set(email, [...summaries.values()].join('\n\n'));
    }
    const when = request.dados.tipo === 'AGENDADA' && request.dados.agendadaPara
      ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(request.dados.agendadaPara)) + ' (Brasilia)' : 'Imediata';
    for (const [email, summary] of recipients) {
      const text = `${travelSubjects[event]}\nEmpresa: ${company.rows[0]?.nome ?? ''}\nRequisicao: ${request.id}\nHorario: ${when}\n\n${summary}${request.motivo ? `\n\nMotivo: ${request.motivo}` : ''}\n\nConsulte o aplicativo para acompanhar a viagem.`;
      await client.query(`INSERT INTO admtaxi.emails_viagem(empresa_id,requisicao_id,evento,destinatario,assunto,corpo)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(requisicao_id,evento,destinatario) DO NOTHING`,
      [request.empresa_id,request.id,event,email,travelSubjects[event],text]);
    }
  }
  async completed(client: QueryExecutor, empresaId: string, corridaId: string): Promise<void> {
    const result = await client.query<RequisitionRow>('SELECT * FROM admtaxi.requisicoes_viagem WHERE empresa_id=$1 AND corrida_id=$2', [empresaId,corridaId]);
    if (result.rows[0]) await this.enqueue(client,result.rows[0],'FINALIZADA');
  }
  start(): void { this.stopping = false; if (!this.timer) { this.kick(); this.timer = setInterval(() => this.kick(),30_000); this.timer.unref(); } }
  async stop(): Promise<void> { this.stopping = true; clearInterval(this.timer); this.timer = undefined; await this.running; }
  kick(): void { void this.process().catch(() => this.logger.error('Falha ao processar emails de viagem.')); }
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
        const result = await client.query<{ id: string; reserva: string; destinatario: string; assunto: string; corpo: string; tentativas: number }>(
          `UPDATE admtaxi.emails_viagem SET status='ENVIANDO',tentativas=tentativas+1,reserva=$2,
            reservada_ate=CURRENT_TIMESTAMP+INTERVAL '2 minutes' WHERE id=$1 RETURNING *`, [selected.rows[0].id,randomUUID()]);
        return result.rows[0]!;
      });
      if (!row) break;
      try { await this.mailer!.send({ id: row.id,to: row.destinatario,subject: row.assunto,text: row.corpo }); }
      catch {
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
