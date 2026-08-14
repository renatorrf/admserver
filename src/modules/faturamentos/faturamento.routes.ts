import { Router } from 'express';

import { asyncHandler } from '../../shared/http/async-handler';
import { uuidParamsSchema, type UuidParams } from '../../shared/validation/common.schemas';
import {
  getValidatedParams, getValidatedQuery, validateBody, validateParams, validateQuery,
} from '../../shared/validation/validate';
import { authorize, requireAuthContext } from '../auth/auth.middleware';
import { auditMetadataFromRequest } from '../auditoria/audit.types';
import {
  corridaValorAjusteSchema, faturamentoCancelSchema, faturamentoCreateSchema,
  faturamentoFiltroSchema, faturamentoListSchema, faturamentoResumoSchema, type CorridaValorAjusteInput,
  type FaturamentoCancelInput, type FaturamentoCreateInput, type FaturamentoFiltro,
  type FaturamentoListQuery, type FaturamentoResumoFiltro,
} from './faturamento.schemas';
import type { FaturamentoService } from './faturamento.service';

export function createFaturamentoRouter(service: FaturamentoService): Router {
  const router = Router();
  router.get('/resumo', authorize('GESTOR'), validateQuery(faturamentoResumoSchema), asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.summary(
      requireAuthContext(request), getValidatedQuery<FaturamentoResumoFiltro>(request),
    ) });
  }));
  router.get('/elegiveis', authorize('GESTOR'), validateQuery(faturamentoFiltroSchema), asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.preview(
      requireAuthContext(request), getValidatedQuery<FaturamentoFiltro>(request),
    ) });
  }));
  router.patch('/corridas/:id/valor-final', authorize('GESTOR'), validateParams(uuidParamsSchema), validateBody(corridaValorAjusteSchema), asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.adjustRideValue(
      requireAuthContext(request), getValidatedParams<UuidParams>(request).id,
      request.body as CorridaValorAjusteInput, auditMetadataFromRequest(request),
    ) });
  }));
  router.get('/', authorize('GESTOR', 'PRESTADOR'), validateQuery(faturamentoListSchema), asyncHandler(async (request, response) => {
    response.status(200).json(await service.list(
      requireAuthContext(request), getValidatedQuery<FaturamentoListQuery>(request),
    ));
  }));
  router.post('/', authorize('GESTOR'), validateBody(faturamentoCreateSchema), asyncHandler(async (request, response) => {
    response.status(201).json({ data: await service.create(
      requireAuthContext(request), request.body as FaturamentoCreateInput, auditMetadataFromRequest(request),
    ) });
  }));
  router.get('/:id/csv', authorize('GESTOR', 'PRESTADOR'), validateParams(uuidParamsSchema), asyncHandler(async (request, response) => {
    const id = getValidatedParams<UuidParams>(request).id;
    response.header('Content-Type', 'text/csv; charset=utf-8');
    response.header('Content-Disposition', `attachment; filename="faturamento-${id}.csv"`);
    response.status(200).send(await service.csv(requireAuthContext(request), id));
  }));
  router.get('/:id', authorize('GESTOR', 'PRESTADOR'), validateParams(uuidParamsSchema), asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.get(
      requireAuthContext(request), getValidatedParams<UuidParams>(request).id,
    ) });
  }));
  router.post('/:id/cancelar', authorize('GESTOR'), validateParams(uuidParamsSchema), validateBody(faturamentoCancelSchema), asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.cancel(
      requireAuthContext(request), getValidatedParams<UuidParams>(request).id,
      request.body as FaturamentoCancelInput, auditMetadataFromRequest(request),
    ) });
  }));
  return router;
}
