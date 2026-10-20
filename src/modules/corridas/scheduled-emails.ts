import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { z } from 'zod';
import { withTransaction, type Database, type QueryExecutor } from '../../db/pool';
import { employeeRide } from './corrida-visibility';
import type { CorridaRecord } from './corrida.types';
import type { ScheduledMailer } from './scheduled-mailer';

export interface ScheduledEmailQueue {
  enqueue(executor: QueryExecutor, ride: CorridaRecord): Promise<void>;
  kick(): void;
}
type EmailRow = { id: string; empresa_id: string; corrida_id: string; funcionario_id: string;
  destinatario: string; assunto: string; corpo: string; tentativas: number; reserva: string };

export class ScheduledRideEmails implements ScheduledEmailQueue {
  private running?: Promise<number>;
  private timer?: ReturnType<typeof setInterval>;
  private stopping = false;
  constructor(private readonly database: Database, private readonly logger: Pick<Logger, 'warn' | 'error'>,
    private readonly mailer?: ScheduledMailer, private readonly appUrl?: string) {}

  async enqueue(executor: QueryExecutor, ride: CorridaRecord): Promise<void> {
    if (ride.tipo !== 'AGENDADA' || !ride.agendadaPara) return;
    const ids = [...new Set([ride.funcionarioId, ...(ride.itinerario?.participantes ?? []).map(p => p.funcionarioId),
      ...(ride.paradas ?? []).flatMap(p => p.funcionarioId ? [p.funcionarioId] : [])])];
    const recipients = await executor.query<{ id: string; nome: string; email: string | null; empresa: string }>(
      `SELECT f.id,f.nome,COALESCE(NULLIF(trim(f.email::text),''),u.email::text) AS email,
        COALESCE(e.nome_fantasia,e.razao_social) AS empresa FROM admtaxi.funcionarios f
       JOIN admtaxi.empresas e ON e.id=f.empresa_id
       LEFT JOIN admtaxi.usuarios u ON u.empresa_id=f.empresa_id AND u.id=f.usuario_id
       WHERE f.empresa_id=$1 AND f.id=ANY($2::uuid[]) AND f.ativo`, [ride.empresaId, ids]);
    const when = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' })
      .format(new Date(ride.agendadaPara));
    for (const person of recipients.rows) {
      const own = employeeRide(ride, person.id);
      const valid = z.email().safeParse(person.email?.trim());
      const link = this.appUrl ? `\nAcompanhe no aplicativo: ${new URL(`/app/corridas/${ride.id}`, this.appUrl).toString()}\n` : '';
      const text = `Ola, ${person.nome}.\n\nUma corrida foi agendada para voce.\n\nEmpresa: ${person.empresa}\nData e horario: ${when} (horario de Brasilia)\nOrigem: ${own.origemDescricao ?? 'A confirmar'}\nDestino: ${own.destinoDescricao ?? 'A confirmar'}\n${link}\nO prestador podera aceitar a corrida a partir de uma hora antes do horario agendado.\nConsulte o aplicativo para acompanhar alteracoes ou cancelamentos.`;
      await executor.query(`INSERT INTO admtaxi.emails_agendamento
        (empresa_id,corrida_id,funcionario_id,destinatario,assunto,corpo,status,ultimo_erro)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (empresa_id,corrida_id,funcionario_id) DO NOTHING`,
      [ride.empresaId, ride.id, person.id, valid.success ? valid.data : null, 'Corrida agendada - ADM Taxi', text,
        valid.success ? 'PENDENTE' : 'SEM_EMAIL', valid.success ? null : 'FUNCIONARIO_SEM_EMAIL_VALIDO']);
    }
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    if (!this.mailer) this.logger.warn('SMTP nao configurado: emails de agendamento permanecerao pendentes.');
    this.kick(); this.timer = setInterval(() => this.kick(), 30_000); this.timer.unref();
  }
  async stop(): Promise<void> { this.stopping = true; clearInterval(this.timer); this.timer = undefined; await this.running; }
  kick(): void { void this.process().catch(() => this.logger.error('Falha ao processar fila de emails de agendamento.')); }
  process(): Promise<number> {
    if (!this.mailer || this.stopping) return Promise.resolve(0);
    if (this.running) return this.running;
    this.running = this.processBatch().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async processBatch(): Promise<number> {
    await this.database.query(`UPDATE admtaxi.emails_agendamento SET status='FALHOU',ultimo_erro='RESERVA_EXPIRADA'
      WHERE status='ENVIANDO' AND reservada_ate<CURRENT_TIMESTAMP AND tentativas>=5`);
    let processed = 0;
    for (; processed < 20 && !this.stopping; processed++) {
      const row = await withTransaction(this.database, async client => {
        const result = await client.query<EmailRow>(`SELECT * FROM admtaxi.emails_agendamento WHERE tentativas<5 AND
          ((status='PENDENTE' AND proxima_tentativa_em<=CURRENT_TIMESTAMP) OR (status='ENVIANDO' AND reservada_ate<CURRENT_TIMESTAMP))
          ORDER BY proxima_tentativa_em,id LIMIT 1 FOR UPDATE SKIP LOCKED`);
        const item = result.rows[0]; if (!item) return null;
        const reserved = await client.query<EmailRow>(`UPDATE admtaxi.emails_agendamento SET status='ENVIANDO',
          tentativas=tentativas+1,reserva=$2,reservada_ate=CURRENT_TIMESTAMP+INTERVAL '2 minutes' WHERE id=$1 RETURNING *`, [item.id, randomUUID()]);
        return reserved.rows[0]!;
      });
      if (!row) break;
      const eligible = await this.database.query(`SELECT 1 FROM admtaxi.corridas c JOIN admtaxi.funcionarios f
        ON f.empresa_id=c.empresa_id AND f.id=$3 JOIN admtaxi.empresas e ON e.id=c.empresa_id
        WHERE c.empresa_id=$1 AND c.id=$2 AND f.ativo AND e.ativo AND c.tipo='AGENDADA'
          AND c.status NOT IN ('CANCELADA','FINALIZADA') AND c.agendada_para>CURRENT_TIMESTAMP
          AND ((c.itinerario_versao=0 AND c.funcionario_id=f.id) OR EXISTS (
            SELECT 1 FROM admtaxi.corrida_participacoes p WHERE p.empresa_id=c.empresa_id AND p.corrida_id=c.id
              AND p.funcionario_id=f.id AND p.estado NOT IN ('CANCELADO','AUSENTE')))`, [row.empresa_id,row.corrida_id,row.funcionario_id]);
      if (!eligible.rowCount) {
        await this.database.query(`UPDATE admtaxi.emails_agendamento SET status='IGNORADO',ultimo_erro='AGENDAMENTO_INATIVO',reserva=NULL,reservada_ate=NULL
          WHERE id=$1 AND reserva=$2`, [row.id,row.reserva]); continue;
      }
      try {
        await this.mailer!.send({ id: row.id, to: row.destinatario, subject: row.assunto, text: row.corpo });
      } catch {
        await this.database.query(`UPDATE admtaxi.emails_agendamento SET status=$3,ultimo_erro='FALHA_SMTP',
          proxima_tentativa_em=CURRENT_TIMESTAMP+($4::integer*INTERVAL '1 minute'),reserva=NULL,reservada_ate=NULL
          WHERE id=$1 AND reserva=$2`, [row.id,row.reserva,row.tentativas>=5 ? 'FALHOU' : 'PENDENTE',2 ** (row.tentativas - 1)]);
        this.logger.warn({ emailId: row.id, tentativa: row.tentativas }, 'Falha no email de agendamento; consulte a fila.');
        continue;
      }
      await this.database.query(`UPDATE admtaxi.emails_agendamento SET status='ENVIADO',enviado_em=CURRENT_TIMESTAMP,
        ultimo_erro=NULL,reserva=NULL,reservada_ate=NULL WHERE id=$1 AND reserva=$2`, [row.id,row.reserva]);
    }
    return processed;
  }
}
