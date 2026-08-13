import { Router } from 'express';
import type { Pool } from 'pg';

import { validateBody } from '../../shared/validation/validate';
import { asyncHandler } from '../../shared/http/async-handler';
import { createAuthenticate, authorize, requireAuthContext } from '../auth/auth.middleware';
import type { TokenService } from '../auth/token-service';
import { AuditRepository } from '../auditoria/audit.repository';
import { auditMetadataFromRequest } from '../auditoria/audit.types';
import { createCorridaRouter } from './corrida.routes';
import { disponibilidadeSchema, type DisponibilidadeInput } from './corrida.schemas';
import { CorridaService } from './corrida.service';
import type { RealtimeBus } from '../../realtime/realtime-bus';
import { createLocalizacaoRouter } from '../localizacoes/localizacao.routes';
import { LocalizacaoService } from '../localizacoes/localizacao.service';
import { createOperacaoRouter } from '../operacao/operacao.routes';
import { OperacaoRepository } from '../operacao/operacao.repository';
import { OperacaoService } from '../operacao/operacao.service';
import { DashboardRepository } from '../dashboard/dashboard.repository';
import { createDashboardRouter } from '../dashboard/dashboard.routes';
import { DashboardService } from '../dashboard/dashboard.service';
import { RelatorioRepository } from '../relatorios/relatorio.repository';
import { createRelatorioRouter } from '../relatorios/relatorio.routes';
import { RelatorioService } from '../relatorios/relatorio.service';
import { createEnderecoRouter } from '../enderecos/endereco.routes';
import { EnderecoService } from '../enderecos/endereco.service';
import { createNotificacaoRouter } from '../notificacoes/notificacao.routes';
import { NotificacaoService } from '../notificacoes/notificacao.service';

export function createOperationalRouter(
  pool: Pool, tokens: TokenService, realtime?: RealtimeBus, geoapifyApiKey?: string, firebaseProjectId?: string,
): Router {
  const router = Router();
  const notifications = new NotificacaoService(pool, firebaseProjectId);
  const service = new CorridaService(pool, new AuditRepository(pool), undefined, realtime, notifications);
  const locations = new LocalizacaoService(pool, service, realtime);
  router.use('/dashboard', createAuthenticate(tokens), createDashboardRouter(new DashboardService(new DashboardRepository(pool))));
  router.use('/relatorios', createAuthenticate(tokens), createRelatorioRouter(new RelatorioService(new RelatorioRepository(pool))));
  router.use(
    '/operacao',
    createAuthenticate(tokens),
    createOperacaoRouter(new OperacaoService(new OperacaoRepository(pool))),
  );
  router.use('/corridas/:id/localizacoes', createAuthenticate(tokens), createLocalizacaoRouter(locations));
  router.use('/corridas', createAuthenticate(tokens), createCorridaRouter(service));
  router.use('/enderecos', createAuthenticate(tokens), createEnderecoRouter(new EnderecoService(pool, geoapifyApiKey)));
  router.use('/notificacoes', createAuthenticate(tokens), createNotificacaoRouter(notifications));
  router.patch(
    '/prestadores/minha-disponibilidade',
    createAuthenticate(tokens),
    authorize('PRESTADOR'),
    validateBody(disponibilidadeSchema),
    asyncHandler(async (request, response) => {
      const result = await service.setAvailability(
        requireAuthContext(request), request.body as DisponibilidadeInput, auditMetadataFromRequest(request),
      );
      response.status(200).json({ data: result });
    }),
  );
  return router;
}
