import type { Database, QueryExecutor } from '../../db/pool';
import { withTransaction } from '../../db/pool';
import type { AuthContext } from '../auth/auth.types';
import type { AuditEntry, AuditMetadata } from '../auditoria/audit.types';
import { notFound } from '../../shared/errors/app-error';
import type { PaginatedResult } from '../../shared/pagination/pagination';
import { CatalogRepository, type CatalogListQuery } from './catalog.repository';
import type { CatalogDefinition, CatalogInput, CatalogRecord } from './catalog.types';

export interface CatalogApplication {
  list(auth: AuthContext, query: CatalogListQuery): Promise<PaginatedResult<CatalogRecord>>;
  get(auth: AuthContext, id: string): Promise<CatalogRecord>;
  create(auth: AuthContext, input: CatalogInput, metadata: AuditMetadata): Promise<CatalogRecord>;
  update(auth: AuthContext, id: string, input: CatalogInput, metadata: AuditMetadata): Promise<CatalogRecord>;
  setActive(auth: AuthContext, id: string, ativo: boolean, metadata: AuditMetadata): Promise<CatalogRecord>;
}

export interface CatalogStore {
  list(empresaId: string, query: CatalogListQuery): Promise<PaginatedResult<CatalogRecord>>;
  findById(executor: QueryExecutor, empresaId: string, id: string): Promise<CatalogRecord | null>;
  create(executor: QueryExecutor, empresaId: string, input: CatalogInput): Promise<CatalogRecord>;
  update(executor: QueryExecutor, empresaId: string, id: string, input: CatalogInput): Promise<CatalogRecord | null>;
  setActive(executor: QueryExecutor, empresaId: string, id: string, ativo: boolean): Promise<CatalogRecord | null>;
}

export interface AuditWriter {
  record(executor: QueryExecutor, entry: AuditEntry): Promise<void>;
}

export class CatalogService implements CatalogApplication {
  private readonly repository: CatalogStore;

  constructor(
    private readonly pool: Database,
    private readonly audit: AuditWriter,
    private readonly definition: CatalogDefinition,
    repository?: CatalogStore,
  ) {
    this.repository = repository ?? new CatalogRepository(pool, definition);
  }

  list(auth: AuthContext, query: CatalogListQuery): Promise<PaginatedResult<CatalogRecord>> {
    return this.repository.list(auth.empresaId, query);
  }

  async get(auth: AuthContext, id: string): Promise<CatalogRecord> {
    const record = await this.repository.findById(this.pool, auth.empresaId, id);
    if (!record) throw notFound(this.definition.entityLabel);
    return record;
  }

  create(auth: AuthContext, input: CatalogInput, metadata: AuditMetadata): Promise<CatalogRecord> {
    return withTransaction(this.pool, async (client) => {
      await this.definition.validateReferences?.(client, auth.empresaId, input);
      const created = await this.repository.create(client, auth.empresaId, input);
      await this.audit.record(client, {
        ...metadata,
        empresaId: auth.empresaId,
        usuarioId: auth.usuarioId,
        entidade: this.definition.entity,
        entidadeId: created.id,
        acao: 'CRIAR',
        dadosNovos: created,
      });
      return created;
    });
  }

  update(auth: AuthContext, id: string, input: CatalogInput, metadata: AuditMetadata): Promise<CatalogRecord> {
    return withTransaction(this.pool, async (client) => {
      const current = await this.repository.findById(client, auth.empresaId, id);
      if (!current) throw notFound(this.definition.entityLabel);
      await this.definition.validateReferences?.(client, auth.empresaId, input);
      const updated = await this.repository.update(client, auth.empresaId, id, input);
      if (!updated) throw notFound(this.definition.entityLabel);
      await this.audit.record(client, {
        ...metadata,
        empresaId: auth.empresaId,
        usuarioId: auth.usuarioId,
        entidade: this.definition.entity,
        entidadeId: id,
        acao: 'ATUALIZAR',
        dadosAnteriores: current,
        dadosNovos: updated,
      });
      return updated;
    });
  }

  setActive(
    auth: AuthContext,
    id: string,
    ativo: boolean,
    metadata: AuditMetadata,
  ): Promise<CatalogRecord> {
    return withTransaction(this.pool, async (client) => {
      const current = await this.repository.findById(client, auth.empresaId, id);
      if (!current) throw notFound(this.definition.entityLabel);
      if (current.ativo === ativo) return current;
      const updated = await this.repository.setActive(client, auth.empresaId, id, ativo);
      if (!updated) throw notFound(this.definition.entityLabel);
      await this.audit.record(client, {
        ...metadata,
        empresaId: auth.empresaId,
        usuarioId: auth.usuarioId,
        entidade: this.definition.entity,
        entidadeId: id,
        acao: ativo ? 'REATIVAR' : 'INATIVAR',
        dadosAnteriores: current,
        dadosNovos: updated,
      });
      return updated;
    });
  }
}
