import argon2 from 'argon2';
import type { Pool } from 'pg';
import { withTransaction } from '../../db/pool';
import { unauthorized } from '../../shared/errors/app-error';
import { PgAuthRepository } from './auth.repository';
import type { TokenService } from './token-service';

type Candidate = {
  id: string; empresaId: string; codigoAcesso: string; nomeFantasia: string;
  perfil: 'GERENTE' | 'PORTARIA'; senhaHash: string; senhaVersao: number;
};

// These roles keep independent credentials per company, unlike shared personal accounts.
export class TenantLoginService {
  constructor(private readonly pool: Pool, private readonly tokens: TokenService, private readonly expires: number) {}

  async identify(input: { email: string; senha: string }) {
    const candidates = await this.pool.query<Candidate>(
      `SELECT u.id,u.empresa_id AS "empresaId",u.perfil,u.senha_hash AS "senhaHash",u.senha_versao AS "senhaVersao",
         e.codigo_acesso::text AS "codigoAcesso",e.nome_fantasia AS "nomeFantasia"
       FROM admtaxi.usuarios u JOIN admtaxi.empresas e ON e.id=u.empresa_id
       WHERE u.email=$1 AND u.perfil IN ('GERENTE','PORTARIA') AND u.ativo AND e.ativo
       ORDER BY e.nome_fantasia,e.id LIMIT 21`, [input.email]);
    if (candidates.rows.length > 20) throw unauthorized('E-mail ou senha invalidos. Utilize o acesso por empresa.');
    const matches: Candidate[] = [];
    for (const row of candidates.rows) if (await argon2.verify(row.senhaHash, input.senha)) matches.push(row);
    if (!matches.length) throw unauthorized('E-mail ou senha invalidos.');
    return {
      perfilSelecao: 'EMPRESA' as const,
      selecaoToken: this.tokens.issueTenantSelection(input.email, matches.map(row => ({ sub: row.id, versao: row.senhaVersao, perfil: row.perfil }))),
      empresas: matches.map(({ empresaId, codigoAcesso, nomeFantasia }) => ({ empresaId, codigoAcesso, nomeFantasia })),
    };
  }

  async select(input: { selecaoToken: string; empresaId: string }) {
    const selection = this.tokens.verifyTenantSelection(input.selecaoToken);
    const repository = new PgAuthRepository(this.pool);
    const session = await withTransaction(this.pool, async client => {
      const member = await client.query<{ id: string }>(
        `SELECT id FROM admtaxi.usuarios WHERE id=ANY($1::uuid[]) AND empresa_id=$2 FOR UPDATE`,
        [selection.usuarios.map(user => user.sub), input.empresaId]);
      const selected = selection.usuarios.find(user => user.sub === member.rows[0]?.id);
      if (!selected) throw unauthorized('Vinculo indisponivel. Entre novamente.');
      const user = await repository.findById({ usuarioId: selected.sub, empresaId: input.empresaId, perfil: selected.perfil }, client);
      if (!user?.ativo || !user.empresaAtiva || user.perfil !== selected.perfil || user.senhaVersao !== selected.versao
        || user.email.toLowerCase() !== selection.email.toLowerCase()) throw unauthorized('Acesso alterado. Entre novamente.');
      const issued = this.tokens.issueTokens(user);
      await client.query('INSERT INTO admtaxi.refresh_tokens(id,empresa_id,usuario_id,token_hash,expira_em) VALUES($1,$2,$3,$4,$5)',
        [issued.refreshRecord.id, user.empresaId, user.usuarioId, issued.refreshRecord.tokenHash, issued.refreshRecord.expiraEm]);
      return { accessToken: issued.accessToken, refreshToken: issued.refreshToken, tokenTipo: 'Bearer', expiraEmSegundos: this.expires,
        usuario: { usuarioId: user.usuarioId, empresaId: user.empresaId, nome: user.nome, email: user.email, perfil: user.perfil, deveAlterarSenha: user.deveAlterarSenha } };
    });
    await repository.updateLastAccess(session.usuario);
    return session;
  }
}
