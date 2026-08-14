import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ quiet: true });

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL nao foi definida.');

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: 'adm-taxi-restore-center', max: 1 });
const client = await pool.connect();

try {
  await client.query('BEGIN');
  const result = await client.query(`
    INSERT INTO admtaxi.centros_custo (empresa_id, codigo, nome, descricao, ativo)
    SELECT DISTINCT u.empresa_id, 'ADM', 'Administracao', 'Centro de custo para demonstracao', TRUE
      FROM admtaxi.usuarios u
     WHERE u.perfil::text = 'GESTOR'
    ON CONFLICT (empresa_id, codigo) DO UPDATE SET
      nome = EXCLUDED.nome,
      descricao = EXCLUDED.descricao,
      ativo = TRUE
    RETURNING id, empresa_id, codigo, nome, ativo
  `);
  if (result.rowCount < 1) throw new Error('Nenhuma empresa com usuario GESTOR foi encontrada.');
  for (const center of result.rows) {
    await client.query(
      `INSERT INTO admtaxi.auditoria
         (empresa_id, usuario_id, entidade, entidade_id, acao, dados_novos)
       SELECT $1, u.id, 'centro_custo', $2, 'RESTAURAR_APOS_LIMPEZA',
              jsonb_build_object('codigo', $3::text, 'nome', $4::text, 'ativo', $5::boolean)
         FROM admtaxi.usuarios u
        WHERE u.empresa_id = $1 AND u.perfil::text = 'GESTOR'
        ORDER BY u.criado_em LIMIT 1`,
      [center.empresa_id, center.id, center.codigo, center.nome, center.ativo],
    );
  }
  await client.query('COMMIT');
  console.log(`Centro de custo restaurado em ${result.rowCount} empresa(s).`);
  for (const row of result.rows) console.log(`${row.codigo} - ${row.nome}: ${row.ativo ? 'ativo' : 'inativo'}`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
