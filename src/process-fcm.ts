import { getFcmWorkerConfig } from './config/env';
import { createLogger } from './config/logger';
import { createPool } from './db/pool';
import { createFcmSender, FcmService } from './modules/notificacoes/fcm.service';

async function main(): Promise<void> {
  const config = getFcmWorkerConfig();
  const logger = createLogger(config);
  const pool = createPool(config);
  const worker = new FcmService(pool, logger, createFcmSender(config.fcmProjectId));
  let stopping = false;
  const stop = (): void => { stopping = true; };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    let processed = 0;
    for (let batch = 0; batch < 10 && !stopping; batch++) {
      const count = await worker.process(); processed += count;
      if (count < 30) break;
    }
    logger.info({ processed }, 'Processamento da fila FCM concluido.');
  } finally { await worker.stop(); await pool.end(); }
}

void main().catch(() => {
  console.error('Falha ao processar FCM. Verifique identidade, FCM_PROJECT_ID, migracao 027 e conectividade.');
  process.exitCode = 1;
});
