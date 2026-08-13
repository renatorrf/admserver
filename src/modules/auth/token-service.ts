import { createHash, randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';
import { z } from 'zod';

import type { AppConfig } from '../../config/env';
import { unauthorized } from '../../shared/errors/app-error';
import { perfisUsuario, type AuthContext, type RefreshTokenRecord } from './auth.types';

const tokenPayloadSchema = z.object({
  sub: z.string().uuid(),
  empresaId: z.string().uuid(),
  perfil: z.enum(perfisUsuario),
  tipo: z.enum(['access', 'refresh']),
  exp: z.number().int().positive(),
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
  constructor(private readonly config: TokenConfig) {}

  issueTokens(auth: AuthContext): IssuedTokens {
    const refreshId = randomUUID();
    const accessToken = jwt.sign(
      { sub: auth.usuarioId, empresaId: auth.empresaId, perfil: auth.perfil, tipo: 'access' },
      this.config.jwtAccessSecret,
      {
        expiresIn: this.config.jwtAccessExpiresInSeconds,
        issuer: 'adm-taxi',
        audience: 'adm-taxi-api',
      },
    );
    const refreshToken = jwt.sign(
      { sub: auth.usuarioId, empresaId: auth.empresaId, perfil: auth.perfil, tipo: 'refresh' },
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
      auth: { usuarioId: payload.sub, empresaId: payload.empresaId, perfil: payload.perfil },
      expiresAt: new Date(payload.exp * 1000),
    };
  }

  verifyRefresh(token: string): AuthContext {
    const payload = this.verify(token, this.config.jwtRefreshSecret, 'refresh');
    return { usuarioId: payload.sub, empresaId: payload.empresaId, perfil: payload.perfil };
  }

  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
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
