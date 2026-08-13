import type { Database } from '../../db/pool';
import { withTransaction } from '../../db/pool';
import type { LocalizacaoRealtimePublisher } from '../../realtime/realtime-bus';
import { conflict, forbidden, notFound } from '../../shared/errors/app-error';
import type { PaginatedResult } from '../../shared/pagination/pagination';
import type { AuthContext } from '../auth/auth.types';
import type { CorridaService } from '../corridas/corrida.service';
import { LocalizacaoRepository, type LocalizacaoStore } from './localizacao.repository';
import type { LocalizacaoCreateInput, LocalizacaoListQuery } from './localizacao.schemas';
import { statusComRastreamento, type AcompanhamentoSnapshot, type LocalizacaoRecord } from './localizacao.types';

export type CorridaAccess = Pick<CorridaService, 'get'>;

export class LocalizacaoService {
  private readonly repository: LocalizacaoStore;

  constructor(
    private readonly database: Database,
    private readonly rideAccess: CorridaAccess,
    private readonly realtime?: LocalizacaoRealtimePublisher,
    repository?: LocalizacaoStore,
  ) {
    this.repository = repository ?? new LocalizacaoRepository(database);
  }

  async create(auth: AuthContext, corridaId: string, input: LocalizacaoCreateInput): Promise<LocalizacaoRecord> {
    if (auth.perfil !== 'PRESTADOR') throw forbidden();
    const location = await withTransaction(this.database, async (client) => {
      const provider = await this.repository.getProvider(client, auth.empresaId, auth.usuarioId);
      if (!provider?.ativo) throw forbidden();
      const ride = await this.repository.getRideForShare(client, auth.empresaId, corridaId);
      if (!ride) throw notFound('Corrida');
      if (ride.prestador_id !== provider.id) throw forbidden();
      if (!statusComRastreamento.includes(ride.status)) {
        throw conflict('A localizacao so pode ser compartilhada durante uma corrida ativa.');
      }
      return this.repository.insert(client, auth.empresaId, corridaId, provider.id, input);
    });
    this.realtime?.publishLocation(location);
    return location;
  }

  async list(
    auth: AuthContext,
    corridaId: string,
    query: LocalizacaoListQuery,
  ): Promise<PaginatedResult<LocalizacaoRecord>> {
    await this.rideAccess.get(auth, corridaId);
    return this.repository.list(auth.empresaId, corridaId, query);
  }

  async snapshot(auth: AuthContext, corridaId: string): Promise<AcompanhamentoSnapshot> {
    const corrida = await this.rideAccess.get(auth, corridaId);
    const localizacaoAtual = await this.repository.latest(this.database, auth.empresaId, corridaId);
    return { corrida, localizacaoAtual };
  }
}
