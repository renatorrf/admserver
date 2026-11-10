import { describe, expect, it } from 'vitest';

import { corridaCreateSchema, corridaFinishSchema, corridaRefuseSchema } from '../src/modules/corridas/corrida.schemas';

const baseRide = {
  funcionarioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  centroCustoId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  tipo: 'IMEDIATA',
  origemDescricao: 'Rua de origem, 100',
  destinoDescricao: 'Rua de destino, 200',
};

describe('schemas de corridas', () => {
  it('exige justificativa de recusa e normaliza espacos', () => {
    expect(corridaRefuseSchema.safeParse({}).success).toBe(false);
    expect(corridaRefuseSchema.safeParse({ motivo: '  nao   ' }).success).toBe(false);
    expect(corridaRefuseSchema.parse({ motivo: ' Veiculo em manutencao. ' })).toEqual({ motivo: 'Veiculo em manutencao.' });
  });
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

  it('valida paradas, funcionarios repetidos e quantidade de passageiros', () => {
    const additionalEmployee = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    expect(corridaCreateSchema.safeParse({
      ...baseRide,
      quantidadePassageiros: 2,
      paradas: [
        { tipo: 'FUNCIONARIO', funcionarioId: additionalEmployee },
        { tipo: 'MANUAL', descricao: 'Avenida Central, 300', latitude: -23.51, longitude: -46.61 },
      ],
    }).success).toBe(true);
    expect(corridaCreateSchema.safeParse({
      ...baseRide,
      quantidadePassageiros: 1,
      paradas: [{ tipo: 'FUNCIONARIO', funcionarioId: additionalEmployee }],
    }).success).toBe(false);
    expect(corridaCreateSchema.safeParse({
      ...baseRide,
      quantidadePassageiros: 2,
      paradas: [{ tipo: 'FUNCIONARIO', funcionarioId: baseRide.funcionarioId }],
    }).success).toBe(false);
  });
});
