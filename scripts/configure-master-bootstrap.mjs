import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import argon2 from 'argon2';

const password = process.env.MASTER_BOOTSTRAP_PASSWORD;
if (!password || password.length < 12) {
  throw new Error('Defina MASTER_BOOTSTRAP_PASSWORD com ao menos 12 caracteres apenas nesta execucao.');
}

const envPath = path.resolve('.env');
if (!existsSync(envPath)) throw new Error('Arquivo .env nao encontrado. Execute npm run env:configure primeiro.');
const lines = readFileSync(envPath, 'utf8').split(/\r?\n/)
  .filter((line) => !line.startsWith('MASTER_BOOTSTRAP_USERNAME=') && !line.startsWith('MASTER_BOOTSTRAP_PASSWORD_HASH='));
const hash = await argon2.hash(password, { type: argon2.argon2id });
lines.push('MASTER_BOOTSTRAP_USERNAME=master', `MASTER_BOOTSTRAP_PASSWORD_HASH=${hash}`, '');
writeFileSync(envPath, lines.join('\n'), { encoding: 'utf8', mode: 0o600 });
console.log('Bootstrap master configurado com hash Argon2id; a senha nao foi gravada.');
