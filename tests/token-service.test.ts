import { describe, expect, it } from 'vitest';

import { TokenService } from '../src/modules/auth/token-service';

const service = new TokenService({
  jwtAccessSecret: 'access-secret-used-only-for-automated-tests-123',
  jwtRefreshSecret: 'refresh-secret-used-only-for-automated-tests-456',
  jwtAccessExpiresInSeconds: 900,
  jwtRefreshExpiresInSeconds: 3600,
});

const context = {
  usuarioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  empresaId: '11111111-1111-4111-8111-111111111111',
  perfil: 'GERENTE' as const,
};

describe('TokenService', () => {
  it('preserva o contexto confiavel no access token', () => {
    const issued = service.issueTokens(context);
    expect(service.verifyAccess(issued.accessToken)).toEqual(context);
    expect(issued.refreshRecord.tokenHash).toHaveLength(64);
    expect(issued.refreshRecord).not.toHaveProperty('refreshToken');
  });

  it('nao aceita refresh token como access token', () => {
    const issued = service.issueTokens(context);
    expect(() => service.verifyAccess(issued.refreshToken)).toThrow('Sessao invalida ou expirada.');
  });
});
