import { Router, type Request, type Response } from 'express';
import type { ZodType } from 'zod';

import { requireAuthContext } from '../auth/auth.middleware';
import { auditMetadataFromRequest } from '../auditoria/audit.types';
import { asyncHandler } from '../../shared/http/async-handler';
import { getValidatedParams, getValidatedQuery, validateBody, validateParams, validateQuery } from '../../shared/validation/validate';
import { uuidParamsSchema, type UuidParams } from '../../shared/validation/common.schemas';
import type { CatalogApplication } from './catalog.service';
import type { CatalogInput } from './catalog.types';
import type { CatalogListQuery } from './catalog.repository';

export type CatalogRouteSchemas = {
  create: ZodType;
  update: ZodType;
  list: ZodType;
};

export function createCatalogRouter(service: CatalogApplication, schemas: CatalogRouteSchemas): Router {
  const router = Router();

  router.get('/', validateQuery(schemas.list), asyncHandler(async (request: Request, response: Response) => {
    const result = await service.list(requireAuthContext(request), getValidatedQuery<CatalogListQuery>(request));
    response.status(200).json(result);
  }));

  router.post('/', validateBody(schemas.create), asyncHandler(async (request: Request, response: Response) => {
    const result = await service.create(
      requireAuthContext(request),
      request.body as CatalogInput,
      auditMetadataFromRequest(request),
    );
    response.status(201).json({ data: result });
  }));

  router.get('/:id', validateParams(uuidParamsSchema), asyncHandler(async (request: Request, response: Response) => {
    const { id } = getValidatedParams<UuidParams>(request);
    const result = await service.get(requireAuthContext(request), id);
    response.status(200).json({ data: result });
  }));

  router.patch('/:id', validateParams(uuidParamsSchema), validateBody(schemas.update), asyncHandler(async (request, response) => {
    const { id } = getValidatedParams<UuidParams>(request);
    const result = await service.update(
      requireAuthContext(request),
      id,
      request.body as CatalogInput,
      auditMetadataFromRequest(request),
    );
    response.status(200).json({ data: result });
  }));

  router.post('/:id/inativar', validateParams(uuidParamsSchema), asyncHandler(async (request, response) => {
    const { id } = getValidatedParams<UuidParams>(request);
    const result = await service.setActive(requireAuthContext(request), id, false, auditMetadataFromRequest(request));
    response.status(200).json({ data: result });
  }));

  router.post('/:id/reativar', validateParams(uuidParamsSchema), asyncHandler(async (request, response) => {
    const { id } = getValidatedParams<UuidParams>(request);
    const result = await service.setActive(requireAuthContext(request), id, true, auditMetadataFromRequest(request));
    response.status(200).json({ data: result });
  }));

  return router;
}
