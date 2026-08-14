import { Router } from 'express';

import { asyncHandler } from '../../shared/http/async-handler';
import { uuidParamsSchema, type UuidParams } from '../../shared/validation/common.schemas';
import { getValidatedParams, getValidatedQuery, validateBody, validateParams, validateQuery } from '../../shared/validation/validate';
import { requireAuthContext } from '../auth/auth.middleware';
import { auditMetadataFromRequest } from '../auditoria/audit.types';
import {
  prestadorUnificadoCreateSchema, prestadorUnificadoUpdateSchema, veiculoVinculoListSchema,
  type PrestadorUnificadoCreateInput, type PrestadorUnificadoUpdateInput, type VeiculoVinculoListQuery,
} from './prestador-unificado.schemas';
import type { PrestadorUnificadoService } from './prestador-unificado.service';

export function createPrestadorUnificadoRouter(service: PrestadorUnificadoService): Router {
  const router = Router();
  router.get('/veiculos', validateQuery(veiculoVinculoListSchema), asyncHandler(async (request, response) => {
    response.status(200).json(await service.listVehicles(
      requireAuthContext(request), getValidatedQuery<VeiculoVinculoListQuery>(request),
    ));
  }));
  router.post('/prestadores', validateBody(prestadorUnificadoCreateSchema), asyncHandler(async (request, response) => {
    response.status(201).json({ data: await service.create(
      requireAuthContext(request), request.body as PrestadorUnificadoCreateInput, auditMetadataFromRequest(request),
    ) });
  }));
  router.get('/prestadores/:id', validateParams(uuidParamsSchema), asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.get(
      requireAuthContext(request), getValidatedParams<UuidParams>(request).id,
    ) });
  }));
  router.patch('/prestadores/:id', validateParams(uuidParamsSchema), validateBody(prestadorUnificadoUpdateSchema), asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.update(
      requireAuthContext(request), getValidatedParams<UuidParams>(request).id,
      request.body as PrestadorUnificadoUpdateInput, auditMetadataFromRequest(request),
    ) });
  }));
  return router;
}
