import argon2 from 'argon2';
import type { Pool, QueryResultRow } from 'pg';

import { withTransaction, type QueryExecutor } from '../../db/pool';
import { conflict, notFound, unauthorized } from '../../shared/errors/app-error';
import type { ProvisionamentoInput } from '../provisionamento/provisionamento.schemas';
import type { ProvisionamentoMetadata, ProvisionamentoResult, ProvisionamentoService } from '../provisionamento/provisionamento.service';
import type { MasterCreateInput, MasterLoginInput, MasterPasswordInput } from './master.schemas';
import { MasterRepository, publicMaster } from './master.repository';
import type { MasterContext, MasterPublic, MasterSession } from './master.types';
import type { MasterTokenService } from './master-token.service';

export type PlatformCompany = {
  id: string; codigoAcesso: string; razaoSocial: string; nomeFantasia: string;
  cnpj: string | null; ativo: boolean; usuarios: number; criadoEm: Date;
};

export class MasterService {
  private readonly repository: MasterRepository;

  constructor(
    private readonly pool: Pool,
    private readonly tokens: MasterTokenService,
    private readonly provisioning: ProvisionamentoService,
  ) {
    this.repository = new MasterRepository(pool);
  }

  async login(input: MasterLoginInput): Promise<MasterSession> {
    const master = await this.repository.findByUsername(this.pool, input.usuario);
    const passwordValid = master
      ? await argon2.verify(master.senhaHash, input.senha)
      : (await argon2.hash(input.senha), false);
    if (!master || !master.ativo || !passwordValid) {
      throw unauthorized('Usuario ou senha invalidos.');
    }
    await this.repository.touchAccess(master.administradorId);
    return this.session(publicMaster(master));
  }

  async getCurrent(context: MasterContext): Promise<MasterPublic> {
    return publicMaster(await this.requireActive(context.administradorId));
  }

  async changePassword(context: MasterContext, input: MasterPasswordInput): Promise<MasterSession> {
    const current = await this.requireActive(context.administradorId);
    if (!await argon2.verify(current.senhaHash, input.senhaAtual)) {
      throw unauthorized('A senha atual esta incorreta.');
    }
    const passwordHash = await argon2.hash(input.novaSenha, { type: argon2.argon2id });
    const updated = await withTransaction(this.pool, async (client) => {
      const master = await this.repository.changePassword(client, context.administradorId, passwordHash);
      await this.audit(client, context.administradorId, 'administrador_plataforma', context.administradorId, 'ALTERAR_SENHA', {
        usuario: master.usuario,
      });
      return master;
    });
    return this.session(publicMaster(updated));
  }

  async listCompanies(context: MasterContext): Promise<PlatformCompany[]> {
    await this.requireReady(context);
    const result = await this.pool.query<QueryResultRow>(`
      SELECT e.id, e.codigo_acesso::text, e.razao_social, e.nome_fantasia, e.cnpj, e.ativo,
             e.criado_em, COUNT(u.id)::integer AS usuarios
        FROM admtaxi.empresas e
        LEFT JOIN admtaxi.usuarios u ON u.empresa_id = e.id
       GROUP BY e.id
       ORDER BY e.nome_fantasia, e.id
    `);
    return result.rows.map((row) => ({
      id: row.id as string,
      codigoAcesso: row.codigo_acesso as string,
      razaoSocial: row.razao_social as string,
      nomeFantasia: row.nome_fantasia as string,
      cnpj: row.cnpj as string | null,
      ativo: row.ativo as boolean,
      usuarios: row.usuarios as number,
      criadoEm: row.criado_em as Date,
    }));
  }

  async createCompany(
    context: MasterContext,
    input: ProvisionamentoInput,
    metadata: ProvisionamentoMetadata,
  ): Promise<ProvisionamentoResult> {
    await this.requireReady(context);
    return this.provisioning.create(input, metadata, context.administradorId);
  }

  async listAdministrators(context: MasterContext): Promise<MasterPublic[]> {
    await this.requireReady(context);
    return this.repository.list();
  }

  async createAdministrator(
    context: MasterContext,
    input: MasterCreateInput,
    metadata: ProvisionamentoMetadata,
  ): Promise<MasterPublic> {
    await this.requireReady(context);
    const passwordHash = await argon2.hash(input.senha, { type: argon2.argon2id });
    return withTransaction(this.pool, async (client) => {
      const created = await this.repository.create(client, input, passwordHash);
      const result = publicMaster(created);
      await this.audit(client, context.administradorId, 'administrador_plataforma', created.administradorId, 'CRIAR', result, metadata);
      return result;
    });
  }

  async setAdministratorActive(
    context: MasterContext,
    id: string,
    active: boolean,
    metadata: ProvisionamentoMetadata,
  ): Promise<MasterPublic> {
    await this.requireReady(context);
    if (id === context.administradorId && !active) {
      throw conflict('Voce nao pode inativar o proprio usuario master.');
    }
    return withTransaction(this.pool, async (client) => {
      const updated = await this.repository.setActive(client, id, active);
      if (!updated) throw notFound('Administrador master');
      const result = publicMaster(updated);
      await this.audit(client, context.administradorId, 'administrador_plataforma', id, active ? 'REATIVAR' : 'INATIVAR', result, metadata);
      return result;
    });
  }

  private session(master: MasterPublic): MasterSession {
    return {
      accessToken: this.tokens.issue(master),
      tokenTipo: 'Bearer',
      expiraEmSegundos: this.tokens.expiresInSeconds,
      administrador: master,
    };
  }

  private async requireActive(id: string) {
    const master = await this.repository.findById(this.pool, id);
    if (!master?.ativo) throw unauthorized('Sessao master invalida ou expirada.');
    return master;
  }

  private async requireReady(context: MasterContext): Promise<void> {
    const master = await this.requireActive(context.administradorId);
    if (master.deveAlterarSenha) {
      throw conflict('Altere a senha inicial antes de continuar.');
    }
  }

  private async audit(
    executor: QueryExecutor,
    administratorId: string,
    entity: string,
    entityId: string,
    action: string,
    data: unknown,
    metadata: ProvisionamentoMetadata = { ip: null, userAgent: null },
  ): Promise<void> {
    await executor.query(`
      INSERT INTO admtaxi.auditoria_plataforma
        (administrador_id, entidade, entidade_id, acao, dados_novos, ip, user_agent)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
    `, [administratorId, entity, entityId, action, JSON.stringify(data), metadata.ip, metadata.userAgent]);
  }
}
