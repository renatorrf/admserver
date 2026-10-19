import type { Pool, PoolClient } from 'pg';

import { queryOne, withTransaction } from '../../db/pool';
import type { AuthContext, AuthUserRecord, LoginCompany, RefreshTokenRecord } from './auth.types';
import { lockCredentials } from './account-credentials';

type AuthUserRow = {
  id: string;
  empresa_id: string;
  nome: string;
  email: string;
  senha_hash: string;
  perfil: AuthUserRecord['perfil'];
  ativo: boolean;
  empresa_ativa: boolean;
  senha_versao: number;
  deve_alterar_senha: boolean;
};

export interface AuthRepository {
  listActiveCompanies(): Promise<LoginCompany[]>;
  findByEmail(email: string, empresaCodigo: string): Promise<AuthUserRecord | null>;
  findById(auth: AuthContext): Promise<AuthUserRecord | null>;
  saveRefreshToken(record: RefreshTokenRecord): Promise<void>;
  rotateRefreshToken<T>(
    currentHash: string,
    auth: AuthContext,
    createNext: (user: AuthUserRecord) => { record: RefreshTokenRecord; value: T },
  ): Promise<{ user: AuthUserRecord; value: T } | null>;
  revokeRefreshToken(tokenHash: string): Promise<void>;
  updateLastAccess(auth: AuthContext): Promise<void>;
}

function mapUser(row: AuthUserRow | null): AuthUserRecord | null {
  if (!row) {
    return null;
  }
  return {
    usuarioId: row.id,
    empresaId: row.empresa_id,
    nome: row.nome,
    email: row.email,
    senhaHash: row.senha_hash,
    perfil: row.perfil,
    ativo: row.ativo,
    empresaAtiva: row.empresa_ativa,
    senhaVersao: row.senha_versao,
    deveAlterarSenha: row.deve_alterar_senha,
  };
}

export class PgAuthRepository implements AuthRepository {
  constructor(private readonly pool: Pool) {}

  async accessAllowed(auth: AuthContext): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM admtaxi.usuarios_autenticacao u JOIN admtaxi.empresas e ON e.id=u.empresa_id
       WHERE u.id=$1 AND u.empresa_id=$2 AND u.perfil=$3 AND u.ativo=TRUE AND e.ativo=TRUE
         AND u.senha_versao=$4 AND u.deve_alterar_senha=$5`,
      [auth.usuarioId, auth.empresaId, auth.perfil, auth.senhaVersao ?? 0, auth.deveAlterarSenha ?? false],
    );
    return result.rowCount === 1;
  }

  async listActiveCompanies(): Promise<LoginCompany[]> {
    const result = await this.pool.query<{ codigo_acesso: string; nome_fantasia: string }>(`
      SELECT codigo_acesso::text, nome_fantasia
        FROM admtaxi.empresas
       WHERE ativo = TRUE
       ORDER BY nome_fantasia, codigo_acesso
    `);
    return result.rows.map((row) => ({
      codigoAcesso: row.codigo_acesso,
      nomeFantasia: row.nome_fantasia,
    }));
  }

  async findByEmail(email: string, empresaCodigo: string): Promise<AuthUserRecord | null> {
    const row = await queryOne<AuthUserRow>(
      this.pool,
      `SELECT u.id, u.empresa_id, u.nome, u.email::text AS email, u.senha_hash,
              u.perfil::text AS perfil, u.ativo, e.ativo AS empresa_ativa, u.senha_versao, u.deve_alterar_senha
         FROM admtaxi.usuarios_autenticacao u
         JOIN admtaxi.empresas e ON e.id = u.empresa_id
        WHERE u.email = $1 AND e.codigo_acesso = $2
        LIMIT 1`,
      [email, empresaCodigo],
    );
    return mapUser(row);
  }

  async findById(auth: AuthContext, executor: Pool | PoolClient = this.pool): Promise<AuthUserRecord | null> {
    const row = await queryOne<AuthUserRow>(
      executor,
      `SELECT u.id, u.empresa_id, u.nome, u.email::text AS email, u.senha_hash,
              u.perfil::text AS perfil, u.ativo, e.ativo AS empresa_ativa, u.senha_versao, u.deve_alterar_senha
         FROM admtaxi.usuarios_autenticacao u
         JOIN admtaxi.empresas e ON e.id = u.empresa_id
        WHERE u.id = $1 AND u.empresa_id = $2
        LIMIT 1`,
      [auth.usuarioId, auth.empresaId],
    );
    return mapUser(row);
  }

  async saveRefreshToken(record: RefreshTokenRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO admtaxi.refresh_tokens
         (id, empresa_id, usuario_id, token_hash, expira_em)
       VALUES ($1, $2, $3, $4, $5)`,
      [record.id, record.empresaId, record.usuarioId, record.tokenHash, record.expiraEm],
    );
  }

  async rotateRefreshToken<T>(
    currentHash: string,
    auth: AuthContext,
    createNext: (user: AuthUserRecord) => { record: RefreshTokenRecord; value: T },
  ): Promise<{ user: AuthUserRecord; value: T } | null> {
    return withTransaction(this.pool, async (client) => {
      const user = await this.consumeRefreshToken(client, currentHash, auth);
      if (!user || !user.ativo || !user.empresaAtiva) {
        return null;
      }

      const next = createNext(user);
      await client.query(
        `INSERT INTO admtaxi.refresh_tokens
           (id, empresa_id, usuario_id, token_hash, expira_em)
         VALUES ($1, $2, $3, $4, $5)`,
        [next.record.id, next.record.empresaId, next.record.usuarioId, next.record.tokenHash, next.record.expiraEm],
      );
      return { user, value: next.value };
    });
  }

  async revokeRefreshToken(tokenHash: string): Promise<void> {
    await this.pool.query(
      `UPDATE admtaxi.refresh_tokens
          SET revogado_em = COALESCE(revogado_em, CURRENT_TIMESTAMP)
        WHERE token_hash = $1`,
      [tokenHash],
    );
  }

  async updateLastAccess(auth: AuthContext): Promise<void> {
    await this.pool.query(
      `UPDATE admtaxi.usuarios
          SET ultimo_acesso_em = CURRENT_TIMESTAMP
        WHERE id = $1 AND empresa_id = $2`,
      [auth.usuarioId, auth.empresaId],
    );
  }

  private async consumeRefreshToken(
    client: PoolClient,
    tokenHash: string,
    auth: AuthContext,
  ): Promise<AuthUserRecord | null> {
    // Same lock order as password changes, preventing refresh/reset races.
    await lockCredentials(client, auth.usuarioId, auth.empresaId);
    const locked = await client.query(
      'SELECT id FROM admtaxi.usuarios_autenticacao WHERE id=$1 AND empresa_id=$2 AND senha_versao=$3',
      [auth.usuarioId, auth.empresaId, auth.senhaVersao ?? 0],
    );
    if (!locked.rowCount) return null;
    const result = await client.query<AuthUserRow>(
      `UPDATE admtaxi.refresh_tokens rt
          SET revogado_em = CURRENT_TIMESTAMP
         FROM admtaxi.usuarios_autenticacao u, admtaxi.empresas e
        WHERE rt.token_hash = $1
          AND rt.usuario_id = $2
          AND rt.empresa_id = $3
          AND rt.revogado_em IS NULL
          AND rt.expira_em > CURRENT_TIMESTAMP
          AND u.id = rt.usuario_id
          AND u.empresa_id = rt.empresa_id
          AND e.id = u.empresa_id
      RETURNING u.id, u.empresa_id, u.nome, u.email::text AS email, u.senha_hash,
                u.perfil::text AS perfil, u.ativo, e.ativo AS empresa_ativa, u.senha_versao, u.deve_alterar_senha`,
      [tokenHash, auth.usuarioId, auth.empresaId],
    );
    return mapUser(result.rows[0] ?? null);
  }
}
