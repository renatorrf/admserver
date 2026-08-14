import type { QueryResultRow } from 'pg';

import { queryOne, type Database, type QueryExecutor } from '../../db/pool';
import { paginate, type PaginatedResult } from '../../shared/pagination/pagination';
import type { CorridaCreateInput, CorridaListQuery, EventoListQuery } from './corrida.schemas';
import type { CorridaEventoRecord, CorridaRecord, PrestadorContext, StatusCorrida } from './corrida.types';

type CorridaRow = QueryResultRow & {
  id: string;
  empresa_id: string;
  solicitante_usuario_id: string;
  funcionario_id: string;
  centro_custo_id: string;
  prestador_id: string | null;
  veiculo_id: string | null;
  status: StatusCorrida;
  tipo: CorridaRecord['tipo'];
  funcionario_nome?: string;
  funcionario_telefone?: string | null;
  funcionario_matricula?: string;
  centro_custo_codigo?: string;
  centro_custo_nome?: string;
  prestador_nome?: string | null;
  prestador_telefone?: string | null;
  veiculo_placa?: string | null;
  veiculo_descricao?: string | null;
};

type EventoRow = QueryResultRow & {
  id: string;
  corrida_id: string;
  usuario_id: string | null;
  tipo_evento: string;
  status_anterior: StatusCorrida | null;
  status_novo: StatusCorrida | null;
  descricao: string | null;
  metadata: Record<string, unknown>;
  criado_em: Date;
};
type PrestadorRow = QueryResultRow & PrestadorContext;

export type CorridaScope =
  | { kind: 'GESTOR' }
  | { kind: 'GERENTE'; usuarioId: string; setorIds: string[]; centroCustoIds: string[] }
  | { kind: 'PRESTADOR'; prestadorId: string; disponivel: boolean };

export type CorridaPatch = {
  prestadorId?: string | null;
  veiculoId?: string | null;
  observacaoPrestador?: string | null;
  valorFinal?: string;
  motivoCancelamento?: string;
};

function numeric(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

const corridaSelect = `SELECT c.*,
  f.nome AS funcionario_nome, f.telefone AS funcionario_telefone, f.matricula AS funcionario_matricula,
  cc.codigo AS centro_custo_codigo, cc.nome AS centro_custo_nome,
  p.nome AS prestador_nome, p.telefone AS prestador_telefone,
  v.placa AS veiculo_placa,
  CASE WHEN v.id IS NULL THEN NULL ELSE v.marca || ' ' || v.modelo || ' - ' || v.cor END AS veiculo_descricao
 FROM admtaxi.corridas c
 JOIN admtaxi.funcionarios f ON f.empresa_id = c.empresa_id AND f.id = c.funcionario_id
 JOIN admtaxi.centros_custo cc ON cc.empresa_id = c.empresa_id AND cc.id = c.centro_custo_id
 LEFT JOIN admtaxi.prestadores p ON p.empresa_id = c.empresa_id AND p.id = c.prestador_id
 LEFT JOIN admtaxi.veiculos v ON v.empresa_id = c.empresa_id AND v.id = c.veiculo_id`;

export function mapCorrida(row: CorridaRow): CorridaRecord {
  return {
    id: row.id,
    empresaId: row.empresa_id,
    solicitanteUsuarioId: row.solicitante_usuario_id,
    funcionarioId: row.funcionario_id,
    centroCustoId: row.centro_custo_id,
    prestadorId: row.prestador_id,
    veiculoId: row.veiculo_id,
    status: row.status,
    tipo: row.tipo,
    agendadaPara: row.agendada_para as Date | null,
    quantidadePassageiros: row.quantidade_passageiros as number,
    origemDescricao: row.origem_descricao as string,
    origemLatitude: numeric(row.origem_latitude),
    origemLongitude: numeric(row.origem_longitude),
    destinoDescricao: row.destino_descricao as string,
    destinoLatitude: numeric(row.destino_latitude),
    destinoLongitude: numeric(row.destino_longitude),
    observacaoSolicitante: row.observacao_solicitante as string | null,
    observacaoPrestador: row.observacao_prestador as string | null,
    valorEstimado: row.valor_estimado as string | null,
    valorFinal: row.valor_final as string | null,
    solicitadaEm: row.solicitada_em as Date,
    aceitaEm: row.aceita_em as Date | null,
    deslocamentoIniciadoEm: row.deslocamento_iniciado_em as Date | null,
    chegadaEmbarqueEm: row.chegada_embarque_em as Date | null,
    embarqueEm: row.embarque_em as Date | null,
    desembarqueEm: row.desembarque_em as Date | null,
    canceladaEm: row.cancelada_em as Date | null,
    finalizadaEm: row.finalizada_em as Date | null,
    motivoCancelamento: row.motivo_cancelamento as string | null,
    criadoEm: row.criado_em as Date,
    atualizadoEm: row.atualizado_em as Date,
    funcionarioNome: row.funcionario_nome,
    funcionarioTelefone: row.funcionario_telefone,
    funcionarioMatricula: row.funcionario_matricula,
    centroCustoCodigo: row.centro_custo_codigo,
    centroCustoNome: row.centro_custo_nome,
    prestadorNome: row.prestador_nome,
    prestadorTelefone: row.prestador_telefone,
    veiculoPlaca: row.veiculo_placa,
    veiculoDescricao: row.veiculo_descricao,
  };
}

function mapEvento(row: EventoRow): CorridaEventoRecord {
  return {
    id: row.id,
    corridaId: row.corrida_id,
    usuarioId: row.usuario_id,
    tipoEvento: row.tipo_evento,
    statusAnterior: row.status_anterior,
    statusNovo: row.status_novo,
    descricao: row.descricao,
    metadata: row.metadata,
    criadoEm: row.criado_em,
  };
}

export class CorridaRepository {
  constructor(private readonly database: Database) {}

  async list(empresaId: string, scope: CorridaScope, query: CorridaListQuery): Promise<PaginatedResult<CorridaRecord>> {
    const values: unknown[] = [empresaId];
    const conditions = ['c.empresa_id = $1'];
    this.addScope(conditions, values, scope);
    const add = (sql: string, value: unknown): void => {
      values.push(value);
      conditions.push(sql.replace('?', `$${values.length}`));
    };
    if (query.status) add('c.status = ?', query.status);
    if (query.tipo) add('c.tipo = ?', query.tipo);
    if (query.centroCustoId) add('c.centro_custo_id = ?', query.centroCustoId);
    if (query.funcionarioId) add('c.funcionario_id = ?', query.funcionarioId);
    if (query.prestadorId) add('c.prestador_id = ?', query.prestadorId);
    if (query.solicitanteUsuarioId) add('c.solicitante_usuario_id = ?', query.solicitanteUsuarioId);
    if (query.inicio) add('c.solicitada_em >= ?', query.inicio);
    if (query.fim) add('c.solicitada_em <= ?', query.fim);
    if (query.busca) {
      values.push(`%${query.busca}%`);
      conditions.push(`(c.origem_descricao ILIKE $${values.length} OR c.destino_descricao ILIKE $${values.length})`);
    }
    const where = conditions.join(' AND ');
    const count = await this.database.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM admtaxi.corridas c WHERE ${where}`,
      values,
    );
    const total = Number(count.rows[0]?.total ?? 0);
    values.push(query.limite, (query.pagina - 1) * query.limite);
    const result = await this.database.query<CorridaRow>(
      `${corridaSelect} WHERE ${where}
       ORDER BY COALESCE(c.agendada_para, c.solicitada_em) DESC, c.id DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return paginate(result.rows.map(mapCorrida), total, query);
  }

  async findAccessible(
    executor: QueryExecutor,
    empresaId: string,
    id: string,
    scope: CorridaScope,
  ): Promise<CorridaRecord | null> {
    const values: unknown[] = [empresaId, id];
    const conditions = ['c.empresa_id = $1', 'c.id = $2'];
    this.addScope(conditions, values, scope);
    const row = await queryOne<CorridaRow>(
      executor,
      `${corridaSelect} WHERE ${conditions.join(' AND ')}`,
      values,
    );
    return row ? mapCorrida(row) : null;
  }

  async findForUpdate(
    executor: QueryExecutor, empresaId: string, id: string, scope: CorridaScope,
  ): Promise<CorridaRecord | null> {
    const values: unknown[] = [empresaId, id];
    const conditions = ['c.empresa_id = $1', 'c.id = $2'];
    this.addScope(conditions, values, scope);
    const row = await queryOne<CorridaRow>(executor,
      `SELECT c.* FROM admtaxi.corridas c WHERE ${conditions.join(' AND ')} FOR UPDATE`, values);
    return row ? mapCorrida(row) : null;
  }

  async create(executor: QueryExecutor, empresaId: string, usuarioId: string, input: CorridaCreateInput): Promise<CorridaRecord> {
    const result = await executor.query<CorridaRow>(
      `INSERT INTO admtaxi.corridas (
         empresa_id, solicitante_usuario_id, funcionario_id, centro_custo_id, tipo, agendada_para,
         quantidade_passageiros, origem_descricao, origem_latitude, origem_longitude,
         destino_descricao, destino_latitude, destino_longitude, observacao_solicitante, valor_estimado
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [
        empresaId, usuarioId, input.funcionarioId, input.centroCustoId, input.tipo,
        input.agendadaPara ?? null, input.quantidadePassageiros, input.origemDescricao,
        input.origemLatitude ?? null, input.origemLongitude ?? null, input.destinoDescricao,
        input.destinoLatitude ?? null, input.destinoLongitude ?? null,
        input.observacaoSolicitante ?? null, input.valorEstimado ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Falha ao solicitar corrida.');
    return mapCorrida(row);
  }

  async updateAssignment(
    executor: QueryExecutor,
    empresaId: string,
    id: string,
    prestadorId: string,
    veiculoId: string | null,
  ): Promise<CorridaRecord> {
    const result = await executor.query<CorridaRow>(
      `UPDATE admtaxi.corridas SET prestador_id = $3, veiculo_id = $4
        WHERE empresa_id = $1 AND id = $2 RETURNING *`,
      [empresaId, id, prestadorId, veiculoId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Falha ao atribuir corrida.');
    return mapCorrida(row);
  }

  async changeStatus(
    executor: QueryExecutor,
    empresaId: string,
    id: string,
    status: StatusCorrida,
    patch: CorridaPatch = {},
  ): Promise<CorridaRecord> {
    const timestampColumns: Partial<Record<StatusCorrida, string[]>> = {
      ACEITA: ['aceita_em'],
      EM_DESLOCAMENTO: ['deslocamento_iniciado_em'],
      AGUARDANDO_PASSAGEIRO: ['chegada_embarque_em'],
      EM_CORRIDA: ['embarque_em'],
      CANCELADA: ['cancelada_em'],
      FINALIZADA: ['finalizada_em'],
    };
    const patchColumns: Record<keyof CorridaPatch, string> = {
      prestadorId: 'prestador_id',
      veiculoId: 'veiculo_id',
      observacaoPrestador: 'observacao_prestador',
      valorFinal: 'valor_final',
      motivoCancelamento: 'motivo_cancelamento',
    };
    const assignments = ['status = $3', ...(timestampColumns[status] ?? []).map((column) => `${column} = CURRENT_TIMESTAMP`)];
    const values: unknown[] = [empresaId, id, status];
    for (const [key, value] of Object.entries(patch) as Array<[keyof CorridaPatch, unknown]>) {
      values.push(value);
      assignments.push(`${patchColumns[key]} = $${values.length}`);
    }
    const result = await executor.query<CorridaRow>(
      `UPDATE admtaxi.corridas SET ${assignments.join(', ')}
        WHERE empresa_id = $1 AND id = $2 RETURNING *`,
      values,
    );
    const row = result.rows[0];
    if (!row) throw new Error('Falha ao atualizar corrida.');
    return mapCorrida(row);
  }

  async createEvent(
    executor: QueryExecutor,
    empresaId: string,
    corridaId: string,
    usuarioId: string,
    type: string,
    previousStatus: StatusCorrida | null,
    newStatus: StatusCorrida | null,
    description: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await executor.query(
      `INSERT INTO admtaxi.corrida_eventos
         (empresa_id, corrida_id, usuario_id, tipo_evento, status_anterior, status_novo, descricao, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [empresaId, corridaId, usuarioId, type, previousStatus, newStatus, description, metadata],
    );
  }

  async markDisembark(executor: QueryExecutor, empresaId: string, id: string): Promise<CorridaRecord> {
    const result = await executor.query<CorridaRow>(
      `UPDATE admtaxi.corridas SET desembarque_em = COALESCE(desembarque_em, CURRENT_TIMESTAMP)
        WHERE empresa_id = $1 AND id = $2 RETURNING *`,
      [empresaId, id],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Falha ao confirmar desembarque.');
    return mapCorrida(row);
  }

  async listEvents(
    empresaId: string,
    corridaId: string,
    query: EventoListQuery,
  ): Promise<PaginatedResult<CorridaEventoRecord>> {
    const count = await this.database.query<{ total: string }>(
      'SELECT COUNT(*)::text AS total FROM admtaxi.corrida_eventos WHERE empresa_id = $1 AND corrida_id = $2',
      [empresaId, corridaId],
    );
    const total = Number(count.rows[0]?.total ?? 0);
    const result = await this.database.query<EventoRow>(
      `SELECT id::text, corrida_id, usuario_id, tipo_evento, status_anterior::text,
              status_novo::text, descricao, metadata, criado_em
         FROM admtaxi.corrida_eventos
        WHERE empresa_id = $1 AND corrida_id = $2
        ORDER BY criado_em DESC, id DESC LIMIT $3 OFFSET $4`,
      [empresaId, corridaId, query.limite, (query.pagina - 1) * query.limite],
    );
    return paginate(result.rows.map(mapEvento), total, query);
  }

  async getProviderByUser(
    executor: QueryExecutor,
    empresaId: string,
    usuarioId: string,
    lock = false,
  ): Promise<PrestadorContext | null> {
    return queryOne<PrestadorRow>(
      executor,
      `SELECT id, usuario_id AS "usuarioId", disponivel, ativo
         FROM admtaxi.prestadores WHERE empresa_id = $1 AND usuario_id = $2${lock ? ' FOR UPDATE' : ''}`,
      [empresaId, usuarioId],
    );
  }

  async validateProviderAndVehicle(
    executor: QueryExecutor,
    empresaId: string,
    prestadorId: string,
    veiculoId: string | null,
    requireAvailable: boolean,
  ): Promise<boolean> {
    const provider = await executor.query(
      `SELECT 1 FROM admtaxi.prestadores
        WHERE empresa_id = $1 AND id = $2 AND ativo = TRUE AND ($3::boolean = FALSE OR disponivel = TRUE)`,
      [empresaId, prestadorId, requireAvailable],
    );
    if (provider.rowCount !== 1) return false;
    if (!veiculoId) return true;
    const vehicle = await executor.query(
      `SELECT 1 FROM admtaxi.veiculos
        WHERE empresa_id = $1 AND id = $2 AND prestador_id = $3 AND ativo = TRUE`,
      [empresaId, veiculoId, prestadorId],
    );
    return vehicle.rowCount === 1;
  }

  async validateEmployeeAndCenter(
    executor: QueryExecutor,
    empresaId: string,
    funcionarioId: string,
    centroCustoId: string,
  ): Promise<boolean> {
    const result = await executor.query(
      `SELECT 1 FROM admtaxi.funcionarios f
         JOIN admtaxi.centros_custo c ON c.empresa_id = f.empresa_id AND c.id = f.centro_custo_id
         JOIN admtaxi.setores s ON s.empresa_id = c.empresa_id AND s.id = c.setor_id
        WHERE f.empresa_id = $1 AND f.id = $2 AND f.centro_custo_id = $3
          AND f.ativo = TRUE AND c.ativo = TRUE AND s.ativo = TRUE`,
      [empresaId, funcionarioId, centroCustoId],
    );
    return result.rowCount === 1;
  }

  async managerCanAccessCenter(
    executor: QueryExecutor,
    empresaId: string,
    usuarioId: string,
    centroCustoId: string,
  ): Promise<boolean> {
    const result = await executor.query(
      `SELECT 1 FROM admtaxi.gerente_centros_custo
        WHERE empresa_id = $1 AND gerente_usuario_id = $2 AND centro_custo_id = $3`,
      [empresaId, usuarioId, centroCustoId],
    );
    return result.rowCount === 1;
  }

  async setProviderAvailability(
    executor: QueryExecutor,
    empresaId: string,
    prestadorId: string,
    available: boolean,
  ): Promise<PrestadorContext | null> {
    return queryOne<PrestadorRow>(
      executor,
      `UPDATE admtaxi.prestadores SET disponivel = $3
        WHERE empresa_id = $1 AND id = $2 AND ativo = TRUE
      RETURNING id, usuario_id AS "usuarioId", disponivel, ativo`,
      [empresaId, prestadorId, available],
    );
  }

  async hasActiveRide(executor: QueryExecutor, empresaId: string, prestadorId: string): Promise<boolean> {
    const result = await executor.query(
      `SELECT 1 FROM admtaxi.corridas
        WHERE empresa_id = $1 AND prestador_id = $2
          AND status IN ('ACEITA', 'EM_DESLOCAMENTO', 'AGUARDANDO_PASSAGEIRO', 'EM_CORRIDA')
        LIMIT 1`,
      [empresaId, prestadorId],
    );
    return result.rowCount === 1;
  }

  private addScope(conditions: string[], values: unknown[], scope: CorridaScope): void {
    if (scope.kind === 'GERENTE') {
      values.push(scope.centroCustoIds);
      conditions.push(`c.centro_custo_id = ANY($${values.length}::uuid[])`);
    } else if (scope.kind === 'PRESTADOR') {
      values.push(scope.prestadorId, scope.disponivel);
      conditions.push(`(
        c.prestador_id = $${values.length - 1}
        OR (c.prestador_id IS NULL AND c.status = 'SOLICITADA' AND $${values.length}::boolean = TRUE)
      )`);
    }
  }
}
