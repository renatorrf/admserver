import { Router } from 'express';

import { asyncHandler } from '../../shared/http/async-handler';
import { getValidatedQuery, validateQuery } from '../../shared/validation/validate';
import { authorize, requireAuthContext } from '../auth/auth.middleware';
import { relatorioExportSchema, relatorioListSchema, type RelatorioExportQuery, type RelatorioListQuery } from './relatorio.schemas';
import type { RelatorioService } from './relatorio.service';

export function createRelatorioRouter(service: RelatorioService): Router {
  const router = Router();
  router.get('/corridas', authorize('GERENTE', 'GESTOR'), validateQuery(relatorioListSchema), asyncHandler(async (request, response) => {
    response.status(200).json(await service.list(
      requireAuthContext(request), getValidatedQuery<RelatorioListQuery>(request),
    ));
  }));
  router.get('/corridas.csv', authorize('GERENTE', 'GESTOR'), validateQuery(relatorioExportSchema), asyncHandler(async (request, response) => {
    const csv = await service.csv(requireAuthContext(request), getValidatedQuery<RelatorioExportQuery>(request));
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', 'attachment; filename="corridas.csv"');
    response.status(200).send(csv);
  }));
  return router;
}
