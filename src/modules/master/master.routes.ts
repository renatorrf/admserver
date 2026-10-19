import { Router, type Request, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { setTimeout as delay } from 'node:timers/promises';
import { masterRecoveryMessage, type MasterRecoveryService } from './master-recovery.service';
import { resetPasswordSchema } from '../auth/password.schemas';

import { conflict, unauthorized } from '../../shared/errors/app-error';
import { asyncHandler } from '../../shared/http/async-handler';
import { getValidatedParams, getValidatedQuery, validateBody, validateParams, validateQuery } from '../../shared/validation/validate';
import { masterCompanySchema, type MasterCompanyInput } from '../provisionamento/provisionamento.schemas';
import { z } from 'zod';
import {
  masterActiveSchema,
  masterCreateSchema,
  masterIdSchema,
  masterLoginSchema,
  masterPasswordSchema,
  masterEmailSchema,
  masterRecoverySchema,
  type MasterCreateInput,
  type MasterLoginInput,
  type MasterPasswordInput,
} from './master.schemas';
import type { MasterService } from './master.service';
import type { MasterTokenService } from './master-token.service';

function metadata(request: Request) {
  return { ip: request.ip || null, userAgent: request.get('user-agent') ?? null };
}

export function createMasterRouter(service: MasterService, tokens: MasterTokenService, recovery?: MasterRecoveryService): Router {
  const authenticate: RequestHandler = (request, _response, next) => {
    const [scheme, token] = request.header('authorization')?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) {
      next(unauthorized('Autenticacao master necessaria.'));
      return;
    }
    try {
      request.master = tokens.verify(token);
      next();
    } catch (error) { next(error); }
  };
  const passwordChanged: RequestHandler = (request, _response, next) => {
    if (request.master?.deveAlterarSenha) {
      next(conflict('Altere a senha inicial antes de continuar.'));
      return;
    }
    next();
  };
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { erro: { codigo: 'MUITAS_TENTATIVAS', mensagem: 'Aguarde alguns minutos antes de tentar novamente.' } },
  });
  const router = Router();
  if (recovery) {
    const limiter = rateLimit({ windowMs: 15*60_000, limit: 5, standardHeaders:'draft-8', legacyHeaders:false,
      message:{ erro:{ codigo:'MUITAS_TENTATIVAS',mensagem:'Aguarde alguns minutos antes de solicitar outro link.' } } });
    router.post('/auth/senha/recuperar',limiter,validateBody(masterRecoverySchema),asyncHandler(async(req,res)=>{
      const started=Date.now(); await recovery.requestReset(req.body);
      await delay(Math.max(0,10_000-(Date.now()-started)));
      res.json({data:{mensagem:masterRecoveryMessage}});
    }));
    router.post('/auth/senha/redefinir',loginLimiter,validateBody(resetPasswordSchema),asyncHandler(async(req,res)=>{
      await recovery.reset(req.body); res.status(204).send();
    }));
  }
  router.post('/auth/email',loginLimiter,authenticate,validateBody(masterEmailSchema),asyncHandler(async(req,res)=>{
    res.json({data:await service.changeEmail(req.master!,req.body)});
  }));

  router.post('/auth/login', loginLimiter, validateBody(masterLoginSchema), asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.login(request.body as MasterLoginInput) });
  }));
  router.get('/auth/me', authenticate, asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.getCurrent(request.master!) });
  }));
  router.post('/auth/senha', loginLimiter, authenticate, validateBody(masterPasswordSchema), asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.changePassword(request.master!, request.body as MasterPasswordInput) });
  }));
  router.get('/empresas', authenticate, passwordChanged, asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.listCompanies(request.master!) });
  }));
  const managerQuery = z.object({ busca: z.string().trim().max(100).optional(), pagina: z.coerce.number().int().min(1).default(1), limite: z.coerce.number().int().min(1).max(100).default(20) }).strict();
  router.get('/gestores', authenticate, passwordChanged, validateQuery(managerQuery), asyncHandler(async (request, response) => {
    response.json({ data: await service.listManagers(request.master!, getValidatedQuery<z.infer<typeof managerQuery>>(request)) });
  }));
  router.post('/empresas', authenticate, passwordChanged, validateBody(masterCompanySchema), asyncHandler(async (request, response) => {
    response.status(201).json({
      data: await service.createCompany(request.master!, request.body as MasterCompanyInput, metadata(request)),
    });
  }));
  router.get('/administradores', authenticate, passwordChanged, asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.listAdministrators(request.master!) });
  }));
  router.post('/administradores', authenticate, passwordChanged, validateBody(masterCreateSchema), asyncHandler(async (request, response) => {
    response.status(201).json({
      data: await service.createAdministrator(request.master!, request.body as MasterCreateInput, metadata(request)),
    });
  }));
  router.patch('/administradores/:id/ativo', authenticate, passwordChanged, validateParams(masterIdSchema), validateBody(masterActiveSchema), asyncHandler(async (request, response) => {
    response.status(200).json({
      data: await service.setAdministratorActive(
        request.master!, getValidatedParams<{ id: string }>(request).id, request.body.ativo as boolean, metadata(request),
      ),
    });
  }));
  return router;
}
