import { Router } from 'express';

import { asyncHandler } from '../../shared/http/async-handler';
import {
  getValidatedParams, getValidatedQuery, validateBody, validateParams, validateQuery,
} from '../../shared/validation/validate';
import { authorize, requireAuthContext } from '../auth/auth.middleware';
import {
  dispositivoAtualParamsSchema, dispositivoAtualSchema, dispositivoGestaoListSchema,
  type DispositivoAtualInput, type DispositivoAtualParams, type DispositivoGestaoListQuery,
} from './dispositivo.schemas';
import type { DispositivoService } from './dispositivo.service';

export function createDispositivoRouter(service: DispositivoService): Router {
  const router = Router();

  router.put('/atual', validateBody(dispositivoAtualSchema), asyncHandler(async (request, response) => {
    const result = await service.syncCurrent(requireAuthContext(request), request.body as DispositivoAtualInput);
    response.status(200).json({ data: result });
  }));
  router.delete('/atual/:chaveDispositivo', validateParams(dispositivoAtualParamsSchema), asyncHandler(async (request, response) => {
    await service.deactivateCurrent(
      requireAuthContext(request), getValidatedParams<DispositivoAtualParams>(request).chaveDispositivo,
    );
    response.status(204).send();
  }));
  router.get('/', authorize('GESTOR'), validateQuery(dispositivoGestaoListSchema), asyncHandler(async (request, response) => {
    const result = await service.listManaged(
      requireAuthContext(request), getValidatedQuery<DispositivoGestaoListQuery>(request),
    );
    response.status(200).json(result);
  }));

  return router;
}
