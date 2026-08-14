import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { Database, QueryExecutor } from '../src/db/pool';
import type { AuthContext } from '../src/modules/auth/auth.types';
import type { AuditEntry } from '../src/modules/auditoria/audit.types';
import { funcionarioUnificadoCreateSchema } from '../src/modules/funcionarios/funcionario-unificado.schemas';
import { FuncionarioUnificadoService } from '../src/modules/funcionarios/funcionario-unificado.service';

const EMPRESA = '11111111-1111-4111-8111-111111111111';
const GESTOR = '22222222-2222-4222-8222-222222222222';
const USUARIO = '33333333-3333-4333-8333-333333333333';
const FUNCIONARIO = '44444444-4444-4444-8444-444444444444';
const CENTRO = '55555555-5555-4555-8555-555555555555';
const auth: AuthContext = { empresaId: EMPRESA, usuarioId: GESTOR, perfil: 'GESTOR' };
const input = {
  acesso: { senha: 'senha-temporaria-123', ativo: true },
  funcionario: {
    centroCustoId: CENTRO, nome: 'Funcionario Teste', matricula: 'MAT-10', cpf: '529.982.247-25',
    telefone: '34999999999', email: 'funcionario@teste.com', enderecoPadrao: null,
    latitudePadrao: null, longitudePadrao: null,
  },
};

function database(query: ReturnType<typeof vi.fn>): Database {
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  return { query: query as QueryExecutor['query'], connect: () => Promise.resolve(client) };
}

function successfulQuery() {
  return vi.fn().mockImplementation((sql: string) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve({ rows: [], rowCount: null });
    if (sql.includes('FROM admtaxi.centros_custo')) return Promise.resolve({ rows: [{ '?column?': 1 }], rowCount: 1 });
    if (sql.includes('INSERT INTO admtaxi.usuarios')) return Promise.resolve({ rows: [{ id: USUARIO }], rowCount: 1 });
    if (sql.includes('INSERT INTO admtaxi.funcionarios')) return Promise.resolve({ rows: [{ id: FUNCIONARIO }], rowCount: 1 });
    if (sql.includes('INSERT INTO admtaxi.auditoria')) return Promise.resolve({ rows: [], rowCount: 1 });
    if (sql.includes('FROM admtaxi.funcionarios f LEFT JOIN')) return Promise.resolve({ rows: [{
      id: FUNCIONARIO, empresa_id: EMPRESA, usuario_id: USUARIO, centro_custo_id: CENTRO,
      nome: input.funcionario.nome, matricula: input.funcionario.matricula, cpf: '52998224725',
      telefone: input.funcionario.telefone, email: input.funcionario.email, endereco_padrao: null,
      latitude_padrao: null, longitude_padrao: null, ativo: true, usuario_ativo: true,
      criado_em: new Date(), atualizado_em: new Date(),
    }], rowCount: 1 });
    return Promise.resolve({ rows: [], rowCount: 1 });
  });
}

const audit = { record: (executor: QueryExecutor, entry: AuditEntry) => executor.query(
  'INSERT INTO admtaxi.auditoria VALUES ($1)', [entry],
) };

describe('cadastro unificado de funcionario', () => {
  it('exige e-mail para criar o usuario de acesso', () => {
    expect(funcionarioUnificadoCreateSchema.safeParse(input).success).toBe(true);
    expect(funcionarioUnificadoCreateSchema.safeParse({
      ...input, funcionario: { ...input.funcionario, email: null },
    }).success).toBe(false);
  });

  it('cria usuario e funcionario no mesmo tenant e confirma uma transacao', async () => {
    const query = successfulQuery();
    const service = new FuncionarioUnificadoService(database(query), audit as never, async () => 'hash');

    const result = await service.create(auth, funcionarioUnificadoCreateSchema.parse(input), {});

    expect(result).toMatchObject({ id: FUNCIONARIO, usuarioId: USUARIO });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO admtaxi.usuarios'), expect.arrayContaining([EMPRESA]));
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO admtaxi.funcionarios'), expect.arrayContaining([EMPRESA, USUARIO, CENTRO]));
    expect(query).toHaveBeenCalledWith('COMMIT');
  });

  it('desfaz o usuario se a criacao do funcionario falhar', async () => {
    const query = successfulQuery();
    query.mockImplementationOnce(() => Promise.resolve({ rows: [], rowCount: null }))
      .mockImplementationOnce(() => Promise.resolve({ rows: [{ '?column?': 1 }], rowCount: 1 }))
      .mockImplementationOnce(() => Promise.resolve({ rows: [{ id: USUARIO }], rowCount: 1 }))
      .mockImplementationOnce(() => Promise.reject(new Error('matricula duplicada')))
      .mockImplementationOnce(() => Promise.resolve({ rows: [], rowCount: null }));
    const service = new FuncionarioUnificadoService(database(query), audit as never, async () => 'hash');

    await expect(service.create(auth, funcionarioUnificadoCreateSchema.parse(input), {})).rejects.toThrow('matricula duplicada');
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(query).not.toHaveBeenCalledWith('COMMIT');
  });

  it('inativa funcionario e usuario juntos e revoga sessoes', async () => {
    const query = successfulQuery();
    const service = new FuncionarioUnificadoService(database(query), audit as never, async () => 'hash');

    await service.update(auth, FUNCIONARIO, { funcionario: { ativo: false } }, {});

    expect(query).toHaveBeenCalledWith(expect.stringContaining('UPDATE admtaxi.usuarios SET ativo = $3'), [EMPRESA, USUARIO, false]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('UPDATE admtaxi.funcionarios SET ativo = $3'), [EMPRESA, FUNCIONARIO, false]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('UPDATE admtaxi.refresh_tokens'), [EMPRESA, USUARIO]);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('DELETE'))).toBe(false);
  });
});
