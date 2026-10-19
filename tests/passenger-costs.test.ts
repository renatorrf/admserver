import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { itinerarySchema, passengerTotal } from '../src/modules/corridas/itinerary';

const start = randomUUID(), end = randomUUID(), center = randomUUID();
const input = { paradas: [{ id: start, descricao: 'Origem', latitude: 0, longitude: 0 }, { id: end, descricao: 'Destino', latitude: 1, longitude: 1 }],
  participantes: ['0.10', '0.20'].map(valor => ({ funcionarioId: randomUUID(), centroCustoId: center, valor, embarqueId: start, desembarqueId: end })) };
describe('individual passenger costs', () => {
  it('adds decimal cents exactly', () => expect(passengerTotal(itinerarySchema.parse(input))).toBe('0.30'));
  it('rejects a partially priced itinerary', () => expect(itinerarySchema.safeParse({ ...input, participantes: input.participantes.map((p, i) => ({ ...p, valor: i ? undefined : p.valor })) }).success).toBe(false));
  it('rejects invalid monetary precision and negatives', () => {
    for (const valor of ['-1', '1.001', '', 'Infinity']) expect(itinerarySchema.safeParse({ ...input, participantes: input.participantes.map(p => ({ ...p, valor })) }).success).toBe(false);
  });
  it('retains the legacy total model when amounts are absent', () => expect(passengerTotal({ ...input, participantes: input.participantes.map(p => ({ ...p, valor: undefined })) })).toBeUndefined());
  it('rejects total overflow', () => expect(() => passengerTotal({ ...input, participantes: input.participantes.map(p => ({ ...p, valor: '9999999999.99' })) })).toThrow());
});
