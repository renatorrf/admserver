import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ quiet: true });

const { Pool } = pg;
const confirm = process.argv.includes('--confirm');
const preservedTables = new Set([
  'administradores_plataforma',
  'auditoria',
  'auditoria_plataforma',
  'centros_custo',
  'empresas',
  'schema_migrations',
  'usuarios',
]);

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL nao foi definida.');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: 'adm-taxi-cleanup', max: 1 });
const client = await pool.connect();

try {
  const tableResult = await client.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'admtaxi' ORDER BY tablename`,
  );
  const tables = tableResult.rows.map((row) => row.tablename);
  const countsBefore = new Map();
  for (const table of tables) {
    const result = await client.query(`SELECT COUNT(*)::int AS total FROM admtaxi.${table}`);
    countsBefore.set(table, result.rows[0].total);
  }
  const gestorResult = await client.query(
    `SELECT COUNT(*)::int AS total, COUNT(DISTINCT empresa_id)::int AS empresas
       FROM admtaxi.usuarios WHERE perfil::text = 'GESTOR'`,
  );
  const gestores = gestorResult.rows[0];

  console.log(`Gestores a preservar: ${gestores.total} em ${gestores.empresas} empresa(s).`);
  for (const table of tables) console.log(`${table}: ${countsBefore.get(table)}`);

  if (!confirm) {
    console.log('Inspecao concluida. Execute novamente com --confirm para limpar.');
  } else {
    if (gestores.total < 1) throw new Error('Limpeza cancelada: nenhum usuario GESTOR foi encontrado.');
    const truncateTables = tables.filter((table) => !preservedTables.has(table));
    await client.query('BEGIN');
    try {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('admtaxi_cleanup_keep_gestors'))`);
      if (truncateTables.length) {
        await client.query(`TRUNCATE TABLE ${truncateTables.map((table) => `admtaxi.${table}`).join(', ')} RESTART IDENTITY`);
      }
      await client.query(
        `UPDATE admtaxi.auditoria a SET usuario_id = NULL
          WHERE usuario_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM admtaxi.usuarios u
               WHERE u.empresa_id = a.empresa_id AND u.id = a.usuario_id AND u.perfil::text = 'GESTOR'
            )`,
      );
      await client.query(
        `DELETE FROM admtaxi.auditoria a
          WHERE NOT EXISTS (
            SELECT 1 FROM admtaxi.usuarios u
             WHERE u.empresa_id = a.empresa_id AND u.perfil::text = 'GESTOR'
          )`,
      );
      await client.query(`DELETE FROM admtaxi.usuarios WHERE perfil::text <> 'GESTOR'`);
      await client.query(
        `DELETE FROM admtaxi.centros_custo c
          WHERE NOT EXISTS (
            SELECT 1 FROM admtaxi.usuarios u
             WHERE u.empresa_id = c.empresa_id AND u.perfil::text = 'GESTOR'
          )`,
      );
      await client.query(
        `DELETE FROM admtaxi.empresas e
          WHERE NOT EXISTS (
            SELECT 1 FROM admtaxi.usuarios u
             WHERE u.empresa_id = e.id AND u.perfil::text = 'GESTOR'
          )`,
      );
      const remaining = await client.query(
        `SELECT COUNT(*)::int AS total, COUNT(DISTINCT empresa_id)::int AS empresas
           FROM admtaxi.usuarios WHERE perfil::text = 'GESTOR'`,
      );
      if (remaining.rows[0].total !== gestores.total) {
        throw new Error('A quantidade de gestores mudou durante a limpeza.');
      }
      await client.query(
        `INSERT INTO admtaxi.auditoria
           (empresa_id, usuario_id, entidade, entidade_id, acao, dados_novos)
         SELECT DISTINCT ON (u.empresa_id) u.empresa_id, u.id, 'manutencao', u.empresa_id::text,
                'LIMPEZA_DADOS', jsonb_build_object('gestoresPreservados', TRUE, 'centrosCustoPreservados', TRUE)
           FROM admtaxi.usuarios u
          WHERE u.perfil::text = 'GESTOR'
          ORDER BY u.empresa_id, u.criado_em`,
      );
      await client.query('COMMIT');
      console.log(`Limpeza concluida. Gestores preservados: ${remaining.rows[0].total}.`);
      console.log(`Empresas preservadas: ${remaining.rows[0].empresas}.`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  client.release();
  await pool.end();
}
