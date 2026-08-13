import { Router } from 'express';

import { asyncHandler } from '../../shared/http/async-handler';
import { authorize, requireAuthContext } from '../auth/auth.middleware';
import type { DashboardService } from './dashboard.service';

export function createDashboardRouter(service: DashboardService): Router {
  const router = Router();
  router.get('/', authorize('GERENTE', 'GESTOR'), asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.get(requireAuthContext(request)) });
  }));
  return router;
}
