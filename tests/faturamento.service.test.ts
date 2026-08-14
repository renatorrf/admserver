import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../src/db/pool';
import type { AuthContext } from '../src/modules/auth/auth.types';
import type { AuditRepository } from '../src/modules/auditoria/audit.repository';
import { FaturamentoService } from '../src/modules/faturamentos/faturamento.service';

const EMPRESA = '11111111-1111-4111-8111-111111111111';
const GESTOR = '22222222-2222-4222-8222-222222222222';
const PRESTADOR_USUARIO = '33333333-3333-4333-8333-333333333333';
const PRESTADOR = '44444444-4444-4444-8444-444444444444';
const FATURAMENTO = '55555555-5555-4555-8555-555555555555';
const CORRIDA_1 = '66666666-6666-4666-8666-666666666666';
const CORRIDA_2 = '77777777-7777-4777-8777-777777777777';
const CORRIDA_3 = '88888888-8888-4888-8888-888888888888';
const gestor: AuthContext = { empresaId: EMPRESA, usuarioId: GESTOR, perfil: 'GESTOR' };
const gerente: AuthContext = { empresaId: EMPRESA, usuarioId: GESTOR, perfil: 'GERENTE' };
const prestador: AuthContext = { empresaId: EMPRESA, usuarioId: PRESTADOR_USUARIO, perfil: 'PRESTADOR' };

const eligible = [
  { id: CORRIDA_1, prestadorId: PRESTADOR, valorFinal: '100.10' },
  { id: CORRIDA_2, prestadorId: PRESTADOR, valorFinal: '20.05' },
  { id: CORRIDA_3, prestadorId: PRESTADOR, valorFinal: '15.00' },
];
const billing = {
  id: FATURAMENTO, empresaId: EMPRESA, numero: '1', periodoInicio: '2026-08-01', periodoFim: '2026-08-31',
  prestadorId: PRESTADOR, prestadorNome: 'Prestador Teste', status: 'FECHADO', quantidadeCorridas: 2,
  valorTotal: '120.15', observacao: null, fechadoEm: new Date(), canceladoEm: null,
  motivoCancelamento: null, criadoEm: new Date(), atualizadoEm: new Date(),
};

function databaseFor(query: ReturnType<typeof vi.fn>): Database {
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  return { query: query as Database['query'], connect: vi.fn().mockResolvedValue(client) };
}

function audit() {
  return { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditRepository;
}

describe('FaturamentoService', () => {
  it('nega fechamento e resumo ao gerente', async () => {
    const service = new FaturamentoService(databaseFor(vi.fn()), audit());
    const filter = { periodoInicio: '2026-08-01', periodoFim: '2026-08-31', prestadorId: PRESTADOR };

    expect(() => service.preview(gerente, filter)).toThrow(expect.objectContaining({ statusCode: 403 }));
    await expect(service.summary(gerente, filter)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('fecha em transacao, congela valores decimais e registra exclusao justificada', async () => {
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('FROM admtaxi.corridas c') && sql.includes('FOR UPDATE OF c')) return Promise.resolve({ rows: eligible });
      if (sql.includes('COALESCE(MAX(numero)')) return Promise.resolve({ rows: [{ numero: '1' }] });
      if (sql.includes('INSERT INTO admtaxi.faturamentos')) return Promise.resolve({ rows: [{ id: FATURAMENTO }] });
      if (sql.includes('FROM admtaxi.faturamentos f LEFT JOIN')) return Promise.resolve({ rows: [billing] });
      if (sql.includes('FROM admtaxi.faturamento_itens fi') && sql.includes('JOIN admtaxi.corridas')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const auditRepository = audit();
    const service = new FaturamentoService(databaseFor(query), auditRepository);

    const result = await service.create(gestor, {
      periodoInicio: '2026-08-01', periodoFim: '2026-08-31', prestadorId: PRESTADOR,
      corridaIds: [CORRIDA_1, CORRIDA_2], exclusoes: [{ corridaId: CORRIDA_3, motivo: 'Enviar no proximo fechamento.' }],
    }, {});

    expect(result).toMatchObject({ id: FATURAMENTO, valorTotal: '120.15' });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO admtaxi.faturamentos'), [
      EMPRESA, '1', '2026-08-01', '2026-08-31', PRESTADOR, 2, '120.15', null, GESTOR,
    ]);
    expect(query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO admtaxi.faturamento_itens'))).toHaveLength(2);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO admtaxi.faturamento_exclusoes'), [
      EMPRESA, FATURAMENTO, CORRIDA_3, 'Enviar no proximo fechamento.', GESTOR,
    ]);
    expect(auditRepository.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ acao: 'FECHAR' }));
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']));
  });

  it('rejeita corrida repetida e desfaz a transacao', async () => {
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('FROM admtaxi.corridas c')) return Promise.resolve({ rows: eligible });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const service = new FaturamentoService(databaseFor(query), audit());

    await expect(service.create(gestor, {
      periodoInicio: '2026-08-01', periodoFim: '2026-08-31', prestadorId: PRESTADOR,
      corridaIds: [CORRIDA_1, CORRIDA_1], exclusoes: [],
    }, {})).rejects.toMatchObject({ statusCode: 422 });
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO admtaxi.faturamentos'))).toBe(false);
  });

  it('cancela logicamente, preserva itens e libera as corridas', async () => {
    const cancelled = { ...billing, status: 'CANCELADO', canceladoEm: new Date(), motivoCancelamento: 'Revisao financeira' };
    let fetched = 0;
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('FOR UPDATE OF f')) return Promise.resolve({ rows: [billing] });
      if (sql.includes('FROM admtaxi.faturamentos f LEFT JOIN')) { fetched += 1; return Promise.resolve({ rows: [fetched ? cancelled : billing] }); }
      if (sql.includes('FROM admtaxi.faturamento_itens fi') && sql.includes('JOIN admtaxi.corridas')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const service = new FaturamentoService(databaseFor(query), audit());

    const result = await service.cancel(gestor, FATURAMENTO, { motivo: 'Revisao financeira' }, {});

    expect(result.status).toBe('CANCELADO');
    expect(query).toHaveBeenCalledWith(expect.stringContaining("SET status='CANCELADO'"), [EMPRESA, FATURAMENTO, 'Revisao financeira']);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('SET ativo=FALSE'), [EMPRESA, FATURAMENTO]);
    expect(query.mock.calls.some(([sql]) => /^DELETE/i.test(String(sql).trim()))).toBe(false);
  });

  it('bloqueia correcao de valor de corrida em faturamento ativo', async () => {
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('SELECT id,status::text,valor_final::text')) return Promise.resolve({ rows: [{ id: CORRIDA_1, status: 'FINALIZADA', valor_final: '100.10' }] });
      if (sql.includes('FROM admtaxi.faturamento_itens')) return Promise.resolve({ rows: [{ '?column?': 1 }], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const service = new FaturamentoService(databaseFor(query), audit());

    await expect(service.adjustRideValue(gestor, CORRIDA_1, {
      valorFinal: '110.00', justificativa: 'Correcao de comprovante',
    }, {})).rejects.toMatchObject({ statusCode: 409 });
    expect(query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('limita a consulta do prestador aos proprios fechamentos no tenant', async () => {
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql.startsWith('SELECT id FROM admtaxi.prestadores')) return Promise.resolve({ rows: [{ id: PRESTADOR }] });
      if (sql.includes('COUNT(*)::text')) return Promise.resolve({ rows: [{ total: '1' }] });
      if (sql.includes('FROM admtaxi.faturamentos f LEFT JOIN')) return Promise.resolve({ rows: [billing] });
      return Promise.resolve({ rows: [] });
    });
    const service = new FaturamentoService(databaseFor(query), audit());

    const result = await service.list(prestador, { pagina: 1, limite: 20 });

    expect(result.data).toHaveLength(1);
    const billingQueries = query.mock.calls.filter(([sql]) => String(sql).includes('admtaxi.faturamentos'));
    expect(billingQueries).toHaveLength(2);
    expect(billingQueries.every(([, values]) => Array.isArray(values) && values[0] === EMPRESA && values[1] === PRESTADOR)).toBe(true);
  });
});
