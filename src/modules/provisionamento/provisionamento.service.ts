import argon2 from 'argon2';
import type { Pool, QueryResultRow } from 'pg';

import { withTransaction } from '../../db/pool';
import type { MasterCompanyInput } from './provisionamento.schemas';
import { forbidden, notFound } from '../../shared/errors/app-error';

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
    input: MasterCompanyInput,
    metadata: ProvisionamentoMetadata,
    platformAdministratorId?: string,
  ): Promise<ProvisionamentoResult> {
    if ('contaId' in input.gestor && !platformAdministratorId) throw forbidden();
    const passwordHash = 'senha' in input.gestor ? await this.hashPassword(input.gestor.senha) : null;
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('admtaxi_company_provisioning'))");
      let existing: { id: string; nome: string; email: string; telefone: string | null; senha_hash: string } | undefined;
      if ('contaId' in input.gestor) {
        const found = await client.query<{ id: string; nome: string; email: string; telefone: string | null; senha_hash: string }>(
          `SELECT c.id,c.nome,c.email::text,c.telefone,c.senha_hash FROM admtaxi.contas_gestor c WHERE c.id=$1
           AND EXISTS(SELECT 1 FROM admtaxi.usuarios u JOIN admtaxi.empresas e ON e.id=u.empresa_id
             WHERE u.conta_gestor_id=c.id AND u.ativo AND e.ativo AND u.perfil='GESTOR') FOR UPDATE OF c`, [input.gestor.contaId]);
        existing = found.rows[0];
        if (!existing) throw notFound('Gestor ativo');
      }
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
          (empresa_id, nome, email, telefone, senha_hash, perfil, conta_gestor_id)
        VALUES ($1, $2, $3, $4, $5, 'GESTOR', $6)
        RETURNING id, nome, email::text, perfil::text
      `, [
        company.id,
        existing?.nome ?? ('nome' in input.gestor ? input.gestor.nome : ''),
        existing?.email ?? ('email' in input.gestor ? input.gestor.email : ''),
        existing?.telefone ?? ('telefone' in input.gestor ? input.gestor.telefone ?? null : null),
        existing?.senha_hash ?? passwordHash,
        existing?.id ?? null,
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
