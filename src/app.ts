import { randomUUID } from 'node:crypto';

import cors from 'cors';
import express, { type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import pinoHttp from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import type { Router } from 'express';

import type { AppConfig } from './config/env';
import { openApiDocument } from './docs/openapi';
import { createAuthRouter } from './modules/auth/auth.routes';
import type { AuthApplication } from './modules/auth/auth.service';
import type { TokenService } from './modules/auth/token-service';
import { AppError } from './shared/errors/app-error';
import { createErrorHandler, notFoundHandler } from './shared/http/error-handler';

export type AppDependencies = {
  config: AppConfig;
  logger: Logger;
  pool: Pick<Pool, 'query'>;
  auth: AuthApplication;
  tokens: TokenService;
  adminRouter?: Router;
  operationalRouter?: Router;
  provisioningRouter?: Router;
  masterRouter?: Router;
};

export function createApp(dependencies: AppDependencies): Express {
  const {
    config, logger, pool, auth, tokens, adminRouter, operationalRouter, provisioningRouter, masterRouter,
  } = dependencies;
  const app = express();

  app.disable('x-powered-by');
  app.disable('etag');
  app.set('trust proxy', config.trustProxy);
  app.use(pinoHttp({
    logger,
    genReqId: (request) => request.headers['x-request-id']?.toString() ?? randomUUID(),
  }));
  app.use(helmet());
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || config.appOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new AppError(403, 'ORIGEM_NAO_PERMITIDA', 'Origem nao permitida.'));
    },
    credentials: true,
  }));
  app.use(express.json({ limit: '100kb' }));
  app.use(rateLimit({
    windowMs: 60_000,
    limit: 200,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  }));
  app.use('/api/v1', (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/v1/health', (_request, response) => {
    response.status(200).json({ data: { status: 'ok' } });
  });
  app.get('/api/v1/ready', async (request, response) => {
    try {
      await pool.query('SELECT 1');
      response.status(200).json({ data: { status: 'ready' } });
    } catch (error) {
      request.log.warn({ err: error }, 'Banco de dados indisponivel');
      response.status(503).json({
        erro: { codigo: 'SERVICO_INDISPONIVEL', mensagem: 'Servico temporariamente indisponivel.' },
        requisicaoId: request.id,
      });
    }
  });

  app.use('/api/v1/auth', createAuthRouter(auth, tokens));
  if (masterRouter) app.use('/api/v1/master', masterRouter);
  if (provisioningRouter) app.use('/api/v1/provisionamento', provisioningRouter);
  if (operationalRouter) app.use('/api/v1', operationalRouter);
  if (adminRouter) app.use('/api/v1', adminRouter);
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument, { explorer: false }));
  app.get('/api/openapi.json', (_request, response) => response.json(openApiDocument));

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}
