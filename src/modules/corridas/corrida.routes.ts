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
  corridaFinishSchema,
  corridaListSchema,
  eventoListSchema,
  type CorridaAcceptInput,
  type CorridaAssignInput,
  type CorridaCancelInput,
  type CorridaFinishInput,
  type CorridaListQuery,
  type EventoListQuery,
} from './corrida.schemas';
import type { CorridaService } from './corrida.service';
import { itineraryActionSchema, itineraryEditSchema } from './itinerary';
import type { RideRouteService } from './route.service';
import { unavailable, forbidden } from '../../shared/errors/app-error';
import { optimizeRouteSchema, type RideRouteOptimizer } from './route-optimizer';

export function createCorridaRouter(service: CorridaService, routes?: RideRouteService, optimizer?: RideRouteOptimizer): Router {
  const router = Router();
  router.post('/:id/otimizar-trajeto', authorize('PRESTADOR'), validateParams(uuidParamsSchema), validateBody(optimizeRouteSchema), asyncHandler(async (request, response) => {
    if (!optimizer) throw unavailable('Calculo de trajeto indisponivel.');
    const { id } = getValidatedParams<UuidParams>(request);
    response.json({ data: await service.optimizeRoute(requireAuthContext(request), id,
      optimizeRouteSchema.parse(request.body), optimizer, auditMetadataFromRequest(request)) });
  }));
  router.get('/:id/rota', authorize('PRESTADOR', 'FUNCIONARIO', 'GERENTE', 'GESTOR'), validateParams(uuidParamsSchema), asyncHandler(async (request, response) => {
    const { id } = getValidatedParams<UuidParams>(request);
    const ride = await service.get(requireAuthContext(request), id);
    if (!routes) throw unavailable('Calculo de rota indisponivel.');
    response.json({ data: await routes.calculate(ride) });
  }));

  router.put('/:id/itinerario', authorize('GERENTE', 'GESTOR'), validateParams(uuidParamsSchema), validateBody(itineraryEditSchema), asyncHandler(async (request, response) => {
    const { id } = getValidatedParams<UuidParams>(request);
    const input = itineraryEditSchema.parse(request.body);
    response.json({ data: await service.editItinerary(requireAuthContext(request), id, input.versao, input.itinerario, auditMetadataFromRequest(request)) });
  }));
  router.post('/:id/itinerario/acoes', authorize('PRESTADOR'), validateParams(uuidParamsSchema), validateBody(itineraryActionSchema), asyncHandler(async (request, response) => {
    const { id } = getValidatedParams<UuidParams>(request);
    response.json({ data: await service.executeItinerary(requireAuthContext(request), id, itineraryActionSchema.parse(request.body), auditMetadataFromRequest(request)) });
  }));

  router.get('/', authorize('PRESTADOR', 'FUNCIONARIO', 'GERENTE', 'GESTOR'), validateQuery(corridaListSchema), asyncHandler(async (request, response) => {
    response.status(200).json(await service.list(
      requireAuthContext(request), getValidatedQuery<CorridaListQuery>(request),
    ));
  }));
  router.post('/', authorize('GERENTE', 'GESTOR', 'PORTARIA'), () => {
    throw forbidden('Crie uma requisicao de viagem. Somente a portaria pode solicitar uma corrida autorizada, pela tela de conferencia.');
  });
  router.get('/:id', authorize('PRESTADOR', 'FUNCIONARIO', 'GERENTE', 'GESTOR'), validateParams(uuidParamsSchema), asyncHandler(async (request, response) => {
    const { id } = getValidatedParams<UuidParams>(request);
    response.status(200).json({ data: await service.get(requireAuthContext(request), id) });
  }));
  router.get('/:id/eventos', authorize('PRESTADOR', 'FUNCIONARIO', 'GERENTE', 'GESTOR'), validateParams(uuidParamsSchema), validateQuery(eventoListSchema), asyncHandler(async (request, response) => {
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
