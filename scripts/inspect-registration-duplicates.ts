import { Pool } from 'pg';
import { getDatabaseUrl } from '../src/config/env';

const pool = new Pool({ connectionString: getDatabaseUrl(), connectionTimeoutMillis: 10_000 });
async function main(): Promise<void> {
  try {
    await pool.query('BEGIN READ ONLY');
    let groups = 0;
    for (const table of ['usuarios', 'prestadores', 'funcionarios', 'veiculos']) {
      for (const field of table === 'veiculos' ? ['placa'] : ['nome', 'telefone', 'email']) {
        const digits = `regexp_replace(r.${field}::text, '[^0-9]', '', 'g')`;
        const expression = field === 'telefone'
          ? `CASE WHEN length(${digits}) IN (12,13) AND left(${digits},2)='55' THEN substring(${digits} FROM 3) ELSE ${digits} END`
          : field === 'nome' ? `lower(btrim(regexp_replace(r.nome, '[[:space:]]+', ' ', 'g')))`
          : field === 'placa' ? `regexp_replace(upper(r.placa), '[^A-Z0-9]', '', 'g')` : 'lower(btrim(r.email::text))';
        const result = await pool.query(`SELECT e.codigo_acesso::text AS empresa, count(*) AS quantidade,
          array_agg(r.id ORDER BY r.criado_em,r.id) AS ids
          FROM admtaxi.${table} r JOIN admtaxi.empresas e ON e.id=r.empresa_id
          WHERE NULLIF(${expression},'') IS NOT NULL
          GROUP BY e.codigo_acesso, ${expression} HAVING count(*)>1 ORDER BY e.codigo_acesso`);
        if (result.rows.length) console.log(JSON.stringify({ tabela: table, campo: field, grupos: result.rows }));
        groups += result.rows.length;
      }
    }
    await pool.query('COMMIT');
    console.log(JSON.stringify({ gruposDuplicados: groups, somenteLeitura: true }));
  } finally { await pool.end(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Falha na verificacao'); process.exitCode = 1; });
