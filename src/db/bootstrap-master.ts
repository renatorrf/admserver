import { promises as fs } from 'node:fs';
import path from 'node:path';

import { getConfig } from '../config/env';
import { ensureInitialMaster } from '../modules/master/master-bootstrap';
import { createPool } from './pool';

async function main(): Promise<void> {
  const config = getConfig();
  if (!config.masterBootstrapUsername || !config.masterBootstrapPasswordHash) {
    throw new Error('Bootstrap master nao configurado.');
  }
  const pool = createPool(config);
  try {
    await ensureInitialMaster(pool, config.masterBootstrapUsername, config.masterBootstrapPasswordHash);
    const envPath = path.resolve('.env');
    const contents = await fs.readFile(envPath, 'utf8');
    const sanitized = contents.split(/\r?\n/)
      .filter((line) => !line.startsWith('MASTER_BOOTSTRAP_PASSWORD_HASH='))
      .join('\n');
    await fs.writeFile(envPath, sanitized, { encoding: 'utf8', mode: 0o600 });
    console.log('Administrador master inicial verificado; hash de bootstrap removido do .env.');
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Falha ao configurar administrador master.');
  process.exitCode = 1;
});
