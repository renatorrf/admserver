import type { QueryResultRow } from 'pg';

import { queryOne, type Database, type QueryExecutor, withTransaction } from '../../db/pool';
import { conflict, forbidden, invalidReference, notFound } from '../../shared/errors/app-error';
import { paginate } from '../../shared/pagination/pagination';
import type { AuthContext } from '../auth/auth.types';
import type { AuditMetadata } from '../auditoria/audit.types';
import type { AuditRepository } from '../auditoria/audit.repository';
import { CorridaRepository } from '../corridas/corrida.repository';
import type { RealtimeBus } from '../../realtime/realtime-bus';
import type {
  CorridaValorAjusteInput, FaturamentoCancelInput, FaturamentoCreateInput,
  FaturamentoFiltro, FaturamentoListQuery, FaturamentoResumoFiltro,
} from './faturamento.schemas';

type EligibleRow = QueryResultRow & {
  id: string; finalizadaEm: Date; funcionarioId: string; funcionarioNome: string;
  prestadorId: string; prestadorNome: string; setorId: string; setorNome: string;
  centroCustoId: string; centroCustoCodigo: string; centroCustoNome: string;
  solicitanteUsuarioId: string; solicitanteNome: string; origemDescricao: string;
  destinoDescricao: string; valorFinal: string;
};

type BillingRow = QueryResultRow & {
  id: string; empresaId: string; numero: string; periodoInicio: string; periodoFim: string;
  prestadorId: string | null; prestadorNome: string | null; status: string;
  quantidadeCorridas: number; valorTotal: string; observacao: string | null;
  fechadoEm: Date | null; canceladoEm: Date | null; motivoCancelamento: string | null;
  criadoEm: Date; atualizadoEm: Date;
};

export class FaturamentoService {
  constructor(
    private readonly database: Database,
    private readonly audit: AuditRepository,
    private readonly realtime?: RealtimeBus,
  ) {}

  preview(auth: AuthContext, filter: FaturamentoFiltro) {
    this.requireManager(auth);
    return this.eligible(this.database, auth.empresaId, filter, false);
  }

  async summary(auth: AuthContext, filter: FaturamentoResumoFiltro) {
    this.requireManager(auth);
    const values: unknown[] = [auth.empresaId, filter.periodoInicio, filter.periodoFim];
    const conditions = [
      'c.empresa_id=$1',
      '(c.finalizada_em::date BETWEEN $2::date AND $3::date OR c.cancelada_em::date BETWEEN $2::date AND $3::date)',
    ];
    const add = (sql: string, value: unknown): void => {
      values.push(value); conditions.push(sql.replace('?', `$${values.length}`));
    };
    if (filter.prestadorId) add('c.prestador_id=?', filter.prestadorId);
    if (filter.setorId) add('s.id=?', filter.setorId);
    if (filter.centroCustoId) add('c.centro_custo_id=?', filter.centroCustoId);
    if (filter.funcionarioId) add('c.funcionario_id=?', filter.funcionarioId);
    if (filter.solicitanteUsuarioId) add('c.solicitante_usuario_id=?', filter.solicitanteUsuarioId);
    const base = `WITH base AS (
      SELECT c.status::text,c.valor_final,fi.id AS faturamento_item_id,
        p.id AS prestador_id,p.nome AS prestador_nome,s.id AS setor_id,s.nome AS setor_nome,
        cc.id AS centro_id,cc.codigo AS centro_codigo,cc.nome AS centro_nome,
        fn.id AS funcionario_id,fn.nome AS funcionario_nome
      FROM admtaxi.corridas c
      JOIN admtaxi.funcionarios fn ON fn.empresa_id=c.empresa_id AND fn.id=c.funcionario_id
      JOIN admtaxi.centros_custo cc ON cc.empresa_id=c.empresa_id AND cc.id=c.centro_custo_id
      JOIN admtaxi.setores s ON s.empresa_id=cc.empresa_id AND s.id=cc.setor_id
      LEFT JOIN admtaxi.prestadores p ON p.empresa_id=c.empresa_id AND p.id=c.prestador_id
      LEFT JOIN admtaxi.faturamento_itens fi ON fi.empresa_id=c.empresa_id AND fi.corrida_id=c.id AND fi.ativo=TRUE
      WHERE ${conditions.join(' AND ')}
    )`;
    const [totals, groups, billingStatuses] = await Promise.all([
      this.database.query<{
        quantidade: string; valor_total: string; valor_medio: string; sem_valor_final: string;
        pendentes: string; faturadas: string; canceladas: string;
      }>(`${base} SELECT COUNT(*)::text AS quantidade,
        COALESCE(SUM(valor_final) FILTER (WHERE status='FINALIZADA'),0)::text AS valor_total,
        COALESCE(AVG(valor_final) FILTER (WHERE status='FINALIZADA'),0)::text AS valor_medio,
        COUNT(*) FILTER (WHERE status='FINALIZADA' AND valor_final IS NULL)::text AS sem_valor_final,
        COUNT(*) FILTER (WHERE status='FINALIZADA' AND valor_final IS NOT NULL AND faturamento_item_id IS NULL)::text AS pendentes,
        COUNT(*) FILTER (WHERE status='FINALIZADA' AND faturamento_item_id IS NOT NULL)::text AS faturadas,
        COUNT(*) FILTER (WHERE status='CANCELADA')::text AS canceladas FROM base`, values),
      this.database.query<{ dimensao: string; id: string; codigo: string | null; nome: string; corridas: string; valor: string }>(
        `${base}
        SELECT 'PRESTADOR' AS dimensao,prestador_id AS id,NULL::text AS codigo,prestador_nome AS nome,
          COUNT(*)::text AS corridas,SUM(valor_final)::text AS valor FROM base
          WHERE status='FINALIZADA' AND valor_final IS NOT NULL GROUP BY prestador_id,prestador_nome
        UNION ALL SELECT 'SETOR',setor_id,NULL::text,setor_nome,COUNT(*)::text,SUM(valor_final)::text FROM base
          WHERE status='FINALIZADA' AND valor_final IS NOT NULL GROUP BY setor_id,setor_nome
        UNION ALL SELECT 'CENTRO_CUSTO',centro_id,centro_codigo,centro_nome,COUNT(*)::text,SUM(valor_final)::text FROM base
          WHERE status='FINALIZADA' AND valor_final IS NOT NULL GROUP BY centro_id,centro_codigo,centro_nome
        UNION ALL SELECT 'FUNCIONARIO',funcionario_id,NULL::text,funcionario_nome,COUNT(*)::text,SUM(valor_final)::text FROM base
          WHERE status='FINALIZADA' AND valor_final IS NOT NULL GROUP BY funcionario_id,funcionario_nome
        ORDER BY dimensao,nome`, values),
      this.database.query<{ status: string; total: string }>(
        `SELECT status::text,COUNT(*)::text AS total FROM admtaxi.faturamentos
          WHERE empresa_id=$1 AND periodo_fim >= $2::date AND periodo_inicio <= $3::date
          GROUP BY status`, values.slice(0, 3)),
    ]);
    const row = totals.rows[0]!;
    const by = (dimension: string) => groups.rows.filter((item) => item.dimensao === dimension).map((item) => ({
      id: item.id, codigo: item.codigo, nome: item.nome, corridas: Number(item.corridas), valor: item.valor,
    }));
    return {
      quantidadeCorridas: Number(row.quantidade), valorTotal: row.valor_total, valorMedio: row.valor_medio,
      semValorFinal: Number(row.sem_valor_final), pendentes: Number(row.pendentes),
      faturadas: Number(row.faturadas), canceladas: Number(row.canceladas),
      porPrestador: by('PRESTADOR'), porSetor: by('SETOR'), porCentroCusto: by('CENTRO_CUSTO'),
      porFuncionario: by('FUNCIONARIO'),
      fechamentos: Object.fromEntries(billingStatuses.rows.map((item) => [item.status, Number(item.total)])),
    };
  }

  async create(auth: AuthContext, input: FaturamentoCreateInput, metadata: AuditMetadata) {
    this.requireManager(auth);
    const createdId = await withTransaction(this.database, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`faturamento:${auth.empresaId}`]);
      const eligible = await this.eligible(client, auth.empresaId, input, true);
      const eligibleIds = new Set(eligible.map((ride) => ride.id));
      const selectedIds = new Set(input.corridaIds);
      const exclusions = new Map(input.exclusoes.map((item) => [item.corridaId, item.motivo]));
      if (selectedIds.size !== input.corridaIds.length || exclusions.size !== input.exclusoes.length) {
        throw invalidReference('Nao repita corridas no fechamento.');
      }
      for (const id of selectedIds) {
        if (!eligibleIds.has(id) || exclusions.has(id)) throw invalidReference('Uma corrida selecionada nao e elegivel.');
      }
      for (const id of exclusions.keys()) {
        if (!eligibleIds.has(id)) throw invalidReference('Uma corrida excluida nao e elegivel.');
      }
      const unclassified = eligible.filter((ride) => !selectedIds.has(ride.id) && !exclusions.has(ride.id));
      if (unclassified.length) {
        throw conflict('Revise as novas corridas elegiveis e justifique cada exclusao antes de fechar.');
      }
      const selected = eligible.filter((ride) => selectedIds.has(ride.id));
      if (!selected.length) throw invalidReference('Selecione ao menos uma corrida elegivel.');
      const total = selected.reduce((sum, ride) => sum + BigInt(ride.valorFinal.replace('.', '')), 0n);
      const amount = `${total / 100n}.${String(total % 100n).padStart(2, '0')}`;
      const numberResult = await client.query<{ numero: string }>(
        'SELECT COALESCE(MAX(numero),0)+1 AS numero FROM admtaxi.faturamentos WHERE empresa_id=$1',
        [auth.empresaId],
      );
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO admtaxi.faturamentos
          (empresa_id,numero,periodo_inicio,periodo_fim,prestador_id,status,quantidade_corridas,
           valor_total,observacao,criado_por_usuario_id,fechado_em)
         VALUES ($1,$2,$3,$4,$5,'FECHADO',$6,$7,$8,$9,CURRENT_TIMESTAMP) RETURNING id`,
        [auth.empresaId, numberResult.rows[0]!.numero, input.periodoInicio, input.periodoFim,
          input.prestadorId, selected.length, amount, input.observacao ?? null, auth.usuarioId],
      );
      const id = inserted.rows[0]?.id;
      if (!id) throw new Error('Falha ao criar faturamento.');
      for (const ride of selected) {
        await client.query(
          `INSERT INTO admtaxi.faturamento_itens
             (empresa_id,faturamento_id,corrida_id,prestador_id,valor_faturado)
           VALUES ($1,$2,$3,$4,$5)`,
          [auth.empresaId, id, ride.id, ride.prestadorId, ride.valorFinal],
        );
      }
      for (const [corridaId, motivo] of exclusions) {
        await client.query(
          `INSERT INTO admtaxi.faturamento_exclusoes
             (empresa_id,faturamento_id,corrida_id,motivo,usuario_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [auth.empresaId, id, corridaId, motivo, auth.usuarioId],
        );
      }
      await this.audit.record(client, {
        ...metadata, empresaId: auth.empresaId, usuarioId: auth.usuarioId,
        entidade: 'faturamento', entidadeId: id, acao: 'FECHAR',
        dadosNovos: { periodoInicio: input.periodoInicio, periodoFim: input.periodoFim,
          prestadorId: input.prestadorId, quantidadeCorridas: selected.length, valorTotal: amount,
          corridas: selected.map((ride) => ride.id), exclusoes: input.exclusoes },
      });
      return id;
    });
    const billing = await this.get(auth, createdId);
    this.realtime?.publishBilling('faturamento:criado', {
      empresaId: auth.empresaId, faturamentoId: createdId, prestadorId: input.prestadorId,
    });
    return billing;
  }

  async list(auth: AuthContext, query: FaturamentoListQuery) {
    const values: unknown[] = [auth.empresaId];
    const conditions = ['f.empresa_id=$1'];
    const providerId = await this.providerScope(auth);
    if (providerId) { values.push(providerId); conditions.push(`f.prestador_id=$${values.length}`); }
    const add = (sql: string, value: unknown): void => { values.push(value); conditions.push(sql.replace('?', `$${values.length}`)); };
    if (query.status) add('f.status=?', query.status);
    if (query.prestadorId && auth.perfil === 'GESTOR') add('f.prestador_id=?', query.prestadorId);
    if (query.inicio) add('f.periodo_fim>=?::date', query.inicio);
    if (query.fim) add('f.periodo_inicio<=?::date', query.fim);
    const where = conditions.join(' AND ');
    const count = await this.database.query<{ total: string }>(`SELECT COUNT(*)::text total FROM admtaxi.faturamentos f WHERE ${where}`, values);
    const total = Number(count.rows[0]?.total ?? 0);
    values.push(query.limite, (query.pagina - 1) * query.limite);
    const rows = await this.database.query<BillingRow>(`${this.billingSelect()} WHERE ${where}
      ORDER BY f.criado_em DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    return paginate(rows.rows, total, query);
  }

  async get(auth: AuthContext, id: string) {
    const providerId = await this.providerScope(auth);
    const values: unknown[] = [auth.empresaId, id];
    const provider = providerId ? ' AND f.prestador_id=$3' : '';
    if (providerId) values.push(providerId);
    const billing = await queryOne<BillingRow>(this.database,
      `${this.billingSelect()} WHERE f.empresa_id=$1 AND f.id=$2${provider}`, values);
    if (!billing) throw notFound('Faturamento');
    const items = await this.database.query(
      `SELECT fi.id,fi.corrida_id AS "corridaId",fi.valor_faturado::text AS "valorFaturado",fi.ativo,
        c.finalizada_em AS "finalizadaEm",c.origem_descricao AS "origemDescricao",c.destino_descricao AS "destinoDescricao",
        fn.nome AS "funcionarioNome",cc.codigo AS "centroCustoCodigo",cc.nome AS "centroCustoNome",
        p.nome AS "prestadorNome"
       FROM admtaxi.faturamento_itens fi
       JOIN admtaxi.corridas c ON c.empresa_id=fi.empresa_id AND c.id=fi.corrida_id
       JOIN admtaxi.funcionarios fn ON fn.empresa_id=c.empresa_id AND fn.id=c.funcionario_id
       JOIN admtaxi.centros_custo cc ON cc.empresa_id=c.empresa_id AND cc.id=c.centro_custo_id
       JOIN admtaxi.prestadores p ON p.empresa_id=fi.empresa_id AND p.id=fi.prestador_id
       WHERE fi.empresa_id=$1 AND fi.faturamento_id=$2 ORDER BY c.finalizada_em,c.id`,
      [auth.empresaId, id],
    );
    return { ...billing, itens: items.rows };
  }

  async cancel(auth: AuthContext, id: string, input: FaturamentoCancelInput, metadata: AuditMetadata) {
    this.requireManager(auth);
    await withTransaction(this.database, async (client) => {
      const current = await queryOne<BillingRow>(client,
        `${this.billingSelect()} WHERE f.empresa_id=$1 AND f.id=$2 FOR UPDATE OF f`, [auth.empresaId, id]);
      if (!current) throw notFound('Faturamento');
      if (current.status === 'CANCELADO') throw conflict('O faturamento ja esta cancelado.');
      if (current.status !== 'FECHADO') throw conflict('Somente faturamentos fechados podem ser cancelados.');
      await client.query(
        `UPDATE admtaxi.faturamentos SET status='CANCELADO',cancelado_em=CURRENT_TIMESTAMP,motivo_cancelamento=$3
          WHERE empresa_id=$1 AND id=$2`, [auth.empresaId, id, input.motivo],
      );
      await client.query('UPDATE admtaxi.faturamento_itens SET ativo=FALSE WHERE empresa_id=$1 AND faturamento_id=$2',
        [auth.empresaId, id]);
      await this.audit.record(client, {
        ...metadata, empresaId: auth.empresaId, usuarioId: auth.usuarioId,
        entidade: 'faturamento', entidadeId: id, acao: 'CANCELAR',
        dadosAnteriores: current, dadosNovos: { status: 'CANCELADO', motivo: input.motivo },
      });
    });
    const billing = await this.get(auth, id);
    this.realtime?.publishBilling('faturamento:cancelado', {
      empresaId: auth.empresaId, faturamentoId: id, prestadorId: billing.prestadorId,
    });
    return billing;
  }

  async adjustRideValue(auth: AuthContext, corridaId: string, input: CorridaValorAjusteInput, metadata: AuditMetadata) {
    this.requireManager(auth);
    const result = await withTransaction(this.database, async (client) => {
      const ride = await queryOne<{ id: string; status: string; valor_final: string | null }>(client,
        `SELECT id,status::text,valor_final::text FROM admtaxi.corridas
          WHERE empresa_id=$1 AND id=$2 FOR UPDATE`, [auth.empresaId, corridaId]);
      if (!ride) throw notFound('Corrida');
      if (ride.status !== 'FINALIZADA' || ride.valor_final === null) {
        throw conflict('Somente corridas finalizadas com valor podem ser corrigidas.');
      }
      const billed = await client.query(
        `SELECT 1 FROM admtaxi.faturamento_itens
          WHERE empresa_id=$1 AND corrida_id=$2 AND ativo=TRUE LIMIT 1`, [auth.empresaId, corridaId]);
      if (billed.rowCount) throw conflict('Cancele o faturamento ativo antes de corrigir o valor desta corrida.');
      await client.query('UPDATE admtaxi.corridas SET valor_final=$3 WHERE empresa_id=$1 AND id=$2',
        [auth.empresaId, corridaId, input.valorFinal]);
      await client.query(
        `INSERT INTO admtaxi.corrida_valor_ajustes
          (empresa_id,corrida_id,valor_anterior,valor_novo,justificativa,usuario_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [auth.empresaId, corridaId, ride.valor_final, input.valorFinal, input.justificativa, auth.usuarioId],
      );
      await client.query(
        `INSERT INTO admtaxi.corrida_eventos
          (empresa_id,corrida_id,usuario_id,tipo_evento,status_anterior,status_novo,descricao,metadata)
         VALUES ($1,$2,$3,'VALOR_FINAL_CORRIGIDO','FINALIZADA','FINALIZADA',$4,$5)`,
        [auth.empresaId, corridaId, auth.usuarioId, 'Valor final corrigido pelo gestor.',
          { valorAnterior: ride.valor_final, valorNovo: input.valorFinal, justificativa: input.justificativa }],
      );
      await this.audit.record(client, {
        ...metadata, empresaId: auth.empresaId, usuarioId: auth.usuarioId,
        entidade: 'corrida', entidadeId: corridaId, acao: 'CORRIGIR_VALOR_FINAL',
        dadosAnteriores: { valorFinal: ride.valor_final },
        dadosNovos: { valorFinal: input.valorFinal, justificativa: input.justificativa },
      });
      return { corridaId, valorAnterior: ride.valor_final, valorFinal: input.valorFinal };
    });
    const ride = await new CorridaRepository(this.database).findAccessible(
      this.database, auth.empresaId, corridaId, { kind: 'GESTOR' },
    );
    if (ride) this.realtime?.publishRide(ride, 'corrida:valor-alterado');
    return result;
  }

  async csv(auth: AuthContext, id: string): Promise<string> {
    const billing = await this.get(auth, id);
    const cell = (value: unknown): string => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const header = ['Corrida', 'Finalizada em', 'Funcionario', 'Centro de custo', 'Prestador', 'Valor faturado'];
    const lines = billing.itens.map((item) => [item.corridaId, item.finalizadaEm, item.funcionarioNome,
      `${item.centroCustoCodigo} - ${item.centroCustoNome}`, item.prestadorNome, item.valorFaturado].map(cell).join(';'));
    return `\uFEFF${header.map(cell).join(';')}\r\n${lines.join('\r\n')}\r\n`;
  }

  private async eligible(executor: QueryExecutor, empresaId: string, filter: FaturamentoFiltro, lock: boolean): Promise<EligibleRow[]> {
    const values: unknown[] = [empresaId, filter.periodoInicio, filter.periodoFim, filter.prestadorId];
    const conditions = [
      'c.empresa_id=$1', "c.status='FINALIZADA'", 'c.valor_final IS NOT NULL',
      'c.finalizada_em::date BETWEEN $2::date AND $3::date', 'c.prestador_id=$4',
      'fi.id IS NULL',
    ];
    const add = (sql: string, value: unknown): void => { values.push(value); conditions.push(sql.replace('?', `$${values.length}`)); };
    if (filter.setorId) add('s.id=?', filter.setorId);
    if (filter.centroCustoId) add('c.centro_custo_id=?', filter.centroCustoId);
    if (filter.funcionarioId) add('c.funcionario_id=?', filter.funcionarioId);
    if (filter.solicitanteUsuarioId) add('c.solicitante_usuario_id=?', filter.solicitanteUsuarioId);
    const result = await executor.query<EligibleRow>(
      `SELECT c.id,c.finalizada_em AS "finalizadaEm",c.funcionario_id AS "funcionarioId",fn.nome AS "funcionarioNome",
        c.prestador_id AS "prestadorId",p.nome AS "prestadorNome",s.id AS "setorId",s.nome AS "setorNome",
        cc.id AS "centroCustoId",cc.codigo AS "centroCustoCodigo",cc.nome AS "centroCustoNome",
        c.solicitante_usuario_id AS "solicitanteUsuarioId",u.nome AS "solicitanteNome",
        c.origem_descricao AS "origemDescricao",c.destino_descricao AS "destinoDescricao",c.valor_final::text AS "valorFinal"
       FROM admtaxi.corridas c
       JOIN admtaxi.funcionarios fn ON fn.empresa_id=c.empresa_id AND fn.id=c.funcionario_id
       JOIN admtaxi.centros_custo cc ON cc.empresa_id=c.empresa_id AND cc.id=c.centro_custo_id
       JOIN admtaxi.setores s ON s.empresa_id=cc.empresa_id AND s.id=cc.setor_id
       JOIN admtaxi.prestadores p ON p.empresa_id=c.empresa_id AND p.id=c.prestador_id
       JOIN admtaxi.usuarios u ON u.empresa_id=c.empresa_id AND u.id=c.solicitante_usuario_id
       LEFT JOIN admtaxi.faturamento_itens fi ON fi.empresa_id=c.empresa_id AND fi.corrida_id=c.id AND fi.ativo=TRUE
       WHERE ${conditions.join(' AND ')} ORDER BY c.finalizada_em,c.id${lock ? ' FOR UPDATE OF c' : ''}`,
      values,
    );
    return result.rows;
  }

  private async providerScope(auth: AuthContext): Promise<string | null> {
    if (auth.perfil === 'GESTOR') return null;
    if (auth.perfil !== 'PRESTADOR') throw forbidden();
    const result = await this.database.query<{ id: string }>(
      'SELECT id FROM admtaxi.prestadores WHERE empresa_id=$1 AND usuario_id=$2 AND ativo=TRUE',
      [auth.empresaId, auth.usuarioId],
    );
    const id = result.rows[0]?.id;
    if (!id) throw forbidden();
    return id;
  }

  private requireManager(auth: AuthContext): void {
    if (auth.perfil !== 'GESTOR') throw forbidden();
  }

  private billingSelect(): string {
    return `SELECT f.id,f.empresa_id AS "empresaId",f.numero::text,f.periodo_inicio::text AS "periodoInicio",
      f.periodo_fim::text AS "periodoFim",f.prestador_id AS "prestadorId",p.nome AS "prestadorNome",
      f.status::text,f.quantidade_corridas AS "quantidadeCorridas",f.valor_total::text AS "valorTotal",
      f.observacao,f.fechado_em AS "fechadoEm",f.cancelado_em AS "canceladoEm",
      f.motivo_cancelamento AS "motivoCancelamento",f.criado_em AS "criadoEm",f.atualizado_em AS "atualizadoEm"
     FROM admtaxi.faturamentos f LEFT JOIN admtaxi.prestadores p
       ON p.empresa_id=f.empresa_id AND p.id=f.prestador_id`;
  }
}
