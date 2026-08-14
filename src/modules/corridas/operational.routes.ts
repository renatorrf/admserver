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
import { createDispositivoRouter } from '../dispositivos/dispositivo.routes';
import { DispositivoService } from '../dispositivos/dispositivo.service';
import type { PushConfig } from '../../config/env';
import { createPainelParticipanteRouter } from '../paineis/painel.routes';
import { PainelParticipanteRepository } from '../paineis/painel.repository';
import { PainelParticipanteService } from '../paineis/painel.service';
import { createFaturamentoRouter } from '../faturamentos/faturamento.routes';
import { FaturamentoService } from '../faturamentos/faturamento.service';

export function createOperationalRouter(
  pool: Pool, tokens: TokenService, realtime?: RealtimeBus, geoapifyApiKey?: string, pushConfig?: PushConfig,
): Router {
  const router = Router();
  const notifications = new NotificacaoService(pool, pushConfig);
  const service = new CorridaService(pool, new AuditRepository(pool), undefined, realtime, notifications);
  const locations = new LocalizacaoService(pool, service, realtime);
  router.use('/dashboard', createAuthenticate(tokens), createDashboardRouter(new DashboardService(new DashboardRepository(pool))));
  router.use('/paineis', createAuthenticate(tokens), createPainelParticipanteRouter(
    new PainelParticipanteService(new PainelParticipanteRepository(pool)),
  ));
  router.use('/faturamentos', createAuthenticate(tokens), createFaturamentoRouter(
    new FaturamentoService(pool, new AuditRepository(pool), realtime),
  ));
  router.use('/relatorios', createAuthenticate(tokens), createRelatorioRouter(new RelatorioService(new RelatorioRepository(pool))));
  router.use(
    '/operacao',
    createAuthenticate(tokens),
    createOperacaoRouter(new OperacaoService(new OperacaoRepository(pool))),
  );
  router.use('/corridas/:id/localizacoes', createAuthenticate(tokens), createLocalizacaoRouter(locations));
  router.use('/corridas', createAuthenticate(tokens), createCorridaRouter(service));
  router.use('/enderecos', createAuthenticate(tokens), createEnderecoRouter(new EnderecoService(pool, geoapifyApiKey)));
  router.use('/push', createNotificacaoRouter(notifications, tokens));
  router.use('/dispositivos', createAuthenticate(tokens), createDispositivoRouter(new DispositivoService(pool)));
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
