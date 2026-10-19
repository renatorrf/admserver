import express from 'express';
import pino from 'pino';
import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import { createOperacaoRouter } from '../src/modules/operacao/operacao.routes';
import type { OperacaoService } from '../src/modules/operacao/operacao.service';
import { createAuthenticate } from '../src/modules/auth/auth.middleware';
import { TokenService } from '../src/modules/auth/token-service';
import { createErrorHandler } from '../src/shared/http/error-handler';

const tokens = new TokenService({ jwtAccessSecret: 'access-secret-test-only-with-more-than-32', jwtRefreshSecret: 'refresh-secret-test-only-with-more-than-32', jwtAccessExpiresInSeconds: 900, jwtRefreshExpiresInSeconds: 3600 });
const auth = { empresaId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', usuarioId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', perfil: 'GESTOR' as const };
const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const path = `/funcionarios/${id}/destinos-recentes`;
function setup() {
  const recentEmployeeDestinations = vi.fn().mockResolvedValue([]);
  const app = express();
  app.use(createAuthenticate(tokens), createOperacaoRouter({ recentEmployeeDestinations } as unknown as OperacaoService));
  app.use(createErrorHandler(pino({ level: 'silent' })));
  return { app, recentEmployeeDestinations };
}
describe('destinos recentes', () => {
  it('exige autenticacao e perfil administrativo', async () => {
    const { app, recentEmployeeDestinations } = setup();
    await request(app).get(path).expect(401);
    for (const perfil of ['FUNCIONARIO', 'PRESTADOR'] as const) await request(app).get(path).auth(tokens.issueTokens({ ...auth, perfil }).accessToken, { type: 'bearer' }).expect(403);
    expect(recentEmployeeDestinations).not.toHaveBeenCalled();
  });
  it('nao aceita empresa arbitraria nem identificador invalido', async () => {
    const { app, recentEmployeeDestinations } = setup(), token = tokens.issueTokens(auth).accessToken;
    await request(app).get(`${path}?empresaId=${auth.empresaId}`).auth(token, { type: 'bearer' }).expect(422);
    await request(app).get('/funcionarios/invalido/destinos-recentes').auth(token, { type: 'bearer' }).expect(422);
    expect(recentEmployeeDestinations).not.toHaveBeenCalled();
  });
  it.each(['GESTOR', 'GERENTE'] as const)('consulta somente no contexto autenticado de %s', async perfil => {
    const { app, recentEmployeeDestinations } = setup();
    const response = await request(app).get(path).auth(tokens.issueTokens({ ...auth, perfil }).accessToken, { type: 'bearer' }).expect(200);
    expect(response.body).toEqual({ data: [] });
    expect(recentEmployeeDestinations).toHaveBeenCalledWith(expect.objectContaining({ ...auth, perfil }), id);
  });
});
