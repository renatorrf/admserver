import { Pool } from 'pg';

import { getDatabaseUrl } from '../config/env';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: getDatabaseUrl(), application_name: 'adm-taxi-schema-inspection', max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const tables = await client.query<{ table_name: string }>(`
        SELECT table_name
          FROM information_schema.tables
         WHERE table_schema = 'admtaxi' AND table_type = 'BASE TABLE'
         ORDER BY table_name
      `);
    const columns = await client.query<{ table_name: string; total: string }>(`
        SELECT table_name, COUNT(*)::text AS total
          FROM information_schema.columns
         WHERE table_schema = 'admtaxi'
         GROUP BY table_name
         ORDER BY table_name
      `);
    const constraints = await client.query<{ constraint_type: string; total: string }>(`
        SELECT constraint_type, COUNT(*)::text AS total
          FROM information_schema.table_constraints
         WHERE constraint_schema = 'admtaxi'
         GROUP BY constraint_type
         ORDER BY constraint_type
      `);
    const indexes = await client.query<{ total: string }>(`
        SELECT COUNT(*)::text AS total
          FROM pg_indexes
         WHERE schemaname = 'admtaxi'
      `);
    const functions = await client.query<{ proname: string }>(`
        SELECT p.proname
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'admtaxi'
         ORDER BY p.proname
      `);
    const enums = await client.query<{ enum_name: string; valores: string }>(`
        SELECT t.typname AS enum_name, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS valores
          FROM pg_type t
          JOIN pg_enum e ON e.enumtypid = t.oid
          JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = 'admtaxi'
         GROUP BY t.typname
         ORDER BY t.typname
      `);
    const migrations = await client.query<{ versao: number; nome: string }>(`
        SELECT versao, nome FROM admtaxi.schema_migrations ORDER BY versao
      `);

    console.log(JSON.stringify({
      tabelas: tables.rows.map((row) => row.table_name),
      colunasPorTabela: Object.fromEntries(columns.rows.map((row) => [row.table_name, Number(row.total)])),
      constraints: Object.fromEntries(constraints.rows.map((row) => [row.constraint_type, Number(row.total)])),
      indices: Number(indexes.rows[0]?.total ?? 0),
      funcoes: functions.rows.map((row) => row.proname),
      enums: Object.fromEntries(enums.rows.map((row) => [row.enum_name, row.valores])),
      migrations: migrations.rows,
    }, null, 2));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Erro desconhecido';
  console.error(`Falha na inspecao: ${message}`);
  process.exitCode = 1;
});
