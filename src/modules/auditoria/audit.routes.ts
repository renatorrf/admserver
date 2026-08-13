import { Router } from 'express';

import { asyncHandler } from '../../shared/http/async-handler';
import { getValidatedQuery, validateQuery } from '../../shared/validation/validate';
import { requireAuthContext } from '../auth/auth.middleware';
import type { AuditRepository } from './audit.repository';
import { auditListSchema, type AuditListQuery } from './audit.schemas';

export function createAuditRouter(repository: AuditRepository): Router {
  const router = Router();
  router.get('/', validateQuery(auditListSchema), asyncHandler(async (request, response) => {
    const auth = requireAuthContext(request);
    const result = await repository.list(auth.empresaId, getValidatedQuery<AuditListQuery>(request));
    response.status(200).json(result);
  }));
  return router;
}
