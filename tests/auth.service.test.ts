import { describe, expect, it } from 'vitest';

import type { AuthRepository } from '../src/modules/auth/auth.repository';
import { AuthService, type PasswordVerifier } from '../src/modules/auth/auth.service';
import type { AuthContext, AuthUserRecord, RefreshTokenRecord } from '../src/modules/auth/auth.types';
import { TokenService } from '../src/modules/auth/token-service';

const EMPRESA_A = '11111111-1111-4111-8111-111111111111';
const EMPRESA_B = '22222222-2222-4222-8222-222222222222';
const USUARIO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USUARIO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

class InMemoryAuthRepository implements AuthRepository {
  readonly refreshTokens = new Map<string, RefreshTokenRecord>();
  readonly revokedHashes = new Set<string>();

  constructor(readonly users: Array<AuthUserRecord & { empresaCodigo: string }>) {}

  listActiveCompanies() {
    return Promise.resolve(this.users.map((user) => ({
      codigoAcesso: user.empresaCodigo,
      nomeFantasia: user.empresaCodigo,
    })));
  }

  findByEmail(email: string, empresaCodigo: string): Promise<AuthUserRecord | null> {
    return Promise.resolve(
      this.users.find((user) => user.email === email && user.empresaCodigo === empresaCodigo) ?? null,
    );
  }

  findById(auth: AuthContext): Promise<AuthUserRecord | null> {
    return Promise.resolve(
      this.users.find((user) => user.usuarioId === auth.usuarioId && user.empresaId === auth.empresaId) ?? null,
    );
  }

  saveRefreshToken(record: RefreshTokenRecord): Promise<void> {
    this.refreshTokens.set(record.tokenHash, record);
    return Promise.resolve();
  }

  rotateRefreshToken<T>(
    currentHash: string,
    auth: AuthContext,
    createNext: (user: AuthUserRecord) => { record: RefreshTokenRecord; value: T },
  ): Promise<{ user: AuthUserRecord; value: T } | null> {
    const current = this.refreshTokens.get(currentHash);
    if (
      !current
      || this.revokedHashes.has(currentHash)
      || current.usuarioId !== auth.usuarioId
      || current.empresaId !== auth.empresaId
    ) {
      return Promise.resolve(null);
    }
    const user = this.users.find((item) => item.usuarioId === auth.usuarioId && item.empresaId === auth.empresaId);
    if (!user) {
      return Promise.resolve(null);
    }
    const next = createNext(user);
    this.revokedHashes.add(currentHash);
    this.refreshTokens.set(next.record.tokenHash, next.record);
    return Promise.resolve({ user, value: next.value });
  }

  revokeRefreshToken(tokenHash: string): Promise<void> {
    this.revokedHashes.add(tokenHash);
    return Promise.resolve();
  }

  updateLastAccess(): Promise<void> {
    return Promise.resolve();
  }
}

const passwordVerifier: PasswordVerifier = {
  verify: (hash, plainText) => Promise.resolve(hash === `hash:${plainText}`),
};

const tokenService = new TokenService({
  jwtAccessSecret: 'access-secret-used-only-for-automated-tests-123',
  jwtRefreshSecret: 'refresh-secret-used-only-for-automated-tests-456',
  jwtAccessExpiresInSeconds: 900,
  jwtRefreshExpiresInSeconds: 3600,
});

function makeUser(overrides: Partial<AuthUserRecord> & { empresaCodigo: string }): AuthUserRecord & { empresaCodigo: string } {
  return {
    usuarioId: USUARIO_A,
    empresaId: EMPRESA_A,
    empresaCodigo: overrides.empresaCodigo,
    nome: 'Usuario Teste',
    email: 'usuario@exemplo.com',
    senhaHash: 'hash:senha-correta',
    perfil: 'GESTOR',
    ativo: true,
    empresaAtiva: true,
    ...overrides,
  };
}

describe('AuthService', () => {
  it('lista as empresas disponiveis para o login sem expor ids internos', async () => {
    const repository = new InMemoryAuthRepository([makeUser({ empresaCodigo: 'EMPRESA-A' })]);
    const service = new AuthService(repository, tokenService, passwordVerifier);

    await expect(service.listCompanies()).resolves.toEqual([
      { codigoAcesso: 'EMPRESA-A', nomeFantasia: 'EMPRESA-A' },
    ]);
  });

  it('seleciona a conta pela empresa e nunca retorna o hash da senha', async () => {
    const repository = new InMemoryAuthRepository([
      makeUser({ empresaCodigo: 'EMPRESA-A' }),
      makeUser({ empresaCodigo: 'EMPRESA-B', empresaId: EMPRESA_B, usuarioId: USUARIO_B, nome: 'Usuario B' }),
    ]);
    const service = new AuthService(repository, tokenService, passwordVerifier);

    const result = await service.login({ empresa: 'EMPRESA-B', email: 'usuario@exemplo.com', senha: 'senha-correta' });

    expect(result.usuario.empresaId).toBe(EMPRESA_B);
    expect(result.usuario.nome).toBe('Usuario B');
    expect(result).not.toHaveProperty('senhaHash');
    expect(repository.refreshTokens.size).toBe(1);
  });

  it('usa o mesmo erro para conta inexistente e senha incorreta', async () => {
    const repository = new InMemoryAuthRepository([makeUser({ empresaCodigo: 'EMPRESA-A' })]);
    const service = new AuthService(repository, tokenService, passwordVerifier);

    await expect(service.login({ empresa: 'INEXISTENTE', email: 'usuario@exemplo.com', senha: 'x' }))
      .rejects.toMatchObject({ statusCode: 401, message: 'E-mail ou senha invalidos.' });
    await expect(service.login({ empresa: 'EMPRESA-A', email: 'usuario@exemplo.com', senha: 'errada' }))
      .rejects.toMatchObject({ statusCode: 401, message: 'E-mail ou senha invalidos.' });
  });

  it('rotaciona o refresh token e bloqueia sua reutilizacao', async () => {
    const repository = new InMemoryAuthRepository([makeUser({ empresaCodigo: 'EMPRESA-A' })]);
    const service = new AuthService(repository, tokenService, passwordVerifier);
    const login = await service.login({ empresa: 'EMPRESA-A', email: 'usuario@exemplo.com', senha: 'senha-correta' });

    const refreshed = await service.refresh({ refreshToken: login.refreshToken });

    expect(refreshed.refreshToken).not.toBe(login.refreshToken);
    await expect(service.refresh({ refreshToken: login.refreshToken }))
      .rejects.toMatchObject({ statusCode: 401, code: 'NAO_AUTORIZADO' });
  });

  it('emite novos tokens com o perfil vigente no banco', async () => {
    const user = makeUser({ empresaCodigo: 'EMPRESA-A', perfil: 'GESTOR' });
    const repository = new InMemoryAuthRepository([user]);
    const service = new AuthService(repository, tokenService, passwordVerifier);
    const login = await service.login({ empresa: 'EMPRESA-A', email: user.email, senha: 'senha-correta' });
    user.perfil = 'GERENTE';

    const refreshed = await service.refresh({ refreshToken: login.refreshToken });

    expect(tokenService.verifyAccess(refreshed.accessToken).perfil).toBe('GERENTE');
    expect(refreshed.usuario.perfil).toBe('GERENTE');
  });

  it('nao permite buscar o usuario em outra empresa', async () => {
    const repository = new InMemoryAuthRepository([makeUser({ empresaCodigo: 'EMPRESA-A' })]);
    const service = new AuthService(repository, tokenService, passwordVerifier);

    await expect(service.getCurrentUser({ usuarioId: USUARIO_A, empresaId: EMPRESA_B, perfil: 'GESTOR' }))
      .rejects.toMatchObject({ statusCode: 401 });
  });
});
