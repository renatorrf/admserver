import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { assertRouteNotStarted, optimizeRouteSchema, RideRouteOptimizer } from '../src/modules/corridas/route-optimizer';
import type { ItinerarySnapshot } from '../src/modules/corridas/itinerary';
import type { CorridaRecord } from '../src/modules/corridas/corrida.types';

function fixture(): ItinerarySnapshot {
  const ids = Array.from({ length: 4 }, () => randomUUID());
  return { versao: 2, paradas: ids.map((id, i) => ({ id, descricao: `Endereco ${i}`, latitude: -18.9 + i / 100,
    longitude: -48.2, ordem: i + 1, estado: 'PENDENTE' })),
  participantes: [0, 1].map(i => ({ funcionarioId: randomUUID(), funcionarioNome: `Funcionario ${i}`,
    embarqueId: ids[i]!, desembarqueId: ids[i + 2]!, centroCustoId: randomUUID(), valor: '12.30', estado: 'AGUARDANDO' })) };
}
const position = { latitude: -18.94, longitude: -48.27, versao: 2 };
const pickup = (index: number) => ({ type: 'pickup', shipment_index: index });
const delivery = (index: number) => ({ type: 'delivery', shipment_index: index });
const response = (actions: unknown[]) => ({ ok: true, json: async () => ({ features: [{ properties: { agent_index: 0, actions } }] }) });

describe('Driver route optimization', () => {
  it('uses fresh driver coordinates, shipments and capacity without exposing employee data', async () => {
    const snapshot = fixture();
    const fetch = vi.fn().mockResolvedValue(response([{ type: 'start' }, pickup(1), delivery(1), pickup(0), delivery(0)]));
    const result = await new RideRouteOptimizer('test', fetch).optimize(snapshot, position, 1);
    expect(result.paradas.map(s => s.id)).toEqual([1, 3, 0, 2].map(i => snapshot.paradas[i]!.id));
    expect(result.participantes).toEqual(snapshot.participantes.map(({ estado: _state, funcionarioNome: _name, ...p }) => p));
    const body = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(body.agents).toEqual([{ start_location: [-48.27, -18.94], delivery_capacity: 1 }]);
    expect(body.shipments[0]).toMatchObject({ pickup: { location_index: 0 }, delivery: { location_index: 2 }, amount: 1 });
    expect(JSON.stringify(body)).not.toContain(snapshot.participantes[0]!.funcionarioId);
    expect(JSON.stringify(body)).not.toContain('Endereco');
    expect(snapshot.paradas[0]!.ordem).toBe(1);
  });

  it.each([
    [pickup(0), delivery(0)],
    [delivery(0), pickup(0), pickup(1), delivery(1)],
    [pickup(0), pickup(0), delivery(0), pickup(1), delivery(1)],
    [pickup(99), delivery(0), pickup(1), delivery(1)],
  ])('rejects incomplete, invalid or unsafe provider plans (%j)', async (...actions) => {
    const fetch = vi.fn().mockResolvedValue(response(actions));
    await expect(new RideRouteOptimizer('test', fetch).optimize(fixture(), position, 4)).rejects.toMatchObject({ statusCode: 503 });
  });

  it('rejects an overloaded route even when the provider ignores capacity', async () => {
    const fetch = vi.fn().mockResolvedValue(response([pickup(0), pickup(1), delivery(0), delivery(1)]));
    await expect(new RideRouteOptimizer('test', fetch).optimize(fixture(), position, 1)).rejects.toMatchObject({ statusCode: 503 });
  });

  it('supports adjacent shared destinations but rejects revisits to the same stop', async () => {
    const snapshot = fixture();
    snapshot.participantes[1]!.desembarqueId = snapshot.paradas[2]!.id;
    snapshot.paradas.pop();
    const fetch = vi.fn().mockResolvedValue(response([pickup(1), pickup(0), delivery(1), delivery(0)]));
    const result = await new RideRouteOptimizer('test', fetch).optimize(snapshot, position, 4);
    expect(result.paradas).toHaveLength(3);
    fetch.mockResolvedValue(response([pickup(1), delivery(1), pickup(0), delivery(0)]));
    await expect(new RideRouteOptimizer('test', fetch).optimize(snapshot, position, 4)).rejects.toMatchObject({ statusCode: 503 });
  });

  it('preserves manual stops from old requests', async () => {
    const snapshot = fixture();
    const extra = { ...snapshot.paradas[0]!, id: randomUUID(), ordem: 5 };
    snapshot.paradas.push(extra);
    const fetch = vi.fn().mockResolvedValue(response([pickup(0), { type: 'job', job_index: 0 }, delivery(0), pickup(1), delivery(1)]));
    const result = await new RideRouteOptimizer('test', fetch).optimize(snapshot, position, 4);
    expect(result.paradas[1]!.id).toBe(extra.id);
  });

  it('returns a recoverable error for missing key, timeout, malformed payload or upstream failure', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('timeout'));
    await expect(new RideRouteOptimizer('test', fetch).optimize(fixture(), position, 4)).rejects.toMatchObject({ statusCode: 503 });
    fetch.mockResolvedValue({ ok: false });
    await expect(new RideRouteOptimizer('test', fetch).optimize(fixture(), position, 4)).rejects.toMatchObject({ statusCode: 503 });
    fetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    await expect(new RideRouteOptimizer('test', fetch).optimize(fixture(), position, 4)).rejects.toMatchObject({ statusCode: 503 });
    await expect(new RideRouteOptimizer().optimize(fixture(), position, 4)).rejects.toMatchObject({ statusCode: 503 });
  });

  it('allows only accepted, unstarted, current-version rides', () => {
    const snapshot = fixture();
    const ride = { status: 'ACEITA', itinerarioVersao: 2 } as CorridaRecord;
    expect(() => assertRouteNotStarted(ride, snapshot, 2)).not.toThrow();
    expect(() => assertRouteNotStarted(ride, snapshot, 1)).toThrow();
    for (const status of ['SOLICITADA', 'EM_DESLOCAMENTO', 'CANCELADA', 'FINALIZADA'] as const)
      expect(() => assertRouteNotStarted({ ...ride, status }, snapshot, 2)).toThrow();
    snapshot.paradas[0]!.estado = 'EM_DESLOCAMENTO';
    expect(() => assertRouteNotStarted(ride, snapshot, 2)).toThrow();
    snapshot.paradas[0]!.estado = 'PENDENTE';
    snapshot.participantes[0]!.estado = 'EMBARCADO';
    expect(() => assertRouteNotStarted(ride, snapshot, 2)).toThrow();
  });

  it('does not accept client-supplied company, ordering or invalid coordinates', () => {
    expect(optimizeRouteSchema.safeParse(position).success).toBe(true);
    for (const data of [{ ...position, empresaId: randomUUID() }, { ...position, paradas: [] }, { ...position, latitude: 91 }])
      expect(optimizeRouteSchema.safeParse(data).success).toBe(false);
  });
});
