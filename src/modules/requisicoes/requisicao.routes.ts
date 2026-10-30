import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../shared/http/async-handler';
import { uuidParamsSchema, type UuidParams } from '../../shared/validation/common.schemas';
import { getValidatedParams, validateBody, validateParams } from '../../shared/validation/validate';
import { authorize, requireAuthContext } from '../auth/auth.middleware';
import { auditMetadataFromRequest } from '../auditoria/audit.types';
import { conferenceSchema, decisionSchema, requisicaoSchema } from './requisicao.schemas';
import type { RequisitionService } from './requisicao.service';
import type { RequisitionAccessService } from './requisition-access';
import { unavailable } from '../../shared/errors/app-error';

export function requisitionRouter(service: RequisitionService, access?: RequisitionAccessService): Router {
  const router = Router();
  router.use(authorize('GESTOR','GERENTE','PORTARIA'));
  router.get('/',asyncHandler(async (req,res) => {
    const offset = z.coerce.number().int().min(0).max(100000).default(0).parse(req.query.offset);
    res.json({ data: await service.list(requireAuthContext(req),offset) });
  }));
  router.post('/',authorize('GESTOR','GERENTE'),validateBody(requisicaoSchema),asyncHandler(async (req,res) => {
    res.status(201).json({ data: await service.create(requireAuthContext(req),requisicaoSchema.parse(req.body),auditMetadataFromRequest(req)) });
  }));
  router.get('/:id',validateParams(uuidParamsSchema),asyncHandler(async (req,res) => {
    res.json({ data: await service.get(requireAuthContext(req),getValidatedParams<UuidParams>(req).id) });
  }));
  router.post('/:id/decisao',authorize('GESTOR'),validateParams(uuidParamsSchema),validateBody(decisionSchema),asyncHandler(async (req,res) => {
    res.json({ data: await service.decide(requireAuthContext(req),getValidatedParams<UuidParams>(req).id,decisionSchema.parse(req.body),auditMetadataFromRequest(req)) });
  }));
  router.post('/:id/solicitar',authorize('PORTARIA'),validateParams(uuidParamsSchema),validateBody(conferenceSchema),asyncHandler(async (req,res) => {
    const ride = await service.dispatch(requireAuthContext(req),getValidatedParams<UuidParams>(req).id,conferenceSchema.parse(req.body).participantes,auditMetadataFromRequest(req));
    res.json({ data: { id: ride.id } });
  }));
  router.get('/:id/acessos',authorize('PORTARIA'),validateParams(uuidParamsSchema),asyncHandler(async (req,res) => {
    if (!access) throw unavailable('Envio de acesso nao configurado.');
    res.setHeader('Cache-Control','no-store');
    res.json({data:await access.list(requireAuthContext(req),getValidatedParams<UuidParams>(req).id)});
  }));
  const accessParams = z.object({id:z.string().uuid(),funcionarioId:z.string().uuid()}).strict();
  router.post('/:id/acessos/:funcionarioId/whatsapp',authorize('PORTARIA'),validateParams(accessParams),
    validateBody(z.object({}).strict()),asyncHandler(async (req,res) => {
      if (!access) throw unavailable('Envio de acesso nao configurado.');
      const params=getValidatedParams<z.infer<typeof accessParams>>(req);
      res.setHeader('Cache-Control','no-store');
      res.json({data:await access.prepare(requireAuthContext(req),params.id,params.funcionarioId,auditMetadataFromRequest(req))});
    }));
  return router;
}
