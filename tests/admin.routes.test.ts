import type { Pool } from 'pg';
import pino from 'pino';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import type { AppConfig } from '../src/config/env';
import { createAdminRouter } from '../src/modules/admin/admin.routes';
import type { AuthApplication } from '../src/modules/auth/auth.service';
import { TokenService } from '../src/modules/auth/token-service';

const config: AppConfig = {
  nodeEnv: 'test', port: 3000, databaseUrl: 'postgres://unused', appOrigins: [],
  jwtAccessSecret: 'access-secret-used-only-for-automated-tests-123',
  jwtRefreshSecret: 'refresh-secret-used-only-for-automated-tests-456',
  jwtAccessExpiresInSeconds: 900, jwtRefreshExpiresInSeconds: 3600,
  logLevel: 'silent', trustProxy: false,
};
const tokens = new TokenService(config);
const pool = { query: vi.fn(), connect: vi.fn() } as unknown as Pool;
const auth = {
  login: vi.fn(), refresh: vi.fn(), logout: vi.fn(), getCurrentUser: vi.fn(),
} as unknown as AuthApplication;

function app() {
  return createApp({
    config, logger: pino({ level: 'silent' }), pool, auth, tokens,
    adminRouter: createAdminRouter(pool, tokens),
  });
}

describe('rotas administrativas', () => {
  beforeEach(() => vi.clearAllMocks());

  it('bloqueia gerente antes de consultar o banco', async () => {
    const token = tokens.issueTokens({
      usuarioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      empresaId: '11111111-1111-4111-8111-111111111111',
      perfil: 'GERENTE',
    }).accessToken;

    const response = await request(app()).get('/api/v1/usuarios').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(403);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('controle_acesso'), expect.any(Array));
    expect(pool.query).not.toHaveBeenCalledWith(expect.stringContaining('SELECT'), expect.anything());
  });

  it('rejeita empresa_id informado pelo cliente', async () => {
    const token = tokens.issueTokens({
      usuarioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      empresaId: '11111111-1111-4111-8111-111111111111',
      perfil: 'GESTOR',
    }).accessToken;

    const response = await request(app())
      .get('/api/v1/usuarios?empresaId=22222222-2222-4222-8222-222222222222')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(422);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('nao disponibiliza exclusao fisica', async () => {
    const token = tokens.issueTokens({
      usuarioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      empresaId: '11111111-1111-4111-8111-111111111111',
      perfil: 'GESTOR',
    }).accessToken;

    const response = await request(app())
      .delete('/api/v1/usuarios/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(404);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
