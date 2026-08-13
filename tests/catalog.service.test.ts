import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { Database, QueryExecutor } from '../src/db/pool';
import type { AuthContext } from '../src/modules/auth/auth.types';
import type { AuditEntry } from '../src/modules/auditoria/audit.types';
import type { CatalogListQuery } from '../src/modules/cadastros/catalog.repository';
import { CatalogService, type AuditWriter, type CatalogStore } from '../src/modules/cadastros/catalog.service';
import type { CatalogDefinition, CatalogInput, CatalogRecord } from '../src/modules/cadastros/catalog.types';
import type { PaginatedResult } from '../src/shared/pagination/pagination';

const EMPRESA_A = '11111111-1111-4111-8111-111111111111';
const EMPRESA_B = '22222222-2222-4222-8222-222222222222';
const USUARIO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REGISTRO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function fakeDatabase(): Database {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  return { query: query as QueryExecutor['query'], connect: () => Promise.resolve(client) };
}

class MemoryCatalogStore implements CatalogStore {
  readonly tenants: string[] = [];
  record: CatalogRecord = { id: REGISTRO, empresaId: EMPRESA_A, nome: 'Financeiro', ativo: true };

  list(empresaId: string, query: CatalogListQuery): Promise<PaginatedResult<CatalogRecord>> {
    this.tenants.push(empresaId);
    return Promise.resolve({ data: [], meta: { pagina: query.pagina, limite: query.limite, total: 0, totalPaginas: 0 } });
  }

  findById(_executor: QueryExecutor, empresaId: string): Promise<CatalogRecord | null> {
    this.tenants.push(empresaId);
    return Promise.resolve(empresaId === this.record.empresaId ? this.record : null);
  }

  create(_executor: QueryExecutor, empresaId: string, input: CatalogInput): Promise<CatalogRecord> {
    this.tenants.push(empresaId);
    this.record = { ...this.record, ...input, empresaId };
    return Promise.resolve(this.record);
  }

  update(_executor: QueryExecutor, empresaId: string, _id: string, input: CatalogInput): Promise<CatalogRecord | null> {
    this.tenants.push(empresaId);
    this.record = { ...this.record, ...input, empresaId };
    return Promise.resolve(this.record);
  }

  setActive(_executor: QueryExecutor, empresaId: string, _id: string, ativo: boolean): Promise<CatalogRecord | null> {
    this.tenants.push(empresaId);
    this.record = { ...this.record, ativo, empresaId };
    return Promise.resolve(this.record);
  }
}

class MemoryAudit implements AuditWriter {
  readonly entries: AuditEntry[] = [];
  record(_executor: QueryExecutor, entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
}

const definition: CatalogDefinition = {
  table: 'centros_custo',
  entity: 'centro_custo',
  entityLabel: 'Centro de custo',
  orderBy: 'nome',
  searchColumns: ['nome'],
  fields: { nome: 'nome' },
  mapRow: () => ({ id: REGISTRO, empresaId: EMPRESA_A, ativo: true }),
};
const auth: AuthContext = { usuarioId: USUARIO, empresaId: EMPRESA_A, perfil: 'GESTOR' };

describe('CatalogService', () => {
  it('usa exclusivamente a empresa autenticada e registra auditoria na mesma operacao', async () => {
    const store = new MemoryCatalogStore();
    const audit = new MemoryAudit();
    const service = new CatalogService(fakeDatabase(), audit, definition, store);

    const updated = await service.update(auth, REGISTRO, { nome: 'Controladoria' }, { ip: '127.0.0.1' });

    expect(updated.empresaId).toBe(EMPRESA_A);
    expect(store.tenants).toEqual([EMPRESA_A, EMPRESA_A]);
    expect(audit.entries[0]).toMatchObject({
      empresaId: EMPRESA_A,
      usuarioId: USUARIO,
      entidade: 'centro_custo',
      entidadeId: REGISTRO,
      acao: 'ATUALIZAR',
    });
  });

  it('nao encontra o mesmo identificador em outra empresa', async () => {
    const service = new CatalogService(fakeDatabase(), new MemoryAudit(), definition, new MemoryCatalogStore());
    await expect(service.get({ ...auth, empresaId: EMPRESA_B }, REGISTRO))
      .rejects.toMatchObject({ statusCode: 404, code: 'REGISTRO_NAO_ENCONTRADO' });
  });

  it('inativa sem exclusao fisica e de forma idempotente', async () => {
    const store = new MemoryCatalogStore();
    const audit = new MemoryAudit();
    const service = new CatalogService(fakeDatabase(), audit, definition, store);

    const inactive = await service.setActive(auth, REGISTRO, false, {});
    const repeated = await service.setActive(auth, REGISTRO, false, {});

    expect(inactive.ativo).toBe(false);
    expect(repeated.ativo).toBe(false);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.acao).toBe('INATIVAR');
  });
});
