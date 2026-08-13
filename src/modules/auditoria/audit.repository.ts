import type { Pool, QueryResultRow } from 'pg';

import type { QueryExecutor } from '../../db/pool';
import { paginate, type PaginatedResult } from '../../shared/pagination/pagination';
import type { AuditListQuery } from './audit.schemas';
import type { AuditEntry } from './audit.types';

type AuditRow = QueryResultRow & {
  id: string;
  empresa_id: string;
  usuario_id: string | null;
  entidade: string;
  entidade_id: string;
  acao: string;
  dados_anteriores: Record<string, unknown> | null;
  dados_novos: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
  criado_em: Date;
};

export type AuditRecord = {
  id: string;
  empresaId: string;
  usuarioId: string | null;
  entidade: string;
  entidadeId: string;
  acao: string;
  dadosAnteriores: Record<string, unknown> | null;
  dadosNovos: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
  criadoEm: Date;
};

function mapAudit(row: AuditRow): AuditRecord {
  return {
    id: row.id,
    empresaId: row.empresa_id,
    usuarioId: row.usuario_id,
    entidade: row.entidade,
    entidadeId: row.entidade_id,
    acao: row.acao,
    dadosAnteriores: row.dados_anteriores,
    dadosNovos: row.dados_novos,
    ip: row.ip,
    userAgent: row.user_agent,
    criadoEm: row.criado_em,
  };
}

export class AuditRepository {
  constructor(private readonly pool: Pool) {}

  async record(executor: QueryExecutor, entry: AuditEntry): Promise<void> {
    await executor.query(
      `INSERT INTO admtaxi.auditoria
         (empresa_id, usuario_id, entidade, entidade_id, acao, dados_anteriores, dados_novos, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        entry.empresaId,
        entry.usuarioId ?? null,
        entry.entidade,
        entry.entidadeId,
        entry.acao,
        entry.dadosAnteriores ?? null,
        entry.dadosNovos ?? null,
        entry.ip ?? null,
        entry.userAgent ?? null,
      ],
    );
  }

  async list(empresaId: string, query: AuditListQuery): Promise<PaginatedResult<AuditRecord>> {
    const values: unknown[] = [empresaId];
    const conditions = ['empresa_id = $1'];
    const addCondition = (condition: string, value: unknown): void => {
      values.push(value);
      conditions.push(condition.replace('?', `$${values.length}`));
    };

    if (query.entidade) addCondition('entidade = ?', query.entidade);
    if (query.acao) addCondition('acao = ?', query.acao);
    if (query.usuarioId) addCondition('usuario_id = ?', query.usuarioId);
    if (query.inicio) addCondition('criado_em >= ?', query.inicio);
    if (query.fim) addCondition('criado_em <= ?', query.fim);

    const where = conditions.join(' AND ');
    const countResult = await this.pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM admtaxi.auditoria WHERE ${where}`,
      values,
    );
    const total = Number(countResult.rows[0]?.total ?? 0);
    values.push(query.limite, (query.pagina - 1) * query.limite);
    const result = await this.pool.query<AuditRow>(
      `SELECT id::text, empresa_id, usuario_id, entidade, entidade_id, acao,
              dados_anteriores, dados_novos, host(ip) AS ip, user_agent, criado_em
         FROM admtaxi.auditoria
        WHERE ${where}
        ORDER BY criado_em DESC, id DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return paginate(result.rows.map(mapAudit), total, query);
  }
}
