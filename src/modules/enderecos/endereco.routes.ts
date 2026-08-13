import { Router } from 'express';

import { asyncHandler } from '../../shared/http/async-handler';
import { getValidatedQuery, validateQuery } from '../../shared/validation/validate';
import { requireAuthContext } from '../auth/auth.middleware';
import { enderecoAutocompleteSchema, enderecoReverseSchema, type EnderecoAutocompleteQuery, type EnderecoReverseQuery } from './endereco.schemas';
import type { EnderecoService } from './endereco.service';

export function createEnderecoRouter(service: EnderecoService): Router {
  const router = Router();
  router.get('/autocomplete', validateQuery(enderecoAutocompleteSchema), asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.autocomplete(
      requireAuthContext(request), getValidatedQuery<EnderecoAutocompleteQuery>(request),
    ) });
  }));
  router.get('/reverso', validateQuery(enderecoReverseSchema), asyncHandler(async (request, response) => {
    response.status(200).json({ data: await service.reverse(
      requireAuthContext(request), getValidatedQuery<EnderecoReverseQuery>(request),
    ) });
  }));
  return router;
}
