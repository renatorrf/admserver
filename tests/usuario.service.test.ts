import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { Database, QueryExecutor } from '../src/db/pool';
import type { AuthContext } from '../src/modules/auth/auth.types';
import type { AuditEntry } from '../src/modules/auditoria/audit.types';
import type { PaginatedResult } from '../src/shared/pagination/pagination';
import type { GerenteCentrosInput, UsuarioCreateInput, UsuarioListQuery, UsuarioUpdateInput } from '../src/modules/usuarios/usuario.schemas';
import type { CentroCustoResumo, SetorResumo, UsuarioRecord } from '../src/modules/usuarios/usuario.repository';
import { UsuarioService, type PasswordHasher, type UsuarioAuditWriter, type UsuarioStore } from '../src/modules/usuarios/usuario.service';

const EMPRESA = '11111111-1111-4111-8111-111111111111';
const GESTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OUTRO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function fakeDatabase(): Database {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  return { query: query as QueryExecutor['query'], connect: () => Promise.resolve(client) };
}

class UserStore implements UsuarioStore {
  revoked = false;
  receivedHash?: string;
  user: UsuarioRecord = {
    id: OUTRO, empresaId: EMPRESA, nome: 'Outro usuario', email: 'outro@exemplo.com',
    telefone: null, perfil: 'GERENTE', ativo: true,
  };

  list(_empresaId: string, query: UsuarioListQuery): Promise<PaginatedResult<UsuarioRecord>> {
    return Promise.resolve({ data: [this.user], meta: { pagina: query.pagina, limite: query.limite, total: 1, totalPaginas: 1 } });
  }
  findById(_executor: QueryExecutor, empresaId: string, id: string): Promise<UsuarioRecord | null> {
    return Promise.resolve(empresaId === EMPRESA && id === this.user.id ? this.user : null);
  }
  create(_executor: QueryExecutor, empresaId: string, input: UsuarioCreateInput, senhaHash: string): Promise<UsuarioRecord> {
    this.receivedHash = senhaHash;
    this.user = { id: OUTRO, empresaId, nome: input.nome, email: input.email, telefone: input.telefone ?? null, perfil: input.perfil, ativo: true };
    return Promise.resolve(this.user);
  }
  update(_executor: QueryExecutor, _empresaId: string, _id: string, input: UsuarioUpdateInput): Promise<UsuarioRecord> {
    this.user = { ...this.user, ...input, senha: undefined };
    return Promise.resolve(this.user);
  }
  setActive(_executor: QueryExecutor, _empresaId: string, _id: string, ativo: boolean): Promise<UsuarioRecord> {
    this.user = { ...this.user, ativo };
    return Promise.resolve(this.user);
  }
  revokeSessions(): Promise<void> { this.revoked = true; return Promise.resolve(); }
  isLinkedProvider(): Promise<boolean> { return Promise.resolve(false); }
  listManagerCenters(): Promise<CentroCustoResumo[]> { return Promise.resolve([]); }
  listManagerSectors(): Promise<SetorResumo[]> {
    return Promise.resolve([{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', codigo: 'SET', nome: 'Setor', ativo: true }]);
  }
  replaceManagerCenters(): Promise<void> { return Promise.resolve(); }
  replaceManagerSectors(): Promise<void> { return Promise.resolve(); }
  countActiveCenters(_executor: QueryExecutor, _empresaId: string, ids: string[]): Promise<number> { return Promise.resolve(ids.length); }
  countActiveSectors(_executor: QueryExecutor, _empresaId: string, ids: string[]): Promise<number> { return Promise.resolve(ids.length); }
  countActiveCentersInSectors(
    _executor: QueryExecutor, _empresaId: string, ids: string[], _sectorIds: string[],
  ): Promise<number> { return Promise.resolve(ids.length); }
  countVisibleEmployees(): Promise<number> { return Promise.resolve(0); }
}

class UserAudit implements UsuarioAuditWriter {
  entries: AuditEntry[] = [];
  record(_executor: QueryExecutor, entry: AuditEntry): Promise<void> { this.entries.push(entry); return Promise.resolve(); }
}

const hasher: PasswordHasher = { hash: (password) => Promise.resolve(`argon:${password}`) };
const auth: AuthContext = { usuarioId: GESTOR, empresaId: EMPRESA, perfil: 'GESTOR' };

describe('UsuarioService', () => {
  it('cria usuario com hash e nunca inclui senha na auditoria', async () => {
    const store = new UserStore();
    const audit = new UserAudit();
    const service = new UsuarioService(fakeDatabase(), audit, hasher, store);

    const created = await service.create(auth, {
      nome: 'Novo usuario', email: 'novo@exemplo.com', senha: 'senha-com-12-caracteres', perfil: 'GERENTE',
    }, {});

    expect(store.receivedHash).toBe('argon:senha-com-12-caracteres');
    expect(created).not.toHaveProperty('senha');
    expect(JSON.stringify(audit.entries)).not.toContain('senha-com-12-caracteres');
  });

  it('impede o gestor de inativar a propria conta', () => {
    const store = new UserStore();
    const service = new UsuarioService(fakeDatabase(), new UserAudit(), hasher, store);
    expect(() => service.setActive(auth, GESTOR, false, {})).toThrow('Voce nao pode inativar o proprio usuario.');
  });

  it('revoga sessoes ao inativar outro usuario e audita a alteracao', async () => {
    const store = new UserStore();
    const audit = new UserAudit();
    const service = new UsuarioService(fakeDatabase(), audit, hasher, store);

    const updated = await service.setActive(auth, OUTRO, false, {});

    expect(updated.ativo).toBe(false);
    expect(store.revoked).toBe(true);
    expect(audit.entries[0]?.acao).toBe('INATIVAR');
  });

  it('revoga sessoes ao alterar senha sem registrar a senha em texto', async () => {
    const store = new UserStore();
    const audit = new UserAudit();
    const service = new UsuarioService(fakeDatabase(), audit, hasher, store);

    await service.update(auth, OUTRO, { senha: 'outra-senha-com-12-caracteres' }, {});

    expect(store.revoked).toBe(true);
    expect(audit.entries[0]?.dadosNovos).toMatchObject({ senhaAlterada: true });
    expect(JSON.stringify(audit.entries)).not.toContain('outra-senha-com-12-caracteres');
  });

  it('valida todos os centros de custo dentro da empresa', async () => {
    const store = new UserStore();
    store.countActiveCentersInSectors = () => Promise.resolve(0);
    const service = new UsuarioService(fakeDatabase(), new UserAudit(), hasher, store);
    const input: GerenteCentrosInput = { centroCustoIds: ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'] };

    await expect(service.replaceManagerCenters(auth, OUTRO, input, {}))
      .rejects.toMatchObject({ statusCode: 422, code: 'REFERENCIA_INVALIDA' });
  });
});
