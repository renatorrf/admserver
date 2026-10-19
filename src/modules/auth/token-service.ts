import { createHash, randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';
import { z } from 'zod';

import type { AppConfig } from '../../config/env';
import { AppError, unauthorized } from '../../shared/errors/app-error';
import { perfisUsuario, type AuthContext, type RefreshTokenRecord } from './auth.types';

const tokenPayloadSchema = z.object({
  sub: z.string().uuid(),
  empresaId: z.string().uuid(),
  perfil: z.enum(perfisUsuario),
  tipo: z.enum(['access', 'refresh']),
  exp: z.number().int().positive(),
  senhaVersao: z.number().int().nonnegative().optional(),
  deveAlterarSenha: z.boolean().optional(),
});

type TokenConfig = Pick<
  AppConfig,
  'jwtAccessSecret' | 'jwtRefreshSecret' | 'jwtAccessExpiresInSeconds' | 'jwtRefreshExpiresInSeconds'
>;

export type IssuedTokens = {
  accessToken: string;
  refreshToken: string;
  refreshRecord: RefreshTokenRecord;
};

export type VerifiedAccessSession = {
  auth: AuthContext;
  expiresAt: Date;
};

export class TokenService {
  constructor(
    private readonly config: TokenConfig,
    private readonly accessAllowed?: (auth: AuthContext) => Promise<boolean>,
  ) {}

  async authenticateAccess(token: string, allowPasswordChange = false): Promise<AuthContext> {
    const auth = this.verifyAccess(token);
    if (this.accessAllowed && !await this.accessAllowed(auth)) {
      throw unauthorized('Conta bloqueada ou perfil alterado. Entre novamente.');
    }
    if (auth.deveAlterarSenha && !allowPasswordChange) {
      throw new AppError(403, 'TROCA_SENHA_OBRIGATORIA', 'Defina uma nova senha para continuar.');
    }
    return auth;
  }

  issueTokens(auth: AuthContext): IssuedTokens {
    const refreshId = randomUUID();
    const accessToken = jwt.sign(
      { sub: auth.usuarioId, empresaId: auth.empresaId, perfil: auth.perfil, tipo: 'access',
        senhaVersao: auth.senhaVersao, deveAlterarSenha: auth.deveAlterarSenha },
      this.config.jwtAccessSecret,
      {
        expiresIn: this.config.jwtAccessExpiresInSeconds,
        issuer: 'adm-taxi',
        audience: 'adm-taxi-api',
      },
    );
    const refreshToken = jwt.sign(
      { sub: auth.usuarioId, empresaId: auth.empresaId, perfil: auth.perfil, tipo: 'refresh',
        senhaVersao: auth.senhaVersao, deveAlterarSenha: auth.deveAlterarSenha },
      this.config.jwtRefreshSecret,
      {
        expiresIn: this.config.jwtRefreshExpiresInSeconds,
        issuer: 'adm-taxi',
        audience: 'adm-taxi-api',
        jwtid: refreshId,
      },
    );

    return {
      accessToken,
      refreshToken,
      refreshRecord: {
        id: refreshId,
        usuarioId: auth.usuarioId,
        empresaId: auth.empresaId,
        tokenHash: this.hash(refreshToken),
        expiraEm: new Date(Date.now() + this.config.jwtRefreshExpiresInSeconds * 1000),
      },
    };
  }

  verifyAccess(token: string): AuthContext {
    return this.verifyAccessSession(token).auth;
  }

  verifyAccessSession(token: string): VerifiedAccessSession {
    const payload = this.verify(token, this.config.jwtAccessSecret, 'access');
    return {
      auth: { usuarioId: payload.sub, empresaId: payload.empresaId, perfil: payload.perfil,
        ...(payload.senhaVersao === undefined ? {} : { senhaVersao: payload.senhaVersao }),
        ...(payload.deveAlterarSenha === undefined ? {} : { deveAlterarSenha: payload.deveAlterarSenha }) },
      expiresAt: new Date(payload.exp * 1000),
    };
  }

  verifyRefresh(token: string): AuthContext {
    const payload = this.verify(token, this.config.jwtRefreshSecret, 'refresh');
    return { usuarioId: payload.sub, empresaId: payload.empresaId, perfil: payload.perfil,
      ...(payload.senhaVersao === undefined ? {} : { senhaVersao: payload.senhaVersao }),
      ...(payload.deveAlterarSenha === undefined ? {} : { deveAlterarSenha: payload.deveAlterarSenha }) };
  }

  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  issueCompanySelection(accountId: string, version: number): string {
    return jwt.sign({ sub: accountId, versao: version, tipo: 'company-selection' }, this.config.jwtAccessSecret,
      { expiresIn: 300, issuer: 'adm-taxi', audience: 'adm-taxi-company-selection', jwtid: randomUUID() });
  }

  verifyCompanySelection(token: string): { sub: string; versao: number } {
    try {
      return z.object({ sub: z.string().uuid(), versao: z.number().int().nonnegative(), tipo: z.literal('company-selection') })
        .parse(jwt.verify(token, this.config.jwtAccessSecret, { algorithms: ['HS256'], issuer: 'adm-taxi', audience: 'adm-taxi-company-selection' }));
    } catch { throw unauthorized('Selecao expirada. Informe seu email e senha novamente.'); }
  }

  private verify(token: string, secret: string, expectedType: 'access' | 'refresh'): z.infer<typeof tokenPayloadSchema> {
    try {
      const decoded = jwt.verify(token, secret, { issuer: 'adm-taxi', audience: 'adm-taxi-api' });
      const payload = tokenPayloadSchema.parse(decoded);
      if (payload.tipo !== expectedType) {
        throw unauthorized('Sessao invalida ou expirada.');
      }
      return payload;
    } catch {
      throw unauthorized('Sessao invalida ou expirada.');
    }
  }
}
