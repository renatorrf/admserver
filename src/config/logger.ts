import pino from 'pino';

import type { AppConfig } from './env';

export function createLogger(config: Pick<AppConfig, 'logLevel' | 'nodeEnv'>): pino.Logger {
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
    ...(config.nodeEnv === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } } }
      : {}),
  });
}
