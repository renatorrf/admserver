import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { Database, QueryExecutor } from '../src/db/pool';
import type { AuthContext } from '../src/modules/auth/auth.types';
import type { AuditEntry } from '../src/modules/auditoria/audit.types';
import type { CorridaScope } from '../src/modules/corridas/corrida.repository';
import type { CorridaCreateInput, CorridaListQuery, EventoListQuery } from '../src/modules/corridas/corrida.schemas';
import { CorridaService, type CorridaAuditWriter, type CorridaStore } from '../src/modules/corridas/corrida.service';
import type { CorridaEventoRecord, CorridaRecord, FuncionarioContext, PrestadorContext, StatusCorrida } from '../src/modules/corridas/corrida.types';
import type { PaginatedResult } from '../src/shared/pagination/pagination';
import type { CorridaNotificationPublisher } from '../src/modules/notificacoes/notificacao.service';

const EMPRESA = '11111111-1111-4111-8111-111111111111';
const GESTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GERENTE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USUARIO_PRESTADOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PRESTADOR = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const VEICULO = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CORRIDA = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const CENTRO = '12121212-1212-4212-8212-121212121212';
const FUNCIONARIO = '34343434-3434-4434-8434-343434343434';

function fakeDatabase(centerIds: string[] = [CENTRO]): Database {
  const query = vi.fn().mockResolvedValue({
    rows: [{ setor_ids: ['56565656-5656-4656-8656-565656565656'], centro_custo_ids: centerIds }], rowCount: 1,
  });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  return { query: query as QueryExecutor['query'], connect: () => Promise.resolve(client) };
}

function ride(status: StatusCorrida = 'SOLICITADA'): CorridaRecord {
  return {
    id: CORRIDA, empresaId: EMPRESA, solicitanteUsuarioId: GERENTE,
    funcionarioId: FUNCIONARIO, centroCustoId: CENTRO, prestadorId: null,
    veiculoId: null, status, tipo: 'IMEDIATA',
  };
}

class RideStore implements CorridaStore {
  current = ride();
  provider: PrestadorContext = { id: PRESTADOR, usuarioId: USUARIO_PRESTADOR, disponivel: true, ativo: true };
  events: Array<{ type: string; from: StatusCorrida | null; to: StatusCorrida | null }> = [];
  scopes: CorridaScope[] = [];
  employeeValid = true;
  managerAccess = true;
  providerVehicleValid = true;
  activeRide = false;

  list(_empresaId: string, scope: CorridaScope, query: CorridaListQuery): Promise<PaginatedResult<CorridaRecord>> {
    this.scopes.push(scope);
    return Promise.resolve({ data: [this.current], meta: { pagina: query.pagina, limite: query.limite, total: 1, totalPaginas: 1 } });
  }
  findAccessible(): Promise<CorridaRecord> { return Promise.resolve(this.current); }
  findForUpdate(): Promise<CorridaRecord> { return Promise.resolve(this.current); }
  create(_e: QueryExecutor, empresaId: string, usuarioId: string, input: CorridaCreateInput): Promise<CorridaRecord> {
    this.current = { ...ride(), empresaId, solicitanteUsuarioId: usuarioId, funcionarioId: input.funcionarioId, centroCustoId: input.centroCustoId, tipo: input.tipo };
    return Promise.resolve(this.current);
  }
  updateAssignment(_e: QueryExecutor, _empresaId: string, _id: string, prestadorId: string, veiculoId: string | null): Promise<CorridaRecord> {
    this.current = { ...this.current, prestadorId, veiculoId };
    return Promise.resolve(this.current);
  }
  changeStatus(_e: QueryExecutor, _empresaId: string, _id: string, status: StatusCorrida, patch = {}): Promise<CorridaRecord> {
    this.current = { ...this.current, ...patch, status };
    return Promise.resolve(this.current);
  }
  createEvent(
    _e: QueryExecutor, _empresaId: string, _rideId: string, _userId: string, type: string,
    from: StatusCorrida | null, to: StatusCorrida | null,
  ): Promise<void> {
    this.events.push({ type, from, to });
    return Promise.resolve();
  }
  markDisembark(): Promise<CorridaRecord> {
    this.current = { ...this.current, desembarqueEm: new Date('2026-08-06T14:00:00Z') };
    return Promise.resolve(this.current);
  }
  listEvents(_empresaId: string, _corridaId: string, query: EventoListQuery): Promise<PaginatedResult<CorridaEventoRecord>> {
    return Promise.resolve({ data: [], meta: { pagina: query.pagina, limite: query.limite, total: 0, totalPaginas: 0 } });
  }
  getProviderByUser(): Promise<PrestadorContext> { return Promise.resolve(this.provider); }
  getEmployeeByUser(): Promise<FuncionarioContext> { return Promise.resolve({ id: FUNCIONARIO, usuarioId: '78787878-7878-4787-8787-787878787878', ativo: true }); }
  validateProviderAndVehicle(): Promise<boolean> { return Promise.resolve(this.providerVehicleValid); }
  validateEmployeeAndCenter(): Promise<boolean> { return Promise.resolve(this.employeeValid); }
  managerCanAccessCenter(): Promise<boolean> { return Promise.resolve(this.managerAccess); }
  setProviderAvailability(_e: QueryExecutor, _empresaId: string, _id: string, available: boolean): Promise<PrestadorContext> {
    this.provider = { ...this.provider, disponivel: available };
    return Promise.resolve(this.provider);
  }
  hasActiveRide(): Promise<boolean> { return Promise.resolve(this.activeRide); }
}

class RideAudit implements CorridaAuditWriter {
  entries: AuditEntry[] = [];
  record(_executor: QueryExecutor, entry: AuditEntry): Promise<void> { this.entries.push(entry); return Promise.resolve(); }
}

const gestor: AuthContext = { usuarioId: GESTOR, empresaId: EMPRESA, perfil: 'GESTOR' };
const gerente: AuthContext = { usuarioId: GERENTE, empresaId: EMPRESA, perfil: 'GERENTE' };
const prestador: AuthContext = { usuarioId: USUARIO_PRESTADOR, empresaId: EMPRESA, perfil: 'PRESTADOR' };
const funcionario: AuthContext = { usuarioId: '78787878-7878-4787-8787-787878787878', empresaId: EMPRESA, perfil: 'FUNCIONARIO' };
const listQuery: CorridaListQuery = { pagina: 1, limite: 20 };

describe('CorridaService', () => {
  it('aplica escopo de listagem conforme o perfil', async () => {
    const store = new RideStore();
    const service = new CorridaService(fakeDatabase(), new RideAudit(), store);

    await service.list(gestor, listQuery);
    await service.list(gerente, listQuery);
    await service.list(prestador, listQuery);
    await service.list(funcionario, listQuery);

    expect(store.scopes).toEqual([
      { kind: 'GESTOR' },
      {
        kind: 'GERENTE', usuarioId: GERENTE,
        setorIds: ['56565656-5656-4656-8656-565656565656'], centroCustoIds: [CENTRO],
      },
      { kind: 'PRESTADOR', prestadorId: PRESTADOR, disponivel: true },
      { kind: 'FUNCIONARIO', funcionarioId: FUNCIONARIO },
    ]);
  });

  it('impede gerente sem centro autorizado de solicitar corrida', async () => {
    const store = new RideStore();
    const service = new CorridaService(fakeDatabase([]), new RideAudit(), store);
    const input: CorridaCreateInput = {
      funcionarioId: FUNCIONARIO, centroCustoId: CENTRO, tipo: 'IMEDIATA', quantidadePassageiros: 1,
      origemDescricao: 'Origem', destinoDescricao: 'Destino',
    };

    await expect(service.create(gerente, input, {})).rejects.toMatchObject({ statusCode: 403 });
  });

  it('reivindica corrida disponivel, registra oferta e aceite e ocupa o prestador', async () => {
    const store = new RideStore();
    const audit = new RideAudit();
    const service = new CorridaService(fakeDatabase(), audit, store);

    const accepted = await service.accept(prestador, CORRIDA, { veiculoId: VEICULO }, {});

    expect(accepted).toMatchObject({ status: 'ACEITA', prestadorId: PRESTADOR, veiculoId: VEICULO });
    expect(store.events.map((event) => event.type)).toEqual(['CORRIDA_REIVINDICADA', 'CORRIDA_ACEITA']);
    expect(store.provider.disponivel).toBe(false);
    expect(audit.entries[0]?.acao).toBe('ACEITAR');
  });

  it('notifica o solicitante apos aceite e transicoes posteriores', async () => {
    const store = new RideStore();
    const notifications: CorridaNotificationPublisher = {
      publishRideCreated: vi.fn(), publishProviderRide: vi.fn(), publishRideUpdate: vi.fn(),
    };
    const service = new CorridaService(fakeDatabase(), new RideAudit(), store, undefined, notifications);

    await service.accept(prestador, CORRIDA, { veiculoId: VEICULO }, {});
    await service.startDisplacement(prestador, CORRIDA, {});
    await service.arrive(prestador, CORRIDA, {});
    await service.board(prestador, CORRIDA, {});
    await service.disembark(prestador, CORRIDA, {});
    await service.finish(prestador, CORRIDA, { valorFinal: '95.00' }, {});

    expect(notifications.publishRideUpdate).toHaveBeenCalledTimes(5);
    expect(notifications.publishRideUpdate).toHaveBeenCalledWith(expect.anything(), 'ACEITA');
    expect(notifications.publishRideUpdate).toHaveBeenCalledWith(expect.anything(), 'DESLOCAMENTO_INICIADO');
    expect(notifications.publishRideUpdate).toHaveBeenCalledWith(expect.anything(), 'CHEGADA_AO_EMBARQUE');
    expect(notifications.publishRideUpdate).toHaveBeenCalledWith(expect.anything(), 'CORRIDA_INICIADA');
    expect(notifications.publishRideUpdate).toHaveBeenCalledWith(expect.anything(), 'FINALIZADA');
  });

  it('retorna mensagem amigavel quando a corrida ja foi aceita', async () => {
    const store = new RideStore();
    store.current = { ...ride('ACEITA'), prestadorId: '99999999-9999-4999-8999-999999999999' };
    const service = new CorridaService(fakeDatabase(), new RideAudit(), store);

    await expect(service.accept(prestador, CORRIDA, { veiculoId: VEICULO }, {}))
      .rejects.toMatchObject({ statusCode: 409, message: 'Esta corrida já foi aceita por outro prestador.' });
  });

  it('bloqueia aceite de corrida ofertada a outro prestador', async () => {
    const store = new RideStore();
    store.current = { ...ride('OFERTADA'), prestadorId: '99999999-9999-4999-8999-999999999999' };
    const service = new CorridaService(fakeDatabase(), new RideAudit(), store);

    await expect(service.accept(prestador, CORRIDA, { veiculoId: VEICULO }, {}))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it('executa as etapas do prestador apenas na ordem permitida', async () => {
    const store = new RideStore();
    store.current = { ...ride('ACEITA'), prestadorId: PRESTADOR, veiculoId: VEICULO };
    store.provider.disponivel = false;
    const service = new CorridaService(fakeDatabase(), new RideAudit(), store);

    await service.startDisplacement(prestador, CORRIDA, {});
    await service.arrive(prestador, CORRIDA, {});
    await service.board(prestador, CORRIDA, {});
    await service.disembark(prestador, CORRIDA, {});
    const finished = await service.finish(prestador, CORRIDA, { valorFinal: '150.75' }, {});

    expect(finished).toMatchObject({ status: 'FINALIZADA', valorFinal: '150.75' });
    expect(store.provider.disponivel).toBe(true);
  });

  it('exige confirmacao de desembarque antes da finalizacao', async () => {
    const store = new RideStore();
    store.current = { ...ride('EM_CORRIDA'), prestadorId: PRESTADOR, veiculoId: VEICULO };
    store.provider.disponivel = false;
    const service = new CorridaService(fakeDatabase(), new RideAudit(), store);

    await expect(service.finish(prestador, CORRIDA, { valorFinal: '80.00' }, {}))
      .rejects.toMatchObject({ statusCode: 409, message: 'Confirme o desembarque antes de finalizar a corrida.' });
  });

  it('impede gerente de cancelar uma corrida ja aceita', async () => {
    const store = new RideStore();
    store.current = { ...ride('ACEITA'), prestadorId: PRESTADOR };
    const service = new CorridaService(fakeDatabase(), new RideAudit(), store);

    await expect(service.cancel(gerente, CORRIDA, { motivo: 'Mudanca de agenda' }, {}))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('permite ao gestor cancelar corrida aceita e libera o prestador', async () => {
    const store = new RideStore();
    store.current = { ...ride('ACEITA'), prestadorId: PRESTADOR };
    store.provider.disponivel = false;
    const service = new CorridaService(fakeDatabase(), new RideAudit(), store);

    const cancelled = await service.cancel(gestor, CORRIDA, { motivo: 'Cancelamento administrativo' }, {});

    expect(cancelled).toMatchObject({ status: 'CANCELADA', motivoCancelamento: 'Cancelamento administrativo' });
    expect(store.provider.disponivel).toBe(true);
  });
});
