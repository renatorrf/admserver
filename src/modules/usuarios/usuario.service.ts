import argon2 from 'argon2';
import type { Database, QueryExecutor } from '../../db/pool';
import { withTransaction } from '../../db/pool';
import { conflict, invalidReference, notFound } from '../../shared/errors/app-error';
import type { PaginatedResult } from '../../shared/pagination/pagination';
import type { AuthContext } from '../auth/auth.types';
import type { AuditEntry, AuditMetadata } from '../auditoria/audit.types';
import type { GerenteCentrosInput, UsuarioCreateInput, UsuarioListQuery, UsuarioUpdateInput } from './usuario.schemas';
import { UsuarioRepository, type CentroCustoResumo, type UsuarioRecord } from './usuario.repository';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
}

export interface UsuarioStore {
  list(empresaId: string, query: UsuarioListQuery): Promise<PaginatedResult<UsuarioRecord>>;
  findById(executor: QueryExecutor, empresaId: string, id: string): Promise<UsuarioRecord | null>;
  create(executor: QueryExecutor, empresaId: string, input: UsuarioCreateInput, senhaHash: string): Promise<UsuarioRecord>;
  update(executor: QueryExecutor, empresaId: string, id: string, input: UsuarioUpdateInput, senhaHash?: string): Promise<UsuarioRecord | null>;
  setActive(executor: QueryExecutor, empresaId: string, id: string, ativo: boolean): Promise<UsuarioRecord | null>;
  revokeSessions(executor: QueryExecutor, empresaId: string, usuarioId: string): Promise<void>;
  isLinkedProvider(executor: QueryExecutor, empresaId: string, usuarioId: string): Promise<boolean>;
  listManagerCenters(executor: QueryExecutor, empresaId: string, usuarioId: string): Promise<CentroCustoResumo[]>;
  replaceManagerCenters(executor: QueryExecutor, empresaId: string, usuarioId: string, centerIds: string[]): Promise<void>;
  countActiveCenters(executor: QueryExecutor, empresaId: string, centerIds: string[]): Promise<number>;
}

export interface UsuarioAuditWriter {
  record(executor: QueryExecutor, entry: AuditEntry): Promise<void>;
}

const defaultPasswordHasher: PasswordHasher = { hash: (password) => argon2.hash(password) };

export class UsuarioService {
  private readonly repository: UsuarioStore;

  constructor(
    private readonly pool: Database,
    private readonly audit: UsuarioAuditWriter,
    private readonly passwordHasher: PasswordHasher = defaultPasswordHasher,
    repository?: UsuarioStore,
  ) {
    this.repository = repository ?? new UsuarioRepository(pool);
  }

  list(auth: AuthContext, query: UsuarioListQuery): Promise<PaginatedResult<UsuarioRecord>> {
    return this.repository.list(auth.empresaId, query);
  }

  async get(auth: AuthContext, id: string): Promise<UsuarioRecord> {
    const user = await this.repository.findById(this.pool, auth.empresaId, id);
    if (!user) throw notFound('Usuario');
    return user;
  }

  async create(auth: AuthContext, input: UsuarioCreateInput, metadata: AuditMetadata): Promise<UsuarioRecord> {
    const senhaHash = await this.passwordHasher.hash(input.senha);
    return withTransaction(this.pool, async (client) => {
      const created = await this.repository.create(client, auth.empresaId, input, senhaHash);
      await this.audit.record(client, {
        ...metadata, empresaId: auth.empresaId, usuarioId: auth.usuarioId,
        entidade: 'usuario', entidadeId: created.id, acao: 'CRIAR', dadosNovos: created,
      });
      return created;
    });
  }

  async update(
    auth: AuthContext,
    id: string,
    input: UsuarioUpdateInput,
    metadata: AuditMetadata,
  ): Promise<UsuarioRecord> {
    if (id === auth.usuarioId && input.perfil && input.perfil !== auth.perfil) {
      throw conflict('Voce nao pode alterar o proprio perfil.');
    }
    const senhaHash = input.senha ? await this.passwordHasher.hash(input.senha) : undefined;
    return withTransaction(this.pool, async (client) => {
      const current = await this.repository.findById(client, auth.empresaId, id);
      if (!current) throw notFound('Usuario');
      if (input.perfil && input.perfil !== 'PRESTADOR' && await this.repository.isLinkedProvider(client, auth.empresaId, id)) {
        throw conflict('Remova o vinculo com o prestador antes de alterar o perfil do usuario.');
      }
      const previousCenters = current.perfil === 'GERENTE'
        ? await this.repository.listManagerCenters(client, auth.empresaId, id)
        : [];
      const updated = await this.repository.update(client, auth.empresaId, id, input, senhaHash);
      if (!updated) throw notFound('Usuario');
      if (current.perfil === 'GERENTE' && updated.perfil !== 'GERENTE') {
        await this.repository.replaceManagerCenters(client, auth.empresaId, id, []);
      }
      if (input.perfil !== undefined || input.senha !== undefined) {
        await this.repository.revokeSessions(client, auth.empresaId, id);
      }
      await this.audit.record(client, {
        ...metadata, empresaId: auth.empresaId, usuarioId: auth.usuarioId,
        entidade: 'usuario', entidadeId: id, acao: 'ATUALIZAR',
        dadosAnteriores: current,
        dadosNovos: { ...updated, ...(input.senha ? { senhaAlterada: true } : {}) },
      });
      if (previousCenters.length > 0 && updated.perfil !== 'GERENTE') {
        await this.audit.record(client, {
          ...metadata, empresaId: auth.empresaId, usuarioId: auth.usuarioId,
          entidade: 'gerente_centros_custo', entidadeId: id, acao: 'DESVINCULAR',
          dadosAnteriores: { centrosCusto: previousCenters }, dadosNovos: { centrosCusto: [] },
        });
      }
      return updated;
    });
  }

  setActive(auth: AuthContext, id: string, ativo: boolean, metadata: AuditMetadata): Promise<UsuarioRecord> {
    if (!ativo && id === auth.usuarioId) throw conflict('Voce nao pode inativar o proprio usuario.');
    return withTransaction(this.pool, async (client) => {
      const current = await this.repository.findById(client, auth.empresaId, id);
      if (!current) throw notFound('Usuario');
      if (current.ativo === ativo) return current;
      const updated = await this.repository.setActive(client, auth.empresaId, id, ativo);
      if (!updated) throw notFound('Usuario');
      if (!ativo) await this.repository.revokeSessions(client, auth.empresaId, id);
      await this.audit.record(client, {
        ...metadata, empresaId: auth.empresaId, usuarioId: auth.usuarioId,
        entidade: 'usuario', entidadeId: id, acao: ativo ? 'REATIVAR' : 'INATIVAR',
        dadosAnteriores: current, dadosNovos: updated,
      });
      return updated;
    });
  }

  async getManagerCenters(auth: AuthContext, id: string): Promise<CentroCustoResumo[]> {
    const user = await this.repository.findById(this.pool, auth.empresaId, id);
    if (!user) throw notFound('Usuario');
    if (user.perfil !== 'GERENTE') throw conflict('O usuario informado nao possui perfil GERENTE.');
    return this.repository.listManagerCenters(this.pool, auth.empresaId, id);
  }

  replaceManagerCenters(
    auth: AuthContext,
    id: string,
    input: GerenteCentrosInput,
    metadata: AuditMetadata,
  ): Promise<CentroCustoResumo[]> {
    return withTransaction(this.pool, async (client) => {
      const user = await this.repository.findById(client, auth.empresaId, id);
      if (!user) throw notFound('Usuario');
      if (user.perfil !== 'GERENTE' || !user.ativo) {
        throw conflict('Selecione um gerente ativo.');
      }
      const validCenters = await this.repository.countActiveCenters(client, auth.empresaId, input.centroCustoIds);
      if (validCenters !== input.centroCustoIds.length) {
        throw invalidReference('Um ou mais centros de custo nao existem, estao inativos ou pertencem a outra empresa.');
      }
      const previous = await this.repository.listManagerCenters(client, auth.empresaId, id);
      await this.repository.replaceManagerCenters(client, auth.empresaId, id, input.centroCustoIds);
      const updated = await this.repository.listManagerCenters(client, auth.empresaId, id);
      await this.audit.record(client, {
        ...metadata, empresaId: auth.empresaId, usuarioId: auth.usuarioId,
        entidade: 'gerente_centros_custo', entidadeId: id, acao: 'SUBSTITUIR_VINCULOS',
        dadosAnteriores: { centrosCusto: previous }, dadosNovos: { centrosCusto: updated },
      });
      return updated;
    });
  }
}
