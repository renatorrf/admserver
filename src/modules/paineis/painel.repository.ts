import type { QueryResultRow } from 'pg';

import type { Database } from '../../db/pool';
import { forbidden } from '../../shared/errors/app-error';
import type { AuthContext } from '../auth/auth.types';
import { CorridaRepository, type CorridaScope } from '../corridas/corrida.repository';
import type { CorridaListQuery } from '../corridas/corrida.schemas';
import type { PainelParticipanteQuery } from './painel.schemas';
import { employeeRide } from '../corridas/corrida-visibility';
import { operationMonth } from '../../shared/validation/calendar-date';

type SummaryRow = QueryResultRow & {
  total: string; finalizadas: string; canceladas: string; agendadas: string;
  em_andamento: string; recusadas: string; proximas: string;
  valor_total: string; valor_medio: string;
};

export class PainelParticipanteRepository {
  private readonly rides: CorridaRepository;

  constructor(private readonly database: Database) {
    this.rides = new CorridaRepository(database);
  }

  async get(auth: AuthContext, query: PainelParticipanteQuery) {
    const identity = await this.identity(auth);
    const period = this.period(query);
    const bounds = await this.database.query<{ inicio: Date; fim: Date }>(
      `SELECT $1::date::timestamp AT TIME ZONE timezone AS inicio,
              $2::date::timestamp AT TIME ZONE timezone AS fim
         FROM admtaxi.empresas WHERE id=$3`, [period.inicio, period.fimExclusive, auth.empresaId]);
    const interval = bounds.rows[0];
    if (!interval) throw forbidden();
    const values: unknown[] = [auth.empresaId, interval.inicio, interval.fim];
    const conditions = [
      'c.empresa_id = $1',
      'c.solicitada_em >= $2::timestamptz',
      'c.solicitada_em < $3::timestamptz',
    ];
    const add = (sql: string, value: unknown): void => {
      values.push(value);
      conditions.push(sql.replace('?', `$${values.length}`));
    };
    if (identity.scope.kind === 'FUNCIONARIO') {
      values.push(identity.scope.funcionarioId);
      conditions.push(`(c.funcionario_id=$${values.length} OR EXISTS (
        SELECT 1 FROM admtaxi.corrida_paradas p WHERE p.empresa_id=c.empresa_id AND p.corrida_id=c.id AND p.funcionario_id=$${values.length}
      ) OR EXISTS (SELECT 1 FROM admtaxi.corrida_participacoes p WHERE p.empresa_id=c.empresa_id AND p.corrida_id=c.id AND p.funcionario_id=$${values.length}))`);
    }
    if (identity.scope.kind === 'PRESTADOR') add('c.prestador_id = ?', identity.scope.prestadorId);
    if (query.status) add('c.status = ?', query.status);
    if (query.solicitanteUsuarioId && identity.scope.kind !== 'FUNCIONARIO') add('c.solicitante_usuario_id = ?', query.solicitanteUsuarioId);
    if (query.prestadorId) add('c.prestador_id = ?', query.prestadorId);
    if (query.centroCustoId) add('c.centro_custo_id = ?', query.centroCustoId);
    if (query.funcionarioId && identity.scope.kind !== 'FUNCIONARIO') {
      values.push(query.funcionarioId);
      conditions.push(`(c.funcionario_id=$${values.length} OR EXISTS (
        SELECT 1 FROM admtaxi.corrida_participacoes p WHERE p.empresa_id=c.empresa_id AND p.corrida_id=c.id AND p.funcionario_id=$${values.length}))`);
    }

    const summary = await this.database.query<SummaryRow>(
      `SELECT COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE c.status='FINALIZADA')::text AS finalizadas,
        COUNT(*) FILTER (WHERE c.status='CANCELADA')::text AS canceladas,
        COUNT(*) FILTER (WHERE c.tipo='AGENDADA')::text AS agendadas,
        COUNT(*) FILTER (WHERE c.status IN ('ACEITA','EM_DESLOCAMENTO','AGUARDANDO_PASSAGEIRO','EM_CORRIDA'))::text AS em_andamento,
        COUNT(*) FILTER (WHERE c.status='RECUSADA')::text AS recusadas,
        COUNT(*) FILTER (WHERE c.agendada_para >= CURRENT_TIMESTAMP AND c.status IN ('SOLICITADA','OFERTADA','ACEITA'))::text AS proximas,
        COALESCE(SUM(c.valor_final) FILTER (WHERE c.status='FINALIZADA'),0)::text AS valor_total,
        COALESCE(AVG(c.valor_final) FILTER (WHERE c.status='FINALIZADA'),0)::text AS valor_medio
       FROM admtaxi.corridas c WHERE ${conditions.join(' AND ')}`,
      values,
    );
    const row = summary.rows[0]!;
    const listQuery: CorridaListQuery = {
      pagina: query.pagina, limite: query.limite, busca: query.busca,
      status: query.status, centroCustoId: query.centroCustoId,
      funcionarioId: query.funcionarioId, prestadorId: query.prestadorId,
      solicitanteUsuarioId: query.solicitanteUsuarioId,
      inicio: interval.inicio,
      fim: new Date(interval.fim.getTime() - 1),
    };
    const history = await this.rides.list(auth.empresaId, identity.scope, listQuery);
    return {
      perfil: auth.perfil,
      periodo: { inicio: period.inicio, fim: period.fim },
      disponibilidade: identity.disponivel,
      resumo: {
        total: Number(row.total), finalizadas: Number(row.finalizadas), canceladas: Number(row.canceladas),
        agendadas: Number(row.agendadas), emAndamento: Number(row.em_andamento), recusadas: Number(row.recusadas),
        proximas: Number(row.proximas), valorTotal: auth.perfil === 'FUNCIONARIO' ? null : row.valor_total,
        valorMedio: auth.perfil === 'FUNCIONARIO' ? null : row.valor_medio,
      },
      corridas: identity.scope.kind === 'FUNCIONARIO' ? { ...history,
        data: history.data.map(ride => employeeRide(ride, (identity.scope as { funcionarioId: string }).funcionarioId)) } : history,
    };
  }

  private async identity(auth: AuthContext): Promise<{ scope: CorridaScope; disponivel: boolean | null }> {
    if (auth.perfil === 'FUNCIONARIO') {
      const result = await this.database.query<{ id: string }>(
        `SELECT id FROM admtaxi.funcionarios
          WHERE empresa_id=$1 AND usuario_id=$2 AND ativo=TRUE`,
        [auth.empresaId, auth.usuarioId],
      );
      const id = result.rows[0]?.id;
      if (!id) throw forbidden();
      return { scope: { kind: 'FUNCIONARIO', funcionarioId: id }, disponivel: null };
    }
    if (auth.perfil === 'PRESTADOR') {
      const result = await this.database.query<{ id: string; disponivel: boolean }>(
        `SELECT id,disponivel FROM admtaxi.prestadores
          WHERE empresa_id=$1 AND usuario_id=$2 AND ativo=TRUE`,
        [auth.empresaId, auth.usuarioId],
      );
      const provider = result.rows[0];
      if (!provider) throw forbidden();
      return {
        scope: { kind: 'PRESTADOR', prestadorId: provider.id, disponivel: provider.disponivel },
        disponivel: provider.disponivel,
      };
    }
    throw forbidden();
  }

  private period(query: PainelParticipanteQuery): { inicio: string; fim: string; fimExclusive: string } {
    const defaults = operationMonth();
    const inicio = query.inicio ?? defaults.inicio;
    const fim = query.fim ?? defaults.fim;
    const end = new Date(`${fim}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    return { inicio, fim, fimExclusive: end.toISOString().slice(0, 10) };
  }
}
