import { describe, expect, it, vi } from 'vitest';

import type { Database, QueryExecutor } from '../src/db/pool';
import type { AuthContext } from '../src/modules/auth/auth.types';
import { CorridaRepository } from '../src/modules/corridas/corrida.repository';
import {
  addCenterScope, OperationalScopeService, type OperationalScope,
} from '../src/modules/escopo/operational-scope.service';

const EMPRESA = '11111111-1111-4111-8111-111111111111';
const USUARIO = '22222222-2222-4222-8222-222222222222';
const SETOR = '33333333-3333-4333-8333-333333333333';
const CENTRO = '44444444-4444-4444-8444-444444444444';
const CORRIDA = '55555555-5555-4555-8555-555555555555';

const gestor: AuthContext = { empresaId: EMPRESA, usuarioId: USUARIO, perfil: 'GESTOR' };
const gerente: AuthContext = { empresaId: EMPRESA, usuarioId: USUARIO, perfil: 'GERENTE' };

describe('OperationalScopeService', () => {
  it('concede ao gestor somente a empresa autenticada sem consultar vinculos', async () => {
    const query = vi.fn();
    const service = new OperationalScopeService({ query } as unknown as Database);

    await expect(service.resolve(gestor)).resolves.toEqual({ kind: 'GESTOR', empresaId: EMPRESA });
    expect(query).not.toHaveBeenCalled();
  });

  it('resolve a intersecao de setores e centros do gerente no banco', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ setor_ids: [SETOR], centro_custo_ids: [CENTRO] }], rowCount: 1,
    });
    const service = new OperationalScopeService({ query } as unknown as Database);

    await expect(service.resolve(gerente)).resolves.toMatchObject({
      kind: 'GERENTE', empresaId: EMPRESA, usuarioId: USUARIO,
      setorIds: [SETOR], centroCustoIds: [CENTRO],
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("u.perfil = 'GERENTE'"), [EMPRESA, USUARIO]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('JOIN admtaxi.gerente_setores'), [EMPRESA, USUARIO]);
  });

  it('mantem escopo vazio quando o gerente nao possui centros', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ setor_ids: [], centro_custo_ids: [] }], rowCount: 1,
    });
    const scope = await new OperationalScopeService({ query } as unknown as Database).resolve(gerente);
    expect(scope).toMatchObject({ kind: 'GERENTE', setorIds: [], centroCustoIds: [] });
  });

  it('rejeita token de gerente sem usuario ativo correspondente', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(new OperationalScopeService({ query } as unknown as Database).resolve(gerente))
      .rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('protecoes por ID e filtros', () => {
  const managerScope: OperationalScope = {
    kind: 'GERENTE', empresaId: EMPRESA, usuarioId: USUARIO,
    setorIds: [SETOR], centroCustoIds: [CENTRO],
  };

  it('adiciona o centro autorizado como intersecao, inclusive quando a lista esta vazia', () => {
    const conditions = ['c.empresa_id=$1'];
    const values: unknown[] = [EMPRESA];
    addCenterScope(conditions, values, { ...managerScope, centroCustoIds: [] }, 'c.centro_custo_id');
    expect(conditions).toContain('c.centro_custo_id = ANY($2::uuid[])');
    expect(values).toEqual([EMPRESA, []]);
  });

  it('consulta corrida por ID com empresa e centros autorizados na propria query', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const repository = new CorridaRepository({ query } as unknown as Database);
    const result = await repository.findAccessible(
      { query } as unknown as QueryExecutor, EMPRESA, CORRIDA,
      { kind: 'GERENTE', usuarioId: USUARIO, setorIds: [SETOR], centroCustoIds: [CENTRO] },
    );
    expect(result).toBeNull();
    expect(query).toHaveBeenCalledWith(expect.stringContaining('c.id = $2'), [EMPRESA, CORRIDA, [CENTRO]]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('c.centro_custo_id = ANY($3::uuid[])'), expect.any(Array));
  });
});
