import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true });

const booleanFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL e obrigatoria'),
  APP_ORIGINS: z.string().default('http://localhost:8100,http://localhost:4200'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET deve ter ao menos 32 caracteres'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET deve ter ao menos 32 caracteres'),
  JWT_ACCESS_EXPIRES_IN_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_EXPIRES_IN_SECONDS: z.coerce.number().int().positive().default(2_592_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: booleanFromString,
  PROVISIONING_SECRET: z.string().min(32, 'PROVISIONING_SECRET deve ter ao menos 32 caracteres').optional(),
  MASTER_BOOTSTRAP_USERNAME: z.string().min(3).max(50).optional(),
  MASTER_BOOTSTRAP_PASSWORD_HASH: z.string().min(20).optional(),
});

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  appOrigins: string[];
  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  jwtAccessExpiresInSeconds: number;
  jwtRefreshExpiresInSeconds: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  trustProxy: boolean;
  provisioningSecret?: string;
  masterBootstrapUsername?: string;
  masterBootstrapPasswordHash?: string;
};

let cachedConfig: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Configuracao de ambiente invalida: ${fields}`);
  }

  cachedConfig = {
    nodeEnv: parsed.data.NODE_ENV,
    port: parsed.data.PORT,
    databaseUrl: parsed.data.DATABASE_URL,
    appOrigins: parsed.data.APP_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
    jwtAccessSecret: parsed.data.JWT_ACCESS_SECRET,
    jwtRefreshSecret: parsed.data.JWT_REFRESH_SECRET,
    jwtAccessExpiresInSeconds: parsed.data.JWT_ACCESS_EXPIRES_IN_SECONDS,
    jwtRefreshExpiresInSeconds: parsed.data.JWT_REFRESH_EXPIRES_IN_SECONDS,
    logLevel: parsed.data.LOG_LEVEL,
    trustProxy: parsed.data.TRUST_PROXY,
    provisioningSecret: parsed.data.PROVISIONING_SECRET,
    masterBootstrapUsername: parsed.data.MASTER_BOOTSTRAP_USERNAME,
    masterBootstrapPasswordHash: parsed.data.MASTER_BOOTSTRAP_PASSWORD_HASH,
  };

  return cachedConfig;
}

export function resetConfigForTests(): void {
  cachedConfig = undefined;
}

export function getDatabaseUrl(): string {
  const result = z.string().min(1, 'DATABASE_URL e obrigatoria').safeParse(process.env.DATABASE_URL);
  if (!result.success) {
    throw new Error('DATABASE_URL nao foi definida.');
  }
  return result.data;
}
