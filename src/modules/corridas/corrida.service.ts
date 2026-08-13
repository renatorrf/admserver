import type { Database, QueryExecutor } from '../../db/pool';
import { withTransaction } from '../../db/pool';
import { conflict, forbidden, invalidReference, notFound } from '../../shared/errors/app-error';
import type { PaginatedResult } from '../../shared/pagination/pagination';
import type { CorridaRealtimePublisher } from '../../realtime/realtime-bus';
import type { AuthContext } from '../auth/auth.types';
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
import type { CorridaEventoRecord, CorridaRecord, PrestadorContext, StatusCorrida } from './corrida.types';

export interface CorridaAuditWriter {
  record(executor: QueryExecutor, entry: AuditEntry): Promise<void>;
}

export interface CorridaStore {
  list(empresaId: string, scope: CorridaScope, query: CorridaListQuery): Promise<PaginatedResult<CorridaRecord>>;
  findAccessible(executor: QueryExecutor, empresaId: string, id: string, scope: CorridaScope): Promise<CorridaRecord | null>;
  findForUpdate(executor: QueryExecutor, empresaId: string, id: string): Promise<CorridaRecord | null>;
  create(executor: QueryExecutor, empresaId: string, usuarioId: string, input: CorridaCreateInput): Promise<CorridaRecord>;
  updateAssignment(executor: QueryExecutor, empresaId: string, id: string, prestadorId: string, veiculoId: string | null): Promise<CorridaRecord>;
  changeStatus(executor: QueryExecutor, empresaId: string, id: string, status: StatusCorrida, patch?: CorridaPatch): Promise<CorridaRecord>;
  createEvent(
    executor: QueryExecutor, empresaId: string, corridaId: string, usuarioId: string, type: string,
    previousStatus: StatusCorrida | null, newStatus: StatusCorrida | null, description: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  markDisembark(executor: QueryExecutor, empresaId: string, id: string): Promise<CorridaRecord>;
  listEvents(empresaId: string, corridaId: string, query: EventoListQuery): Promise<PaginatedResult<CorridaEventoRecord>>;
  getProviderByUser(executor: QueryExecutor, empresaId: string, usuarioId: string, lock?: boolean): Promise<PrestadorContext | null>;
  validateProviderAndVehicle(
    executor: QueryExecutor, empresaId: string, prestadorId: string, veiculoId: string | null, requireAvailable: boolean,
  ): Promise<boolean>;
  validateEmployeeAndCenter(executor: QueryExecutor, empresaId: string, funcionarioId: string, centroCustoId: string): Promise<boolean>;
  managerCanAccessCenter(executor: QueryExecutor, empresaId: string, usuarioId: string, centroCustoId: string): Promise<boolean>;
  setProviderAvailability(executor: QueryExecutor, empresaId: string, prestadorId: string, available: boolean): Promise<PrestadorContext | null>;
  hasActiveRide(executor: QueryExecutor, empresaId: string, prestadorId: string): Promise<boolean>;
}

export type DisponibilidadeResult = {
  prestadorId: string;
  disponivel: boolean;
};

export class CorridaService {
  private readonly repository: CorridaStore;

  constructor(
    private readonly database: Database,
    private readonly audit: CorridaAuditWriter,
    repository?: CorridaStore,
    private readonly realtime?: CorridaRealtimePublisher,
  ) {
    this.repository = repository ?? new CorridaRepository(database);
  }

  async list(auth: AuthContext, query: CorridaListQuery): Promise<PaginatedResult<CorridaRecord>> {
    return this.repository.list(auth.empresaId, await this.resolveScope(auth), query);
  }

  async get(auth: AuthContext, id: string): Promise<CorridaRecord> {
    const ride = await this.repository.findAccessible(this.database, auth.empresaId, id, await this.resolveScope(auth));
    if (!ride) throw notFound('Corrida');
    return ride;
  }

  async listEvents(
    auth: AuthContext,
    id: string,
    query: EventoListQuery,
  ): Promise<PaginatedResult<CorridaEventoRecord>> {
    await this.get(auth, id);
    return this.repository.listEvents(auth.empresaId, id, query);
  }

  create(auth: AuthContext, input: CorridaCreateInput, metadata: AuditMetadata): Promise<CorridaRecord> {
    if (auth.perfil === 'PRESTADOR') throw forbidden();
    if (input.tipo === 'AGENDADA' && input.agendadaPara && input.agendadaPara.getTime() <= Date.now()) {
      throw conflict('A corrida agendada deve possuir data futura.');
    }
    return this.withRealtime(withTransaction(this.database, async (client) => {
      if (!await this.repository.validateEmployeeAndCenter(client, auth.empresaId, input.funcionarioId, input.centroCustoId)) {
        throw invalidReference('Funcionario e centro de custo devem estar ativos, vinculados e pertencer a mesma empresa.');
      }
      if (auth.perfil === 'GERENTE'
        && !await this.repository.managerCanAccessCenter(client, auth.empresaId, auth.usuarioId, input.centroCustoId)) {
        throw forbidden();
      }
      const created = await this.repository.create(client, auth.empresaId, auth.usuarioId, input);
      await this.repository.createEvent(
        client, auth.empresaId, created.id, auth.usuarioId, 'CORRIDA_SOLICITADA', null, 'SOLICITADA',
        'Corrida solicitada.',
      );
      await this.recordAudit(client, auth, metadata, created, 'CRIAR', null, created);
      return created;
    }));
  }

  assign(auth: AuthContext, id: string, input: CorridaAssignInput, metadata: AuditMetadata): Promise<CorridaRecord> {
    this.requireManager(auth);
    return this.withRealtime(withTransaction(this.database, async (client) => {
      const current = await this.requireLockedRide(client, auth, id);
      if (current.status !== 'SOLICITADA' && current.status !== 'OFERTADA') {
        throw conflict('Somente corridas solicitadas ou ofertadas podem receber prestador.');
      }
      const vehicleId = input.veiculoId ?? null;
      if (!await this.repository.validateProviderAndVehicle(client, auth.empresaId, input.prestadorId, vehicleId, true)) {
        throw invalidReference('Prestador ou veiculo invalido, inativo, indisponivel ou pertencente a outra empresa.');
      }

      let updated: CorridaRecord;
      if (current.status === 'SOLICITADA') {
        assertTransition(current.status, 'OFERTADA');
        updated = await this.repository.changeStatus(client, auth.empresaId, id, 'OFERTADA', {
          prestadorId: input.prestadorId, veiculoId: vehicleId,
        });
      } else {
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
    }));
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
    }));
  }

  accept(auth: AuthContext, id: string, input: CorridaAcceptInput, metadata: AuditMetadata): Promise<CorridaRecord> {
    this.requireProvider(auth);
    return this.withRealtime(withTransaction(this.database, async (client) => {
      const current = await this.requireLockedRide(client, auth, id);
      const provider = await this.requireProviderContext(client, auth, true);
      if (!provider.disponivel || await this.repository.hasActiveRide(client, auth.empresaId, provider.id)) {
        throw conflict('O prestador nao esta disponivel para aceitar outra corrida.');
      }
      if (current.status !== 'SOLICITADA' && current.status !== 'OFERTADA') {
        throw conflict('Esta corrida nao esta disponivel para aceite.');
      }
      if (current.status === 'OFERTADA' && current.prestadorId !== provider.id) throw forbidden();
      if (current.status === 'SOLICITADA' && current.prestadorId !== null) throw conflict('A corrida ja possui prestador.');

      const vehicleId = input.veiculoId ?? current.veiculoId;
      if (!vehicleId || !await this.repository.validateProviderAndVehicle(
        client, auth.empresaId, provider.id, vehicleId, true,
      )) {
        throw invalidReference('Selecione um veiculo ativo vinculado ao prestador.');
      }

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
    }));
  }

  refuse(auth: AuthContext, id: string, metadata: AuditMetadata): Promise<CorridaRecord> {
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

  disembark(auth: AuthContext, id: string, metadata: AuditMetadata): Promise<CorridaRecord> {
    this.requireProvider(auth);
    return this.withRealtime(withTransaction(this.database, async (client) => {
      const current = await this.requireLockedRide(client, auth, id);
      const provider = await this.requireProviderContext(client, auth, true);
      if (current.prestadorId !== provider.id) throw forbidden();
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

  finish(auth: AuthContext, id: string, input: CorridaFinishInput, metadata: AuditMetadata): Promise<CorridaRecord> {
    this.requireProvider(auth);
    return this.withRealtime(withTransaction(this.database, async (client) => {
      const current = await this.requireLockedRide(client, auth, id);
      const provider = await this.requireProviderContext(client, auth, true);
      if (current.prestadorId !== provider.id) throw forbidden();
      if (!current.desembarqueEm) throw conflict('Confirme o desembarque antes de finalizar a corrida.');
      assertTransition(current.status, 'FINALIZADA');
      const finished = await this.repository.changeStatus(client, auth.empresaId, id, 'FINALIZADA', {
        valorFinal: input.valorFinal,
        observacaoPrestador: input.observacaoPrestador ?? null,
      });
      await this.repository.setProviderAvailability(client, auth.empresaId, provider.id, true);
      await this.repository.createEvent(
        client, auth.empresaId, id, auth.usuarioId, 'CORRIDA_FINALIZADA', current.status, 'FINALIZADA',
        'Corrida finalizada.', { valorFinal: input.valorFinal },
      );
      await this.recordAudit(client, auth, metadata, finished, 'FINALIZAR', current, finished);
      return finished;
    }));
  }

  cancel(auth: AuthContext, id: string, input: CorridaCancelInput, metadata: AuditMetadata): Promise<CorridaRecord> {
    if (auth.perfil === 'PRESTADOR') throw forbidden();
    return this.withRealtime(withTransaction(this.database, async (client) => {
      const current = await this.requireLockedRide(client, auth, id);
      if (auth.perfil === 'GERENTE') {
        if (!await this.repository.managerCanAccessCenter(client, auth.empresaId, auth.usuarioId, current.centroCustoId)) {
          throw forbidden();
        }
        if (current.status !== 'SOLICITADA' && current.status !== 'OFERTADA') {
          throw conflict('O gerente so pode cancelar corridas solicitadas ou ofertadas.');
        }
      } else if (!['SOLICITADA', 'OFERTADA', 'ACEITA'].includes(current.status)) {
        throw conflict('A corrida nao pode mais ser cancelada.');
      }
      assertTransition(current.status, 'CANCELADA');
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
    }));
  }

  setAvailability(
    auth: AuthContext,
    input: DisponibilidadeInput,
    metadata: AuditMetadata,
  ): Promise<DisponibilidadeResult> {
    this.requireProvider(auth);
    return withTransaction(this.database, async (client) => {
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

  private providerTransition(
    auth: AuthContext,
    id: string,
    target: StatusCorrida,
    eventType: string,
    description: string,
    metadata: AuditMetadata,
  ): Promise<CorridaRecord> {
    this.requireProvider(auth);
    return this.withRealtime(withTransaction(this.database, async (client) => {
      const current = await this.requireLockedRide(client, auth, id);
      const provider = await this.requireProviderContext(client, auth, true);
      if (current.prestadorId !== provider.id) throw forbidden();
      assertTransition(current.status, target);
      const updated = await this.repository.changeStatus(client, auth.empresaId, id, target);
      await this.repository.createEvent(
        client, auth.empresaId, id, auth.usuarioId, eventType, current.status, target, description,
        { prestadorId: provider.id },
      );
      await this.recordAudit(client, auth, metadata, updated, eventType, current, updated);
      return updated;
    }));
  }

  private async withRealtime(operation: Promise<CorridaRecord>): Promise<CorridaRecord> {
    const ride = await operation;
    this.realtime?.publishRide(ride);
    return ride;
  }

  private async resolveScope(auth: AuthContext): Promise<CorridaScope> {
    if (auth.perfil === 'GESTOR') return { kind: 'GESTOR' };
    if (auth.perfil === 'GERENTE') return { kind: 'GERENTE', usuarioId: auth.usuarioId };
    const provider = await this.requireProviderContext(this.database, auth, false);
    return { kind: 'PRESTADOR', prestadorId: provider.id, disponivel: provider.disponivel };
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
    const ride = await this.repository.findForUpdate(executor, auth.empresaId, id);
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
