import { Router } from 'express';

import { asyncHandler } from '../../shared/http/async-handler';
import { getValidatedParams, getValidatedQuery, validateBody, validateParams, validateQuery } from '../../shared/validation/validate';
import { uuidParamsSchema, type UuidParams } from '../../shared/validation/common.schemas';
import { requireAuthContext } from '../auth/auth.middleware';
import { auditMetadataFromRequest } from '../auditoria/audit.types';
import {
  gerenteCentrosSchema,
  gerenteEscopoSchema,
  usuarioCreateSchema,
  usuarioListSchema,
  usuarioUpdateSchema,
  type GerenteCentrosInput,
  type GerenteEscopoInput,
  type UsuarioCreateInput,
  type UsuarioListQuery,
  type UsuarioUpdateInput,
} from './usuario.schemas';
import type { UsuarioService } from './usuario.service';

export function createUsuarioRouter(service: UsuarioService): Router {
  const router = Router();

  router.get('/', validateQuery(usuarioListSchema), asyncHandler(async (request, response) => {
    const result = await service.list(requireAuthContext(request), getValidatedQuery<UsuarioListQuery>(request));
    response.status(200).json(result);
  }));
  router.post('/', validateBody(usuarioCreateSchema), asyncHandler(async (request, response) => {
    const result = await service.create(
      requireAuthContext(request), request.body as UsuarioCreateInput, auditMetadataFromRequest(request),
    );
    response.status(201).json({ data: result });
  }));
  router.post('/escopo/preview', validateBody(gerenteEscopoSchema), asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.previewManagerScope(
      requireAuthContext(request), request.body as GerenteEscopoInput,
    ) });
  }));
  router.get('/:id', validateParams(uuidParamsSchema), asyncHandler(async (request, response) => {
    const { id } = getValidatedParams<UuidParams>(request);
    response.status(200).json({ data: await service.get(requireAuthContext(request), id) });
  }));
  router.patch('/:id', validateParams(uuidParamsSchema), validateBody(usuarioUpdateSchema), asyncHandler(async (request, response) => {
    const { id } = getValidatedParams<UuidParams>(request);
    const result = await service.update(
      requireAuthContext(request), id, request.body as UsuarioUpdateInput, auditMetadataFromRequest(request),
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
  router.get('/:id/centros-custo', validateParams(uuidParamsSchema), asyncHandler(async (request, response) => {
    const { id } = getValidatedParams<UuidParams>(request);
    response.status(200).json({ data: await service.getManagerCenters(requireAuthContext(request), id) });
  }));
  router.get('/:id/escopo', validateParams(uuidParamsSchema), asyncHandler(async (request, response) => {
    const { id } = getValidatedParams<UuidParams>(request);
    response.status(200).json({ data: await service.getManagerScope(requireAuthContext(request), id) });
  }));
  router.put('/:id/escopo', validateParams(uuidParamsSchema), validateBody(gerenteEscopoSchema), asyncHandler(async (request, response) => {
    const { id } = getValidatedParams<UuidParams>(request);
    const result = await service.replaceManagerScope(
      requireAuthContext(request), id, request.body as GerenteEscopoInput, auditMetadataFromRequest(request),
    );
    response.status(200).json({ data: result });
  }));
  router.put('/:id/centros-custo', validateParams(uuidParamsSchema), validateBody(gerenteCentrosSchema), asyncHandler(async (request, response) => {
    const { id } = getValidatedParams<UuidParams>(request);
    const result = await service.replaceManagerCenters(
      requireAuthContext(request), id, request.body as GerenteCentrosInput, auditMetadataFromRequest(request),
    );
    response.status(200).json({ data: result });
  }));

  return router;
}
