import { createRequire } from 'node:module';
import pino from 'pino';

import type { AppConfig } from './env';

export function createLogger(config: Pick<AppConfig, 'logLevel' | 'nodeEnv'>): pino.Logger {
  let prettyTarget: string | undefined;
  if (config.nodeEnv === 'development' && process.stdout.isTTY && !process.env.K_SERVICE) {
    try {
      prettyTarget = createRequire(__filename).resolve('pino-pretty');
    } catch {
      // Pretty output is optional; production-only installs must still start.
    }
  }
  return pino({
    level: config.logLevel,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers.x-provisioning-secret',
        'res.headers.set-cookie',
        'password',
        'senha',
        'senhaHash',
        'token',
        'refreshToken',
        'DATABASE_URL',
      ],
      censor: '[REMOVIDO]',
    },
    ...(prettyTarget
      ? { transport: { target: prettyTarget, options: { colorize: true, translateTime: 'SYS:standard' } } }
      : {}),
  });
}
