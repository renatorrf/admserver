import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { getDatabaseUrl } from '../src/config/env';
import type { Database } from '../src/db/pool';
import { UsuarioControleService } from '../src/modules/usuarios/usuario-controle.service';

async function main() {
  const pool = new Pool({ connectionString: getDatabaseUrl(), max: 1,
    connectionTimeoutMillis: 10_000, statement_timeout: 10_000, query_timeout: 12_000,
    application_name: 'adm-taxi-pilot-readonly' });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const version = await client.query('SHOW server_version');
      console.log('PostgreSQL:', version.rows[0].server_version);
      const tls = await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()');
      console.log('TLS nesta conexao:', tls.rows[0]?.ssl === true ? 'ativo' : 'inativo');
      const applied = await client.query<{ versao: number; nome: string; checksum: string }>(
        'SELECT versao,nome,checksum FROM admtaxi.schema_migrations ORDER BY versao');
      const directory = path.resolve('src/db/migrations');
      const files = (await readdir(directory)).filter(file => /^\d{3}_.+\.up\.sql$/.test(file));
      const pending: string[] = [];
      for (const file of files) {
        const record = applied.rows.find(row => row.versao === Number(file.slice(0, 3)));
        if (!record) { pending.push(file); continue; }
        const sql = await readFile(path.join(directory, file), 'utf8');
        assert.equal(createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex'), record.checksum.trim(),
          `Checksum divergente: ${file}`);
      }
      console.log('Migracoes aplicadas:', applied.rowCount, '| Pendentes:', pending.length ? pending.join(', ') : 'nenhuma');
      assert.equal(pending.length, 0, 'Aplique as migracoes pendentes com autorizacao antes do piloto.');
      const tables = ['usuarios','empresas','refresh_tokens','dispositivos_usuario','dispositivos_push',
        'setores','centros_custo','funcionarios','prestadores','corridas','corrida_paradas','corrida_localizacoes',
        'push_subscriptions','push_tentativas','faturamentos','faturamento_itens','faturamento_exclusoes','corrida_valor_ajustes'];
      for (const table of tables) {
        const check = await client.query('SELECT to_regclass($1) AS relation', [`admtaxi.${table}`]);
        assert.ok(check.rows[0].relation, `Tabela ausente: ${table}`);
      }
      console.log('Tabelas essenciais: presentes');
      const database = { query: client.query.bind(client) } as Database;
      const service = new UsuarioControleService(database);
      const empty = await service.list({ empresaId: randomUUID(), usuarioId: randomUUID(), perfil: 'GESTOR' }, { pagina: 1, limite: 20 });
      assert.equal(empty.meta.total, 0);
      assert.equal(empty.data.length, 0);
      const companies = await client.query<{ id: string }>('SELECT id FROM admtaxi.empresas ORDER BY id LIMIT 20');
      for (const company of companies.rows) {
        const auth = { empresaId: company.id, usuarioId: randomUUID(), perfil: 'GESTOR' as const };
        const start = Date.now();
        const result = await service.list(auth, { pagina: 1, limite: 20 });
        const expected = await client.query('SELECT COUNT(*)::int AS total FROM admtaxi.usuarios WHERE empresa_id=$1', [company.id]);
        assert.equal(result.meta.total, expected.rows[0].total);
        const ids = result.data.map(user => user.id);
        const isolated = await client.query('SELECT COUNT(*)::int AS total FROM admtaxi.usuarios WHERE empresa_id=$1 AND id=ANY($2::uuid[])', [company.id, ids]);
        assert.equal(isolated.rows[0].total, ids.length);
        const filtered = await service.list(auth, { pagina: 1, limite: 20, ativo: true, atividade: 'RECENTE', perfil: 'GESTOR' });
        assert.ok(filtered.data.every(user => user.ativo === true && user.atividadeRecente === true && user.perfil === 'GESTOR'));
        console.log('Consulta e isolamento: OK | duracao(ms):', Date.now() - start);
      }
      await client.query('ROLLBACK');
      console.log('Verificacao concluida em READ ONLY. Nenhum dado alterado.');
    } finally { client.release(); }
  } finally { await pool.end(); }
}

void main().catch((error: unknown) => {
  console.error('Verificacao nao concluida:', error instanceof Error ? error.message : 'erro desconhecido');
  process.exitCode = 1;
});
