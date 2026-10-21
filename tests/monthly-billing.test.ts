import { describe, it, expect } from 'vitest';
import { monthlyAllocation, monthlyQuery, monthlyClose } from '../src/modules/faturamentos/monthly-billing.service';
import { moneyCents } from '../src/modules/corridas/itinerary';
const p = (ride: string, employee: string, center: string) => ({ corridaId: ride, funcionarioId: employee, centroCustoId: center, codigo: center, nome: center });
describe('mensalidade fixa por empresa e prestador', () => {
  it('da o mesmo peso a cada corrida, dividido entre os passageiros transportados', () => {
    const allocation = monthlyAllocation('100.00', [p('a', '1', 'A'), p('a', '2', 'B'), p('b', '1', 'A')]);
    expect(allocation.filter(x => x.centroCustoId === 'A').reduce((s, x) => s + moneyCents(x.valor), 0n)).toBe(7500n);
    expect(allocation.find(x => x.centroCustoId === 'B')?.valor).toBe('25.00');
  });
  it('preserva todos os centavos com rateios desiguais e ordem deterministica', () => {
    const rows = [p('a', '1', 'A'), p('b', '1', 'A'), p('b', '2', 'B'), p('c', '1', 'C'), p('c', '2', 'B'), p('c', '3', 'A')];
    for (const amount of ['0.01', '0.02', '100.01', '9999999999.99']) {
      const result = monthlyAllocation(amount, rows);
      expect(result.reduce((s, x) => s + moneyCents(x.valor), 0n)).toBe(moneyCents(amount));
      expect(monthlyAllocation(amount, [...rows].reverse())).toEqual(result);
    }
  });
  it('nao inventa centro para uma mensalidade sem movimento', () => { expect(monthlyAllocation('2000.00', [])).toEqual([]); });
  it('rejeita competencia invalida, empresa injetada e fechamento sem revisao', () => {
    const valid = { prestadorId: '11111111-1111-4111-8111-111111111111', competencia: '2026-10' };
    expect(monthlyQuery.safeParse(valid).success).toBe(true);
    expect(monthlyQuery.safeParse({ ...valid, competencia: '2026-13' }).success).toBe(false);
    expect(monthlyQuery.safeParse({ ...valid, empresaId: valid.prestadorId }).success).toBe(false);
    expect(monthlyClose.safeParse(valid).success).toBe(false);
  });
});
