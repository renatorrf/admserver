import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';

import { asyncHandler } from '../../shared/http/async-handler';
import { validateBody } from '../../shared/validation/validate';
import { AuthController } from './auth.controller';
import { createAuthenticate } from './auth.middleware';
import { loginSchema, refreshSchema } from './auth.schemas';
import type { AuthApplication } from './auth.service';
import type { TokenService } from './token-service';

export function createAuthRouter(auth: AuthApplication, tokens: TokenService): Router {
  const router = Router();
  const controller = new AuthController(auth);
  const authenticate = createAuthenticate(tokens);
  const sensitiveRouteLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      erro: { codigo: 'MUITAS_TENTATIVAS', mensagem: 'Aguarde alguns minutos antes de tentar novamente.' },
    },
  });

  router.get('/empresas', asyncHandler(controller.companies));
  router.post('/login', sensitiveRouteLimiter, validateBody(loginSchema), asyncHandler(controller.login));
  router.post('/refresh', sensitiveRouteLimiter, validateBody(refreshSchema), asyncHandler(controller.refresh));
  router.post('/logout', validateBody(refreshSchema), asyncHandler(controller.logout));
  router.get('/me', authenticate, asyncHandler(controller.me));

  return router;
}
