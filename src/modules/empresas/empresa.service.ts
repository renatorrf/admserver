import type { Pool, QueryResultRow } from 'pg';

import { queryOne, withTransaction, type QueryExecutor } from '../../db/pool';
import { notFound } from '../../shared/errors/app-error';
import type { AuthContext } from '../auth/auth.types';
import type { AuditRepository } from '../auditoria/audit.repository';
import type { AuditMetadata } from '../auditoria/audit.types';
import type { EmpresaUpdateInput } from './empresa.schemas';

type EmpresaRecord = Record<string, unknown> & {
  id: string;
  codigoAcesso: string;
  razaoSocial: string;
  nomeFantasia: string;
  cnpj: string | null;
  telefone: string | null;
  email: string | null;
  timezone: string;
  cidadePadrao: string | null;
  estadoPadrao: string | null;
  latitudePadrao: number | null;
  longitudePadrao: number | null;
  ativo: boolean;
};

const fieldColumns: Record<keyof EmpresaUpdateInput, string> = {
  codigoAcesso: 'codigo_acesso',
  razaoSocial: 'razao_social',
  nomeFantasia: 'nome_fantasia',
  cnpj: 'cnpj',
  telefone: 'telefone',
  email: 'email',
  timezone: 'timezone',
  cidadePadrao: 'cidade_padrao',
  estadoPadrao: 'estado_padrao',
  latitudePadrao: 'latitude_padrao',
  longitudePadrao: 'longitude_padrao',
};

function mapEmpresa(row: QueryResultRow): EmpresaRecord {
  return {
    id: row.id as string,
    codigoAcesso: row.codigo_acesso as string,
    razaoSocial: row.razao_social as string,
    nomeFantasia: row.nome_fantasia as string,
    cnpj: row.cnpj as string | null,
    telefone: row.telefone as string | null,
    email: row.email as string | null,
    timezone: row.timezone as string,
    cidadePadrao: row.cidade_padrao as string | null,
    estadoPadrao: row.estado_padrao as string | null,
    latitudePadrao: row.latitude_padrao === null ? null : Number(row.latitude_padrao),
    longitudePadrao: row.longitude_padrao === null ? null : Number(row.longitude_padrao),
    ativo: row.ativo as boolean,
    criadoEm: row.criado_em as Date,
    atualizadoEm: row.atualizado_em as Date,
  };
}

export class EmpresaService {
  constructor(private readonly pool: Pool, private readonly audit: AuditRepository) {}

  async getCurrent(auth: AuthContext): Promise<EmpresaRecord> {
    const row = await this.find(this.pool, auth.empresaId);
    if (!row) throw notFound('Empresa');
    return row;
  }

  updateCurrent(auth: AuthContext, input: EmpresaUpdateInput, metadata: AuditMetadata): Promise<EmpresaRecord> {
    return withTransaction(this.pool, async (client) => {
      const current = await this.find(client, auth.empresaId);
      if (!current) throw notFound('Empresa');
      const entries = Object.entries(input).filter(([, value]) => value !== undefined) as Array<[keyof EmpresaUpdateInput, unknown]>;
      const values: unknown[] = [auth.empresaId];
      const assignments = entries.map(([key, value]) => {
        values.push(value);
        return `${fieldColumns[key]} = $${values.length}`;
      });
      const result = await client.query<QueryResultRow>(
        `UPDATE admtaxi.empresas SET ${assignments.join(', ')} WHERE id = $1 RETURNING *`,
        values,
      );
      const row = result.rows[0];
      if (!row) throw notFound('Empresa');
      const updated = mapEmpresa(row);
      await this.audit.record(client, {
        ...metadata,
        empresaId: auth.empresaId,
        usuarioId: auth.usuarioId,
        entidade: 'empresa',
        entidadeId: auth.empresaId,
        acao: 'ATUALIZAR',
        dadosAnteriores: current,
        dadosNovos: updated,
      });
      return updated;
    });
  }

  private async find(executor: QueryExecutor, empresaId: string): Promise<EmpresaRecord | null> {
    const row = await queryOne<QueryResultRow>(executor, 'SELECT * FROM admtaxi.empresas WHERE id = $1', [empresaId]);
    return row ? mapEmpresa(row) : null;
  }
}
