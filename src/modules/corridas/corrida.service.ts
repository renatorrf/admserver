import type { Database, QueryExecutor } from '../../db/pool';
import { withTransaction } from '../../db/pool';
import { conflict, forbidden, invalidReference, notFound } from '../../shared/errors/app-error';
import type { PaginatedResult } from '../../shared/pagination/pagination';
import type { CorridaRealtimeEvent, CorridaRealtimePublisher } from '../../realtime/realtime-bus';
import type { AuthContext } from '../auth/auth.types';
import { driverRideContext, driverMemberships } from '../auth/driver-scope';
import type { AuditEntry, AuditMetadata } from '../auditoria/audit.types';
import { CorridaRepository, type CorridaPatch, type CorridaScope } from './corrida.repository';
import type {
  CorridaAcceptInput,
  CorridaAssignInput,
  CorridaCancelInput,
  CorridaCreateInput,
  CorridaFinishInput,
  CorridaListQuery,
  DisponibilidadeInput,
  EventoListQuery,
} from './corrida.schemas';
import { assertTransition, isActiveRide } from './state-machine';
import { employeeRide } from './corrida-visibility';
import { employeeEvent, type EmployeeHistoryScope } from './employee-history';
import { advanceItinerary, itineraryResolved, itinerarySchema, moneyCents, passengerTotal, type ItineraryAction, type ItineraryInput } from './itinerary';
import { commandHash, ItineraryRepository } from './itinerary.repository';
import { assertRouteNotStarted, type OptimizeRouteInput, type RideRouteOptimizer } from './route-optimizer';
import type {
  CorridaEventoRecord, CorridaRecord, FuncionarioContext, PrestadorContext, StatusCorrida,
} from './corrida.types';
import type { CorridaNotificationPublisher } from '../notificacoes/notificacao.service';
import type { ScheduledEmailQueue } from './scheduled-emails';
import type { TravelEmails } from '../requisicoes/travel-emails';
import {
  centerAllowed, OperationalScopeService, type OperationalScopeResolver,
} from '../escopo/operational-scope.service';

export interface CorridaAuditWriter {
  record(executor: QueryExecutor, entry: AuditEntry): Promise<void>;
}

export interface CorridaStore {
  assertVehicleCapacity?(executor: QueryExecutor, empresaId: string, ride: CorridaRecord, veiculoId: string): Promise<void>;
  list(empresaId: string, scope: CorridaScope, query: CorridaListQuery): Promise<PaginatedResult<CorridaRecord>>;
  findAccessible(executor: QueryExecutor, empresaId: string, id: string, scope: CorridaScope): Promise<CorridaRecord | null>;
  findForUpdate(executor: QueryExecutor, empresaId: string, id: string, scope: CorridaScope): Promise<CorridaRecord | null>;
  create(executor: QueryExecutor, empresaId: string, usuarioId: string, input: CorridaCreateInput): Promise<CorridaRecord>;
  updateAssignment(executor: QueryExecutor, empresaId: string, id: string, prestadorId: string, veiculoId: string | null): Promise<CorridaRecord>;
  changeStatus(executor: QueryExecutor, empresaId: string, id: string, status: StatusCorrida, patch?: CorridaPatch): Promise<CorridaRecord>;
  createEvent(
    executor: QueryExecutor, empresaId: string, corridaId: string, usuarioId: string, type: string,
    previousStatus: StatusCorrida | null, newStatus: StatusCorrida | null, description: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  markDisembark(executor: QueryExecutor, empresaId: string, id: string): Promise<CorridaRecord>;
  listEvents(empresaId: string, corridaId: string, query: EventoListQuery, employee?: EmployeeHistoryScope): Promise<PaginatedResult<CorridaEventoRecord>>;
  getProviderByUser(executor: QueryExecutor, empresaId: string, usuarioId: string, lock?: boolean): Promise<PrestadorContext | null>;
  getEmployeeByUser(executor: QueryExecutor, empresaId: string, usuarioId: string): Promise<FuncionarioContext | null>;
  validateProviderAndVehicle(
    executor: QueryExecutor, empresaId: string, prestadorId: string, veiculoId: string | null, requireAvailable: boolean,
  ): Promise<boolean>;
  validateEmployeeAndCenter(executor: QueryExecutor, empresaId: string, funcionarioId: string, centroCustoId: string): Promise<boolean>;
  validateEmployeeStops?(
    executor: QueryExecutor, empresaId: string, funcionarioIds: string[], centroCustoId: string,
  ): Promise<boolean>;
  managerCanAccessCenter(executor: QueryExecutor, empresaId: string, usuarioId: string, centroCustoId: string): Promise<boolean>;
  setProviderAvailability(executor: QueryExecutor, empresaId: string, prestadorId: string, available: boolean): Promise<PrestadorContext | null>;
  hasActiveRide(executor: QueryExecutor, empresaId: string, prestadorId: string): Promise<boolean>;
}

export type DisponibilidadeResult = {
  prestadorId: string;
  disponivel: boolean;
};
type Conference = (client: QueryExecutor) => Promise<{ existingId: string; input?: never; complete?: never }
  | { existingId?: never; input: CorridaCreateInput; complete(id: string): Promise<void> }>;

export class CorridaService {
  private readonly repository: CorridaStore;
  private readonly scopeResolver: OperationalScopeResolver;

  constructor(
    private readonly database: Database,
    private readonly audit: CorridaAuditWriter,
    repository?: CorridaStore,
    private readonly realtime?: CorridaRealtimePublisher,
    private readonly notifications?: CorridaNotificationPublisher,
    scopeResolver?: OperationalScopeResolver,
    private readonly scheduledEmails?: ScheduledEmailQueue,
    private readonly travelEmails?: TravelEmails,
  ) {
    this.repository = repository ?? new CorridaRepository(database);
    this.scopeResolver = scopeResolver ?? new OperationalScopeService(database);
  }

  async list(auth: AuthContext, query: CorridaListQuery): Promise<PaginatedResult<CorridaRecord>> {
    if (auth.perfil === 'PRESTADOR' && auth.contaMotoristaId) return this.repository.list(auth.empresaId, { kind: 'MOTORISTA', contaId: auth.contaMotoristaId }, query);
    const scope = await this.resolveScope(auth);
    const result = await this.repository.list(auth.empresaId, scope, query);
    return scope.kind === 'FUNCIONARIO' ? { ...result, data: result.data.map(ride => employeeRide(ride, scope.funcionarioId)) } : result;
  }

  async get(auth: AuthContext, id: string): Promise<CorridaRecord> {
    auth = await driverRideContext(this.database, auth, id);
    const scope = await this.resolveScope(auth);
    const ride = await this.repository.findAccessible(this.database, auth.empresaId, id, scope);
    if (!ride) throw notFound('Corrida');
    return scope.kind === 'FUNCIONARIO' ? employeeRide(ride, scope.funcionarioId) : ride;
  }

  async listEvents(
    auth: AuthContext,
    id: string,
    query: EventoListQuery,
  ): Promise<PaginatedResult<CorridaEventoRecord>> {
    auth = await driverRideContext(this.database, auth, id);
    const ride = await this.get(auth, id);
    const own = ride.itinerario?.participantes.find(person => person.funcionarioId === ride.funcionarioId);
    const audience = auth.perfil === 'FUNCIONARIO' ? { funcionarioId: ride.funcionarioId,
      embarqueId: own?.embarqueId, desembarqueId: own?.desembarqueId, legacy: !ride.itinerarioVersao } : undefined;
    const result = await this.repository.listEvents(auth.empresaId, id, query, audience);
    return audience ? { ...result, data: result.data.map(event => employeeEvent(event, audience)) } : result;
  }

  create(auth: AuthContext, input: CorridaCreateInput, metadata: AuditMetadata): Promise<CorridaRecord> {
    return this.createInternal(auth, input, metadata);
  }

  createConferred(auth: AuthContext, metadata: AuditMetadata, conference: Conference): Promise<CorridaRecord> {
    if (auth.perfil !== 'PORTARIA') throw forbidden();
    return this.createInternal(auth, undefined, metadata, conference);
  }

  private createInternal(auth: AuthContext, supplied: CorridaCreateInput | undefined, metadata: AuditMetadata, conference?: Conference): Promise<CorridaRecord> {
    if (!['GESTOR', 'GERENTE', 'PORTARIA'].includes(auth.perfil)) throw forbidden();
    if (supplied && !supplied.chaveSolicitacao && supplied.tipo === 'AGENDADA' && supplied.agendadaPara && supplied.agendadaPara.getTime() <= Date.now()) {
      throw conflict('A corrida agendada deve possuir data futura.');
    }
    let createdNow = true;
    return this.withRealtime(withTransaction(this.database, async (client) => {
      const checked = await conference?.(client);
      if (checked?.existingId) {
        createdNow = false;
        const existing = await this.repository.findForUpdate(client, auth.empresaId, checked.existingId, { kind: 'GESTOR' });
        if (!existing) throw notFound('Corrida');
        return existing;
      }
      const input = checked?.input ?? supplied!;
      const scope = await this.scopeResolver.resolve(auth, client);
      if (!centerAllowed(scope, input.centroCustoId)) {
        throw forbidden('Voce nao possui permissao para solicitar corridas para este funcionario ou centro de custo.');
      }
      if (input.chaveSolicitacao) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',
          [auth.empresaId, `${auth.usuarioId}:${input.chaveSolicitacao}`]);
        const previous = await client.query<{ id: string; solicitacao_hash: string }>(
          `SELECT id,solicitacao_hash FROM admtaxi.corridas WHERE empresa_id=$1
            AND solicitante_usuario_id=$2 AND solicitacao_chave=$3`, [auth.empresaId, auth.usuarioId, input.chaveSolicitacao]);
        if (previous.rows[0]) {
          if (previous.rows[0].solicitacao_hash !== commandHash(input)) throw conflict('Esta chave de solicitacao ja foi usada com outros dados.');
          createdNow = false;
          // The idempotency lookup above is scoped to the company and requester.
          if (auth.perfil === 'PORTARIA') {
            const existing = await this.repository.findForUpdate(client, auth.empresaId, previous.rows[0].id, { kind: 'GESTOR' });
            if (!existing || existing.solicitanteUsuarioId !== auth.usuarioId) throw notFound('Corrida');
            return existing;
          }
          return this.requireLockedRide(client, auth, previous.rows[0].id);
        }
      }
      if (input.tipo === 'AGENDADA' && input.agendadaPara && input.agendadaPara.getTime() <= Date.now()) {
        throw conflict('A corrida agendada deve possuir data futura.');
      }
      const policy = await client.query<{ modo_cobranca: string }>('SELECT modo_cobranca FROM admtaxi.empresas WHERE id=$1 FOR SHARE', [auth.empresaId]);
      const monthly = policy.rows[0]?.modo_cobranca === 'MENSAL_FIXO';
      if (monthly && (input.valorEstimado != null || input.itinerario?.participantes.some(p => p.valor !== undefined))) {
        throw invalidReference('Esta empresa utiliza mensalidade fixa. Reabra a solicitacao sem valores individuais.');
      }
      if (monthly && !input.itinerario) throw invalidReference('Informe os participantes e seus centros de custo para o rateio mensal.');
      if (input.itinerario) await this.validateItinerary(client, auth, input.itinerario, input.funcionarioId, input.centroCustoId, monthly);
      if (!input.itinerario && !await this.repository.validateEmployeeAndCenter(client, auth.empresaId, input.funcionarioId, input.centroCustoId)) {
        throw invalidReference('Funcionario e centro de custo devem estar ativos, vinculados e pertencer a mesma empresa.');
      }
      const employeeStopIds = (input.paradas ?? [])
        .filter((stop) => stop.tipo === 'FUNCIONARIO')
        .map((stop) => stop.funcionarioId);
      if (employeeStopIds.includes(input.funcionarioId) || new Set(employeeStopIds).size !== employeeStopIds.length) {
        throw invalidReference('Nao repita funcionarios no itinerario.');
      }
      if (input.quantidadePassageiros < employeeStopIds.length + 1) {
        throw invalidReference('A quantidade de passageiros deve incluir os funcionarios adicionais.');
      }
      if (employeeStopIds.length && (!this.repository.validateEmployeeStops
        || !await this.repository.validateEmployeeStops(client, auth.empresaId, employeeStopIds, input.centroCustoId))) {
        throw invalidReference('Funcionarios adicionais devem estar ativos, pertencer ao centro de custo e possuir endereco padrao localizado.');
      }
      const created = await this.repository.create(client, auth.empresaId, auth.usuarioId, input);
      await this.repository.createEvent(
        client, auth.empresaId, created.id, auth.usuarioId, 'CORRIDA_SOLICITADA', null, 'SOLICITADA',
        'Corrida solicitada.',
      );
      await this.recordAudit(client, auth, metadata, created, 'CRIAR', null, created);
      if (checked?.complete) await checked.complete(created.id);
      else await this.scheduledEmails?.enqueue(client, created);
      return created;
    }), async ride => { if (createdNow) { await this.notifications?.publishRideCreated(ride); this.scheduledEmails?.kick(); this.travelEmails?.kick(); } });
  }

  assign(auth: AuthContext, id: string, input: CorridaAssignInput, metadata: AuditMetadata): Promise<CorridaRecord> {
    this.requireManager(auth);
    let notificationEvent: 'ATRIBUIDA' | 'ALTERADA' = 'ATRIBUIDA';
    let previousProviderId: string | null = null;
    return this.withRealtime(withTransaction(this.database, async (client) => {
      const current = await this.requireLockedRide(client, auth, id);
      previousProviderId = current.prestadorId;
      if (current.status !== 'SOLICITADA' && current.status !== 'OFERTADA') {
        throw conflict('Somente corridas solicitadas ou ofertadas podem receber prestador.');
      }
      const vehicleId = input.veiculoId ?? null;
      if (!await this.repository.validateProviderAndVehicle(client, auth.empresaId, input.prestadorId, vehicleId, true)) {
        throw invalidReference('Prestador ou veiculo invalido, inativo, indisponivel ou pertencente a outra empresa.');
      }
      if (vehicleId) await this.repository.assertVehicleCapacity?.(client, auth.empresaId, current, vehicleId);

      let updated: CorridaRecord;
      if (current.status === 'SOLICITADA') {
        assertTransition(current.status, 'OFERTADA');
        updated = await this.repository.changeStatus(client, auth.empresaId, id, 'OFERTADA', {
          prestadorId: input.prestadorId, veiculoId: vehicleId,
        });
      } else {
        notificationEvent = 'ALTERADA';
        updated = await this.repository.updateAssignment(client, auth.empresaId, id, input.prestadorId, vehicleId);
      }
      await this.repository.createEvent(
        client, auth.empresaId, id, auth.usuarioId,
        current.status === 'SOLICITADA' ? 'CORRIDA_OFERTADA' : 'ATRIBUICAO_ALTERADA',
        current.status, updated.status, 'Prestador atribuido a corrida.',
        { prestadorAnteriorId: current.prestadorId, prestadorNovoId: input.prestadorId, veiculoId: vehicleId },
      );
      await this.recordAudit(client, auth, metadata, updated, 'ATRIBUIR', current, updated);
      return updated;
    }), async ride => {
      await this.notifications?.publishProviderRide(ride, notificationEvent);
      this.notifications?.publishRideUpdate(ride, 'ATRIBUICAO_ALTERADA');
      if (previousProviderId && previousProviderId !== ride.prestadorId) {
        await this.notifications?.publishProviderRide({ ...ride, prestadorId: previousProviderId }, 'REMOVIDA');
      }
    });
  }

  reopen(auth: AuthContext, id: string, metadata: AuditMetadata): Promise<CorridaRecord> {
    this.requireManager(auth);
    return this.withRealtime(withTransaction(this.database, async (client) => {
      const current = await this.requireLockedRide(client, auth, id);
      assertTransition(current.status, 'SOLICITADA');
      const updated = await this.repository.changeStatus(client, auth.empresaId, id, 'SOLICITADA', {
        prestadorId: null, veiculoId: null,
      });
      await this.repository.createEvent(
        client, auth.empresaId, id, auth.usuarioId, 'CORRIDA_REABERTA', current.status, 'SOLICITADA',
        'Corrida reaberta para nova atribuicao.',
      );
      await this.recordAudit(client, auth, metadata, updated, 'REABRIR', current, updated);
      return updated;
    }), ride => this.notifications?.publishRideCreated(ride));
  }

  async accept(auth: AuthContext, id: string, input: CorridaAcceptInput, metadata: AuditMetadata): Promise<CorridaRecord> {
    auth = await driverRideContext(this.database, auth, id);
    this.requireProvider(auth);
    let changed = true;
    return this.withRealtime(withTransaction(this.database, async (client) => {
      const current = await this.requireLockedRide(client, auth, id);
      const provider = await this.requireProviderContext(client, auth, true);
      if (current.prestadorId === provider.id && current.aceitaEm && (!input.veiculoId || input.veiculoId === current.veiculoId)) {
        changed = false;
        return current;
      }
      if (current.status !== 'SOLICITADA' && current.status !== 'OFERTADA') {
        throw conflict('Esta corrida já foi aceita por outro prestador.');
      }
      if (!provider.disponivel || await this.repository.hasActiveRide(client, auth.empresaId, provider.id)) {
        throw conflict('O prestador nao esta disponivel para aceitar outra corrida.');
      }
      if (current.status === 'OFERTADA' && current.prestadorId !== provider.id) throw forbidden();
      if (current.status === 'SOLICITADA' && current.prestadorId !== null) throw conflict('A corrida ja possui prestador.');
      if (current.tipo === 'AGENDADA' && (!current.agendadaPara
        || !Number.isFinite(new Date(current.agendadaPara).getTime())
        || new Date(current.agendadaPara).getTime() - Date.now() > 60 * 60 * 1000)) {
        throw conflict('O aceite desta corrida sera liberado uma hora antes do horario agendado.');
      }

      const vehicleId = input.veiculoId ?? current.veiculoId;
      if (!vehicleId || !await this.repository.validateProviderAndVehicle(
        client, auth.empresaId, provider.id, vehicleId, true,
      )) {
        throw invalidReference('Selecione um veiculo ativo vinculado ao prestador.');
      }
      await this.repository.assertVehicleCapacity?.(client, auth.empresaId, current, vehicleId);

      let offered = current;
      if (current.status === 'SOLICITADA') {
        assertTransition('SOLICITADA', 'OFERTADA');
        offered = await this.repository.changeStatus(client, auth.empresaId, id, 'OFERTADA', {
          prestadorId: provider.id, veiculoId: vehicleId,
        });
        await this.repository.createEvent(
          client, auth.empresaId, id, auth.usuarioId, 'CORRIDA_REIVINDICADA', 'SOLICITADA', 'OFERTADA',
          'Prestador selecionou uma corrida disponivel.', { prestadorId: provider.id, veiculoId: vehicleId },
        );
      } else if (current.veiculoId !== vehicleId) {
        offered = await this.repository.updateAssignment(client, auth.empresaId, id, provider.id, vehicleId);
      }

      assertTransition(offered.status, 'ACEITA');
      const accepted = await this.repository.changeStatus(client, auth.empresaId, id, 'ACEITA');
      await this.repository.setProviderAvailability(client, auth.empresaId, provider.id, false);
      await this.repository.createEvent(
        client, auth.empresaId, id, auth.usuarioId, 'CORRIDA_ACEITA', offered.status, 'ACEITA',
        'Corrida aceita pelo prestador.', { prestadorId: provider.id, veiculoId: vehicleId },
      );
      await this.recordAudit(client, auth, metadata, accepted, 'ACEITAR', current, accepted);
      return accepted;
    }), ride => { if (changed) this.notifications?.publishRideUpdate(ride, 'ACEITA'); });
  }

  async refuse(auth: AuthContext, id: string, metadata: AuditMetadata): Promise<CorridaRecord> {
    auth = await driverRideContext(this.database, auth, id);
    this.requireProvider(auth);
    return this.withRealtime(withTransaction(this.database, async (client) => {
      const current = await this.requireLockedRide(client, auth, id);
      const provider = await this.requireProviderContext(client, auth, false);
      if (current.prestadorId !== provider.id) throw forbidden();
      assertTransition(current.status, 'RECUSADA');
      const refused = await this.repository.changeStatus(client, auth.empresaId, id, 'RECUSADA');
      await this.repository.createEvent(
        client, auth.empresaId, id, auth.usuarioId, 'CORRIDA_RECUSADA', current.status, 'RECUSADA',
        'Corrida recusada pelo prestador.', { prestadorId: provider.id },
      );
      await this.recordAudit(client, auth, metadata, refused, 'RECUSAR', current, refused);
      return refused;
    }));
  }

  startDisplacement(auth: AuthContext, id: string, metadata: AuditMetadata): Promise<CorridaRecord> {
    return this.providerTransition(auth, id, 'EM_DESLOCAMENTO', 'DESLOCAMENTO_INICIADO', 'Prestador iniciou o deslocamento.', metadata);
  }

  arrive(auth: AuthContext, id: string, metadata: AuditMetadata): Promise<CorridaRecord> {
    return this.providerTransition(auth, id, 'AGUARDANDO_PASSAGEIRO', 'CHEGADA_AO_EMBARQUE', 'Prestador chegou ao embarque.', metadata);
  }

  board(auth: AuthContext, id: string, metadata: AuditMetadata): Promise<CorridaRecord> {
    return this.providerTransition(auth, id, 'EM_CORRIDA', 'PASSAGEIRO_EMBARCOU', 'Passageiro embarcou e a corrida iniciou.', metadata);
  }

  async disembark(auth: AuthContext, id: string, metadata: AuditMetadata): Promise<CorridaRecord> {
    auth = await driverRideContext(this.database, auth, id);
    this.requireProvider(auth);
    return this.withRealtime(withTransaction(this.database, async (client) => {
      const current = await this.requireLockedRide(client, auth, id);
      const provider = await this.requireProviderContext(client, auth, true);
      if (current.prestadorId !== provider.id) throw forbidden();
      if (current.itinerarioVersao) throw conflict('Confirme cada desembarque no itinerario individual.');
      if (current.status !== 'EM_CORRIDA') throw conflict('O desembarque so pode ser confirmado durante a corrida.');
      if (current.desembarqueEm) return current;
      const updated = await this.repository.markDisembark(client, auth.empresaId, id);
      await this.repository.createEvent(
        client, auth.empresaId, id, auth.usuarioId, 'DESEMBARQUE_CONFIRMADO', 'EM_CORRIDA', 'EM_CORRIDA',
        'Desembarque do passageiro confirmado.', { prestadorId: provider.id },
      );
      await this.recordAudit(client, auth, metadata, updated, 'CONFIRMAR_DESEMBARQUE', current, updated);
      return updated;
    }));
  }

  async finish(auth: AuthContext, id: string, input: CorridaFinishInput, metadata: AuditMetadata): Promise<CorridaRecord> {
    auth = await driverRideContext(this.database, auth, id);
    this.requireProvider(auth);
    let changed = true;
    return this.withRealtime(withTransaction(this.database, async (client) => {
      const current = await this.requireLockedRide(client, auth, id);
      const provider = await this.requireProviderContext(client, auth, true);
      if (current.prestadorId !== provider.id) throw forbidden();
      const monthly = current.modoCobranca === 'MENSAL_FIXO';
      if (!monthly && input.valorFinal === undefined) throw invalidReference('Informe o valor final da corrida.');
      if (monthly && input.valorFinal !== undefined) throw invalidReference('A corrida mensal nao possui valor individual.');
      const finalValue = monthly ? null : input.valorFinal!;
      if (current.status === 'FINALIZADA') {
        if (Number(current.valorFinal) !== Number(finalValue)
          || (current.observacaoPrestador ?? null) !== (input.observacaoPrestador ?? null)) throw conflict('A corrida ja foi finalizada com outros dados.');
        changed = false;
        return current;
      }
      if (current.itinerarioVersao) {
        const itinerary = await new ItineraryRepository().load(client, auth.empresaId, id, current.itinerarioVersao);
        if (!itineraryResolved(itinerary)) throw conflict('Conclua todas as paradas e resolva todos os passageiros antes de finalizar.');
        const total = passengerTotal(itinerary);
        if (!monthly && total !== undefined && moneyCents(total) !== moneyCents(input.valorFinal!)) {
          throw conflict(`O valor final deve corresponder a soma dos valores individuais: R$ ${total.replace('.', ',')}.`);
        }
      }
      if (!current.desembarqueEm) throw conflict('Confirme o desembarque antes de finalizar a corrida.');
      assertTransition(current.status, 'FINALIZADA');
      const finished = await this.repository.changeStatus(client, auth.empresaId, id, 'FINALIZADA', {
        valorFinal: finalValue,
        observacaoPrestador: input.observacaoPrestador ?? null,
      });
      await this.repository.setProviderAvailability(client, auth.empresaId, provider.id, true);
      await this.repository.createEvent(
        client, auth.empresaId, id, auth.usuarioId, 'CORRIDA_FINALIZADA', current.status, 'FINALIZADA',
        'Corrida finalizada.', { valorFinal: input.valorFinal },
      );
      await this.recordAudit(client, auth, metadata, finished, 'FINALIZAR', current, finished);
      await this.travelEmails?.completed(client, auth.empresaId, id);
      return finished;
    }), ride => { if (changed) { this.notifications?.publishRideUpdate(ride, 'FINALIZADA'); this.travelEmails?.kick(); } });
  }

  async cancel(auth: AuthContext, id: string, input: CorridaCancelInput, metadata: AuditMetadata): Promise<CorridaRecord> {
    auth = await driverRideContext(this.database, auth, id);
    if (!['GESTOR', 'GERENTE'].includes(auth.perfil)) throw forbidden();
    let changed = true;
    return this.withRealtime(withTransaction(this.database, async (client) => {
      const current = await this.requireLockedRide(client, auth, id);
      if (current.status === 'CANCELADA') {
        if (current.motivoCancelamento !== input.motivo) throw conflict('Corrida ja cancelada com outro motivo.');
        changed = false;
        return current;
      }
      if (auth.perfil === 'GERENTE') {
        if (current.status !== 'SOLICITADA' && current.status !== 'OFERTADA') {
          throw conflict('O gerente so pode cancelar corridas solicitadas ou ofertadas.');
        }
      } else if (!['SOLICITADA', 'OFERTADA', 'ACEITA'].includes(current.status)) {
        throw conflict('A corrida nao pode mais ser cancelada.');
      }
      assertTransition(current.status, 'CANCELADA');
      if (current.itinerarioVersao) {
        await client.query(`UPDATE admtaxi.corrida_participacoes SET estado='CANCELADO',motivo=$3
          WHERE empresa_id=$1 AND corrida_id=$2 AND estado='AGUARDANDO'`, [auth.empresaId, id, input.motivo]);
      }
      const cancelled = await this.repository.changeStatus(client, auth.empresaId, id, 'CANCELADA', {
        motivoCancelamento: input.motivo,
      });
      if (current.prestadorId && isActiveRide(current.status)) {
        await this.repository.setProviderAvailability(client, auth.empresaId, current.prestadorId, true);
      }
      await this.repository.createEvent(
        client, auth.empresaId, id, auth.usuarioId, 'CORRIDA_CANCELADA', current.status, 'CANCELADA',
        'Corrida cancelada.', { motivo: input.motivo },
      );
      await this.recordAudit(client, auth, metadata, cancelled, 'CANCELAR', current, cancelled);
      return cancelled;
    }), ride => {
      if (!changed) return;
      this.notifications?.publishProviderRide(ride, 'CANCELADA');
      this.notifications?.publishRideUpdate(ride, 'CANCELADA');
    });
  }

  setAvailability(
    auth: AuthContext,
    input: DisponibilidadeInput,
    metadata: AuditMetadata,
  ): Promise<DisponibilidadeResult> {
    this.requireProvider(auth);
    return withTransaction(this.database, async (client) => {
      if (auth.contaMotoristaId) {
        await client.query('SELECT id FROM admtaxi.contas_motorista WHERE id=$1 FOR UPDATE', [auth.contaMotoristaId]);
        const members = await driverMemberships(client, auth);
        if (!members.length) throw forbidden();
        const primary = members[0]!;
        if (input.disponivel && await this.repository.hasActiveRide(client, primary.empresa_id, primary.prestador_id)) throw conflict('Finalize a corrida ativa antes de ficar disponivel.');
        for (const member of members) {
          await this.repository.setProviderAvailability(client, member.empresa_id, member.prestador_id, input.disponivel);
          await this.audit.record(client, { ...metadata, empresaId: member.empresa_id, usuarioId: member.usuario_id,
            entidade: 'prestador', entidadeId: member.prestador_id, acao: 'ALTERAR_DISPONIBILIDADE', dadosNovos: { disponivel: input.disponivel } });
        }
        return { prestadorId: primary.prestador_id, disponivel: input.disponivel };
      }
      const provider = await this.requireProviderContext(client, auth, true);
      if (input.disponivel && await this.repository.hasActiveRide(client, auth.empresaId, provider.id)) {
        throw conflict('Finalize ou cancele a corrida ativa antes de ficar disponivel.');
      }
      if (provider.disponivel === input.disponivel) {
        return { prestadorId: provider.id, disponivel: provider.disponivel };
      }
      const updated = await this.repository.setProviderAvailability(
        client, auth.empresaId, provider.id, input.disponivel,
      );
      if (!updated) throw notFound('Prestador');
      await this.audit.record(client, {
        ...metadata, empresaId: auth.empresaId, usuarioId: auth.usuarioId,
        entidade: 'prestador', entidadeId: provider.id, acao: 'ALTERAR_DISPONIBILIDADE',
        dadosAnteriores: { disponivel: provider.disponivel }, dadosNovos: { disponivel: updated.disponivel },
      });
      return { prestadorId: provider.id, disponivel: updated.disponivel };
    });
  }

  private async providerTransition(
    auth: AuthContext,
    id: string,
    target: StatusCorrida,
    eventType: string,
    description: string,
    metadata: AuditMetadata,
  ): Promise<CorridaRecord> {
    auth = await driverRideContext(this.database, auth, id);
    this.requireProvider(auth);
    let changed = true;
    return this.withRealtime(withTransaction(this.database, async (client) => {
      const current = await this.requireLockedRide(client, auth, id);
      const provider = await this.requireProviderContext(client, auth, true);
      if (current.prestadorId !== provider.id) throw forbidden();
      if (current.itinerarioVersao) throw conflict('Execute as acoes na proxima parada do itinerario.');
      if (current.status === target) { changed = false; return current; }
      assertTransition(current.status, target);
      const updated = await this.repository.changeStatus(client, auth.empresaId, id, target);
      await this.repository.createEvent(
        client, auth.empresaId, id, auth.usuarioId, eventType, current.status, target, description,
        { prestadorId: provider.id },
      );
      await this.recordAudit(client, auth, metadata, updated, eventType, current, updated);
      return updated;
    }), ride => {
      const notificationEvents = {
        DESLOCAMENTO_INICIADO: 'DESLOCAMENTO_INICIADO',
        CHEGADA_AO_EMBARQUE: 'CHEGADA_AO_EMBARQUE',
        PASSAGEIRO_EMBARCOU: 'CORRIDA_INICIADA',
      } as const;
      const event = notificationEvents[eventType as keyof typeof notificationEvents];
      if (event && changed) this.notifications?.publishRideUpdate(ride, event);
    });
  }

  editItinerary(auth: AuthContext, id: string, version: number, input: ItineraryInput, metadata: AuditMetadata): Promise<CorridaRecord> {
    if (!['GESTOR', 'GERENTE'].includes(auth.perfil)) throw forbidden();
    return this.withRealtime(withTransaction(this.database, async client => {
      const ride = await this.requireLockedRide(client, auth, id);
      if (!ride.itinerarioVersao || ride.itinerarioVersao !== version) throw conflict('Itinerario desatualizado. Recarregue a viagem.');
      if (!['SOLICITADA', 'OFERTADA'].includes(ride.status)) throw conflict('Edicao permitida somente antes do aceite.');
      const store = new ItineraryRepository();
      const previous = await store.load(client, auth.empresaId, id, version);
      input = { ...input, participantes: input.participantes.map(p => {
        const old = previous.participantes.find(item => item.funcionarioId === p.funcionarioId);
        return { ...p, centroCustoId: p.centroCustoId ?? old?.centroCustoId, valor: p.valor ?? old?.valor };
      }) };
      await this.validateItinerary(client, auth, input, ride.funcionarioId, ride.centroCustoId, ride.modoCobranca === 'MENSAL_FIXO');
      if (previous.participantes.some(p => !input.participantes.some(next => next.funcionarioId === p.funcionarioId))) {
        throw conflict('Reassocie os passageiros; nao remova participacoes silenciosamente. Para cancelar a viagem, use cancelamento com motivo.');
      }
      await store.replace(client, auth.empresaId, id, input);
      const updated = await this.requireLockedRide(client, auth, id);
      if (ride.veiculoId) await this.repository.assertVehicleCapacity?.(client, auth.empresaId, updated, ride.veiculoId);
      await this.repository.createEvent(client, auth.empresaId, id, auth.usuarioId, 'ITINERARIO_EDITADO', ride.status, ride.status,
        'Itinerario atualizado antes do aceite.', { versao: version + 1 });
      await this.audit.record(client, { ...metadata, empresaId: auth.empresaId, usuarioId: auth.usuarioId,
        entidade: 'corrida', entidadeId: id, acao: 'EDITAR_ITINERARIO', dadosAnteriores: previous, dadosNovos: input });
      return updated;
    }), ride => this.notifications?.publishItineraryUpdate?.(ride));
  }

  async optimizeRoute(auth: AuthContext, id: string, input: OptimizeRouteInput, optimizer: RideRouteOptimizer, metadata: AuditMetadata): Promise<CorridaRecord> {
    auth = await driverRideContext(this.database, auth, id);
    this.requireProvider(auth);
    const store = new ItineraryRepository();
    const initial = await withTransaction(this.database, async client => {
      const ride = await this.requireLockedRide(client, auth, id);
      const provider = await this.requireProviderContext(client, auth, true);
      if (ride.prestadorId !== provider.id) throw forbidden();
      const snapshot = await store.load(client, auth.empresaId, id, ride.itinerarioVersao ?? 0);
      assertRouteNotStarted(ride, snapshot, input.versao);
      const vehicle = await client.query<{ capacidade: number }>(
        'SELECT capacidade_passageiros AS capacidade FROM admtaxi.veiculos WHERE empresa_id=$1 AND id=$2 AND ativo=TRUE',
        [auth.empresaId, ride.veiculoId]);
      if (!vehicle.rows[0]?.capacidade) throw invalidReference('Veiculo indisponivel para calcular o trajeto.');
      return { ride, snapshot, capacity: vehicle.rows[0].capacidade };
    });
    // The external request must not hold ride/provider database locks.
    const candidate = await optimizer.optimize(initial.snapshot, input, initial.capacity);
    return this.withRealtime(withTransaction(this.database, async client => {
      const ride = await this.requireLockedRide(client, auth, id);
      const provider = await this.requireProviderContext(client, auth, true);
      if (ride.prestadorId !== provider.id) throw forbidden();
      const previous = await store.load(client, auth.empresaId, id, ride.itinerarioVersao ?? 0);
      assertRouteNotStarted(ride, previous, input.versao);
      if (ride.veiculoId !== initial.ride.veiculoId) throw conflict('O veiculo foi alterado. Calcule novamente.');
      await store.replace(client, auth.empresaId, id, candidate);
      const updated = await this.requireLockedRide(client, auth, id);
      await store.assertCapacity(client, auth.empresaId, id, ride.veiculoId!, candidate.participantes.length, updated.itinerarioVersao!);
      await this.repository.createEvent(client, auth.empresaId, id, auth.usuarioId, 'TRAJETO_CALCULADO', ride.status, ride.status,
        'Trajeto calculado a partir da localizacao do motorista.', { versao: input.versao + 1 });
      await this.audit.record(client, { ...metadata, empresaId: auth.empresaId, usuarioId: auth.usuarioId,
        entidade: 'corrida', entidadeId: id, acao: 'CALCULAR_TRAJETO', dadosAnteriores: previous, dadosNovos: candidate });
      return updated;
    }), ride => this.notifications?.publishItineraryUpdate?.(ride));
  }

  async executeItinerary(auth: AuthContext, id: string, action: ItineraryAction, metadata: AuditMetadata): Promise<CorridaRecord> {
    auth = await driverRideContext(this.database, auth, id);
    this.requireProvider(auth);
    let changed = false;
    return this.withRealtime(withTransaction(this.database, async client => {
      let ride = await this.requireLockedRide(client, auth, id);
      const provider = await this.requireProviderContext(client, auth, true);
      if (ride.prestadorId !== provider.id) throw forbidden();
      const hash = commandHash({ usuarioId: auth.usuarioId, ...action });
      const previous = await client.query<{ comando_hash: string }>(
        'SELECT comando_hash FROM admtaxi.corrida_comandos WHERE empresa_id=$1 AND corrida_id=$2 AND chave=$3',
        [auth.empresaId, id, action.chave]);
      if (previous.rows[0]) {
        if (previous.rows[0].comando_hash !== hash) throw conflict('Chave de operacao ja utilizada com outros dados.');
        return ride;
      }
      if (!ride.itinerarioVersao || !isActiveRide(ride.status)) throw conflict('Esta viagem nao permite executar paradas.');
      const store = new ItineraryRepository();
      const current = await store.load(client, auth.empresaId, id, ride.itinerarioVersao);
      const next = advanceItinerary(current, action, new Date().toISOString());
      if (ride.veiculoId) await this.repository.assertVehicleCapacity?.(client, auth.empresaId, ride, ride.veiculoId);
      await store.saveExecution(client, auth.empresaId, id, next);
      const previousStatus = ride.status;
      if (ride.status === 'ACEITA' && action.acao === 'INICIAR') ride = await this.repository.changeStatus(client, auth.empresaId, id, 'EM_DESLOCAMENTO');
      if (ride.status === 'EM_DESLOCAMENTO' && action.acao === 'CHEGAR') ride = await this.repository.changeStatus(client, auth.empresaId, id, 'AGUARDANDO_PASSAGEIRO');
      if (ride.status === 'AGUARDANDO_PASSAGEIRO' && ['EMBARCAR', 'CONCLUIR'].includes(action.acao)) ride = await this.repository.changeStatus(client, auth.empresaId, id, 'EM_CORRIDA');
      if (action.avancoAutomatico && ride.status === 'AGUARDANDO_PASSAGEIRO'
        && (next.paradas.find(p => p.estado !== 'CONCLUIDA')?.estado === 'EM_DESLOCAMENTO' || itineraryResolved(next))) {
        ride = await this.repository.changeStatus(client, auth.empresaId, id, 'EM_CORRIDA');
      }
      if (itineraryResolved(next)) ride = await this.repository.markDisembark(client, auth.empresaId, id);
      await client.query(`INSERT INTO admtaxi.corrida_comandos (empresa_id,corrida_id,chave,comando_hash,versao)
        VALUES ($1,$2,$3,$4,$5)`, [auth.empresaId, id, action.chave, hash, next.versao]);
      const stop = next.paradas.find(p => p.id === action.paradaId)!;
      const passenger = next.participantes.find(p => p.funcionarioId === action.funcionarioId);
      const descriptions: Record<ItineraryAction['acao'], string> = {
        INICIAR: previousStatus === 'ACEITA' ? 'Corrida iniciada' : 'Deslocamento iniciado',
        CHEGAR: 'Chegada registrada', EMBARCAR: 'Embarque confirmado', DESEMBARCAR: 'Desembarque confirmado',
        AUSENTE: 'Ausencia registrada', CANCELAR_PASSAGEIRO: 'Participacao cancelada', CONCLUIR: 'Atendimento concluido',
      };
      await this.repository.createEvent(client, auth.empresaId, id, auth.usuarioId, `PARADA_${action.acao}`,
        previousStatus, ride.status, `${descriptions[action.acao]}${passenger ? `: ${passenger.funcionarioNome}` : ''}. Parada ${stop.ordem}: ${stop.descricao}`,
        { paradaId: action.paradaId, funcionarioId: action.funcionarioId, versao: next.versao });
      if (action.avancoAutomatico && stop.estado === 'CONCLUIDA') {
        for (const skipped of next.paradas.filter(p => p.id !== stop.id && p.estado === 'CONCLUIDA'
          && current.paradas.find(before => before.id === p.id)?.estado === 'PENDENTE')) {
          await this.repository.createEvent(client, auth.empresaId, id, auth.usuarioId, 'PARADA_DISPENSADA', ride.status, ride.status,
            `Parada ${skipped.ordem} dispensada: sem passageiros a atender. ${skipped.descricao}`, { paradaId: skipped.id, versao: next.versao });
        }
        if (action.acao !== 'CONCLUIR') await this.repository.createEvent(client, auth.empresaId, id, auth.usuarioId,
          'PARADA_CONCLUIR', ride.status, ride.status, `Atendimento concluido. Parada ${stop.ordem}: ${stop.descricao}`,
          { paradaId: stop.id, versao: next.versao });
        const following = next.paradas.find(p => p.estado === 'EM_DESLOCAMENTO');
        if (following) await this.repository.createEvent(client, auth.empresaId, id, auth.usuarioId,
          'PARADA_INICIAR', ride.status, ride.status, `A caminho da parada ${following.ordem}: ${following.descricao}`,
          { paradaId: following.id, versao: next.versao });
      }
      await this.audit.record(client, { ...metadata, empresaId: auth.empresaId, usuarioId: auth.usuarioId,
        entidade: 'corrida', entidadeId: id, acao: `PARADA_${action.acao}`, dadosAnteriores: current, dadosNovos: next });
      changed = true;
      return ride;
    }), ride => { if (changed) this.notifications?.publishItineraryUpdate?.(ride, action); });
  }

  private async validateItinerary(client: QueryExecutor, auth: AuthContext, input: ItineraryInput, primary: string, center: string, monthly = false): Promise<void> {
    itinerarySchema.parse(input);
    if (!input.participantes.some(p => p.funcionarioId === primary)) throw invalidReference('Mantenha o funcionario principal entre os participantes.');
    const total = passengerTotal(input);
    if (monthly && total !== undefined) throw invalidReference('O modo mensal nao permite valores individuais.');
    if (!monthly && total === undefined && input.participantes.some(p => p.centroCustoId && p.centroCustoId !== center)) {
      throw invalidReference('Informe os valores individuais para utilizar centros de custo diferentes.');
    }
    const scope = await this.scopeResolver.resolve(auth, client);
    for (const participant of input.participantes) {
      const selectedCenter = participant.centroCustoId ?? center;
      if (participant.funcionarioId === primary && selectedCenter !== center) throw invalidReference('O centro principal deve corresponder ao primeiro funcionario.');
      if (!centerAllowed(scope, selectedCenter)) throw forbidden('Centro de custo do participante fora do seu escopo.');
      if (!participant.centroCustoId) {
        if (!await this.repository.validateEmployeeAndCenter(client, auth.empresaId, participant.funcionarioId, selectedCenter)) {
          throw invalidReference('Funcionario e centro de custo devem estar ativos e vinculados.');
        }
      } else {
        const employee = await client.query<{ centro_custo_id: string; avulso: boolean }>(`SELECT f.centro_custo_id,f.avulso FROM admtaxi.funcionarios f
          JOIN admtaxi.centros_custo home ON home.empresa_id=f.empresa_id AND home.id=f.centro_custo_id AND (home.ativo OR f.avulso)
          JOIN admtaxi.setores hs ON hs.empresa_id=home.empresa_id AND hs.id=home.setor_id AND (hs.ativo OR f.avulso)
          JOIN admtaxi.centros_custo cc ON cc.empresa_id=f.empresa_id AND cc.id=$3 AND cc.ativo
          JOIN admtaxi.setores s ON s.empresa_id=cc.empresa_id AND s.id=cc.setor_id AND s.ativo
          WHERE f.empresa_id=$1 AND f.id=$2 AND f.ativo`, [auth.empresaId, participant.funcionarioId, selectedCenter]);
        if (!employee.rows[0]) throw invalidReference('Funcionario e centro de custo devem estar ativos na empresa.');
        if (!employee.rows[0].avulso && !centerAllowed(scope, employee.rows[0].centro_custo_id)) throw forbidden('Funcionario fora do seu escopo.');
      }
    }
  }

  private async withRealtime(
    operation: Promise<CorridaRecord>, afterCommit?: (ride: CorridaRecord) => void | Promise<void>,
  ): Promise<CorridaRecord> {
    const ride = await operation;
    const complete = await this.repository.findAccessible(
      this.database, ride.empresaId, ride.id, { kind: 'GESTOR' },
    ) ?? ride;
    this.realtime?.publishRide(complete, this.realtimeEvent(complete));
    await afterCommit?.(complete);
    return complete;
  }

  private realtimeEvent(ride: CorridaRecord): CorridaRealtimeEvent {
    if (ride.status === 'SOLICITADA') return 'corrida:criada';
    if (ride.status === 'OFERTADA') return 'corrida:ofertada';
    if (ride.status === 'ACEITA') return 'corrida:aceita';
    if (ride.status === 'FINALIZADA') return 'corrida:finalizada';
    if (ride.status === 'CANCELADA') return 'corrida:cancelada';
    return 'corrida:status-alterado';
  }

  private async resolveScope(auth: AuthContext, executor: QueryExecutor = this.database): Promise<CorridaScope> {
    if (auth.perfil === 'PORTARIA') throw forbidden('Portaria pode solicitar corridas e consultar suas notificacoes.');
    if (auth.perfil === 'GESTOR' || auth.perfil === 'GERENTE') {
      const scope = await this.scopeResolver.resolve(auth, executor);
      return scope.kind !== 'GERENTE'
        ? { kind: 'GESTOR' }
        : {
          kind: 'GERENTE', usuarioId: scope.usuarioId,
          setorIds: scope.setorIds, centroCustoIds: scope.centroCustoIds,
        };
    }
    if (auth.perfil === 'PRESTADOR') {
      const provider = await this.requireProviderContext(executor, auth, false);
      return { kind: 'PRESTADOR', prestadorId: provider.id, disponivel: provider.disponivel };
    }
    const employee = await this.repository.getEmployeeByUser(executor, auth.empresaId, auth.usuarioId);
    if (!employee || !employee.ativo) throw forbidden();
    return { kind: 'FUNCIONARIO', funcionarioId: employee.id };
  }

  private async requireProviderContext(
    executor: QueryExecutor,
    auth: AuthContext,
    lock: boolean,
  ): Promise<PrestadorContext> {
    const provider = await this.repository.getProviderByUser(executor, auth.empresaId, auth.usuarioId, lock);
    if (!provider || !provider.ativo) throw forbidden();
    return provider;
  }

  private async requireLockedRide(executor: QueryExecutor, auth: AuthContext, id: string): Promise<CorridaRecord> {
    const ride = await this.repository.findForUpdate(executor, auth.empresaId, id, await this.resolveScope(auth, executor));
    if (!ride) throw notFound('Corrida');
    return ride;
  }

  private requireManager(auth: AuthContext): void {
    if (auth.perfil !== 'GESTOR') throw forbidden();
  }

  private requireProvider(auth: AuthContext): void {
    if (auth.perfil !== 'PRESTADOR') throw forbidden();
  }

  private recordAudit(
    executor: QueryExecutor,
    auth: AuthContext,
    metadata: AuditMetadata,
    ride: CorridaRecord,
    action: string,
    previous: CorridaRecord | null,
    next: CorridaRecord,
  ): Promise<void> {
    return this.audit.record(executor, {
      ...metadata, empresaId: auth.empresaId, usuarioId: auth.usuarioId,
      entidade: 'corrida', entidadeId: ride.id, acao: action,
      dadosAnteriores: previous, dadosNovos: next,
    });
  }
}
