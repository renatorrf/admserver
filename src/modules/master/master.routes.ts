import { Router, type Request, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

import { conflict, unauthorized } from '../../shared/errors/app-error';
import { asyncHandler } from '../../shared/http/async-handler';
import { getValidatedParams, validateBody, validateParams } from '../../shared/validation/validate';
import { provisionamentoSchema, type ProvisionamentoInput } from '../provisionamento/provisionamento.schemas';
import {
  masterActiveSchema,
  masterCreateSchema,
  masterIdSchema,
  masterLoginSchema,
  masterPasswordSchema,
  type MasterCreateInput,
  type MasterLoginInput,
  type MasterPasswordInput,
} from './master.schemas';
import type { MasterService } from './master.service';
import type { MasterTokenService } from './master-token.service';

function metadata(request: Request) {
  return { ip: request.ip || null, userAgent: request.get('user-agent') ?? null };
}

export function createMasterRouter(service: MasterService, tokens: MasterTokenService): Router {
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

  router.post('/auth/login', loginLimiter, validateBody(masterLoginSchema), asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.login(request.body as MasterLoginInput) });
  }));
  router.get('/auth/me', authenticate, asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.getCurrent(request.master!) });
  }));
  router.post('/auth/senha', authenticate, validateBody(masterPasswordSchema), asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.changePassword(request.master!, request.body as MasterPasswordInput) });
  }));
  router.get('/empresas', authenticate, passwordChanged, asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.listCompanies(request.master!) });
  }));
  router.post('/empresas', authenticate, passwordChanged, validateBody(provisionamentoSchema), asyncHandler(async (request, response) => {
    response.status(201).json({
      data: await service.createCompany(request.master!, request.body as ProvisionamentoInput, metadata(request)),
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
