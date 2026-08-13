import type { QueryResultRow } from 'pg';

import { queryOne, type Database, type QueryExecutor } from '../../db/pool';
import { paginate, type PaginatedResult } from '../../shared/pagination/pagination';
import type { PerfilUsuario } from '../auth/auth.types';
import type { UsuarioCreateInput, UsuarioListQuery, UsuarioUpdateInput } from './usuario.schemas';

type UsuarioRow = QueryResultRow & {
  id: string;
  empresa_id: string;
  nome: string;
  email: string;
  telefone: string | null;
  perfil: PerfilUsuario;
  ativo: boolean;
  ultimo_acesso_em: Date | null;
  criado_em: Date;
  atualizado_em: Date;
};

export type UsuarioRecord = Record<string, unknown> & {
  id: string;
  empresaId: string;
  nome: string;
  email: string;
  telefone: string | null;
  perfil: PerfilUsuario;
  ativo: boolean;
};

export type CentroCustoResumo = Record<string, unknown> & {
  id: string;
  codigo: string;
  nome: string;
  ativo: boolean;
};

function mapUsuario(row: UsuarioRow): UsuarioRecord {
  return {
    id: row.id,
    empresaId: row.empresa_id,
    nome: row.nome,
    email: row.email,
    telefone: row.telefone,
    perfil: row.perfil,
    ativo: row.ativo,
    ultimoAcessoEm: row.ultimo_acesso_em,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

export class UsuarioRepository {
  constructor(private readonly pool: Database) {}

  async list(empresaId: string, query: UsuarioListQuery): Promise<PaginatedResult<UsuarioRecord>> {
    const values: unknown[] = [empresaId];
    const conditions = ['empresa_id = $1'];
    const add = (sql: string, value: unknown): void => {
      values.push(value);
      conditions.push(sql.replace('?', `$${values.length}`));
    };
    if (query.ativo !== undefined) add('ativo = ?', query.ativo);
    if (query.perfil) add('perfil = ?', query.perfil);
    if (query.busca) {
      values.push(`%${query.busca}%`);
      conditions.push(`(nome ILIKE $${values.length} OR email::text ILIKE $${values.length} OR telefone ILIKE $${values.length})`);
    }
    const where = conditions.join(' AND ');
    const count = await this.pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM admtaxi.usuarios WHERE ${where}`,
      values,
    );
    const total = Number(count.rows[0]?.total ?? 0);
    values.push(query.limite, (query.pagina - 1) * query.limite);
    const result = await this.pool.query<UsuarioRow>(
      `SELECT id, empresa_id, nome, email::text, telefone, perfil::text, ativo,
              ultimo_acesso_em, criado_em, atualizado_em
         FROM admtaxi.usuarios WHERE ${where}
        ORDER BY nome ASC, id ASC
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return paginate(result.rows.map(mapUsuario), total, query);
  }

  async findById(executor: QueryExecutor, empresaId: string, id: string): Promise<UsuarioRecord | null> {
    const row = await queryOne<UsuarioRow>(
      executor,
      `SELECT id, empresa_id, nome, email::text, telefone, perfil::text, ativo,
              ultimo_acesso_em, criado_em, atualizado_em
         FROM admtaxi.usuarios WHERE empresa_id = $1 AND id = $2`,
      [empresaId, id],
    );
    return row ? mapUsuario(row) : null;
  }

  async create(
    executor: QueryExecutor,
    empresaId: string,
    input: UsuarioCreateInput,
    senhaHash: string,
  ): Promise<UsuarioRecord> {
    const result = await executor.query<UsuarioRow>(
      `INSERT INTO admtaxi.usuarios (empresa_id, nome, email, telefone, senha_hash, perfil)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, empresa_id, nome, email::text, telefone, perfil::text, ativo,
                 ultimo_acesso_em, criado_em, atualizado_em`,
      [empresaId, input.nome, input.email, input.telefone ?? null, senhaHash, input.perfil],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Falha ao criar usuario.');
    return mapUsuario(row);
  }

  async update(
    executor: QueryExecutor,
    empresaId: string,
    id: string,
    input: UsuarioUpdateInput,
    senhaHash?: string,
  ): Promise<UsuarioRecord | null> {
    const fieldColumns: Record<string, string> = {
      nome: 'nome', email: 'email', telefone: 'telefone', perfil: 'perfil',
    };
    const values: unknown[] = [empresaId, id];
    const assignments = Object.entries(input)
      .filter(([key, value]) => key !== 'senha' && value !== undefined)
      .map(([key, value]) => {
        values.push(value);
        return `${fieldColumns[key]} = $${values.length}`;
      });
    if (senhaHash) {
      values.push(senhaHash);
      assignments.push(`senha_hash = $${values.length}`);
    }
    const result = await executor.query<UsuarioRow>(
      `UPDATE admtaxi.usuarios SET ${assignments.join(', ')}
        WHERE empresa_id = $1 AND id = $2
      RETURNING id, empresa_id, nome, email::text, telefone, perfil::text, ativo,
                ultimo_acesso_em, criado_em, atualizado_em`,
      values,
    );
    return result.rows[0] ? mapUsuario(result.rows[0]) : null;
  }

  async setActive(executor: QueryExecutor, empresaId: string, id: string, ativo: boolean): Promise<UsuarioRecord | null> {
    const result = await executor.query<UsuarioRow>(
      `UPDATE admtaxi.usuarios SET ativo = $3 WHERE empresa_id = $1 AND id = $2
       RETURNING id, empresa_id, nome, email::text, telefone, perfil::text, ativo,
                 ultimo_acesso_em, criado_em, atualizado_em`,
      [empresaId, id, ativo],
    );
    return result.rows[0] ? mapUsuario(result.rows[0]) : null;
  }

  async revokeSessions(executor: QueryExecutor, empresaId: string, usuarioId: string): Promise<void> {
    await executor.query(
      `UPDATE admtaxi.refresh_tokens SET revogado_em = COALESCE(revogado_em, CURRENT_TIMESTAMP)
        WHERE empresa_id = $1 AND usuario_id = $2`,
      [empresaId, usuarioId],
    );
  }

  async isLinkedProvider(executor: QueryExecutor, empresaId: string, usuarioId: string): Promise<boolean> {
    const result = await executor.query(
      'SELECT 1 FROM admtaxi.prestadores WHERE empresa_id = $1 AND usuario_id = $2 LIMIT 1',
      [empresaId, usuarioId],
    );
    return result.rowCount === 1;
  }

  async listManagerCenters(executor: QueryExecutor, empresaId: string, usuarioId: string): Promise<CentroCustoResumo[]> {
    const result = await executor.query<QueryResultRow>(
      `SELECT c.id, c.codigo, c.nome, c.ativo
         FROM admtaxi.gerente_centros_custo gcc
         JOIN admtaxi.centros_custo c
           ON c.empresa_id = gcc.empresa_id AND c.id = gcc.centro_custo_id
        WHERE gcc.empresa_id = $1 AND gcc.gerente_usuario_id = $2
        ORDER BY c.codigo`,
      [empresaId, usuarioId],
    );
    return result.rows.map((row) => ({
      id: row.id as string,
      codigo: row.codigo as string,
      nome: row.nome as string,
      ativo: row.ativo as boolean,
    }));
  }

  async replaceManagerCenters(
    executor: QueryExecutor,
    empresaId: string,
    usuarioId: string,
    centerIds: string[],
  ): Promise<void> {
    await executor.query(
      'DELETE FROM admtaxi.gerente_centros_custo WHERE empresa_id = $1 AND gerente_usuario_id = $2',
      [empresaId, usuarioId],
    );
    if (centerIds.length > 0) {
      await executor.query(
        `INSERT INTO admtaxi.gerente_centros_custo (empresa_id, gerente_usuario_id, centro_custo_id)
         SELECT $1, $2, centro_id FROM unnest($3::uuid[]) AS centro_id`,
        [empresaId, usuarioId, centerIds],
      );
    }
  }

  async countActiveCenters(executor: QueryExecutor, empresaId: string, centerIds: string[]): Promise<number> {
    if (centerIds.length === 0) return 0;
    const result = await executor.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM admtaxi.centros_custo
        WHERE empresa_id = $1 AND id = ANY($2::uuid[]) AND ativo = TRUE`,
      [empresaId, centerIds],
    );
    return Number(result.rows[0]?.total ?? 0);
  }
}
