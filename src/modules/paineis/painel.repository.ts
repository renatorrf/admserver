import type { QueryResultRow } from 'pg';

import type { Database } from '../../db/pool';
import { forbidden } from '../../shared/errors/app-error';
import type { AuthContext } from '../auth/auth.types';
import { CorridaRepository, type CorridaScope } from '../corridas/corrida.repository';
import type { CorridaListQuery } from '../corridas/corrida.schemas';
import type { PainelParticipanteQuery } from './painel.schemas';

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
    const values: unknown[] = [auth.empresaId, period.inicio, period.fimExclusive];
    const conditions = [
      'c.empresa_id = $1',
      'c.solicitada_em >= $2::date',
      'c.solicitada_em < $3::date',
    ];
    const add = (sql: string, value: unknown): void => {
      values.push(value);
      conditions.push(sql.replace('?', `$${values.length}`));
    };
    if (identity.scope.kind === 'FUNCIONARIO') add('c.funcionario_id = ?', identity.scope.funcionarioId);
    if (identity.scope.kind === 'PRESTADOR') add('c.prestador_id = ?', identity.scope.prestadorId);
    if (query.status) add('c.status = ?', query.status);
    if (query.solicitanteUsuarioId) add('c.solicitante_usuario_id = ?', query.solicitanteUsuarioId);
    if (query.prestadorId) add('c.prestador_id = ?', query.prestadorId);
    if (query.centroCustoId) add('c.centro_custo_id = ?', query.centroCustoId);
    if (query.funcionarioId) add('c.funcionario_id = ?', query.funcionarioId);

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
      inicio: new Date(`${period.inicio}T00:00:00.000Z`),
      fim: new Date(new Date(`${period.fimExclusive}T00:00:00.000Z`).getTime() - 1),
    };
    const history = await this.rides.list(auth.empresaId, identity.scope, listQuery);
    return {
      perfil: auth.perfil,
      periodo: { inicio: period.inicio, fim: period.fim },
      disponibilidade: identity.disponivel,
      resumo: {
        total: Number(row.total), finalizadas: Number(row.finalizadas), canceladas: Number(row.canceladas),
        agendadas: Number(row.agendadas), emAndamento: Number(row.em_andamento), recusadas: Number(row.recusadas),
        proximas: Number(row.proximas), valorTotal: row.valor_total, valorMedio: row.valor_medio,
      },
      corridas: history,
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
    const today = new Date();
    const year = today.getUTCFullYear();
    const month = today.getUTCMonth();
    const defaultStart = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    const defaultEnd = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
    const inicio = query.inicio ?? defaultStart;
    const fim = query.fim ?? defaultEnd;
    const end = new Date(`${fim}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    return { inicio, fim, fimExclusive: end.toISOString().slice(0, 10) };
  }
}
