import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { authenticatedRateKey } from '../src/shared/http/rate-key';
import { TokenService } from '../src/modules/auth/token-service';
import { createAuthRouter } from '../src/modules/auth/auth.routes';
import type { AuthApplication } from '../src/modules/auth/auth.service';

const tokens = new TokenService({ jwtAccessSecret: 'test-only-access-secret-at-least-32-chars', jwtRefreshSecret: 'test-only-refresh-secret-at-least-32-chars', jwtAccessExpiresInSeconds: 900, jwtRefreshExpiresInSeconds: 3600 });
const auth = { empresaId: '11111111-1111-4111-8111-111111111111', usuarioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', perfil: 'GESTOR' as const };

describe('limites de requisicoes para o piloto', () => {
  it('separa usuarios da mesma rede e nao aceita identidade nao assinada', () => {
    const key = authenticatedRateKey(tokens);
    const req = (token: string) => ({ header: () => `Bearer ${token}`, ip: '127.0.0.1' }) as unknown as express.Request;
    const first = key(req(tokens.issueTokens(auth).accessToken));
    const second = key(req(tokens.issueTokens({ ...auth, usuarioId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }).accessToken));
    expect(first).not.toBe(second);
    expect(first).toBe(`usuario:${auth.empresaId}:${auth.usuarioId}`);
    expect(key(req('forged'))).toBe('ip:127.0.0.1');
  });
  it('nao compartilha a cota de dez logins com renovacoes legitimas', async () => {
    const refresh = vi.fn().mockResolvedValue({ accessToken: 'fixture' });
    const app = express();
    app.use(express.json(), createAuthRouter({ refresh } as unknown as AuthApplication, tokens));
    const refreshToken = tokens.issueTokens(auth).refreshToken;
    for (let i = 0; i < 12; i++) {
      expect((await request(app).post('/refresh').send({ refreshToken })).status).toBe(200);
    }
    expect(refresh).toHaveBeenCalledTimes(12);
  });
});
