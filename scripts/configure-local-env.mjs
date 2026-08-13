import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const envPath = path.resolve('.env');

function parseEnv(contents) {
  return Object.fromEntries(contents
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
}

function existingOrRandom(current, key) {
  return current[key]?.length >= 32 ? current[key] : randomBytes(48).toString('base64url');
}

function configuredOrigins(current) {
  const origins = new Set((current.APP_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean));
  ['http://localhost:8100', 'http://localhost:8101', 'http://127.0.0.1:8101', 'http://localhost:4200']
    .forEach((origin) => origins.add(origin));
  return [...origins].join(',');
}

const current = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
const databaseUrl = process.env.DATABASE_URL || current.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('Defina DATABASE_URL no ambiente antes de configurar o .env local.');
}

const values = {
  NODE_ENV: current.NODE_ENV || 'development',
  PORT: current.PORT || '3000',
  DATABASE_URL: databaseUrl,
  APP_ORIGINS: configuredOrigins(current),
  JWT_ACCESS_SECRET: existingOrRandom(current, 'JWT_ACCESS_SECRET'),
  JWT_REFRESH_SECRET: existingOrRandom(current, 'JWT_REFRESH_SECRET'),
  JWT_ACCESS_EXPIRES_IN_SECONDS: current.JWT_ACCESS_EXPIRES_IN_SECONDS || '900',
  JWT_REFRESH_EXPIRES_IN_SECONDS: current.JWT_REFRESH_EXPIRES_IN_SECONDS || '2592000',
  LOG_LEVEL: current.LOG_LEVEL || 'debug',
  TRUST_PROXY: current.TRUST_PROXY || 'false',
  PROVISIONING_SECRET: existingOrRandom(current, 'PROVISIONING_SECRET'),
  ...(current.MASTER_BOOTSTRAP_USERNAME ? { MASTER_BOOTSTRAP_USERNAME: current.MASTER_BOOTSTRAP_USERNAME } : {}),
  ...(current.MASTER_BOOTSTRAP_PASSWORD_HASH ? { MASTER_BOOTSTRAP_PASSWORD_HASH: current.MASTER_BOOTSTRAP_PASSWORD_HASH } : {}),
};

const contents = [
  '# Arquivo local ignorado pelo Git. Nao compartilhe os valores.',
  ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
  '',
].join('\n');

writeFileSync(envPath, contents, { encoding: 'utf8', mode: 0o600 });
console.log('.env local configurado sem exibir credenciais.');
