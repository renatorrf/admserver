import express from 'express';
import pino from 'pino';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import type { AppConfig } from '../src/config/env';
import { authorize, createAuthenticate } from '../src/modules/auth/auth.middleware';
import type { AuthApplication } from '../src/modules/auth/auth.service';
import { TokenService } from '../src/modules/auth/token-service';

const config: AppConfig = {
  nodeEnv: 'test',
  port: 3000,
  databaseUrl: 'postgres://unused-in-tests',
  appOrigins: ['http://localhost:8100'],
  jwtAccessSecret: 'access-secret-used-only-for-automated-tests-123',
  jwtRefreshSecret: 'refresh-secret-used-only-for-automated-tests-456',
  jwtAccessExpiresInSeconds: 900,
  jwtRefreshExpiresInSeconds: 3600,
  logLevel: 'silent',
  trustProxy: false,
};
const tokens = new TokenService(config);
const context = {
  usuarioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  empresaId: '11111111-1111-4111-8111-111111111111',
  perfil: 'GERENTE' as const,
};

function createAuthMock(): AuthApplication {
  return {
    listCompanies: vi.fn().mockResolvedValue([
      { codigoAcesso: 'EMPRESA-A', nomeFantasia: 'Empresa A' },
    ]),
    login: vi.fn().mockResolvedValue({ ok: true }),
    refresh: vi.fn().mockResolvedValue({ ok: true }),
    logout: vi.fn().mockResolvedValue(undefined),
    getCurrentUser: vi.fn().mockResolvedValue({ ...context, nome: 'Gerente', email: 'gerente@exemplo.com' }),
  } as unknown as AuthApplication;
}

describe('API HTTP', () => {
  it('nao permite cache condicional nas respostas dinamicas da API', async () => {
    const app = createApp({
      config,
      logger: pino({ level: 'silent' }),
      pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
      auth: createAuthMock(),
      tokens,
    });

    const first = await request(app).get('/api/v1/health');
    const second = await request(app).get('/api/v1/health').set('If-None-Match', 'W/"valor-antigo"');

    expect(first.status).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.headers.etag).toBeUndefined();
    expect(second.status).toBe(200);
  });

  it('aceita X-Forwarded-For quando existe exatamente um proxy confiavel', async () => {
    const app = createApp({
      config: { ...config, trustProxy: 1 },
      logger: pino({ level: 'silent' }),
      pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
      auth: createAuthMock(),
      tokens,
    });

    const response = await request(app)
      .get('/api/v1/health')
      .set('X-Forwarded-For', '203.0.113.10');

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('ok');
  });

  it('lista somente os dados necessarios para selecionar a empresa no login', async () => {
    const app = createApp({
      config,
      logger: pino({ level: 'silent' }),
      pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
      auth: createAuthMock(),
      tokens,
    });

    const response = await request(app).get('/api/v1/auth/empresas');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([
      { codigoAcesso: 'EMPRESA-A', nomeFantasia: 'Empresa A' },
    ]);
    expect(response.body.data[0]).not.toHaveProperty('id');
  });

  it('valida o payload de login em portugues', async () => {
    const app = createApp({
      config,
      logger: pino({ level: 'silent' }),
      pool: { query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) },
      auth: createAuthMock(),
      tokens,
    });

    const response = await request(app).post('/api/v1/auth/login').send({ email: 'invalido', senha: '' });

    expect(response.status).toBe(422);
    expect(response.body.erro).toMatchObject({ codigo: 'DADOS_INVALIDOS', mensagem: 'Revise os dados informados.' });
    expect(JSON.stringify(response.body)).not.toContain('senhaHash');
  });

  it('retorna 400 para JSON malformado sem expor detalhes internos', async () => {
    const app = createApp({
      config,
      logger: pino({ level: 'silent' }),
      pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
      auth: createAuthMock(),
      tokens,
    });

    const response = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"empresa":');

    expect(response.status).toBe(400);
    expect(response.body.erro).toEqual({
      codigo: 'JSON_INVALIDO',
      mensagem: 'O corpo da requisicao contem JSON invalido.',
    });
  });

  it('recupera o perfil usando somente o contexto do bearer token', async () => {
    const auth = createAuthMock();
    const app = createApp({
      config,
      logger: pino({ level: 'silent' }),
      pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
      auth,
      tokens,
    });
    const accessToken = tokens.issueTokens(context).accessToken;

    const response = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${accessToken}`);

    expect(response.status).toBe(200);
    expect(auth.getCurrentUser).toHaveBeenCalledWith(context);
    expect(response.body.data.empresaId).toBe(context.empresaId);
  });

  it('bloqueia um perfil fora da lista permitida', async () => {
    const app = express();
    app.get('/gestor', createAuthenticate(tokens), authorize('GESTOR'), (_request, response) => response.sendStatus(204));
    const accessToken = tokens.issueTokens(context).accessToken;

    const response = await request(app).get('/gestor').set('Authorization', `Bearer ${accessToken}`);

    expect(response.status).toBe(403);
  });
});
