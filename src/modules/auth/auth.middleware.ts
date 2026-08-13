import type { Request, RequestHandler } from 'express';

import { forbidden, unauthorized } from '../../shared/errors/app-error';
import type { PerfilUsuario } from './auth.types';
import type { TokenService } from './token-service';

export function createAuthenticate(tokens: TokenService): RequestHandler {
  return (request, _response, next) => {
    const authorization = request.header('authorization');
    const [scheme, token] = authorization?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) {
      next(unauthorized());
      return;
    }

    try {
      request.auth = tokens.verifyAccess(token);
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function authorize(...allowedProfiles: PerfilUsuario[]): RequestHandler {
  return (request, _response, next) => {
    if (!request.auth) {
      next(unauthorized());
      return;
    }
    if (!allowedProfiles.includes(request.auth.perfil)) {
      next(forbidden());
      return;
    }
    next();
  };
}

export function requireAuthContext(request: Request): NonNullable<Request['auth']> {
  if (!request.auth) {
    throw unauthorized();
  }
  return request.auth;
}
