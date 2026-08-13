import type { QueryResultRow } from 'pg';

import { queryOne, type Database, type QueryExecutor } from '../../db/pool';
import type { MasterCreateInput } from './master.schemas';
import type { MasterPublic, MasterRecord } from './master.types';

type MasterRow = QueryResultRow & {
  id: string; usuario: string; nome: string; senha_hash: string; ativo: boolean;
  deve_alterar_senha: boolean; ultimo_acesso_em: Date | null; criado_em: Date;
};

function mapMaster(row: MasterRow): MasterRecord {
  return {
    administradorId: row.id,
    usuario: row.usuario,
    nome: row.nome,
    senhaHash: row.senha_hash,
    ativo: row.ativo,
    deveAlterarSenha: row.deve_alterar_senha,
    ultimoAcessoEm: row.ultimo_acesso_em,
    criadoEm: row.criado_em,
  };
}

export function publicMaster(master: MasterRecord): MasterPublic {
  return {
    administradorId: master.administradorId,
    usuario: master.usuario,
    nome: master.nome,
    ativo: master.ativo,
    deveAlterarSenha: master.deveAlterarSenha,
    ultimoAcessoEm: master.ultimoAcessoEm,
    criadoEm: master.criadoEm,
  };
}

export class MasterRepository {
  constructor(private readonly database: Database) {}

  async findByUsername(executor: QueryExecutor, username: string): Promise<MasterRecord | null> {
    const row = await queryOne<MasterRow>(executor, `
      SELECT id, usuario::text, nome, senha_hash, ativo, deve_alterar_senha, ultimo_acesso_em, criado_em
        FROM admtaxi.administradores_plataforma WHERE usuario = $1
    `, [username]);
    return row ? mapMaster(row) : null;
  }

  async findById(executor: QueryExecutor, id: string): Promise<MasterRecord | null> {
    const row = await queryOne<MasterRow>(executor, `
      SELECT id, usuario::text, nome, senha_hash, ativo, deve_alterar_senha, ultimo_acesso_em, criado_em
        FROM admtaxi.administradores_plataforma WHERE id = $1
    `, [id]);
    return row ? mapMaster(row) : null;
  }

  async touchAccess(id: string): Promise<void> {
    await this.database.query(
      'UPDATE admtaxi.administradores_plataforma SET ultimo_acesso_em = CURRENT_TIMESTAMP WHERE id = $1', [id],
    );
  }

  async changePassword(executor: QueryExecutor, id: string, passwordHash: string): Promise<MasterRecord> {
    const result = await executor.query<MasterRow>(`
      UPDATE admtaxi.administradores_plataforma
         SET senha_hash = $2, deve_alterar_senha = FALSE
       WHERE id = $1
      RETURNING id, usuario::text, nome, senha_hash, ativo, deve_alterar_senha, ultimo_acesso_em, criado_em
    `, [id, passwordHash]);
    return mapMaster(result.rows[0]!);
  }

  async list(): Promise<MasterPublic[]> {
    const result = await this.database.query<MasterRow>(`
      SELECT id, usuario::text, nome, senha_hash, ativo, deve_alterar_senha, ultimo_acesso_em, criado_em
        FROM admtaxi.administradores_plataforma ORDER BY nome, id
    `);
    return result.rows.map((row) => publicMaster(mapMaster(row)));
  }

  async create(executor: QueryExecutor, input: MasterCreateInput, passwordHash: string): Promise<MasterRecord> {
    const result = await executor.query<MasterRow>(`
      INSERT INTO admtaxi.administradores_plataforma (usuario, nome, senha_hash)
      VALUES ($1, $2, $3)
      RETURNING id, usuario::text, nome, senha_hash, ativo, deve_alterar_senha, ultimo_acesso_em, criado_em
    `, [input.usuario, input.nome, passwordHash]);
    return mapMaster(result.rows[0]!);
  }

  async setActive(executor: QueryExecutor, id: string, active: boolean): Promise<MasterRecord | null> {
    const result = await executor.query<MasterRow>(`
      UPDATE admtaxi.administradores_plataforma SET ativo = $2 WHERE id = $1
      RETURNING id, usuario::text, nome, senha_hash, ativo, deve_alterar_senha, ultimo_acesso_em, criado_em
    `, [id, active]);
    return result.rows[0] ? mapMaster(result.rows[0]) : null;
  }
}
