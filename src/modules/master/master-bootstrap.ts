import type { Pool } from 'pg';

export async function ensureInitialMaster(
  pool: Pool,
  username: string | undefined,
  passwordHash: string | undefined,
): Promise<void> {
  if (!username || !passwordHash) return;
  await pool.query(`
    INSERT INTO admtaxi.administradores_plataforma (usuario, nome, senha_hash, deve_alterar_senha)
    SELECT $1, 'Administrador Master', $2, TRUE
    WHERE NOT EXISTS (SELECT 1 FROM admtaxi.administradores_plataforma)
    ON CONFLICT (usuario) DO NOTHING
  `, [username, passwordHash]);
}
