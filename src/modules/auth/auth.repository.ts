import type { Pool, PoolClient } from 'pg';

import { queryOne, withTransaction } from '../../db/pool';
import type { AuthContext, AuthUserRecord, LoginCompany, RefreshTokenRecord } from './auth.types';

type AuthUserRow = {
  id: string;
  empresa_id: string;
  nome: string;
  email: string;
  senha_hash: string;
  perfil: AuthUserRecord['perfil'];
  ativo: boolean;
  empresa_ativa: boolean;
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
  };
}

export class PgAuthRepository implements AuthRepository {
  constructor(private readonly pool: Pool) {}

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
              u.perfil::text AS perfil, u.ativo, e.ativo AS empresa_ativa
         FROM admtaxi.usuarios u
         JOIN admtaxi.empresas e ON e.id = u.empresa_id
        WHERE u.email = $1 AND e.codigo_acesso = $2
        LIMIT 1`,
      [email, empresaCodigo],
    );
    return mapUser(row);
  }

  async findById(auth: AuthContext): Promise<AuthUserRecord | null> {
    const row = await queryOne<AuthUserRow>(
      this.pool,
      `SELECT u.id, u.empresa_id, u.nome, u.email::text AS email, u.senha_hash,
              u.perfil::text AS perfil, u.ativo, e.ativo AS empresa_ativa
         FROM admtaxi.usuarios u
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
    const result = await client.query<AuthUserRow>(
      `UPDATE admtaxi.refresh_tokens rt
          SET revogado_em = CURRENT_TIMESTAMP
         FROM admtaxi.usuarios u, admtaxi.empresas e
        WHERE rt.token_hash = $1
          AND rt.usuario_id = $2
          AND rt.empresa_id = $3
          AND rt.revogado_em IS NULL
          AND rt.expira_em > CURRENT_TIMESTAMP
          AND u.id = rt.usuario_id
          AND u.empresa_id = rt.empresa_id
          AND e.id = u.empresa_id
      RETURNING u.id, u.empresa_id, u.nome, u.email::text AS email, u.senha_hash,
                u.perfil::text AS perfil, u.ativo, e.ativo AS empresa_ativa`,
      [tokenHash, auth.usuarioId, auth.empresaId],
    );
    return mapUser(result.rows[0] ?? null);
  }
}
