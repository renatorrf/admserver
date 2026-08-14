import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../src/db/pool';
import type { AuthContext } from '../src/modules/auth/auth.types';
import { DashboardRepository } from '../src/modules/dashboard/dashboard.repository';
import { DashboardService } from '../src/modules/dashboard/dashboard.service';
import { RelatorioRepository } from '../src/modules/relatorios/relatorio.repository';
import { relatorioListSchema } from '../src/modules/relatorios/relatorio.schemas';
import { RelatorioService, rowsToCsv } from '../src/modules/relatorios/relatorio.service';
import type { RelatorioCorrida } from '../src/modules/relatorios/relatorio.types';
import type { OperationalScopeResolver } from '../src/modules/escopo/operational-scope.service';

const EMPRESA = '11111111-1111-4111-8111-111111111111';
const USUARIO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const gerente: AuthContext = { empresaId: EMPRESA, usuarioId: USUARIO, perfil: 'GERENTE' };
const prestador: AuthContext = { ...gerente, perfil: 'PRESTADOR' };
const CENTRO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const scopeResolver: OperationalScopeResolver = {
  resolve: () => Promise.resolve({
    kind: 'GERENTE', empresaId: EMPRESA, usuarioId: USUARIO,
    setorIds: ['dddddddd-dddd-4ddd-8ddd-dddddddddddd'], centroCustoIds: [CENTRO],
  }),
};

describe('relatorios', () => {
  it('valida a ordem do periodo', () => {
    const result = relatorioListSchema.safeParse({ inicio: '2026-08-10', fim: '2026-08-01' });
    expect(result.success).toBe(false);
  });

  it('bloqueia o perfil prestador', () => {
    const repository = { list: vi.fn(), export: vi.fn() } as unknown as RelatorioRepository;
    const service = new RelatorioService(repository);
    expect(() => service.list(prestador, { pagina: 1, limite: 20 })).toThrow();
  });

  it('aplica empresa e centros autorizados em todas as consultas', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ corridas: '0', finalizadas: '0', canceladas: '0', valorEstimado: '0', valorFinal: '0' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const repository = new RelatorioRepository({ query } as unknown as Database, scopeResolver);

    await repository.list(gerente, { pagina: 1, limite: 20 });

    expect(query).toHaveBeenCalledTimes(5);
    for (const [sql, values] of query.mock.calls as Array<[string, unknown[]]>) {
      expect(sql).toContain('centro_custo_id = ANY($2::uuid[])');
      expect(values[0]).toBe(EMPRESA);
      expect(values[1]).toEqual([CENTRO]);
    }
  });

  it('neutraliza formulas e preserva campos com delimitadores no CSV', () => {
    const row: RelatorioCorrida = {
      id: '1', solicitadaEm: new Date('2026-08-06T12:00:00Z'), agendadaPara: null, finalizadaEm: null,
      status: 'SOLICITADA', tipo: 'IMEDIATA', funcionarioId: 'f1', funcionarioNome: '=CMD()',
      centroCustoId: 'c1', centroCustoCodigo: 'ADM', centroCustoNome: 'Administrativo', prestadorId: null,
      prestadorNome: null, solicitanteUsuarioId: 'u1', solicitanteNome: 'Gerente',
      origemDescricao: 'Rua A; 10', destinoDescricao: 'Rua "B"', valorEstimado: '10.00', valorFinal: null,
    };
    const csv = rowsToCsv([row]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain("\"'=CMD()\"");
    expect(csv).toContain('"Rua A; 10"');
    expect(csv).toContain('"Rua ""B"""');
  });
});

describe('dashboard', () => {
  it('bloqueia o perfil prestador', () => {
    const repository = { get: vi.fn() } as unknown as DashboardRepository;
    expect(() => new DashboardService(repository).get(prestador)).toThrow();
  });

  it('mantem o escopo do gerente nas seis consultas agregadas', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        solicitadasHoje: '0', emAndamento: '0', finalizadasHoje: '0', canceladasHoje: '0', custoDia: '0',
        custoMes: '0', proximasCorridas: '0', minhasSolicitacoesMes: '0', prestadoresDisponiveis: '0',
      }] })
      .mockResolvedValue({ rows: [] });
    const repository = new DashboardRepository({ query } as unknown as Database, scopeResolver);

    const result = await repository.get(gerente);

    expect(result.indicadores.prestadoresDisponiveis).toBeNull();
    expect(query).toHaveBeenCalledTimes(6);
    for (const [sql, values] of query.mock.calls as Array<[string, unknown[]]>) {
      expect(sql).toContain('centro_custo_id');
      expect(values[0]).toBe(EMPRESA);
      expect(values).toContainEqual([CENTRO]);
    }
  });
});
