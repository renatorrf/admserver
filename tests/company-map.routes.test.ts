import type { Pool } from 'pg';
import pino from 'pino';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import type { AppConfig } from '../src/config/env';
import type { AuthApplication } from '../src/modules/auth/auth.service';
import type { PerfilUsuario } from '../src/modules/auth/auth.types';
import { TokenService } from '../src/modules/auth/token-service';
import { createOperationalRouter } from '../src/modules/corridas/operational.routes';

const config: AppConfig = {
  nodeEnv: 'test', port: 3000, databaseUrl: 'postgres://unused', appOrigins: [],
  jwtAccessSecret: 'access-secret-used-only-for-automated-tests-123',
  jwtRefreshSecret: 'refresh-secret-used-only-for-automated-tests-456',
  jwtAccessExpiresInSeconds: 900, jwtRefreshExpiresInSeconds: 3600,
  logLevel: 'silent', trustProxy: false,
};
const tokens = new TokenService(config);
const query = vi.fn();
const pool = { query, connect: vi.fn() } as unknown as Pool;
const empresaId = '11111111-1111-4111-8111-111111111111';
const path = '/api/v1/operacao/localizacao-padrao';
const app = createApp({
  config, logger: pino({ level: 'silent' }), pool, tokens, auth: {} as AuthApplication,
  operationalRouter: createOperationalRouter(pool, tokens),
});

describe('Company map location route', () => {
  beforeEach(() => {
    query.mockReset().mockResolvedValue({ rows: [{ latitude_padrao: '-18.91', longitude_padrao: '-48.27' }] });
  });

  it('exige autenticacao', async () => {
    expect((await request(app).get(path)).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it.each<PerfilUsuario>(['GESTOR', 'GERENTE', 'FUNCIONARIO', 'PRESTADOR'])('retorna somente coordenadas para %s', async perfil => {
    const token = tokens.issueTokens({ empresaId, usuarioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', perfil }).accessToken;
    const response = await request(app).get(path).set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { latitudePadrao: -18.91, longitudePadrao: -48.27 } });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1 AND ativo = TRUE'), [empresaId]);
  });

  it('nao permite selecionar outra empresa pelo cliente', async () => {
    const token = tokens.issueTokens({ empresaId, usuarioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', perfil: 'GESTOR' }).accessToken;
    const response = await request(app).get(`${path}?empresaId=22222222-2222-4222-8222-222222222222`)
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(422);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([[-18.923, -48.281], [0, 0]])('prioriza o endereco cadastrado (%s, %s)', async (latitude, longitude) => {
    query.mockResolvedValue({ rows: [{ latitude_padrao: '-23.55', longitude_padrao: '-46.63',
      endereco: 'Rua da empresa, 10', endereco_latitude: String(latitude), endereco_longitude: String(longitude) }] });
    const token = tokens.issueTokens({ empresaId, usuarioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', perfil: 'GESTOR' }).accessToken;
    const response = await request(app).get(path).set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { latitudePadrao: latitude, longitudePadrao: longitude } });
  });

  it.each([
    { endereco: null, endereco_latitude: '-19', endereco_longitude: '-48' },
    { endereco: 'Rua A', endereco_latitude: null, endereco_longitude: '-48' },
    { endereco: 'Rua A', endereco_latitude: '-19', endereco_longitude: null },
    { endereco: 'Rua A', endereco_latitude: '91', endereco_longitude: '-48' },
    { endereco: 'Rua A', endereco_latitude: '-19', endereco_longitude: '181' },
    { endereco: 'Rua A', endereco_latitude: 'NaN', endereco_longitude: '-48' },
  ])('usa o par padrao completo se o endereco for incompleto ou invalido: %j', async address => {
    query.mockResolvedValue({ rows: [{ latitude_padrao: '-18.91', longitude_padrao: '-48.27', ...address }] });
    const token = tokens.issueTokens({ empresaId, usuarioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', perfil: 'GESTOR' }).accessToken;
    const response = await request(app).get(path).set('Authorization', `Bearer ${token}`);
    expect(response.body).toEqual({ data: { latitudePadrao: -18.91, longitudePadrao: -48.27 } });
  });

  it('consulta novamente a empresa do token a cada acesso, sem reutilizar a anterior', async () => {
    const otherCompany = '22222222-2222-4222-8222-222222222222';
    query.mockImplementation(async (_sql, values) => ({ rows: [{ endereco: 'Endereco da empresa',
      endereco_latitude: values[0] === empresaId ? '-18.9' : '-22.9', endereco_longitude: '-48' }] }));
    for (const id of [empresaId, otherCompany]) {
      const token = tokens.issueTokens({ empresaId: id, usuarioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', perfil: 'GESTOR' }).accessToken;
      const response = await request(app).get(path).set('Authorization', `Bearer ${token}`);
      expect(response.body.data.latitudePadrao).toBe(id === empresaId ? -18.9 : -22.9);
      expect(query).toHaveBeenLastCalledWith(expect.stringContaining('WHERE id = $1 AND ativo = TRUE'), [id]);
    }
  });

  it('retorna nulos quando nao ha empresa ativa ou coordenadas cadastradas', async () => {
    const token = tokens.issueTokens({ empresaId, usuarioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', perfil: 'GESTOR' }).accessToken;
    for (const rows of [[], [{ latitude_padrao: null, longitude_padrao: null }]]) {
      query.mockResolvedValue({ rows });
      const response = await request(app).get(path).set('Authorization', `Bearer ${token}`);
      expect(response.body).toEqual({ data: { latitudePadrao: null, longitudePadrao: null } });
    }
  });
});
