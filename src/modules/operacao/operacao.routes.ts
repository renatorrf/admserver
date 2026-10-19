import { Router } from 'express';

import { asyncHandler } from '../../shared/http/async-handler';
import { getValidatedParams, getValidatedQuery, validateParams, validateQuery } from '../../shared/validation/validate';
import { authorize, requireAuthContext } from '../auth/auth.middleware';
import {
  funcionarioLookupSchema, funcionarioSearchSchema, prestadorSearchSchema, mapLocationQuerySchema, employeeDestinationParamsSchema,
  type FuncionarioLookupQuery, type FuncionarioSearchQuery, type PrestadorSearchQuery,
} from './operacao.schemas';
import type { OperacaoService } from './operacao.service';

export function createOperacaoRouter(service: OperacaoService): Router {
  const router = Router();
  router.get('/funcionarios/:id/destinos-recentes', authorize('GERENTE', 'GESTOR'),
    validateParams(employeeDestinationParamsSchema), validateQuery(mapLocationQuerySchema), asyncHandler(async (request, response) => {
      response.json({ data: await service.recentEmployeeDestinations(requireAuthContext(request), getValidatedParams<{ id: string }>(request).id) });
    }));
  router.get('/endereco-empresa', authorize('GERENTE', 'GESTOR'), validateQuery(mapLocationQuerySchema), asyncHandler(async (request, response) => {
    response.json({ data: await service.getCompanyAddress(requireAuthContext(request)) });
  }));

  router.get('/localizacao-padrao', validateQuery(mapLocationQuerySchema), asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.getMapLocation(requireAuthContext(request)) });
  }));

  router.get('/escopo', authorize('GERENTE', 'GESTOR'), asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.getScopeSummary(requireAuthContext(request)) });
  }));
  router.get('/setores', authorize('GERENTE', 'GESTOR'), asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.listSectors(requireAuthContext(request)) });
  }));

  router.get('/centros-custo', authorize('GERENTE', 'GESTOR'), asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.listCenters(requireAuthContext(request)) });
  }));
  router.get(
    '/funcionarios',
    authorize('GERENTE', 'GESTOR'),
    validateQuery(funcionarioLookupSchema),
    asyncHandler(async (request, response) => {
      response.status(200).json({ data: await service.listEmployees(
        requireAuthContext(request), getValidatedQuery<FuncionarioLookupQuery>(request),
      ) });
    }),
  );
  router.get(
    '/funcionarios/pesquisa',
    authorize('GERENTE', 'GESTOR'),
    validateQuery(funcionarioSearchSchema),
    asyncHandler(async (request, response) => {
      response.status(200).json(await service.searchEmployees(
        requireAuthContext(request), getValidatedQuery<FuncionarioSearchQuery>(request),
      ));
    }),
  );
  router.get('/meu-prestador', authorize('PRESTADOR'), asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.getMyProvider(requireAuthContext(request)) });
  }));
  router.get('/meus-veiculos', authorize('PRESTADOR'), asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.listMyVehicles(requireAuthContext(request)) });
  }));
  router.get('/prestadores', authorize('GERENTE', 'GESTOR'), asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.listProviders(requireAuthContext(request)) });
  }));
  router.get(
    '/prestadores/pesquisa',
    authorize('GESTOR'),
    validateQuery(prestadorSearchSchema),
    asyncHandler(async (request, response) => {
      response.status(200).json(await service.searchProviders(
        requireAuthContext(request), getValidatedQuery<PrestadorSearchQuery>(request),
      ));
    }),
  );
  router.get('/solicitantes', authorize('GERENTE', 'GESTOR'), asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.listRequesters(requireAuthContext(request)) });
  }));

  return router;
}
