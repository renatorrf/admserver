import type { Request } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import type { TokenService } from '../../modules/auth/token-service';

export function authenticatedRateKey(tokens: TokenService, kind: 'access' | 'refresh' = 'access') {
  return (request: Request): string => {
    try {
      const [scheme, bearer] = request.header('authorization')?.split(' ') ?? [];
      const token = kind === 'refresh' ? request.body?.refreshToken : scheme === 'Bearer' ? bearer : undefined;
      if (typeof token === 'string') {
        const auth = kind === 'refresh' ? tokens.verifyRefresh(token) : tokens.verifyAccess(token);
        return `usuario:${auth.empresaId}:${auth.usuarioId}`;
      }
    } catch { /* Invalid tokens share the anonymous IP bucket, never an unverified identity. */ }
    return `ip:${ipKeyGenerator(request.ip ?? '0.0.0.0')}`;
  };
}
