import { rateLimit } from 'express-rate-limit';
import { Router } from 'express';

import { asyncHandler } from '../../shared/http/async-handler';
import { uuidParamsSchema, type UuidParams } from '../../shared/validation/common.schemas';
import {
  getValidatedParams,
  getValidatedQuery,
  validateBody,
  validateParams,
  validateQuery,
} from '../../shared/validation/validate';
import { authorize, requireAuthContext } from '../auth/auth.middleware';
import {
  localizacaoCreateSchema,
  localizacaoListSchema,
  type LocalizacaoCreateInput,
  type LocalizacaoListQuery,
} from './localizacao.schemas';
import type { LocalizacaoService } from './localizacao.service';

export function createLocalizacaoRouter(service: LocalizacaoService): Router {
  const router = Router({ mergeParams: true });
  const locationRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { erro: { codigo: 'LIMITE_EXCEDIDO', mensagem: 'Aguarde antes de enviar uma nova localizacao.' } },
  });

  router.get(
    '/',
    authorize('PRESTADOR', 'GERENTE', 'GESTOR'),
    validateParams(uuidParamsSchema),
    validateQuery(localizacaoListSchema),
    asyncHandler(async (request, response) => {
      const { id } = getValidatedParams<UuidParams>(request);
      response.status(200).json(await service.list(
        requireAuthContext(request), id, getValidatedQuery<LocalizacaoListQuery>(request),
      ));
    }),
  );
  router.post(
    '/',
    authorize('PRESTADOR'),
    locationRateLimit,
    validateParams(uuidParamsSchema),
    validateBody(localizacaoCreateSchema),
    asyncHandler(async (request, response) => {
      const { id } = getValidatedParams<UuidParams>(request);
      response.status(201).json({ data: await service.create(
        requireAuthContext(request), id, request.body as LocalizacaoCreateInput,
      ) });
    }),
  );

  return router;
}
