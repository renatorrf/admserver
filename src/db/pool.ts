import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

import type { AppConfig } from '../config/env';

export type Database = Pick<Pool, 'query' | 'connect'>;
export type QueryExecutor = Pick<PoolClient, 'query'>;

export function createPool(config: Pick<AppConfig, 'databaseUrl'>): Pool {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    application_name: 'adm-taxi-backend',
    options: '-c timezone=America/Sao_Paulo',
    max: 10,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
    query_timeout: 35_000,
  });

  return pool;
}

export async function withTransaction<T>(pool: Database, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function queryOne<T extends QueryResultRow>(
  database: QueryExecutor,
  text: string,
  values: unknown[],
): Promise<T | null> {
  const result: QueryResult<T> = await database.query<T>(text, values);
  return result.rows[0] ?? null;
}
