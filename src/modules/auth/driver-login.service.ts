import argon2 from 'argon2';
import type { Pool } from 'pg';
import { conflict, unauthorized } from '../../shared/errors/app-error';
import type { TokenService } from './token-service';

export class DriverLoginService {
  constructor(private readonly pool: Pool, private readonly tokens: TokenService, _expires: number) {}

  async identify(input: { email: string; senha: string }) {
    const rows = (await this.pool.query<{ id: string; senha_hash: string; senha_versao: number }>(
      `SELECT c.id,c.senha_hash,c.senha_versao FROM admtaxi.contas_motorista c WHERE c.email=$1
       AND EXISTS(SELECT 1 FROM admtaxi.motorista_vinculos_ativos m WHERE m.conta_id=c.id) ORDER BY c.id LIMIT 21`, [input.email])).rows;
    if (rows.length > 20) throw unauthorized();
    const matches: typeof rows = [];
    for (const row of rows) if (await argon2.verify(row.senha_hash, input.senha)) matches.push(row);
    if (!matches.length) return null;
    if (matches.length !== 1) throw conflict('Existem contas antigas distintas para este motorista. Solicite a regularizacao ao administrador, sem criar outro cadastro.');
    const account = matches[0]!;
    const members = (await this.pool.query<{ id: string; empresaId: string; codigoAcesso: string; nomeFantasia: string }>(
      `SELECT m.usuario_id AS id,m.empresa_id AS "empresaId",e.codigo_acesso::text AS "codigoAcesso",e.nome_fantasia AS "nomeFantasia"
       FROM admtaxi.motorista_vinculos_ativos m JOIN admtaxi.empresas e ON e.id=m.empresa_id
       WHERE m.conta_id=$1 ORDER BY e.nome_fantasia,e.id LIMIT 21`, [account.id])).rows;
    if (!members.length || members.length > 20) throw unauthorized('Acesse informando a empresa.');
    return {
      perfilSelecao: 'EMPRESA' as const,
      selecaoToken: this.tokens.issueTenantSelection(input.email, members.map(row => ({ sub: row.id, versao: account.senha_versao, perfil: 'PRESTADOR' }))),
      empresas: members.map(({ empresaId, codigoAcesso, nomeFantasia }) => ({ empresaId, codigoAcesso, nomeFantasia })),
    };
  }
}
