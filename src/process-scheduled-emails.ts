import { getConfig } from './config/env';
import { createLogger } from './config/logger';
import { createPool } from './db/pool';
import { ScheduledRideEmails } from './modules/corridas/scheduled-emails';
import { SmtpScheduledMailer } from './modules/corridas/scheduled-mailer';
import { TravelEmails } from './modules/requisicoes/travel-emails';

async function main(): Promise<void> {
  const config = getConfig();
  const logger = createLogger(config);
  if (!config.mail) throw new Error('Configure SMTP antes de processar a fila de agendamentos.');
  const pool = createPool(config);
  const worker = new ScheduledRideEmails(pool, logger, new SmtpScheduledMailer(config.mail));
  const travel = new TravelEmails(pool,logger,new SmtpScheduledMailer(config.mail),config.mail);
  let stopping = false;
  const stop = (): void => { stopping = true; void worker.stop(); void travel.stop(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    let processed = 0;
    // A bounded job leaves remaining rows for the next execution, including delayed retries.
    for (let batch = 0; batch < 10 && !stopping; batch++) {
      const count = await worker.process(); processed += count;
      if (count < 20) break;
    }
    for (let batch = 0; batch < 10 && !stopping; batch++) { const count = await travel.process(); processed += count; if (count < 20) break; }
    logger.info({ processed }, 'Processamento de emails de agendamento concluido.');
  } finally { await worker.stop(); await travel.stop(); await pool.end(); }
}

void main().catch(() => { console.error('Falha ao processar emails de agendamento. Verifique SMTP, migracao 022 e conectividade do banco.'); process.exitCode = 1; });
