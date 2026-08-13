import type { QueryResultRow } from 'pg';

import type { Database } from '../../db/pool';
import { paginate } from '../../shared/pagination/pagination';
import type { AuthContext } from '../auth/auth.types';
import type { RelatorioExportQuery, RelatorioFilters, RelatorioListQuery } from './relatorio.schemas';
import type { CustoAgrupado, RelatorioCorrida, RelatorioResumo } from './relatorio.types';

type ReportRow = QueryResultRow & RelatorioCorrida;
type SummaryRow = QueryResultRow & {
  corridas: string; finalizadas: string; canceladas: string; valorEstimado: string; valorFinal: string;
};
type GroupRow = QueryResultRow & { id: string | null; codigo?: string; nome: string; corridas: string; valor: string };

const select = `SELECT c.id, c.solicitada_em AS "solicitadaEm", c.agendada_para AS "agendadaPara",
  c.finalizada_em AS "finalizadaEm", c.status::text, c.tipo::text,
  c.funcionario_id AS "funcionarioId", f.nome AS "funcionarioNome",
  c.centro_custo_id AS "centroCustoId", cc.codigo AS "centroCustoCodigo", cc.nome AS "centroCustoNome",
  c.prestador_id AS "prestadorId", p.nome AS "prestadorNome",
  c.solicitante_usuario_id AS "solicitanteUsuarioId", u.nome AS "solicitanteNome",
  c.origem_descricao AS "origemDescricao", c.destino_descricao AS "destinoDescricao",
  c.valor_estimado::text AS "valorEstimado", c.valor_final::text AS "valorFinal"
 FROM admtaxi.corridas c
 JOIN admtaxi.funcionarios f ON f.empresa_id = c.empresa_id AND f.id = c.funcionario_id
 JOIN admtaxi.centros_custo cc ON cc.empresa_id = c.empresa_id AND cc.id = c.centro_custo_id
 JOIN admtaxi.usuarios u ON u.empresa_id = c.empresa_id AND u.id = c.solicitante_usuario_id
 LEFT JOIN admtaxi.prestadores p ON p.empresa_id = c.empresa_id AND p.id = c.prestador_id`;

export class RelatorioRepository {
  constructor(private readonly database: Database) {}

  async list(auth: AuthContext, query: RelatorioListQuery) {
    const { where, values } = this.buildWhere(auth, query);
    const count = await this.database.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM admtaxi.corridas c WHERE ${where}`,
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
    const { where, values } = this.buildWhere(auth, query);
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
      `SELECT COUNT(*)::text AS corridas,
        SUM(CASE WHEN c.status = 'FINALIZADA' THEN 1 ELSE 0 END)::text AS finalizadas,
        SUM(CASE WHEN c.status = 'CANCELADA' THEN 1 ELSE 0 END)::text AS canceladas,
        COALESCE(SUM(c.valor_estimado), 0)::text AS "valorEstimado",
        COALESCE(SUM(CASE WHEN c.status = 'FINALIZADA' THEN c.valor_final ELSE 0 END), 0)::text AS "valorFinal"
       FROM admtaxi.corridas c WHERE ${where}`,
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
      `SELECT c.centro_custo_id AS id, cc.codigo, cc.nome, COUNT(*)::text AS corridas,
        COALESCE(SUM(CASE WHEN c.status = 'FINALIZADA' THEN c.valor_final ELSE 0 END), 0)::text AS valor
       FROM admtaxi.corridas c
       JOIN admtaxi.centros_custo cc ON cc.empresa_id = c.empresa_id AND cc.id = c.centro_custo_id
       WHERE ${where} GROUP BY c.centro_custo_id, cc.codigo, cc.nome ORDER BY valor DESC, cc.codigo LIMIT 20`,
      values,
    );
    return result.rows.map((row) => ({ ...row, corridas: Number(row.corridas) }));
  }

  private async groupByProvider(where: string, values: unknown[]): Promise<CustoAgrupado[]> {
    const result = await this.database.query<GroupRow>(
      `SELECT c.prestador_id AS id, COALESCE(p.nome, 'Sem prestador') AS nome, COUNT(*)::text AS corridas,
        COALESCE(SUM(CASE WHEN c.status = 'FINALIZADA' THEN c.valor_final ELSE 0 END), 0)::text AS valor
       FROM admtaxi.corridas c
       LEFT JOIN admtaxi.prestadores p ON p.empresa_id = c.empresa_id AND p.id = c.prestador_id
       WHERE ${where} GROUP BY c.prestador_id, p.nome ORDER BY valor DESC, nome LIMIT 20`,
      values,
    );
    return result.rows.map((row) => ({ ...row, corridas: Number(row.corridas) }));
  }

  private buildWhere(auth: AuthContext, query: RelatorioFilters): { where: string; values: unknown[] } {
    const values: unknown[] = [auth.empresaId];
    const conditions = ['c.empresa_id = $1'];
    const add = (sql: string, value: unknown): void => { values.push(value); conditions.push(sql.replace('?', `$${values.length}`)); };
    if (auth.perfil === 'GERENTE') {
      values.push(auth.usuarioId);
      conditions.push(`EXISTS (SELECT 1 FROM admtaxi.gerente_centros_custo gcc
        WHERE gcc.empresa_id = c.empresa_id AND gcc.centro_custo_id = c.centro_custo_id
          AND gcc.gerente_usuario_id = $${values.length})`);
    }
    if (query.inicio) add('c.solicitada_em >= ?', query.inicio);
    if (query.fim) add('c.solicitada_em <= ?', query.fim);
    if (query.status) add('c.status = ?', query.status);
    if (query.centroCustoId) add('c.centro_custo_id = ?', query.centroCustoId);
    if (query.funcionarioId) add('c.funcionario_id = ?', query.funcionarioId);
    if (query.prestadorId) add('c.prestador_id = ?', query.prestadorId);
    if (query.solicitanteUsuarioId) add('c.solicitante_usuario_id = ?', query.solicitanteUsuarioId);
    return { where: conditions.join(' AND '), values };
  }
}
