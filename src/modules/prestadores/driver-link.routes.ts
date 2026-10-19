import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { authorize, requireAuthContext } from '../auth/auth.middleware';
import { auditMetadataFromRequest } from '../auditoria/audit.types';
import { asyncHandler } from '../../shared/http/async-handler';
import { getValidatedQuery, validateBody, validateQuery } from '../../shared/validation/validate';
import type { DriverLinkService } from './driver-link.service';

export function createDriverLinkRouter(service: DriverLinkService): Router {
  const router = Router();
  router.use(authorize('GESTOR'), rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }));
  router.get('/', validateQuery(z.object({ email: z.string().trim().email().max(254).toLowerCase() }).strict()), asyncHandler(async (req, res) => {
    res.json({ data: await service.search(requireAuthContext(req), getValidatedQuery<{ email: string }>(req).email) });
  }));
  router.post('/', validateBody(z.object({ contaId: z.string().uuid(), copiarVeiculo: z.boolean() }).strict()), asyncHandler(async (req, res) => {
    res.status(201).json({ data: await service.link(requireAuthContext(req), req.body.contaId, req.body.copiarVeiculo, auditMetadataFromRequest(req)) });
  }));
  return router;
}
