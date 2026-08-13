import { Router } from 'express';
import { asyncHandler } from '../../shared/http/async-handler';
import { getValidatedParams, validateBody, validateParams } from '../../shared/validation/validate';
import { requireAuthContext } from '../auth/auth.middleware';
import { dispositivoIdSchema, dispositivoPushSchema, type DispositivoIdParams, type DispositivoPushInput } from './notificacao.schemas';
import type { NotificacaoService } from './notificacao.service';

export function createNotificacaoRouter(service: NotificacaoService): Router {
  const router = Router();
  router.post('/dispositivos', validateBody(dispositivoPushSchema), asyncHandler(async (request, response) => {
    response.status(201).json({ data: await service.register(requireAuthContext(request), request.body as DispositivoPushInput) });
  }));
  router.delete('/dispositivos/:id', validateParams(dispositivoIdSchema), asyncHandler(async (request, response) => {
    await service.revoke(requireAuthContext(request), getValidatedParams<DispositivoIdParams>(request).id);
    response.status(204).send();
  }));
  return router;
}
