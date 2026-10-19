import type { QueryResultRow } from 'pg';

import type { Database } from '../../db/pool';
import type { AuthContext } from '../auth/auth.types';
import {
  addCenterScope, OperationalScopeService, type OperationalScope, type OperationalScopeResolver,
} from '../escopo/operational-scope.service';

type MetricsRow = QueryResultRow & {
  solicitadasHoje: string;
  emAndamento: string;
  finalizadasHoje: string;
  canceladasHoje: string;
  custoDia: string;
  custoMes: string;
  proximasCorridas: string;
  minhasSolicitacoesMes: string;
  prestadoresDisponiveis: string;
};
type CostRow = QueryResultRow & { id: string | null; codigo?: string; nome: string; corridas: string; valor: string };
type MonthRow = QueryResultRow & { mes: string; corridas: string; valor: string };
type ActiveRideRow = QueryResultRow & {
  id: string; status: string; funcionarioNome: string; prestadorNome: string | null;
  origemDescricao: string; destinoDescricao: string; latitude: string | null; longitude: string | null;
};
type UpcomingRow = QueryResultRow & {
  id: string; agendadaPara: Date; funcionarioNome: string; origemDescricao: string; destinoDescricao: string;
};

export class DashboardRepository {
  private readonly scopeResolver: OperationalScopeResolver;

  constructor(private readonly database: Database, scopeResolver?: OperationalScopeResolver) {
    this.scopeResolver = scopeResolver ?? new OperationalScopeService(database);
  }

  async get(auth: AuthContext) {
    const scope = await this.scopeResolver.resolve(auth);
    const { where, values } = this.scope(scope);
    const [metrics, centers, providers, monthly, active, upcoming] = await Promise.all([
      this.database.query<MetricsRow>(
        `SELECT
          SUM(CASE WHEN c.solicitada_em::date = CURRENT_DATE THEN 1 ELSE 0 END)::text AS "solicitadasHoje",
          SUM(CASE WHEN c.status IN ('ACEITA','EM_DESLOCAMENTO','AGUARDANDO_PASSAGEIRO','EM_CORRIDA') THEN 1 ELSE 0 END)::text AS "emAndamento",
          SUM(CASE WHEN c.status = 'FINALIZADA' AND c.finalizada_em::date = CURRENT_DATE THEN 1 ELSE 0 END)::text AS "finalizadasHoje",
          SUM(CASE WHEN c.status = 'CANCELADA' AND c.cancelada_em::date = CURRENT_DATE THEN 1 ELSE 0 END)::text AS "canceladasHoje",
          COALESCE(SUM(CASE WHEN c.status = 'FINALIZADA' AND c.finalizada_em::date = CURRENT_DATE THEN c.valor_final ELSE 0 END),0)::text AS "custoDia",
          COALESCE(SUM(CASE WHEN c.status = 'FINALIZADA' AND date_trunc('month', c.finalizada_em) = date_trunc('month', CURRENT_DATE) THEN c.valor_final ELSE 0 END),0)::text AS "custoMes",
          SUM(CASE WHEN c.tipo = 'AGENDADA' AND c.agendada_para >= CURRENT_TIMESTAMP AND c.status IN ('SOLICITADA','OFERTADA','ACEITA') THEN 1 ELSE 0 END)::text AS "proximasCorridas",
          SUM(CASE WHEN c.solicitante_usuario_id = $${values.length + 1} AND date_trunc('month', c.solicitada_em) = date_trunc('month', CURRENT_DATE) THEN 1 ELSE 0 END)::text AS "minhasSolicitacoesMes",
          (SELECT COUNT(*)::text FROM admtaxi.prestadores p WHERE p.empresa_id = $1 AND p.ativo = TRUE AND p.disponivel = TRUE) AS "prestadoresDisponiveis"
         FROM admtaxi.corridas c WHERE ${where}`,
        [...values, auth.usuarioId],
      ),
      this.database.query<CostRow>(
        `SELECT a.centro_custo_id AS id, cc.codigo, cc.nome, COUNT(DISTINCT c.id)::text AS corridas,
          COALESCE(SUM(a.valor_final),0)::text AS valor
         FROM admtaxi.corridas c JOIN admtaxi.corrida_custos a ON a.empresa_id=c.empresa_id AND a.corrida_id=c.id
         JOIN admtaxi.centros_custo cc ON cc.empresa_id=c.empresa_id AND cc.id=a.centro_custo_id
         WHERE ${where} AND c.status='FINALIZADA' AND date_trunc('month',c.finalizada_em)=date_trunc('month',CURRENT_DATE)
         GROUP BY a.centro_custo_id,cc.codigo,cc.nome ORDER BY valor DESC LIMIT 8`, values,
      ),
      this.database.query<CostRow>(
        `SELECT c.prestador_id AS id, COALESCE(p.nome,'Sem prestador') AS nome, COUNT(*)::text AS corridas,
          COALESCE(SUM(c.valor_final),0)::text AS valor
         FROM admtaxi.corridas c LEFT JOIN admtaxi.prestadores p ON p.empresa_id=c.empresa_id AND p.id=c.prestador_id
         WHERE ${where} AND c.status='FINALIZADA' AND date_trunc('month',c.finalizada_em)=date_trunc('month',CURRENT_DATE)
         GROUP BY c.prestador_id,p.nome ORDER BY valor DESC LIMIT 8`, values,
      ),
      this.database.query<MonthRow>(
        `SELECT to_char(months.mes,'YYYY-MM') AS mes, COUNT(c.id)::text AS corridas,
          COALESCE(SUM(c.valor_final),0)::text AS valor
         FROM generate_series(date_trunc('month',CURRENT_DATE)-interval '11 months',date_trunc('month',CURRENT_DATE),interval '1 month') months(mes)
         LEFT JOIN admtaxi.corridas c ON c.empresa_id=$1 AND c.status='FINALIZADA'
          AND date_trunc('month',c.finalizada_em)=months.mes
          ${this.managerJoinScope(scope, values)}
         GROUP BY months.mes ORDER BY months.mes`, values,
      ),
      this.database.query<ActiveRideRow>(
        `SELECT c.id,c.status::text,f.nome AS "funcionarioNome",p.nome AS "prestadorNome",
          c.origem_descricao AS "origemDescricao",c.destino_descricao AS "destinoDescricao",
          COALESCE(last.latitude,c.origem_latitude)::text AS latitude,
          COALESCE(last.longitude,c.origem_longitude)::text AS longitude
         FROM admtaxi.corridas c JOIN admtaxi.funcionarios f ON f.empresa_id=c.empresa_id AND f.id=c.funcionario_id
         LEFT JOIN admtaxi.prestadores p ON p.empresa_id=c.empresa_id AND p.id=c.prestador_id
         LEFT JOIN LATERAL (SELECT l.latitude,l.longitude FROM admtaxi.corrida_localizacoes l
           WHERE l.empresa_id=c.empresa_id AND l.corrida_id=c.id ORDER BY l.registrado_em DESC,l.id DESC LIMIT 1) last ON TRUE
         WHERE ${where} AND c.status IN ('ACEITA','EM_DESLOCAMENTO','AGUARDANDO_PASSAGEIRO','EM_CORRIDA')
         ORDER BY c.atualizado_em DESC LIMIT 50`, values,
      ),
      this.database.query<UpcomingRow>(
        `SELECT c.id,c.agendada_para AS "agendadaPara",f.nome AS "funcionarioNome",
          c.origem_descricao AS "origemDescricao",c.destino_descricao AS "destinoDescricao"
         FROM admtaxi.corridas c JOIN admtaxi.funcionarios f ON f.empresa_id=c.empresa_id AND f.id=c.funcionario_id
         WHERE ${where} AND c.tipo='AGENDADA' AND c.agendada_para>=CURRENT_TIMESTAMP
          AND c.status IN ('SOLICITADA','OFERTADA','ACEITA') ORDER BY c.agendada_para LIMIT 5`, values,
      ),
    ]);
    const row = metrics.rows[0];
    return {
      indicadores: {
        solicitadasHoje: Number(row?.solicitadasHoje ?? 0), emAndamento: Number(row?.emAndamento ?? 0),
        finalizadasHoje: Number(row?.finalizadasHoje ?? 0), canceladasHoje: Number(row?.canceladasHoje ?? 0),
        custoDia: row?.custoDia ?? '0', custoMes: row?.custoMes ?? '0',
        proximasCorridas: Number(row?.proximasCorridas ?? 0),
        minhasSolicitacoesMes: Number(row?.minhasSolicitacoesMes ?? 0),
        prestadoresDisponiveis: auth.perfil === 'GESTOR' ? Number(row?.prestadoresDisponiveis ?? 0) : null,
      },
      custosPorCentro: centers.rows.map(this.mapCost),
      custosPorPrestador: providers.rows.map(this.mapCost),
      evolucaoMensal: monthly.rows.map((item) => ({ mes: item.mes, corridas: Number(item.corridas), valor: item.valor })),
      corridasAtivas: active.rows.map((item) => ({
        ...item, latitude: item.latitude === null ? null : Number(item.latitude), longitude: item.longitude === null ? null : Number(item.longitude),
      })),
      proximasCorridas: upcoming.rows,
    };
  }

  private readonly mapCost = (row: CostRow) => ({ ...row, corridas: Number(row.corridas) });

  private scope(scope: OperationalScope): { where: string; values: unknown[] } {
    const values: unknown[] = [scope.empresaId];
    const conditions = ['c.empresa_id=$1'];
    addCenterScope(conditions, values, scope, 'c.centro_custo_id');
    if (scope.kind === 'GERENTE') conditions.push(this.allCentersScope(values.length));
    return { where: conditions.join(' AND '), values };
  }

  private managerJoinScope(scope: OperationalScope, values: unknown[]): string {
    if (scope.kind !== 'GERENTE') return '';
    return `AND c.centro_custo_id = ANY($${values.length}::uuid[]) AND ${this.allCentersScope(values.length)}`;
  }

  private allCentersScope(index: number): string {
    return `NOT EXISTS (SELECT 1 FROM admtaxi.corrida_participacoes cp
      JOIN admtaxi.funcionarios cf ON cf.empresa_id=cp.empresa_id AND cf.id=cp.funcionario_id
      WHERE cp.empresa_id=c.empresa_id AND cp.corrida_id=c.id AND
      (NOT (cp.centro_custo_id=ANY($${index}::uuid[])) OR NOT (cf.centro_custo_id=ANY($${index}::uuid[]))))`;
  }
}
