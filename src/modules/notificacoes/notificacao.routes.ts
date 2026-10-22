import { Router } from 'express';

import type { TokenService } from '../auth/token-service';
import { createAuthenticate, authorize, requireAuthContext } from '../auth/auth.middleware';
import { asyncHandler } from '../../shared/http/async-handler';
import { getValidatedParams, validateBody, validateParams } from '../../shared/validation/validate';
import {
  pushSubscriptionSchema, subscriptionIdSchema, type PushSubscriptionInput, type SubscriptionIdParams,
} from './notificacao.schemas';
import type { NotificacaoService } from './notificacao.service';
import { type FcmService, nativeDeviceSchema, nativeBindingSchema } from './fcm.service';

export function createNotificacaoRouter(service: NotificacaoService, tokens: TokenService, fcm?: FcmService): Router {
  const router = Router();
  router.get('/public-key', asyncHandler(async (_request, response) => {
    response.status(200).json({ data: { publicKey: service.publicKey() } });
  }));
  router.use(createAuthenticate(tokens));
  if (fcm) {
    router.post('/android/devices', authorize('PRESTADOR'), validateBody(nativeDeviceSchema), asyncHandler(async (req,res) => {
      res.status(201).json({ data: await fcm.register(requireAuthContext(req),req.body) });
    }));
    router.post('/android/status', authorize('PRESTADOR'), validateBody(nativeBindingSchema), asyncHandler(async (req,res) => {
      res.json({ data: await fcm.status(requireAuthContext(req),req.body.vinculoId) });
    }));
    router.post('/android/revoke', authorize('PRESTADOR'), validateBody(nativeBindingSchema), asyncHandler(async (req,res) => {
      await fcm.revoke(requireAuthContext(req),req.body.vinculoId); res.sendStatus(204);
    }));
  }
  router.get('/notificacoes', asyncHandler(async (request, response) => {
    response.json({ data: await service.listOwn(requireAuthContext(request)) });
  }));
  router.post('/subscriptions', validateBody(pushSubscriptionSchema), asyncHandler(async (request, response) => {
    response.status(201).json({ data: await service.register(
      requireAuthContext(request), request.body as PushSubscriptionInput, request.headers['user-agent'] ?? null,
    ) });
  }));
  router.get('/subscriptions/status', asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.status(requireAuthContext(request)) });
  }));
  router.delete('/subscriptions/:id', validateParams(subscriptionIdSchema), asyncHandler(async (request, response) => {
    await service.revoke(requireAuthContext(request), getValidatedParams<SubscriptionIdParams>(request).id);
    response.status(204).send();
  }));
  router.post('/test', asyncHandler(async (request, response) => {
    await service.sendTest(requireAuthContext(request));
    response.status(204).send();
  }));
  router.get('/diagnostics', authorize('GESTOR'), asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.diagnostics(requireAuthContext(request)) });
  }));
  router.post('/diagnostics/:id/test', authorize('GESTOR'), validateParams(subscriptionIdSchema), asyncHandler(async (request, response) => {
    await service.sendDiagnosticTest(
      requireAuthContext(request), getValidatedParams<SubscriptionIdParams>(request).id,
    );
    response.status(204).send();
  }));
  return router;
}
