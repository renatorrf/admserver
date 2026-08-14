import { Router } from 'express';

import { asyncHandler } from '../../shared/http/async-handler';
import { getValidatedQuery, validateQuery } from '../../shared/validation/validate';
import { authorize, requireAuthContext } from '../auth/auth.middleware';
import { painelParticipanteSchema, type PainelParticipanteQuery } from './painel.schemas';
import type { PainelParticipanteService } from './painel.service';

export function createPainelParticipanteRouter(service: PainelParticipanteService): Router {
  const router = Router();
  router.get('/meu', authorize('FUNCIONARIO', 'PRESTADOR'), validateQuery(painelParticipanteSchema), asyncHandler(async (request, response) => {
    response.status(200).json({
      data: await service.get(requireAuthContext(request), getValidatedQuery<PainelParticipanteQuery>(request)),
    });
  }));
  return router;
}
