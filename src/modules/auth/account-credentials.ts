import type { PoolClient } from 'pg';

// Lock the credential owner, not a single membership, across reset/refresh/link operations.
export async function lockCredentials(client: PoolClient, usuarioId: string, empresaId: string): Promise<string | null> {
  const result = await client.query<{ conta_gestor_id: string | null }>(
    'SELECT conta_gestor_id FROM admtaxi.usuarios WHERE id=$1 AND empresa_id=$2', [usuarioId, empresaId]);
  const account = result.rows[0]?.conta_gestor_id ?? null;
  if (account) await client.query('SELECT id FROM admtaxi.contas_gestor WHERE id=$1 FOR UPDATE', [account]);
  else await client.query('SELECT id FROM admtaxi.usuarios WHERE id=$1 AND empresa_id=$2 FOR UPDATE', [usuarioId, empresaId]);
  return account;
}

export async function setPassword(client: PoolClient, account: string | null, usuarioId: string, empresaId: string, hash: string): Promise<void> {
  if (account) await client.query('UPDATE admtaxi.contas_gestor SET senha_hash=$2,deve_alterar_senha=FALSE WHERE id=$1', [account, hash]);
  else await client.query('UPDATE admtaxi.usuarios SET senha_hash=$3,deve_alterar_senha=FALSE WHERE id=$1 AND empresa_id=$2', [usuarioId, empresaId, hash]);
}
