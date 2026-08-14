import argon2 from 'argon2';
import type { QueryResultRow } from 'pg';

import { queryOne, type Database, type QueryExecutor, withTransaction } from '../../db/pool';
import { invalidReference, notFound } from '../../shared/errors/app-error';
import type { AuthContext } from '../auth/auth.types';
import type { AuditMetadata } from '../auditoria/audit.types';
import type { AuditRepository } from '../auditoria/audit.repository';
import { funcionarioDefinition } from './funcionario.catalog';
import type { FuncionarioUnificadoCreateInput, FuncionarioUnificadoUpdateInput } from './funcionario-unificado.schemas';

type FuncionarioRow = QueryResultRow & {
  id: string; empresa_id: string; usuario_id: string | null; centro_custo_id: string; nome: string;
  matricula: string; cpf: string | null; telefone: string | null; email: string | null;
  endereco_padrao: string | null; latitude_padrao: string | null; longitude_padrao: string | null;
  ativo: boolean; criado_em: Date; atualizado_em: Date; usuario_ativo: boolean | null;
};

type PasswordHasher = (password: string) => Promise<string>;

export class FuncionarioUnificadoService {
  constructor(
    private readonly database: Database,
    private readonly audit: AuditRepository,
    private readonly hashPassword: PasswordHasher = (password) => argon2.hash(password),
  ) {}

  async create(auth: AuthContext, input: FuncionarioUnificadoCreateInput, metadata: AuditMetadata) {
    const passwordHash = await this.hashPassword(input.acesso.senha);
    return withTransaction(this.database, async (client) => {
      await funcionarioDefinition.validateReferences?.(client, auth.empresaId, input.funcionario);
      const user = await client.query<{ id: string }>(
        `INSERT INTO admtaxi.usuarios (empresa_id, nome, email, telefone, senha_hash, perfil, ativo)
         VALUES ($1, $2, $3, $4, $5, 'FUNCIONARIO', $6) RETURNING id`,
        [auth.empresaId, input.funcionario.nome, input.funcionario.email!, input.funcionario.telefone ?? null,
          passwordHash, input.acesso.ativo],
      );
      const userId = user.rows[0]?.id;
      if (!userId) throw new Error('Falha ao criar usuario do funcionario.');
      const employee = input.funcionario;
      const created = await client.query<{ id: string }>(
        `INSERT INTO admtaxi.funcionarios
           (empresa_id, usuario_id, centro_custo_id, nome, matricula, cpf, telefone, email,
            endereco_padrao, latitude_padrao, longitude_padrao, ativo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [auth.empresaId, userId, employee.centroCustoId, employee.nome, employee.matricula,
          employee.cpf ?? null, employee.telefone ?? null, employee.email!, employee.enderecoPadrao ?? null,
          employee.latitudePadrao ?? null, employee.longitudePadrao ?? null, input.acesso.ativo],
      );
      const employeeId = created.rows[0]?.id;
      if (!employeeId) throw new Error('Falha ao criar funcionario.');
      await this.audit.record(client, {
        ...metadata, empresaId: auth.empresaId, usuarioId: auth.usuarioId, entidade: 'cadastro_unificado',
        entidadeId: employeeId, acao: 'CRIAR_FUNCIONARIO_ACESSO',
        dadosNovos: { funcionarioId: employeeId, usuarioId: userId, perfil: 'FUNCIONARIO' },
      });
      return this.getFrom(client, auth.empresaId, employeeId);
    });
  }

  async update(auth: AuthContext, id: string, input: FuncionarioUnificadoUpdateInput, metadata: AuditMetadata) {
    const passwordHash = input.acesso?.senha ? await this.hashPassword(input.acesso.senha) : undefined;
    return withTransaction(this.database, async (client) => {
      const current = await this.getFrom(client, auth.empresaId, id, true);
      if (input.funcionario) await funcionarioDefinition.validateReferences?.(client, auth.empresaId, input.funcionario);
      let userId = current.usuarioId;
      if (!userId) {
        const email = input.funcionario?.email ?? current.email;
        if (!email || !passwordHash) {
          throw invalidReference('Funcionario sem acesso: informe e-mail e uma senha temporaria para criar o usuario.');
        }
        const user = await client.query<{ id: string }>(
          `INSERT INTO admtaxi.usuarios (empresa_id, nome, email, telefone, senha_hash, perfil, ativo)
           VALUES ($1, $2, $3, $4, $5, 'FUNCIONARIO', $6) RETURNING id`,
          [auth.empresaId, input.funcionario?.nome ?? current.nome, email,
            input.funcionario?.telefone ?? current.telefone, passwordHash,
            input.acesso?.ativo ?? input.funcionario?.ativo ?? current.ativo],
        );
        userId = user.rows[0]?.id ?? null;
        if (!userId) throw new Error('Falha ao criar usuario do funcionario.');
        await client.query('UPDATE admtaxi.funcionarios SET usuario_id = $3 WHERE empresa_id = $1 AND id = $2',
          [auth.empresaId, id, userId]);
      } else {
        if (input.funcionario?.email === null) throw invalidReference('O e-mail de acesso do funcionario nao pode ser removido.');
        await this.updateUser(client, auth.empresaId, userId, input, passwordHash);
      }
      if (input.funcionario) await this.updateEmployee(client, auth.empresaId, id, input.funcionario);

      const inactivate = input.acesso?.ativo === false || input.funcionario?.ativo === false;
      const activate = !inactivate && (input.acesso?.ativo === true || input.funcionario?.ativo === true);
      if (inactivate || activate) {
        const active = activate;
        await client.query('UPDATE admtaxi.usuarios SET ativo = $3 WHERE empresa_id = $1 AND id = $2', [auth.empresaId, userId, active]);
        await client.query('UPDATE admtaxi.funcionarios SET ativo = $3 WHERE empresa_id = $1 AND id = $2', [auth.empresaId, id, active]);
      }
      if (inactivate || passwordHash) {
        await client.query(
          `UPDATE admtaxi.refresh_tokens SET revogado_em = COALESCE(revogado_em, CURRENT_TIMESTAMP)
            WHERE empresa_id = $1 AND usuario_id = $2`, [auth.empresaId, userId],
        );
      }
      const updated = await this.getFrom(client, auth.empresaId, id);
      await this.audit.record(client, {
        ...metadata, empresaId: auth.empresaId, usuarioId: auth.usuarioId, entidade: 'cadastro_unificado',
        entidadeId: id, acao: 'ATUALIZAR_FUNCIONARIO_ACESSO', dadosAnteriores: current, dadosNovos: updated,
      });
      return updated;
    });
  }

  private async updateUser(
    client: QueryExecutor, empresaId: string, userId: string, input: FuncionarioUnificadoUpdateInput,
    passwordHash?: string,
  ): Promise<void> {
    const values: unknown[] = [empresaId, userId];
    const assignments: string[] = [];
    const employee = input.funcionario;
    for (const [column, value] of [
      ['nome', employee?.nome], ['email', employee?.email], ['telefone', employee?.telefone],
      ['ativo', input.acesso?.ativo], ['senha_hash', passwordHash],
    ] as const) {
      if (value === undefined) continue;
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    }
    if (assignments.length) {
      await client.query(`UPDATE admtaxi.usuarios SET ${assignments.join(', ')} WHERE empresa_id = $1 AND id = $2`, values);
    }
  }

  private async updateEmployee(
    client: QueryExecutor, empresaId: string, employeeId: string,
    input: NonNullable<FuncionarioUnificadoUpdateInput['funcionario']>,
  ): Promise<void> {
    const columns: Record<string, string> = {
      centroCustoId: 'centro_custo_id', nome: 'nome', matricula: 'matricula', cpf: 'cpf',
      telefone: 'telefone', email: 'email', enderecoPadrao: 'endereco_padrao',
      latitudePadrao: 'latitude_padrao', longitudePadrao: 'longitude_padrao', ativo: 'ativo',
    };
    const values: unknown[] = [empresaId, employeeId];
    const assignments = Object.entries(input).filter(([, value]) => value !== undefined).map(([key, value]) => {
      values.push(value);
      return `${columns[key]} = $${values.length}`;
    });
    if (assignments.length) {
      await client.query(`UPDATE admtaxi.funcionarios SET ${assignments.join(', ')} WHERE empresa_id = $1 AND id = $2`, values);
    }
  }

  private async getFrom(executor: QueryExecutor, empresaId: string, id: string, lock = false) {
    const row = await queryOne<FuncionarioRow>(executor,
      `SELECT f.*, u.ativo AS usuario_ativo
         FROM admtaxi.funcionarios f LEFT JOIN admtaxi.usuarios u
           ON u.empresa_id = f.empresa_id AND u.id = f.usuario_id
        WHERE f.empresa_id = $1 AND f.id = $2${lock ? ' FOR UPDATE OF f' : ''}`,
      [empresaId, id]);
    if (!row) throw notFound('Funcionario');
    return {
      id: row.id, empresaId: row.empresa_id, usuarioId: row.usuario_id, centroCustoId: row.centro_custo_id,
      nome: row.nome, matricula: row.matricula, cpf: row.cpf, telefone: row.telefone, email: row.email,
      enderecoPadrao: row.endereco_padrao,
      latitudePadrao: row.latitude_padrao === null ? null : Number(row.latitude_padrao),
      longitudePadrao: row.longitude_padrao === null ? null : Number(row.longitude_padrao),
      ativo: row.ativo && (row.usuario_ativo ?? true), criadoEm: row.criado_em, atualizadoEm: row.atualizado_em,
    };
  }
}
