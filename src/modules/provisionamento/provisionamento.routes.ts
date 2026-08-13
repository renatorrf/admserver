import { timingSafeEqual } from 'node:crypto';

import { Router, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

import { unauthorized } from '../../shared/errors/app-error';
import { asyncHandler } from '../../shared/http/async-handler';
import { validateBody } from '../../shared/validation/validate';
import { provisionamentoSchema, type ProvisionamentoInput } from './provisionamento.schemas';
import type { ProvisionamentoService } from './provisionamento.service';

function matchesSecret(received: string | undefined, expected: string): boolean {
  if (!received) return false;
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

export function createProvisionamentoRouter(service: ProvisionamentoService, secret: string): Router {
  const authorizeProvisioning: RequestHandler = (request, _response, next) => {
    if (!matchesSecret(request.header('x-provisioning-secret'), secret)) {
      next(unauthorized('Credencial de provisionamento invalida.'));
      return;
    }
    next();
  };
  const router = Router();
  router.post('/empresas', rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  }), authorizeProvisioning, validateBody(provisionamentoSchema), asyncHandler(async (request, response) => {
    const result = await service.create(request.body as ProvisionamentoInput, {
      ip: request.ip || null,
      userAgent: request.get('user-agent') ?? null,
    });
    response.status(201).json({ data: result });
  }));
  return router;
}
