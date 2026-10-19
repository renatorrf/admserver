import type { QueryResultRow } from 'pg';

import type { Database } from '../../db/pool';
import { paginate } from '../../shared/pagination/pagination';
import type { AuthContext } from '../auth/auth.types';
import {
  addCenterScope, OperationalScopeService, type OperationalScope, type OperationalScopeResolver,
} from '../escopo/operational-scope.service';
import type { RelatorioExportQuery, RelatorioFilters, RelatorioListQuery } from './relatorio.schemas';
import type { CustoAgrupado, RelatorioCorrida, RelatorioResumo } from './relatorio.types';

type ReportRow = QueryResultRow & RelatorioCorrida;
type SummaryRow = QueryResultRow & {
  corridas: string; finalizadas: string; canceladas: string; valorEstimado: string; valorFinal: string;
};
type GroupRow = QueryResultRow & { id: string | null; codigo?: string; nome: string; corridas: string; valor: string };

const select = `SELECT c.id, c.solicitada_em AS "solicitadaEm", c.agendada_para AS "agendadaPara",
  c.finalizada_em AS "finalizadaEm", c.status::text, c.tipo::text,
  a.funcionario_id AS "funcionarioId", f.nome AS "funcionarioNome",
  a.centro_custo_id AS "centroCustoId", cc.codigo AS "centroCustoCodigo", cc.nome AS "centroCustoNome",
  c.prestador_id AS "prestadorId", p.nome AS "prestadorNome",
  c.solicitante_usuario_id AS "solicitanteUsuarioId", u.nome AS "solicitanteNome",
  c.origem_descricao AS "origemDescricao", c.destino_descricao AS "destinoDescricao",
  a.valor_estimado::text AS "valorEstimado", a.valor_final::text AS "valorFinal"
 FROM admtaxi.corridas c
 JOIN admtaxi.corrida_custos a ON a.empresa_id=c.empresa_id AND a.corrida_id=c.id
 JOIN admtaxi.funcionarios f ON f.empresa_id = c.empresa_id AND f.id = a.funcionario_id
 JOIN admtaxi.centros_custo cc ON cc.empresa_id = c.empresa_id AND cc.id = a.centro_custo_id
 JOIN admtaxi.usuarios u ON u.empresa_id = c.empresa_id AND u.id = c.solicitante_usuario_id
 LEFT JOIN admtaxi.prestadores p ON p.empresa_id = c.empresa_id AND p.id = c.prestador_id`;

export class RelatorioRepository {
  private readonly scopeResolver: OperationalScopeResolver;

  constructor(private readonly database: Database, scopeResolver?: OperationalScopeResolver) {
    this.scopeResolver = scopeResolver ?? new OperationalScopeService(database);
  }

  async list(auth: AuthContext, query: RelatorioListQuery) {
    const { where, values } = this.buildWhere(await this.scopeResolver.resolve(auth), query);
    const count = await this.database.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM admtaxi.corridas c
       JOIN admtaxi.corrida_custos a ON a.empresa_id=c.empresa_id AND a.corrida_id=c.id WHERE ${where}`,
      values,
    );
    const total = Number(count.rows[0]?.total ?? 0);
    const pageValues = [...values, query.limite, (query.pagina - 1) * query.limite];
    const rows = await this.database.query<ReportRow>(
      `${select} WHERE ${where}
       ORDER BY COALESCE(c.finalizada_em, c.agendada_para, c.solicitada_em) DESC, c.id DESC
       LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
      pageValues,
    );
    const [summary, centers, providers] = await Promise.all([
      this.summary(where, values),
      this.groupByCenter(where, values),
      this.groupByProvider(where, values),
    ]);
    return { ...paginate(rows.rows, total, query), resumo: summary, custosPorCentro: centers, custosPorPrestador: providers };
  }

  async export(auth: AuthContext, query: RelatorioExportQuery): Promise<RelatorioCorrida[]> {
    const { where, values } = this.buildWhere(await this.scopeResolver.resolve(auth), query);
    const result = await this.database.query<ReportRow>(
      `${select} WHERE ${where}
       ORDER BY COALESCE(c.finalizada_em, c.agendada_para, c.solicitada_em) DESC, c.id DESC
       LIMIT 10000`,
      values,
    );
    return result.rows;
  }

  private async summary(where: string, values: unknown[]): Promise<RelatorioResumo> {
    const result = await this.database.query<SummaryRow>(
      `SELECT COUNT(DISTINCT c.id)::text AS corridas,
        COUNT(DISTINCT c.id) FILTER (WHERE c.status='FINALIZADA')::text AS finalizadas,
        COUNT(DISTINCT c.id) FILTER (WHERE c.status='CANCELADA')::text AS canceladas,
        COALESCE(SUM(a.valor_estimado), 0)::text AS "valorEstimado",
        COALESCE(SUM(CASE WHEN c.status = 'FINALIZADA' THEN a.valor_final ELSE 0 END), 0)::text AS "valorFinal"
       FROM admtaxi.corridas c JOIN admtaxi.corrida_custos a ON a.empresa_id=c.empresa_id AND a.corrida_id=c.id WHERE ${where}`,
      values,
    );
    const row = result.rows[0];
    return {
      corridas: Number(row?.corridas ?? 0), finalizadas: Number(row?.finalizadas ?? 0),
      canceladas: Number(row?.canceladas ?? 0), valorEstimado: row?.valorEstimado ?? '0', valorFinal: row?.valorFinal ?? '0',
    };
  }

  private async groupByCenter(where: string, values: unknown[]): Promise<CustoAgrupado[]> {
    const result = await this.database.query<GroupRow>(
      `SELECT a.centro_custo_id AS id, cc.codigo, cc.nome, COUNT(DISTINCT c.id)::text AS corridas,
        COALESCE(SUM(CASE WHEN c.status = 'FINALIZADA' THEN a.valor_final ELSE 0 END), 0)::text AS valor
       FROM admtaxi.corridas c
       JOIN admtaxi.corrida_custos a ON a.empresa_id=c.empresa_id AND a.corrida_id=c.id
       JOIN admtaxi.centros_custo cc ON cc.empresa_id = c.empresa_id AND cc.id = a.centro_custo_id
       WHERE ${where} GROUP BY a.centro_custo_id, cc.codigo, cc.nome ORDER BY valor DESC, cc.codigo LIMIT 20`,
      values,
    );
    return result.rows.map((row) => ({ ...row, corridas: Number(row.corridas) }));
  }

  private async groupByProvider(where: string, values: unknown[]): Promise<CustoAgrupado[]> {
    const result = await this.database.query<GroupRow>(
      `SELECT c.prestador_id AS id, COALESCE(p.nome, 'Sem prestador') AS nome, COUNT(DISTINCT c.id)::text AS corridas,
        COALESCE(SUM(CASE WHEN c.status = 'FINALIZADA' THEN a.valor_final ELSE 0 END), 0)::text AS valor
       FROM admtaxi.corridas c
       JOIN admtaxi.corrida_custos a ON a.empresa_id=c.empresa_id AND a.corrida_id=c.id
       LEFT JOIN admtaxi.prestadores p ON p.empresa_id = c.empresa_id AND p.id = c.prestador_id
       WHERE ${where} GROUP BY c.prestador_id, p.nome ORDER BY valor DESC, nome LIMIT 20`,
      values,
    );
    return result.rows.map((row) => ({ ...row, corridas: Number(row.corridas) }));
  }

  private buildWhere(scope: OperationalScope, query: RelatorioFilters): { where: string; values: unknown[] } {
    const values: unknown[] = [scope.empresaId];
    const conditions = ['c.empresa_id = $1'];
    const add = (sql: string, value: unknown): void => { values.push(value); conditions.push(sql.replace('?', `$${values.length}`)); };
    addCenterScope(conditions, values, scope, 'a.centro_custo_id');
    if (scope.kind === 'GERENTE') conditions.push(`NOT EXISTS (SELECT 1 FROM admtaxi.corrida_participacoes cp
      JOIN admtaxi.funcionarios cf ON cf.empresa_id=cp.empresa_id AND cf.id=cp.funcionario_id
      WHERE cp.empresa_id=c.empresa_id AND cp.corrida_id=c.id AND
      (NOT (cp.centro_custo_id=ANY($${values.length}::uuid[])) OR NOT (cf.centro_custo_id=ANY($${values.length}::uuid[]))))`);
    if (query.inicio) add('c.solicitada_em >= ?', query.inicio);
    if (query.fim) add('c.solicitada_em <= ?', query.fim);
    if (query.status) add('c.status = ?', query.status);
    if (query.centroCustoId) add('a.centro_custo_id = ?', query.centroCustoId);
    if (query.funcionarioId) add('a.funcionario_id = ?', query.funcionarioId);
    if (query.prestadorId) add('c.prestador_id = ?', query.prestadorId);
    if (query.solicitanteUsuarioId) add('c.solicitante_usuario_id = ?', query.solicitanteUsuarioId);
    return { where: conditions.join(' AND '), values };
  }
}
