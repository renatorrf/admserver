import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { Database, QueryExecutor } from '../src/db/pool';
import type { AuthContext } from '../src/modules/auth/auth.types';
import type { CorridaRecord, StatusCorrida } from '../src/modules/corridas/corrida.types';
import type { LocalizacaoStore } from '../src/modules/localizacoes/localizacao.repository';
import type { LocalizacaoCreateInput, LocalizacaoListQuery } from '../src/modules/localizacoes/localizacao.schemas';
import { LocalizacaoService, type CorridaAccess } from '../src/modules/localizacoes/localizacao.service';
import type { LocalizacaoRecord } from '../src/modules/localizacoes/localizacao.types';
import type { LocalizacaoRealtimePublisher } from '../src/realtime/realtime-bus';

const EMPRESA = '11111111-1111-4111-8111-111111111111';
const USUARIO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRESTADOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CORRIDA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const prestador: AuthContext = { usuarioId: USUARIO, empresaId: EMPRESA, perfil: 'PRESTADOR' };
const gestor: AuthContext = { usuarioId: USUARIO, empresaId: EMPRESA, perfil: 'GESTOR' };
const input: LocalizacaoCreateInput = {
  latitude: -23.55052,
  longitude: -46.633308,
  precisaoMetros: 8.5,
  velocidade: 12,
  direcao: 180,
};

function fakeDatabase(): Database {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  return { query: query as QueryExecutor['query'], connect: () => Promise.resolve(client) };
}

function location(): LocalizacaoRecord {
  return {
    id: '1', empresaId: EMPRESA, corridaId: CORRIDA, prestadorId: PRESTADOR,
    ...input, registradoEm: new Date('2026-08-06T18:00:00Z'),
  };
}

class LocationStore implements LocalizacaoStore {
  provider = { id: PRESTADOR, ativo: true };
  ride: { id: string; prestador_id: string | null; status: StatusCorrida } | null = {
    id: CORRIDA, prestador_id: PRESTADOR, status: 'EM_DESLOCAMENTO',
  };
  inserted = false;

  getProvider(): Promise<{ id: string; ativo: boolean } | null> { return Promise.resolve(this.provider); }
  getRideForShare(): Promise<{ id: string; prestador_id: string | null; status: StatusCorrida } | null> {
    return Promise.resolve(this.ride);
  }
  insert(): Promise<LocalizacaoRecord> { this.inserted = true; return Promise.resolve(location()); }
  latest(): Promise<LocalizacaoRecord | null> { return Promise.resolve(location()); }
  list(_empresaId: string, _corridaId: string, query: LocalizacaoListQuery) {
    return Promise.resolve({
      data: [location()],
      meta: { pagina: query.pagina, limite: query.limite, total: 1, totalPaginas: 1 },
    });
  }
}

function rideAccess(): CorridaAccess {
  return {
    get: vi.fn().mockResolvedValue({
      id: CORRIDA, empresaId: EMPRESA, prestadorId: PRESTADOR, status: 'EM_DESLOCAMENTO',
    } as CorridaRecord),
  };
}

describe('LocalizacaoService', () => {
  it('registra e publica localizacao do prestador durante corrida ativa', async () => {
    const store = new LocationStore();
    const realtime: LocalizacaoRealtimePublisher = { publishLocation: vi.fn() };
    const service = new LocalizacaoService(fakeDatabase(), rideAccess(), realtime, store);

    const created = await service.create(prestador, CORRIDA, input);

    expect(created).toMatchObject({ corridaId: CORRIDA, latitude: input.latitude });
    expect(store.inserted).toBe(true);
    expect(realtime.publishLocation).toHaveBeenCalledWith(created);
  });

  it('recusa envio por perfil que nao seja prestador', async () => {
    const service = new LocalizacaoService(fakeDatabase(), rideAccess(), undefined, new LocationStore());

    await expect(service.create(gestor, CORRIDA, input)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('recusa envio para corrida de outro prestador', async () => {
    const store = new LocationStore();
    store.ride = { ...store.ride!, prestador_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
    const service = new LocalizacaoService(fakeDatabase(), rideAccess(), undefined, store);

    await expect(service.create(prestador, CORRIDA, input)).rejects.toMatchObject({ statusCode: 403 });
    expect(store.inserted).toBe(false);
  });

  it.each<StatusCorrida>(['SOLICITADA', 'OFERTADA', 'RECUSADA', 'FINALIZADA', 'CANCELADA'])(
    'nao coleta localizacao no estado %s',
    async (status) => {
      const store = new LocationStore();
      store.ride = { ...store.ride!, status };
      const service = new LocalizacaoService(fakeDatabase(), rideAccess(), undefined, store);

      await expect(service.create(prestador, CORRIDA, input)).rejects.toMatchObject({ statusCode: 409 });
      expect(store.inserted).toBe(false);
    },
  );

  it('valida acesso a corrida antes de listar o historico', async () => {
    const access = rideAccess();
    const service = new LocalizacaoService(fakeDatabase(), access, undefined, new LocationStore());

    const result = await service.list(gestor, CORRIDA, { pagina: 1, limite: 50 });

    expect(access.get).toHaveBeenCalledWith(gestor, CORRIDA);
    expect(result.meta.total).toBe(1);
  });
});
