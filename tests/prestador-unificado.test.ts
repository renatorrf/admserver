import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { Database, QueryExecutor } from '../src/db/pool';
import type { AuthContext } from '../src/modules/auth/auth.types';
import type { AuditEntry } from '../src/modules/auditoria/audit.types';
import { prestadorUnificadoCreateSchema } from '../src/modules/prestadores/prestador-unificado.schemas';
import { PrestadorUnificadoService } from '../src/modules/prestadores/prestador-unificado.service';

const EMPRESA = '11111111-1111-4111-8111-111111111111';
const GESTOR = '22222222-2222-4222-8222-222222222222';
const USUARIO = '33333333-3333-4333-8333-333333333333';
const PRESTADOR = '44444444-4444-4444-8444-444444444444';
const VEICULO = '55555555-5555-4555-8555-555555555555';
const auth: AuthContext = { empresaId: EMPRESA, usuarioId: GESTOR, perfil: 'GESTOR' };

const input = {
  acesso: {
    nome: 'Motorista Teste', email: 'motorista@teste.com', telefone: '34999999999', ativo: true,
    formaAtivacao: 'SENHA_TEMPORARIA' as const, senha: 'senha-temporaria-123',
  },
  prestador: {
    reutilizarDadosAcesso: true, cpf: '529.982.247-25', numeroCnh: 'cnh123',
    validadeCnh: '2030-12-31', disponivel: true, ativo: true,
  },
  veiculo: {
    modo: 'NOVO' as const,
    dados: { placa: 'BRA1E23', marca: 'Fiat', modelo: 'Cronos', cor: 'Prata', ano: 2026, capacidadePassageiros: 4, ativo: true },
  },
};

function database(query: ReturnType<typeof vi.fn>): Database {
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  return { query: query as QueryExecutor['query'], connect: () => Promise.resolve(client) };
}

function successfulQuery() {
  return vi.fn().mockImplementation((sql: string) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve({ rows: [], rowCount: null });
    if (sql.includes('INSERT INTO admtaxi.usuarios')) return Promise.resolve({ rows: [{ id: USUARIO }], rowCount: 1 });
    if (sql.includes('INSERT INTO admtaxi.prestadores')) return Promise.resolve({ rows: [{ id: PRESTADOR }], rowCount: 1 });
    if (sql.includes('INSERT INTO admtaxi.veiculos')) return Promise.resolve({ rows: [{ id: VEICULO }], rowCount: 1 });
    if (sql.includes('INSERT INTO admtaxi.auditoria')) return Promise.resolve({ rows: [], rowCount: 1 });
    if (sql.includes('FROM admtaxi.prestadores p JOIN')) return Promise.resolve({ rows: [{
      id: PRESTADOR, empresa_id: EMPRESA, usuario_id: USUARIO, nome: input.acesso.nome,
      cpf: '52998224725', telefone: input.acesso.telefone, email: input.acesso.email,
      numero_cnh: 'CNH123', validade_cnh: '2030-12-31', disponivel: true, ativo: true,
      usuario_nome: input.acesso.nome, usuario_email: input.acesso.email,
      usuario_telefone: input.acesso.telefone, usuario_ativo: true,
    }], rowCount: 1 });
    if (sql.includes('FROM admtaxi.veiculos WHERE')) return Promise.resolve({ rows: [{
      id: VEICULO, placa: 'BRA1E23', marca: 'Fiat', modelo: 'Cronos', cor: 'Prata', ano: 2026,
      capacidade_passageiros: 4, ativo: true,
    }], rowCount: 1 });
    if (sql.includes('FROM admtaxi.dispositivos_push')) return Promise.resolve({ rows: [], rowCount: 0 });
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

const audit = { record: (executor: QueryExecutor, entry: AuditEntry) => executor.query(
  'INSERT INTO admtaxi.auditoria VALUES ($1)', [entry],
) };

describe('cadastro unificado de prestador', () => {
  it('valida acesso, prestador e veiculo em um unico payload', () => {
    expect(prestadorUnificadoCreateSchema.safeParse(input).success).toBe(true);
    expect(prestadorUnificadoCreateSchema.safeParse({
      ...input, acesso: { ...input.acesso, telefone: null },
    }).success).toBe(false);
  });

  it('cria usuario, prestador e veiculo no tenant autenticado e confirma uma transacao', async () => {
    const query = successfulQuery();
    const service = new PrestadorUnificadoService(database(query), audit as never);

    const result = await service.create(auth, prestadorUnificadoCreateSchema.parse(input), {});

    expect(result).toMatchObject({ id: PRESTADOR, usuarioId: USUARIO });
    expect(query).toHaveBeenCalledWith('COMMIT');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO admtaxi.usuarios'), expect.arrayContaining([EMPRESA]));
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO admtaxi.prestadores'), expect.arrayContaining([EMPRESA, USUARIO]));
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO admtaxi.veiculos'), expect.arrayContaining([EMPRESA, PRESTADOR]));
  });

  it('permite concluir o cadastro sem veiculo e nao executa insercao parcial', async () => {
    const query = successfulQuery();
    const service = new PrestadorUnificadoService(database(query), audit as never);
    const parsed = prestadorUnificadoCreateSchema.parse({ ...input, veiculo: { modo: 'DEPOIS' } });

    await service.create(auth, parsed, {});

    expect(query).toHaveBeenCalledWith('COMMIT');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO admtaxi.veiculos'))).toBe(false);
  });

  it('vincula um veiculo ativo e livre da mesma empresa', async () => {
    const fallback = successfulQuery();
    const query = vi.fn().mockImplementation((sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT id, prestador_id')) {
        expect(values).toEqual([EMPRESA, VEICULO]);
        return Promise.resolve({ rows: [{ id: VEICULO, prestador_id: null }], rowCount: 1 });
      }
      return fallback(sql, values);
    });
    const service = new PrestadorUnificadoService(database(query), audit as never);
    const parsed = prestadorUnificadoCreateSchema.parse({ ...input, veiculo: { modo: 'EXISTENTE', veiculoId: VEICULO } });

    await service.create(auth, parsed, {});

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE admtaxi.veiculos SET prestador_id = $3'), [EMPRESA, VEICULO, PRESTADOR],
    );
    expect(query).toHaveBeenCalledWith('COMMIT');
  });

  it('desfaz usuario e prestador se a criacao do veiculo falhar', async () => {
    const query = successfulQuery();
    query.mockImplementationOnce(() => Promise.resolve({ rows: [], rowCount: null }))
      .mockImplementationOnce(() => Promise.resolve({ rows: [{ id: USUARIO }], rowCount: 1 }))
      .mockImplementationOnce(() => Promise.resolve({ rows: [{ id: PRESTADOR }], rowCount: 1 }))
      .mockImplementationOnce(() => Promise.reject(new Error('placa duplicada')))
      .mockImplementationOnce(() => Promise.resolve({ rows: [], rowCount: null }));
    const service = new PrestadorUnificadoService(database(query), audit as never);

    await expect(service.create(auth, prestadorUnificadoCreateSchema.parse(input), {})).rejects.toThrow('placa duplicada');
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(query).not.toHaveBeenCalledWith('COMMIT');
  });

  it('recusa veiculo de outra empresa ou ja vinculado e executa rollback', async () => {
    const query = successfulQuery();
    query.mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return Promise.resolve({ rows: [], rowCount: null });
      if (sql.includes('INSERT INTO admtaxi.usuarios')) return Promise.resolve({ rows: [{ id: USUARIO }], rowCount: 1 });
      if (sql.includes('INSERT INTO admtaxi.prestadores')) return Promise.resolve({ rows: [{ id: PRESTADOR }], rowCount: 1 });
      if (sql.includes('SELECT id, prestador_id')) return Promise.resolve({ rows: [{ id: VEICULO, prestador_id: '66666666-6666-4666-8666-666666666666' }], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const service = new PrestadorUnificadoService(database(query), audit as never);
    const parsed = prestadorUnificadoCreateSchema.parse({ ...input, veiculo: { modo: 'EXISTENTE', veiculoId: VEICULO } });

    await expect(service.create(auth, parsed, {})).rejects.toMatchObject({ statusCode: 409 });
    expect(query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('recusa veiculo ausente no tenant autenticado', async () => {
    const query = successfulQuery();
    query.mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return Promise.resolve({ rows: [], rowCount: null });
      if (sql.includes('INSERT INTO admtaxi.usuarios')) return Promise.resolve({ rows: [{ id: USUARIO }], rowCount: 1 });
      if (sql.includes('INSERT INTO admtaxi.prestadores')) return Promise.resolve({ rows: [{ id: PRESTADOR }], rowCount: 1 });
      if (sql.includes('SELECT id, prestador_id')) return Promise.resolve({ rows: [], rowCount: 0 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const service = new PrestadorUnificadoService(database(query), audit as never);
    const parsed = prestadorUnificadoCreateSchema.parse({ ...input, veiculo: { modo: 'EXISTENTE', veiculoId: VEICULO } });

    await expect(service.create(auth, parsed, {})).rejects.toMatchObject({ statusCode: 422 });
    expect(query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('desfaz a transacao quando o e-mail de acesso e duplicado', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }))
      .mockResolvedValueOnce({ rows: [], rowCount: null });
    const service = new PrestadorUnificadoService(database(query), audit as never);

    await expect(service.create(auth, prestadorUnificadoCreateSchema.parse(input), {})).rejects.toMatchObject({ code: '23505' });
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(query).not.toHaveBeenCalledWith('COMMIT');
  });

  it('troca o veiculo dentro da mesma transacao e preserva os registros', async () => {
    const fallback = successfulQuery();
    const query = vi.fn().mockImplementation((sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT id, prestador_id')) return Promise.resolve({ rows: [{ id: VEICULO, prestador_id: null }], rowCount: 1 });
      return fallback(sql, values);
    });
    const service = new PrestadorUnificadoService(database(query), audit as never);

    await service.update(auth, PRESTADOR, { veiculo: { acao: 'EXISTENTE', veiculoId: VEICULO } }, {});

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('SET prestador_id = NULL'), [EMPRESA, PRESTADOR],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('SET prestador_id = $3'), [EMPRESA, VEICULO, PRESTADOR],
    );
    expect(query.mock.calls.some(([sql]) => String(sql).includes('DELETE'))).toBe(false);
    expect(query).toHaveBeenCalledWith('COMMIT');
  });

  it('inativa usuario e prestador juntos sem excluir veiculo ou historico', async () => {
    const query = successfulQuery();
    const service = new PrestadorUnificadoService(database(query), audit as never);

    await service.update(auth, PRESTADOR, { prestador: { ativo: false } }, {});

    expect(query).toHaveBeenCalledWith(expect.stringContaining('UPDATE admtaxi.usuarios SET ativo = FALSE'), [EMPRESA, USUARIO]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('UPDATE admtaxi.prestadores SET ativo = FALSE'), [EMPRESA, PRESTADOR]);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM admtaxi.veiculos'))).toBe(false);
  });
});
