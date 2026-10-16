import { createHash } from 'node:crypto';
import type { QueryExecutor } from '../../db/pool';
import { conflict, invalidReference } from '../../shared/errors/app-error';
import { peakOccupancy, type ItineraryInput, type ItinerarySnapshot, type ItineraryStop, type Participation } from './itinerary';

export const commandHash = (input: unknown): string => createHash('sha256').update(JSON.stringify(input)).digest('hex');

export class ItineraryRepository {
  async load(db: QueryExecutor, empresaId: string, corridaId: string, versao: number): Promise<ItinerarySnapshot> {
    const stops = await db.query<ItineraryStop>(
      `SELECT id, ordem, descricao, latitude::float8, longitude::float8, estado,
        chegada_em AS "chegadaEm", saida_em AS "saidaEm"
       FROM admtaxi.corrida_paradas WHERE empresa_id=$1 AND corrida_id=$2 ORDER BY ordem`, [empresaId, corridaId]);
    const passengers = await db.query<Participation>(
      `SELECT p.funcionario_id AS "funcionarioId", f.nome AS "funcionarioNome",
        p.embarque_id AS "embarqueId", p.desembarque_id AS "desembarqueId", p.estado, p.motivo,
        p.embarque_em AS "embarqueEm", p.desembarque_em AS "desembarqueEm"
       FROM admtaxi.corrida_participacoes p JOIN admtaxi.funcionarios f
        ON f.empresa_id=p.empresa_id AND f.id=p.funcionario_id
       WHERE p.empresa_id=$1 AND p.corrida_id=$2 ORDER BY p.funcionario_id`, [empresaId, corridaId]);
    return { versao, paradas: stops.rows, participantes: passengers.rows };
  }

  async replace(db: QueryExecutor, empresaId: string, corridaId: string, input: ItineraryInput): Promise<void> {
    // Caller holds the parent ride lock and permits this only before acceptance.
    const existing = await db.query<{ id: string }>(
      'SELECT id FROM admtaxi.corrida_paradas WHERE empresa_id=$1 AND corrida_id=$2', [empresaId, corridaId]);
    const ids = input.paradas.map(p => p.id);
    const owned = await db.query<{ id: string }>(
      'SELECT id FROM admtaxi.corrida_paradas WHERE id=ANY($1::uuid[]) AND NOT (empresa_id=$2 AND corrida_id=$3)',
      [ids, empresaId, corridaId]);
    if (owned.rows.length) throw invalidReference('Identificador de parada indisponivel.');
    await db.query('DELETE FROM admtaxi.corrida_participacoes WHERE empresa_id=$1 AND corrida_id=$2', [empresaId, corridaId]);
    // All replacements are atomic; stable IDs survive the delete/reinsert in this transaction.
    if (existing.rows.length) await db.query('DELETE FROM admtaxi.corrida_paradas WHERE empresa_id=$1 AND corrida_id=$2', [empresaId, corridaId]);
    for (const [index, stop] of input.paradas.entries()) {
      await db.query(`INSERT INTO admtaxi.corrida_paradas
        (id,empresa_id,corrida_id,ordem,tipo,descricao,latitude,longitude)
        VALUES ($1,$2,$3,$4,'MANUAL',$5,$6,$7)`,
      [stop.id, empresaId, corridaId, index + 1, stop.descricao, stop.latitude, stop.longitude]);
    }
    for (const passenger of input.participantes) {
      await db.query(`INSERT INTO admtaxi.corrida_participacoes
        (empresa_id,corrida_id,funcionario_id,embarque_id,desembarque_id) VALUES ($1,$2,$3,$4,$5)`,
      [empresaId, corridaId, passenger.funcionarioId, passenger.embarqueId, passenger.desembarqueId]);
    }
    const first = input.paradas[0]!;
    const last = input.paradas[input.paradas.length - 1]!;
    await db.query(`UPDATE admtaxi.corridas SET itinerario_versao=itinerario_versao+1,
      quantidade_passageiros=$3, origem_descricao=$4,origem_latitude=$5,origem_longitude=$6,
      destino_descricao=$7,destino_latitude=$8,destino_longitude=$9
      WHERE empresa_id=$1 AND id=$2`,
    [empresaId, corridaId, input.participantes.length, first.descricao, first.latitude, first.longitude,
      last.descricao, last.latitude, last.longitude]);
  }

  async saveExecution(db: QueryExecutor, empresaId: string, corridaId: string, snapshot: ItinerarySnapshot): Promise<void> {
    for (const stop of snapshot.paradas) await db.query(`UPDATE admtaxi.corrida_paradas
      SET estado=$4,chegada_em=$5,saida_em=$6 WHERE empresa_id=$1 AND corrida_id=$2 AND id=$3`,
    [empresaId, corridaId, stop.id, stop.estado, stop.chegadaEm ?? null, stop.saidaEm ?? null]);
    for (const p of snapshot.participantes) await db.query(`UPDATE admtaxi.corrida_participacoes
      SET estado=$4,motivo=$5,embarque_em=$6,desembarque_em=$7 WHERE empresa_id=$1 AND corrida_id=$2 AND funcionario_id=$3`,
    [empresaId, corridaId, p.funcionarioId, p.estado, p.motivo ?? null, p.embarqueEm ?? null, p.desembarqueEm ?? null]);
    await db.query('UPDATE admtaxi.corridas SET itinerario_versao=$3 WHERE empresa_id=$1 AND id=$2', [empresaId, corridaId, snapshot.versao]);
  }

  async assertCapacity(db: QueryExecutor, empresaId: string, corridaId: string, veiculoId: string, total: number, versao: number): Promise<void> {
    const vehicle = await db.query<{ capacidade_passageiros: number }>(
      'SELECT capacidade_passageiros FROM admtaxi.veiculos WHERE empresa_id=$1 AND id=$2 AND ativo=TRUE FOR SHARE', [empresaId, veiculoId]);
    const capacity = vehicle.rows[0]?.capacidade_passageiros;
    const itinerary = versao ? await this.load(db, empresaId, corridaId, versao) : null;
    if (capacity && itinerary?.participantes.every(p => ['AUSENTE', 'CANCELADO'].includes(p.estado))) return;
    const peak = itinerary ? peakOccupancy({ paradas: itinerary.paradas.map(({ id, descricao, latitude, longitude }) => ({ id, descricao, latitude, longitude })),
      participantes: itinerary.participantes.filter(p => !['AUSENTE', 'CANCELADO'].includes(p.estado))
        .map(({ funcionarioId, embarqueId, desembarqueId }) => ({ funcionarioId, embarqueId, desembarqueId })) }) : total;
    if (!capacity || peak > capacity) throw conflict(`Lotacao maxima de ${peak} passageiros simultaneos excede a capacidade do veiculo (${capacity ?? 0}).`);
  }
}
