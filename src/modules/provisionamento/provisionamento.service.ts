import argon2 from 'argon2';
import type { Pool, QueryResultRow } from 'pg';

import { withTransaction } from '../../db/pool';
import type { ProvisionamentoInput } from './provisionamento.schemas';

export type ProvisionamentoMetadata = { ip: string | null; userAgent: string | null };
export type ProvisionamentoResult = {
  empresa: { id: string; codigoAcesso: string; razaoSocial: string; nomeFantasia: string };
  gestor: { id: string; nome: string; email: string; perfil: 'GESTOR' };
};

type PasswordHasher = (password: string) => Promise<string>;

export class ProvisionamentoService {
  constructor(
    private readonly pool: Pool,
    private readonly hashPassword: PasswordHasher = (password) => argon2.hash(password, { type: argon2.argon2id }),
  ) {}

  async create(
    input: ProvisionamentoInput,
    metadata: ProvisionamentoMetadata,
    platformAdministratorId?: string,
  ): Promise<ProvisionamentoResult> {
    const passwordHash = await this.hashPassword(input.gestor.senha);
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('admtaxi_company_provisioning'))");
      const companyResult = await client.query<QueryResultRow>(`
        INSERT INTO admtaxi.empresas
          (codigo_acesso, razao_social, nome_fantasia, cnpj, telefone, email,
           cidade_padrao, estado_padrao, latitude_padrao, longitude_padrao)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id, codigo_acesso::text, razao_social, nome_fantasia
      `, [
        input.empresa.codigoAcesso,
        input.empresa.razaoSocial,
        input.empresa.nomeFantasia,
        input.empresa.cnpj ?? null,
        input.empresa.telefone ?? null,
        input.empresa.email ?? null,
        input.empresa.cidadePadrao,
        input.empresa.estadoPadrao,
        input.empresa.latitudePadrao,
        input.empresa.longitudePadrao,
      ]);
      const company = companyResult.rows[0];
      if (!company) throw new Error('Falha ao criar empresa.');

      const userResult = await client.query<QueryResultRow>(`
        INSERT INTO admtaxi.usuarios
          (empresa_id, nome, email, telefone, senha_hash, perfil)
        VALUES ($1, $2, $3, $4, $5, 'GESTOR')
        RETURNING id, nome, email::text, perfil::text
      `, [
        company.id,
        input.gestor.nome,
        input.gestor.email,
        input.gestor.telefone ?? null,
        passwordHash,
      ]);
      const manager = userResult.rows[0];
      if (!manager) throw new Error('Falha ao criar gestor.');

      const result: ProvisionamentoResult = {
        empresa: {
          id: company.id as string,
          codigoAcesso: company.codigo_acesso as string,
          razaoSocial: company.razao_social as string,
          nomeFantasia: company.nome_fantasia as string,
        },
        gestor: {
          id: manager.id as string,
          nome: manager.nome as string,
          email: manager.email as string,
          perfil: 'GESTOR',
        },
      };
      await client.query(`
        INSERT INTO admtaxi.auditoria
          (empresa_id, usuario_id, entidade, entidade_id, acao, dados_novos, ip, user_agent)
        VALUES ($1::uuid, $2::uuid, 'empresa', $3::text, 'PROVISIONAR', $4::jsonb, $5::inet, $6::text)
      `, [
        result.empresa.id,
        result.gestor.id,
        result.empresa.id,
        JSON.stringify(result),
        metadata.ip,
        metadata.userAgent,
      ]);
      if (platformAdministratorId) {
        await client.query(`
          INSERT INTO admtaxi.auditoria_plataforma
            (administrador_id, entidade, entidade_id, acao, dados_novos, ip, user_agent)
          VALUES ($1::uuid, 'empresa', $2::text, 'PROVISIONAR', $3::jsonb, $4::inet, $5::text)
        `, [platformAdministratorId, result.empresa.id, JSON.stringify(result), metadata.ip, metadata.userAgent]);
      }
      return result;
    });
  }
}
