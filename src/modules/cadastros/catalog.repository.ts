import type { QueryResultRow } from 'pg';

import { queryOne, type Database, type QueryExecutor } from '../../db/pool';
import { paginate, type PaginatedResult, type PaginationQuery } from '../../shared/pagination/pagination';
import type { CatalogDefinition, CatalogInput, CatalogRecord } from './catalog.types';

export type CatalogListQuery = PaginationQuery & Record<string, unknown>;

export class CatalogRepository {
  constructor(
    private readonly pool: Database,
    private readonly definition: CatalogDefinition,
  ) {}

  async list(empresaId: string, query: CatalogListQuery): Promise<PaginatedResult<CatalogRecord>> {
    const values: unknown[] = [empresaId];
    const conditions = ['empresa_id = $1'];
    const addCondition = (condition: string, value: unknown): void => {
      values.push(value);
      conditions.push(condition.replace('?', `$${values.length}`));
    };

    if (query.ativo !== undefined) {
      addCondition('ativo = ?', query.ativo);
    }
    if (query.busca) {
      values.push(`%${query.busca}%`);
      const placeholder = `$${values.length}`;
      conditions.push(`(${this.definition.searchColumns.map((column) => `${column}::text ILIKE ${placeholder}`).join(' OR ')})`);
    }
    for (const [key, column] of Object.entries(this.definition.filters ?? {})) {
      if (query[key] !== undefined) {
        addCondition(`${column} = ?`, query[key]);
      }
    }

    const where = conditions.join(' AND ');
    const table = `admtaxi.${this.definition.table}`;
    const countResult = await this.pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM ${table} WHERE ${where}`,
      values,
    );
    const total = Number(countResult.rows[0]?.total ?? 0);
    values.push(query.limite, (query.pagina - 1) * query.limite);
    const result = await this.pool.query<QueryResultRow>(
      `SELECT * FROM ${table}
        WHERE ${where}
        ORDER BY ${this.definition.orderBy}
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return paginate(result.rows.map(this.definition.mapRow), total, query);
  }

  async findById(executor: QueryExecutor, empresaId: string, id: string): Promise<CatalogRecord | null> {
    const row = await queryOne<QueryResultRow>(
      executor,
      `SELECT * FROM admtaxi.${this.definition.table} WHERE empresa_id = $1 AND id = $2`,
      [empresaId, id],
    );
    return row ? this.definition.mapRow(row) : null;
  }

  async create(executor: QueryExecutor, empresaId: string, input: CatalogInput): Promise<CatalogRecord> {
    const entries = this.persistenceEntries(input);
    const columns = ['empresa_id', ...entries.map(([column]) => column)];
    const values = [empresaId, ...entries.map(([, value]) => value)];
    const placeholders = values.map((_value, index) => `$${index + 1}`);
    const result = await executor.query<QueryResultRow>(
      `INSERT INTO admtaxi.${this.definition.table} (${columns.join(', ')})
       VALUES (${placeholders.join(', ')}) RETURNING *`,
      values,
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Falha ao criar ${this.definition.entity}.`);
    return this.definition.mapRow(row);
  }

  async update(executor: QueryExecutor, empresaId: string, id: string, input: CatalogInput): Promise<CatalogRecord | null> {
    const entries = this.persistenceEntries(input);
    const values: unknown[] = [empresaId, id];
    const assignments = entries.map(([column, value]) => {
      values.push(value);
      return `${column} = $${values.length}`;
    });
    if (assignments.length === 0) return this.findById(executor, empresaId, id);

    const result = await executor.query<QueryResultRow>(
      `UPDATE admtaxi.${this.definition.table}
          SET ${assignments.join(', ')}
        WHERE empresa_id = $1 AND id = $2
      RETURNING *`,
      values,
    );
    return result.rows[0] ? this.definition.mapRow(result.rows[0]) : null;
  }

  async setActive(executor: QueryExecutor, empresaId: string, id: string, ativo: boolean): Promise<CatalogRecord | null> {
    const values: unknown[] = [empresaId, id, ativo];
    const extraAssignments = !ativo
      ? Object.entries(this.definition.deactivateFields ?? {}).map(([column, value]) => {
        values.push(value);
        return `${column} = $${values.length}`;
      })
      : [];
    const result = await executor.query<QueryResultRow>(
      `UPDATE admtaxi.${this.definition.table}
          SET ativo = $3${extraAssignments.length > 0 ? `, ${extraAssignments.join(', ')}` : ''}
        WHERE empresa_id = $1 AND id = $2
      RETURNING *`,
      values,
    );
    return result.rows[0] ? this.definition.mapRow(result.rows[0]) : null;
  }

  private persistenceEntries(input: CatalogInput): Array<[string, unknown]> {
    return Object.entries(this.definition.fields)
      .filter(([key]) => input[key] !== undefined)
      .map(([key, column]) => [column, input[key]]);
  }
}
