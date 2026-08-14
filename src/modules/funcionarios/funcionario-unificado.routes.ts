import { Router } from 'express';

import { asyncHandler } from '../../shared/http/async-handler';
import { uuidParamsSchema, type UuidParams } from '../../shared/validation/common.schemas';
import { getValidatedParams, validateBody, validateParams } from '../../shared/validation/validate';
import { requireAuthContext } from '../auth/auth.middleware';
import { auditMetadataFromRequest } from '../auditoria/audit.types';
import {
  funcionarioUnificadoCreateSchema, funcionarioUnificadoUpdateSchema,
  type FuncionarioUnificadoCreateInput, type FuncionarioUnificadoUpdateInput,
} from './funcionario-unificado.schemas';
import type { FuncionarioUnificadoService } from './funcionario-unificado.service';

export function createFuncionarioUnificadoRouter(service: FuncionarioUnificadoService): Router {
  const router = Router();
  router.post('/', validateBody(funcionarioUnificadoCreateSchema), asyncHandler(async (request, response) => {
    response.status(201).json({ data: await service.create(
      requireAuthContext(request), request.body as FuncionarioUnificadoCreateInput, auditMetadataFromRequest(request),
    ) });
  }));
  router.patch('/:id', validateParams(uuidParamsSchema), validateBody(funcionarioUnificadoUpdateSchema), asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.update(
      requireAuthContext(request), getValidatedParams<UuidParams>(request).id,
      request.body as FuncionarioUnificadoUpdateInput, auditMetadataFromRequest(request),
    ) });
  }));
  return router;
}
