import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';

import { asyncHandler } from '../../shared/http/async-handler';
import { validateBody } from '../../shared/validation/validate';
import { AuthController } from './auth.controller';
import { createAuthenticate } from './auth.middleware';
import { loginSchema, refreshSchema } from './auth.schemas';
import type { AuthApplication } from './auth.service';
import type { TokenService } from './token-service';
import { authenticatedRateKey } from '../../shared/http/rate-key';
import { requireAuthContext } from './auth.middleware';
import { changePasswordSchema, forgotPasswordSchema, resetPasswordSchema } from './password.schemas';
import { recoveryMessage, type PasswordService } from './password.service';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { ManagerLoginService } from './manager-login.service';
import type { DriverLoginService } from './driver-login.service';
import type { EmployeeLoginService } from './employee-login.service';
import type { TenantLoginService } from './tenant-login.service';
import { AppError, unauthorized } from '../../shared/errors/app-error';

export function createAuthRouter(auth: AuthApplication, tokens: TokenService, passwords?: PasswordService, managers?: ManagerLoginService, drivers?: DriverLoginService, employees?: EmployeeLoginService, tenants?: TenantLoginService): Router {
  const router = Router();
  const controller = new AuthController(auth);
  const authenticate = createAuthenticate(tokens, true);
  const sensitiveRouteLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      erro: { codigo: 'MUITAS_TENTATIVAS', mensagem: 'Aguarde alguns minutos antes de tentar novamente.' },
    },
  });
  const refreshLimiter = rateLimit({
    windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
    keyGenerator: authenticatedRateKey(tokens, 'refresh'),
    message: { erro: { codigo: 'MUITAS_TENTATIVAS', mensagem: 'Aguarde um minuto antes de renovar a sessao.' } },
  });

  router.get('/empresas', asyncHandler(controller.companies));
  if (drivers && managers) router.post('/acesso', sensitiveRouteLimiter, validateBody(loginSchema.omit({ empresa: true })), asyncHandler(async (req, res) => {
    const session = await drivers.identify(req.body);
    if (session) { res.json({ data: { sessao: session } }); return; }
    for (const service of [managers, employees, tenants].filter(service => service !== undefined)) {
      try {
        res.json({ data: await service.identify(req.body) });
        return;
      } catch (error) {
        if (!(error instanceof AppError) || error.statusCode !== 401) throw error;
      }
    }
    throw unauthorized('E-mail ou senha invalidos.');
  }));
  if (tenants) router.post('/empresa/selecionar', sensitiveRouteLimiter,
    validateBody(z.object({ selecaoToken: z.string().min(1).max(4096), empresaId: z.string().uuid() }).strict()), asyncHandler(async (req, res) => {
      res.json({ data: await tenants.select(req.body) });
    }));
  if (employees) router.post('/funcionario/empresa', sensitiveRouteLimiter,
    validateBody(z.object({ selecaoToken: z.string().min(1).max(4096), empresaId: z.string().uuid() }).strict()), asyncHandler(async (req, res) => {
      res.json({ data: await employees.select(req.body) });
    }));
  if (managers) {
    router.post('/gestor/login', sensitiveRouteLimiter, validateBody(loginSchema.omit({ empresa: true })), asyncHandler(async (req, res) => {
      res.json({ data: await managers.identify(req.body) });
    }));
    router.post('/gestor/empresa', sensitiveRouteLimiter, validateBody(z.object({ selecaoToken: z.string().min(1).max(4096), empresaId: z.string().uuid() }).strict()), asyncHandler(async (req, res) => {
      res.json({ data: await managers.select(req.body) });
    }));
  }
  router.post('/login', sensitiveRouteLimiter, validateBody(loginSchema), asyncHandler(controller.login));
  router.post('/refresh', validateBody(refreshSchema), refreshLimiter, asyncHandler(controller.refresh));
  router.post('/logout', validateBody(refreshSchema), asyncHandler(controller.logout));
  router.get('/me', authenticate, asyncHandler(controller.me));
  if (passwords) {
    const recoveryLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 5,
      standardHeaders: 'draft-8', legacyHeaders: false,
      message: { erro: { codigo: 'MUITAS_TENTATIVAS', mensagem: 'Aguarde alguns minutos antes de solicitar outro link.' } } });
    router.post('/senha/recuperar', recoveryLimiter, validateBody(forgotPasswordSchema), asyncHandler(async (req, res) => {
      const started = Date.now();
      await passwords.requestReset(req.body);
      // SMTP has a 9s deadline; pad successful public responses to reduce account timing leaks.
      await delay(Math.max(0, 10_000 - (Date.now() - started)));
      res.status(200).json({ data: { mensagem: recoveryMessage } });
    }));
    router.post('/senha/redefinir', sensitiveRouteLimiter, validateBody(resetPasswordSchema), asyncHandler(async (req, res) => {
      await passwords.reset(req.body);
      res.status(204).send();
    }));
    router.post('/senha', sensitiveRouteLimiter, authenticate, validateBody(changePasswordSchema), asyncHandler(async (req, res) => {
      await passwords.change(requireAuthContext(req), req.body);
      res.status(204).send();
    }));
  }

  return router;
}
