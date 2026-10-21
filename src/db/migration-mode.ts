// PostgreSQL 9.6 requires ADD VALUE outside transactions. Only this idempotent
// operation may opt out; migrations that change rows remain transactional.
export function isNonTransactionalMigration(sql: string): boolean {
  if (!sql.startsWith('-- transaction: none')) return false;
  const statement = sql.replace(/^--[^\n]*(?:\n|$)/gm, '').trim();
  if (!/^ALTER TYPE admtaxi\.[a-z_]+ ADD VALUE IF NOT EXISTS '[A-Z_]+';$/u.test(statement)) {
    throw new Error('Migration sem transacao deve conter somente ALTER TYPE ADD VALUE IF NOT EXISTS.');
  }
  return true;
}
