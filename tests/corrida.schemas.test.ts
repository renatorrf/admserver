import { describe, expect, it } from 'vitest';

import { corridaCreateSchema, corridaFinishSchema } from '../src/modules/corridas/corrida.schemas';

const baseRide = {
  funcionarioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  centroCustoId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  tipo: 'IMEDIATA',
  origemDescricao: 'Rua de origem, 100',
  destinoDescricao: 'Rua de destino, 200',
};

describe('schemas de corridas', () => {
  it('rejeita empresa_id e coordenadas incompletas', () => {
    expect(corridaCreateSchema.safeParse({
      ...baseRide, empresaId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    }).success).toBe(false);
    expect(corridaCreateSchema.safeParse({ ...baseRide, origemLatitude: -23.5 }).success).toBe(false);
  });

  it('exige agendamento apenas para corrida agendada', () => {
    expect(corridaCreateSchema.safeParse({ ...baseRide, tipo: 'AGENDADA' }).success).toBe(false);
    expect(corridaCreateSchema.safeParse({ ...baseRide, agendadaPara: '2030-01-01T10:00:00-03:00' }).success).toBe(false);
    expect(corridaCreateSchema.safeParse({
      ...baseRide, tipo: 'AGENDADA', agendadaPara: '2030-01-01T10:00:00-03:00',
    }).success).toBe(true);
  });

  it('normaliza valor monetario sem converter para float', () => {
    expect(corridaFinishSchema.parse({ valorFinal: '123,45' }).valorFinal).toBe('123.45');
    expect(corridaFinishSchema.safeParse({ valorFinal: '12.345' }).success).toBe(false);
  });
});
