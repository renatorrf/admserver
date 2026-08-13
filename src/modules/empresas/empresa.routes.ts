import { Router } from 'express';

import { asyncHandler } from '../../shared/http/async-handler';
import { validateBody } from '../../shared/validation/validate';
import { requireAuthContext } from '../auth/auth.middleware';
import { auditMetadataFromRequest } from '../auditoria/audit.types';
import { empresaUpdateSchema, type EmpresaUpdateInput } from './empresa.schemas';
import type { EmpresaService } from './empresa.service';

export function createEmpresaRouter(service: EmpresaService): Router {
  const router = Router();
  router.get('/atual', asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.getCurrent(requireAuthContext(request)) });
  }));
  router.patch('/atual', validateBody(empresaUpdateSchema), asyncHandler(async (request, response) => {
    const result = await service.updateCurrent(
      requireAuthContext(request),
      request.body as EmpresaUpdateInput,
      auditMetadataFromRequest(request),
    );
    response.status(200).json({ data: result });
  }));
  return router;
}
