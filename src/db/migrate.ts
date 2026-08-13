import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { Pool, type PoolClient } from 'pg';

import { getDatabaseUrl } from '../config/env';

type Direction = 'up' | 'down' | 'status' | 'validate';
type Migration = { version: number; name: string; path: string; checksum: string };
type AppliedMigration = { versao: number; nome: string; checksum: string; aplicada_em: Date };

const migrationFilePattern = /^(\d{3})_(.+)\.up\.sql$/;

function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

function migrationsDirectory(): string {
  return path.resolve(__dirname, 'migrations');
}

async function listMigrations(): Promise<Migration[]> {
  const directory = migrationsDirectory();
  const files = await fs.readdir(directory);
  const migrations = await Promise.all(files.flatMap(async (file): Promise<Migration[]> => {
    const match = migrationFilePattern.exec(file);
    if (!match?.[1] || !match[2]) {
      return [];
    }
    const migrationPath = path.join(directory, file);
    const sql = await fs.readFile(migrationPath, 'utf8');
    return [{
      version: Number(match[1]),
      name: match[2],
      path: migrationPath,
      checksum: migrationChecksum(sql),
    }];
  }));

  const sorted = migrations.flat().sort((a, b) => a.version - b.version);
  const versions = new Set<number>();
  for (const migration of sorted) {
    if (versions.has(migration.version)) {
      throw new Error(`Versao de migration duplicada: ${migration.version}`);
    }
    versions.add(migration.version);
  }
  return sorted;
}

async function prepare(client: PoolClient): Promise<void> {
  await client.query('CREATE SCHEMA IF NOT EXISTS admtaxi');
  await client.query(`
    CREATE TABLE IF NOT EXISTS admtaxi.schema_migrations (
      versao INTEGER PRIMARY KEY,
      nome TEXT NOT NULL,
      checksum CHAR(64) NOT NULL,
      aplicada_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function getApplied(client: PoolClient): Promise<AppliedMigration[]> {
  const result = await client.query<AppliedMigration>(
    'SELECT versao, nome, checksum, aplicada_em FROM admtaxi.schema_migrations ORDER BY versao',
  );
  return result.rows;
}

function assertAppliedFilesUnchanged(migrations: Migration[], applied: AppliedMigration[]): void {
  for (const existing of applied) {
    const local = migrations.find((migration) => migration.version === existing.versao);
    if (!local) {
      throw new Error(`Migration aplicada nao existe localmente: ${existing.versao}_${existing.nome}`);
    }
    if (local.name !== existing.nome || local.checksum !== existing.checksum.trim()) {
      throw new Error(`Migration aplicada foi alterada: ${existing.versao}_${existing.nome}`);
    }
  }
}

async function migrateUp(client: PoolClient, migrations: Migration[], applied: AppliedMigration[]): Promise<void> {
  const appliedVersions = new Set(applied.map((migration) => migration.versao));
  const pending = migrations.filter((migration) => !appliedVersions.has(migration.version));
  if (pending.length === 0) {
    console.log('Banco atualizado; nenhuma migration pendente.');
    return;
  }

  for (const migration of pending) {
    const sql = await fs.readFile(migration.path, 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO admtaxi.schema_migrations (versao, nome, checksum) VALUES ($1, $2, $3)',
        [migration.version, migration.name, migration.checksum],
      );
      await client.query('COMMIT');
      console.log(`Aplicada: ${String(migration.version).padStart(3, '0')}_${migration.name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
}

async function migrateDown(client: PoolClient, migrations: Migration[], applied: AppliedMigration[]): Promise<void> {
  if (process.env.ALLOW_DESTRUCTIVE_MIGRATION !== 'true') {
    throw new Error('Rollback bloqueado. Defina ALLOW_DESTRUCTIVE_MIGRATION=true conscientemente.');
  }
  const latest = applied.at(-1);
  if (!latest) {
    console.log('Nenhuma migration aplicada.');
    return;
  }
  const migration = migrations.find((item) => item.version === latest.versao);
  if (!migration) {
    throw new Error(`Arquivo da migration ${latest.versao} nao encontrado.`);
  }
  const downPath = migration.path.replace(/\.up\.sql$/, '.down.sql');
  const sql = await fs.readFile(downPath, 'utf8');

  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('DELETE FROM admtaxi.schema_migrations WHERE versao = $1', [latest.versao]);
    await client.query('COMMIT');
    console.log(`Revertida: ${String(migration.version).padStart(3, '0')}_${migration.name}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function validatePending(client: PoolClient, migrations: Migration[], applied: AppliedMigration[]): Promise<void> {
  const appliedVersions = new Set(applied.map((migration) => migration.versao));
  const pending = migrations.filter((migration) => !appliedVersions.has(migration.version));
  if (pending.length === 0) {
    console.log('Banco atualizado; nenhuma migration pendente para validar.');
    return;
  }

  await client.query('BEGIN');
  try {
    for (const migration of pending) {
      const sql = await fs.readFile(migration.path, 'utf8');
      await client.query(sql);
    }
    await client.query('ROLLBACK');
    console.log(`${pending.length} migration(s) validada(s) com rollback completo.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

function printStatus(migrations: Migration[], applied: AppliedMigration[]): void {
  const appliedVersions = new Set(applied.map((migration) => migration.versao));
  for (const migration of migrations) {
    const status = appliedVersions.has(migration.version) ? 'aplicada' : 'pendente';
    console.log(`${String(migration.version).padStart(3, '0')} ${migration.name}: ${status}`);
  }
}

async function main(): Promise<void> {
  const direction = (process.argv[2] ?? 'up') as Direction;
  if (!['up', 'down', 'status', 'validate'].includes(direction)) {
    throw new Error('Use: migrate.ts [up|down|status|validate]');
  }

  const pool = new Pool({ connectionString: getDatabaseUrl(), application_name: 'adm-taxi-migrations', max: 1 });
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('admtaxi_schema_migrations'))");
    await prepare(client);
    const migrations = await listMigrations();
    const applied = await getApplied(client);
    assertAppliedFilesUnchanged(migrations, applied);

    if (direction === 'up') {
      await migrateUp(client, migrations, applied);
    } else if (direction === 'down') {
      await migrateDown(client, migrations, applied);
    } else if (direction === 'status') {
      printStatus(migrations, applied);
    } else {
      await validatePending(client, migrations, applied);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('admtaxi_schema_migrations'))");
    client.release();
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Erro desconhecido';
  console.error(`Falha nas migrations: ${message}`);
  process.exitCode = 1;
});
