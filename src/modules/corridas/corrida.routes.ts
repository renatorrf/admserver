import { Router } from 'express';

import { asyncHandler } from '../../shared/http/async-handler';
import { uuidParamsSchema, type UuidParams } from '../../shared/validation/common.schemas';
import { getValidatedParams, getValidatedQuery, validateBody, validateParams, validateQuery } from '../../shared/validation/validate';
import { authorize, requireAuthContext } from '../auth/auth.middleware';
import { auditMetadataFromRequest } from '../auditoria/audit.types';
import {
  corridaAcceptSchema,
  corridaAssignSchema,
  corridaCancelSchema,
  corridaCreateSchema,
  corridaFinishSchema,
  corridaListSchema,
  eventoListSchema,
  type CorridaAcceptInput,
  type CorridaAssignInput,
  type CorridaCancelInput,
  type CorridaCreateInput,
  type CorridaFinishInput,
  type CorridaListQuery,
  type EventoListQuery,
} from './corrida.schemas';
import type { CorridaService } from './corrida.service';

export function createCorridaRouter(service: CorridaService): Router {
  const router = Router();

  router.get('/', authorize('PRESTADOR', 'GERENTE', 'GESTOR'), validateQuery(corridaListSchema), asyncHandler(async (request, response) => {
    response.status(200).json(await service.list(
      requireAuthContext(request), getValidatedQuery<CorridaListQuery>(request),
    ));
  }));
  router.post('/', authorize('GERENTE', 'GESTOR'), validateBody(corridaCreateSchema), asyncHandler(async (request, response) => {
    const result = await service.create(
      requireAuthContext(request), request.body as CorridaCreateInput, auditMetadataFromRequest(request),
    );
    response.status(201).json({ data: result });
  }));
  router.get('/:id', authorize('PRESTADOR', 'GERENTE', 'GESTOR'), validateParams(uuidParamsSchema), asyncHandler(async (request, response) => {
    const { id } = getValidatedParams<UuidParams>(request);
    response.status(200).json({ data: await service.get(requireAuthContext(request), id) });
  }));
  router.get('/:id/eventos', authorize('PRESTADOR', 'GERENTE', 'GESTOR'), validateParams(uuidParamsSchema), validateQuery(eventoListSchema), asyncHandler(async (request, response) => {
    const { id } = getValidatedParams<UuidParams>(request);
    response.status(200).json(await service.listEvents(
      requireAuthContext(request), id, getValidatedQuery<EventoListQuery>(request),
    ));
  }));
  router.post('/:id/atribuir', authorize('GESTOR'), validateParams(uuidParamsSchema), validateBody(corridaAssignSchema), asyncHandler(async (request, response) => {
    const { id } = getValidatedParams<UuidParams>(request);
    response.status(200).json({ data: await service.assign(
      requireAuthContext(request), id, request.body as CorridaAssignInput, auditMetadataFromRequest(request),
    ) });
  }));
  router.post('/:id/reabrir', authorize('GESTOR'), validateParams(uuidParamsSchema), asyncHandler(async (request, response) => {
    const { id } = getValidatedParams<UuidParams>(request);
    response.status(200).json({ data: await service.reopen(
      requireAuthContext(request), id, auditMetadataFromRequest(request),
    ) });
  }));
  router.post('/:id/aceitar', authorize('PRESTADOR'), validateParams(uuidParamsSchema), validateBody(corridaAcceptSchema), asyncHandler(async (request, response) => {
    const { id } = getValidatedParams<UuidParams>(request);
    response.status(200).json({ data: await service.accept(
      requireAuthContext(request), id, request.body as CorridaAcceptInput, auditMetadataFromRequest(request),
    ) });
  }));
  router.post('/:id/recusar', authorize('PRESTADOR'), validateParams(uuidParamsSchema), asyncHandler(async (request, response) => {
    const { id } = getValidatedParams<UuidParams>(request);
    response.status(200).json({ data: await service.refuse(
      requireAuthContext(request), id, auditMetadataFromRequest(request),
    ) });
  }));
  router.post('/:id/iniciar-deslocamento', authorize('PRESTADOR'), validateParams(uuidParamsSchema), asyncHandler(async (request, response) => {
    const { id } = getValidatedParams<UuidParams>(request);
    response.status(200).json({ data: await service.startDisplacement(
      requireAuthContext(request), id, auditMetadataFromRequest(request),
    ) });
  }));
  router.post('/:id/cheguei-embarque', authorize('PRESTADOR'), validateParams(uuidParamsSchema), asyncHandler(async (request, response) => {
    const { id } = getValidatedParams<UuidParams>(request);
    response.status(200).json({ data: await service.arrive(
      requireAuthContext(request), id, auditMetadataFromRequest(request),
    ) });
  }));
  router.post('/:id/confirmar-embarque', authorize('PRESTADOR'), validateParams(uuidParamsSchema), asyncHandler(async (request, response) => {
    const { id } = getValidatedParams<UuidParams>(request);
    response.status(200).json({ data: await service.board(
      requireAuthContext(request), id, auditMetadataFromRequest(request),
    ) });
  }));
  router.post('/:id/finalizar', authorize('PRESTADOR'), validateParams(uuidParamsSchema), validateBody(corridaFinishSchema), asyncHandler(async (request, response) => {
    const { id } = getValidatedParams<UuidParams>(request);
    response.status(200).json({ data: await service.finish(
      requireAuthContext(request), id, request.body as CorridaFinishInput, auditMetadataFromRequest(request),
    ) });
  }));
  router.post('/:id/confirmar-desembarque', authorize('PRESTADOR'), validateParams(uuidParamsSchema), asyncHandler(async (request, response) => {
    const { id } = getValidatedParams<UuidParams>(request);
    response.status(200).json({ data: await service.disembark(
      requireAuthContext(request), id, auditMetadataFromRequest(request),
    ) });
  }));
  router.post('/:id/cancelar', authorize('GERENTE', 'GESTOR'), validateParams(uuidParamsSchema), validateBody(corridaCancelSchema), asyncHandler(async (request, response) => {
    const { id } = getValidatedParams<UuidParams>(request);
    response.status(200).json({ data: await service.cancel(
      requireAuthContext(request), id, request.body as CorridaCancelInput, auditMetadataFromRequest(request),
    ) });
  }));

  return router;
}
