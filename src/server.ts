import { createServer } from 'node:http';

import { createApp } from './app';
import { getConfig } from './config/env';
import { createLogger } from './config/logger';
import { createPool } from './db/pool';
import { createAdminRouter } from './modules/admin/admin.routes';
import { PgAuthRepository } from './modules/auth/auth.repository';
import { AuthService } from './modules/auth/auth.service';
import { TokenService } from './modules/auth/token-service';
import { createOperationalRouter } from './modules/corridas/operational.routes';
import { AuditRepository } from './modules/auditoria/audit.repository';
import { CorridaService } from './modules/corridas/corrida.service';
import { LocalizacaoService } from './modules/localizacoes/localizacao.service';
import { ensureInitialMaster } from './modules/master/master-bootstrap';
import { createMasterRouter } from './modules/master/master.routes';
import { MasterService } from './modules/master/master.service';
import { MasterTokenService } from './modules/master/master-token.service';
import { createProvisionamentoRouter } from './modules/provisionamento/provisionamento.routes';
import { ProvisionamentoService } from './modules/provisionamento/provisionamento.service';
import { RealtimeBus } from './realtime/realtime-bus';
import { attachSocketServer } from './realtime/socket-server';

const config = getConfig();
const logger = createLogger(config);
const pool = createPool(config);
const tokenService = new TokenService(config);
const authRepository = new PgAuthRepository(pool);
const authService = new AuthService(
  authRepository,
  tokenService,
  undefined,
  config.jwtAccessExpiresInSeconds,
);
const realtime = new RealtimeBus();
const adminRouter = createAdminRouter(pool, tokenService);
const operationalRouter = createOperationalRouter(
  pool, tokenService, realtime, config.geoapifyApiKey, config.firebaseProjectId,
);
const provisioningRouter = config.provisioningSecret
  ? createProvisionamentoRouter(new ProvisionamentoService(pool), config.provisioningSecret)
  : undefined;
const masterTokens = new MasterTokenService(config.jwtAccessSecret);
const masterRouter = createMasterRouter(
  new MasterService(pool, masterTokens, new ProvisionamentoService(pool)), masterTokens,
);
const app = createApp({
  config, logger, pool, auth: authService, tokens: tokenService, adminRouter, operationalRouter,
  provisioningRouter, masterRouter,
});
const server = createServer(app);
const socketRideService = new CorridaService(pool, new AuditRepository(pool));
const socketLocationService = new LocalizacaoService(pool, socketRideService, realtime);
const io = attachSocketServer(server, config, tokenService, socketLocationService, realtime, logger);

async function start(): Promise<void> {
  await ensureInitialMaster(pool, config.masterBootstrapUsername, config.masterBootstrapPasswordHash);
  server.listen(config.port, () => {
    logger.info({ port: config.port, environment: config.nodeEnv }, 'API ADM Taxi iniciada');
  });
}

void start().catch(async (error: unknown) => {
  logger.fatal({ err: error }, 'Falha ao iniciar API');
  await pool.end();
  process.exitCode = 1;
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Encerrando API');
  io.disconnectSockets(true);
  server.close(async (error) => {
    await pool.end();
    if (error) {
      logger.error({ err: error }, 'Erro ao encerrar servidor');
      process.exitCode = 1;
    }
  });
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
