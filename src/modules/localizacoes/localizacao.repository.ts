import type { QueryResultRow } from 'pg';

import { queryOne, type Database, type QueryExecutor } from '../../db/pool';
import { paginate, type PaginatedResult } from '../../shared/pagination/pagination';
import type { StatusCorrida } from '../corridas/corrida.types';
import type { LocalizacaoCreateInput, LocalizacaoListQuery } from './localizacao.schemas';
import type { LocalizacaoRecord } from './localizacao.types';

type PrestadorRow = QueryResultRow & { id: string; ativo: boolean };
type CorridaRastreamentoRow = QueryResultRow & {
  id: string;
  prestador_id: string | null;
  status: StatusCorrida;
};
type LocalizacaoRow = QueryResultRow & {
  id: string;
  empresa_id: string;
  corrida_id: string;
  prestador_id: string;
  latitude: string;
  longitude: string;
  precisao_metros: string | null;
  velocidade: string | null;
  direcao: string | null;
  registrado_em: Date;
};

function numeric(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function mapLocation(row: LocalizacaoRow): LocalizacaoRecord {
  return {
    id: row.id,
    empresaId: row.empresa_id,
    corridaId: row.corrida_id,
    prestadorId: row.prestador_id,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    precisaoMetros: numeric(row.precisao_metros),
    velocidade: numeric(row.velocidade),
    direcao: numeric(row.direcao),
    registradoEm: row.registrado_em,
  };
}

export interface LocalizacaoStore {
  getProvider(executor: QueryExecutor, empresaId: string, usuarioId: string): Promise<PrestadorRow | null>;
  getRideForShare(executor: QueryExecutor, empresaId: string, corridaId: string): Promise<CorridaRastreamentoRow | null>;
  insert(
    executor: QueryExecutor,
    empresaId: string,
    corridaId: string,
    prestadorId: string,
    input: LocalizacaoCreateInput,
  ): Promise<LocalizacaoRecord>;
  latest(executor: QueryExecutor, empresaId: string, corridaId: string): Promise<LocalizacaoRecord | null>;
  list(empresaId: string, corridaId: string, query: LocalizacaoListQuery): Promise<PaginatedResult<LocalizacaoRecord>>;
}

export class LocalizacaoRepository implements LocalizacaoStore {
  constructor(private readonly database: Database) {}

  getProvider(executor: QueryExecutor, empresaId: string, usuarioId: string): Promise<PrestadorRow | null> {
    return queryOne<PrestadorRow>(
      executor,
      'SELECT id, ativo FROM admtaxi.prestadores WHERE empresa_id = $1 AND usuario_id = $2',
      [empresaId, usuarioId],
    );
  }

  getRideForShare(
    executor: QueryExecutor,
    empresaId: string,
    corridaId: string,
  ): Promise<CorridaRastreamentoRow | null> {
    return queryOne<CorridaRastreamentoRow>(
      executor,
      `SELECT id, prestador_id, status::text
         FROM admtaxi.corridas
        WHERE empresa_id = $1 AND id = $2
        FOR SHARE`,
      [empresaId, corridaId],
    );
  }

  async insert(
    executor: QueryExecutor,
    empresaId: string,
    corridaId: string,
    prestadorId: string,
    input: LocalizacaoCreateInput,
  ): Promise<LocalizacaoRecord> {
    const result = await executor.query<LocalizacaoRow>(
      `INSERT INTO admtaxi.corrida_localizacoes
         (empresa_id, corrida_id, prestador_id, latitude, longitude, precisao_metros, velocidade, direcao)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id::text, empresa_id, corrida_id, prestador_id, latitude::text, longitude::text,
                 precisao_metros::text, velocidade::text, direcao::text, registrado_em`,
      [
        empresaId,
        corridaId,
        prestadorId,
        input.latitude,
        input.longitude,
        input.precisaoMetros ?? null,
        input.velocidade ?? null,
        input.direcao ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Falha ao registrar localizacao.');
    return mapLocation(row);
  }

  async latest(executor: QueryExecutor, empresaId: string, corridaId: string): Promise<LocalizacaoRecord | null> {
    const row = await queryOne<LocalizacaoRow>(
      executor,
      `SELECT id::text, empresa_id, corrida_id, prestador_id, latitude::text, longitude::text,
              precisao_metros::text, velocidade::text, direcao::text, registrado_em
         FROM admtaxi.corrida_localizacoes
        WHERE empresa_id = $1 AND corrida_id = $2
        ORDER BY registrado_em DESC, id DESC LIMIT 1`,
      [empresaId, corridaId],
    );
    return row ? mapLocation(row) : null;
  }

  async list(
    empresaId: string,
    corridaId: string,
    query: LocalizacaoListQuery,
  ): Promise<PaginatedResult<LocalizacaoRecord>> {
    const count = await this.database.query<{ total: string }>(
      'SELECT COUNT(*)::text AS total FROM admtaxi.corrida_localizacoes WHERE empresa_id = $1 AND corrida_id = $2',
      [empresaId, corridaId],
    );
    const total = Number(count.rows[0]?.total ?? 0);
    const result = await this.database.query<LocalizacaoRow>(
      `SELECT id::text, empresa_id, corrida_id, prestador_id, latitude::text, longitude::text,
              precisao_metros::text, velocidade::text, direcao::text, registrado_em
         FROM admtaxi.corrida_localizacoes
        WHERE empresa_id = $1 AND corrida_id = $2
        ORDER BY registrado_em DESC, id DESC LIMIT $3 OFFSET $4`,
      [empresaId, corridaId, query.limite, (query.pagina - 1) * query.limite],
    );
    return paginate(result.rows.map(mapLocation), total, query);
  }
}
