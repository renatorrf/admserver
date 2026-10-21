import { z } from 'zod';
import type { Database, QueryExecutor } from '../../db/pool';
import { withTransaction } from '../../db/pool';
import type { AuthContext } from '../auth/auth.types';
import type { AuditRepository } from '../auditoria/audit.repository';
import type { AuditMetadata } from '../auditoria/audit.types';
import { conflict, forbidden, invalidReference, notFound } from '../../shared/errors/app-error';
import { moneyCents, passengerMoney } from '../corridas/itinerary';
import { commandHash } from '../corridas/itinerary.repository';

export const monthlyQuery = z.object({ prestadorId: z.string().uuid(), competencia: z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/) }).strict();
export const monthlyValue = z.object({ valor: passengerMoney }).strict();
export const monthlyClose = monthlyQuery.extend({ previsaoHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type MonthlyQuery = z.infer<typeof monthlyQuery>;
type Passenger = { corridaId: string; funcionarioId: string; centroCustoId: string; codigo: string; nome: string };
const money = (cents: bigint): string => `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;

// Each ride has the same weight; each transported passenger shares that ride.
// Largest remainders distribute cents once, globally, without losing the monthly total.
export function monthlyAllocation(total: string, passengers: Passenger[]) {
  const counts = new Map<string, number>();
  for (const p of passengers) counts.set(p.corridaId, (counts.get(p.corridaId) ?? 0) + 1);
  if (!counts.size) return [];
  const cents = moneyCents(total);
  const amounts = passengers.map(p => {
    const denominator = BigInt(counts.size * counts.get(p.corridaId)!);
    return { ...p, cents: cents / denominator, remainder: cents % denominator, denominator };
  });
  let remaining = moneyCents(total) - amounts.reduce((sum, p) => sum + p.cents, 0n);
  amounts.sort((a, b) => {
    const difference = b.remainder * a.denominator - a.remainder * b.denominator;
    return difference === 0n ? `${a.corridaId}:${a.funcionarioId}`.localeCompare(`${b.corridaId}:${b.funcionarioId}`) : difference > 0n ? 1 : -1;
  });
  for (const item of amounts) { if (remaining <= 0n) break; item.cents++; remaining--; }
  return amounts.map(({ cents, remainder: _r, denominator: _d, ...p }) => ({ ...p, valor: money(cents) }));
}

export class MonthlyBillingService {
  constructor(private readonly db: Database, private readonly audit: AuditRepository) {}
  private manager(auth: AuthContext): void { if (auth.perfil !== 'GESTOR') throw forbidden(); }
  async providers(auth: AuthContext) {
    this.manager(auth);
    return (await this.db.query('SELECT id,nome,valor_mensal_fixo::text AS "valorMensalFixo" FROM admtaxi.prestadores WHERE empresa_id=$1 AND ativo ORDER BY nome', [auth.empresaId])).rows;
  }
  async setValue(auth: AuthContext, providerId: string, value: string, metadata: AuditMetadata) {
    this.manager(auth);
    return withTransaction(this.db, async db => {
      const previous = await db.query('SELECT valor_mensal_fixo FROM admtaxi.prestadores WHERE empresa_id=$1 AND id=$2 AND ativo FOR UPDATE', [auth.empresaId, providerId]);
      if (!previous.rows.length) throw notFound('Prestador');
      await db.query('UPDATE admtaxi.prestadores SET valor_mensal_fixo=$3 WHERE empresa_id=$1 AND id=$2', [auth.empresaId, providerId, value]);
      await this.audit.record(db, { ...metadata, empresaId: auth.empresaId, usuarioId: auth.usuarioId, entidade: 'prestador', entidadeId: providerId,
        acao: 'ALTERAR_MENSALIDADE', dadosAnteriores: previous.rows[0], dadosNovos: { valorMensalFixo: value } });
      return { valorMensalFixo: value };
    });
  }
  async preview(auth: AuthContext, input: MonthlyQuery, db: QueryExecutor = this.db, lock = false) {
    this.manager(auth);
    const provider = await db.query<{ valor: string | null; modo: string }>(`SELECT p.valor_mensal_fixo::text AS valor,e.modo_cobranca AS modo
      FROM admtaxi.prestadores p JOIN admtaxi.empresas e ON e.id=p.empresa_id
      WHERE p.empresa_id=$1 AND p.id=$2 AND p.ativo ${lock ? 'FOR SHARE OF p,e' : ''}`, [auth.empresaId, input.prestadorId]);
    if (!provider.rows[0]) throw notFound('Prestador');
    if (provider.rows[0].modo !== 'MENSAL_FIXO') throw conflict('Esta empresa nao utiliza mensalidade fixa.');
    const value = provider.rows[0].valor;
    if (value === null) throw invalidReference('Configure a mensalidade deste prestador.');
    const start = `${input.competencia}-01`;
    const rides = await db.query<{ id: string }>(`SELECT c.id FROM admtaxi.corridas c
      WHERE c.empresa_id=$1 AND c.prestador_id=$2 AND c.modo_cobranca='MENSAL_FIXO' AND c.status='FINALIZADA'
      AND (c.finalizada_em AT TIME ZONE 'America/Sao_Paulo')::date >= $3::date
      AND (c.finalizada_em AT TIME ZONE 'America/Sao_Paulo')::date < ($3::date + interval '1 month')
      AND EXISTS(SELECT 1 FROM admtaxi.corrida_participacoes cp WHERE cp.empresa_id=c.empresa_id AND cp.corrida_id=c.id AND cp.estado='DESEMBARCADO')
      ORDER BY c.id ${lock ? 'FOR UPDATE OF c' : ''}`, [auth.empresaId, input.prestadorId, start]);
    const participants = await db.query<Passenger>(`SELECT cp.corrida_id AS "corridaId",cp.funcionario_id AS "funcionarioId",
      cp.centro_custo_id AS "centroCustoId",cc.codigo,cc.nome FROM admtaxi.corrida_participacoes cp
      JOIN admtaxi.centros_custo cc ON cc.empresa_id=cp.empresa_id AND cc.id=cp.centro_custo_id
      WHERE cp.empresa_id=$1 AND cp.corrida_id=ANY($2::uuid[]) AND cp.estado='DESEMBARCADO' ORDER BY cp.corrida_id,cp.funcionario_id`,
    [auth.empresaId, rides.rows.map(r => r.id)]);
    const allocations = monthlyAllocation(value, participants.rows);
    const counts = new Map<string, number>();
    for (const p of participants.rows) counts.set(p.corridaId, (counts.get(p.corridaId) ?? 0) + 1);
    const centers = [...new Set(allocations.map(p => p.centroCustoId))].map(id => {
      const rows = allocations.filter(p => p.centroCustoId === id), first = rows[0]!;
      const weight = rows.reduce((sum, p) => sum + 1 / counts.get(p.corridaId)!, 0);
      return { id, codigo: first.codigo, nome: first.nome, corridasEquivalentes: weight, percentual: weight / rides.rows.length * 100,
        valor: money(rows.reduce((sum, p) => sum + moneyCents(p.valor), 0n)) };
    });
    const result = { competencia: input.competencia, prestadorId: input.prestadorId, valorMensal: value,
      quantidadeCorridas: rides.rows.length, porCentroCusto: centers, participacoes: allocations,
      semMovimento: !rides.rows.length };
    return { ...result, previsaoHash: commandHash(result) };
  }
  async close(auth: AuthContext, input: MonthlyQuery & { previsaoHash: string }, metadata: AuditMetadata): Promise<string> {
    this.manager(auth);
    return withTransaction(this.db, async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`faturamento:${auth.empresaId}`]);
      const period = await db.query<{ fim: string; encerrado: boolean }>(`SELECT ($1::date + interval '1 month' - interval '1 day')::date::text AS fim,
        ($1::date + interval '1 month')::date <= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date AS encerrado`, [`${input.competencia}-01`]);
      if (!period.rows[0]!.encerrado) throw conflict('O fechamento mensal so pode ser confirmado apos o fim do mes.');
      const existing = await db.query('SELECT id FROM admtaxi.faturamentos WHERE empresa_id=$1 AND prestador_id=$2 AND periodo_inicio=$3 AND modo_cobranca=\'MENSAL_FIXO\' AND status<>\'CANCELADO\'',
        [auth.empresaId, input.prestadorId, `${input.competencia}-01`]);
      if (existing.rows.length) throw conflict('Esta mensalidade ja foi fechada. Consulte o historico.');
      const result = await this.preview(auth, input, db, true);
      if (input.previsaoHash !== result.previsaoHash) throw conflict('O rateio foi atualizado. Revise novamente antes de fechar.');
      if (result.semMovimento) throw conflict('Sem corridas com passageiros transportados neste mes. Nao e possivel ratear a mensalidade.');
      const created = await db.query<{ id: string }>(`INSERT INTO admtaxi.faturamentos
        (empresa_id,numero,periodo_inicio,periodo_fim,prestador_id,status,quantidade_corridas,valor_total,criado_por_usuario_id,fechado_em,modo_cobranca)
        SELECT $1,COALESCE(MAX(numero),0)+1,$2,$3,$4,'FECHADO',$5,$6,$7,CURRENT_TIMESTAMP,'MENSAL_FIXO'
        FROM admtaxi.faturamentos WHERE empresa_id=$1 RETURNING id`,
      [auth.empresaId, `${input.competencia}-01`, period.rows[0]!.fim, input.prestadorId, result.quantidadeCorridas, result.valorMensal, auth.usuarioId]);
      const id = created.rows[0]!.id;
      for (const rideId of new Set(result.participacoes.map(p => p.corridaId))) {
        const rows = result.participacoes.filter(p => p.corridaId === rideId);
        const item = await db.query<{ id: string }>(`INSERT INTO admtaxi.faturamento_itens(empresa_id,faturamento_id,corrida_id,prestador_id,valor_faturado)
          VALUES($1,$2,$3,$4,$5) RETURNING id`, [auth.empresaId, id, rideId, input.prestadorId, money(rows.reduce((sum, p) => sum + moneyCents(p.valor), 0n))]);
        for (const p of rows) await db.query(`INSERT INTO admtaxi.faturamento_participacoes(empresa_id,item_id,funcionario_id,centro_custo_id,valor)
          VALUES($1,$2,$3,$4,$5)`, [auth.empresaId, item.rows[0]!.id, p.funcionarioId, p.centroCustoId, p.valor]);
      }
      await this.audit.record(db, { ...metadata, empresaId: auth.empresaId, usuarioId: auth.usuarioId, entidade: 'faturamento', entidadeId: id,
        acao: 'FECHAR_MENSAL', dadosNovos: result });
      return id;
    });
  }
}
