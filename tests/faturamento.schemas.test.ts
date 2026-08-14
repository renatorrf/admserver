import { describe, expect, it } from 'vitest';

import {
  faturamentoCreateSchema, faturamentoFiltroSchema, faturamentoResumoSchema,
} from '../src/modules/faturamentos/faturamento.schemas';

const PRESTADOR = '11111111-1111-4111-8111-111111111111';
const CORRIDA = '22222222-2222-4222-8222-222222222222';

describe('schemas de faturamento', () => {
  it('carrega e valida resumo sem prestador', () => {
    expect(faturamentoResumoSchema.safeParse({
      periodoInicio: '2026-08-01', periodoFim: '2026-08-31',
    }).success).toBe(true);
  });

  it('exige prestador no filtro de elegibilidade', () => {
    expect(faturamentoFiltroSchema.safeParse({
      periodoInicio: '2026-08-01', periodoFim: '2026-08-31',
    }).success).toBe(false);
  });

  it('valida fechamento sem estender schema refinado', () => {
    expect(faturamentoCreateSchema.safeParse({
      periodoInicio: '2026-08-01', periodoFim: '2026-08-31', prestadorId: PRESTADOR,
      corridaIds: [CORRIDA], exclusoes: [],
    }).success).toBe(true);
  });

  it('rejeita periodo invertido em todos os fluxos', () => {
    const period = { periodoInicio: '2026-08-31', periodoFim: '2026-08-01' };
    expect(faturamentoResumoSchema.safeParse(period).success).toBe(false);
    expect(faturamentoFiltroSchema.safeParse({ ...period, prestadorId: PRESTADOR }).success).toBe(false);
    expect(faturamentoCreateSchema.safeParse({
      ...period, prestadorId: PRESTADOR, corridaIds: [CORRIDA], exclusoes: [],
    }).success).toBe(false);
  });
});
