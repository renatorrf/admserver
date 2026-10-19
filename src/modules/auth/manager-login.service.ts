import argon2 from 'argon2';
import type { Pool } from 'pg';
import { withTransaction } from '../../db/pool';
import { conflict, unauthorized } from '../../shared/errors/app-error';
import { PgAuthRepository } from './auth.repository';
import type { TokenService } from './token-service';

const dummy = '$argon2id$v=19$m=65536,p=4,t=3$xEaSttu1YczR4JkEnk+M5Q$9N7orLZXeVYLd1tjt6hgesNcwaDXMCorYIyDRzu2pTk';
export class ManagerLoginService {
  constructor(private readonly pool: Pool, private readonly tokens: TokenService, private readonly expires: number) {}

  async identify(input: { email: string; senha: string }) {
    const result = await this.pool.query<{ id: string; senha_hash: string; senha_versao: number }>(
      `SELECT c.id,c.senha_hash,c.senha_versao FROM admtaxi.contas_gestor c WHERE c.email=$1
       AND EXISTS(SELECT 1 FROM admtaxi.usuarios u JOIN admtaxi.empresas e ON e.id=u.empresa_id
         WHERE u.conta_gestor_id=c.id AND u.ativo AND e.ativo AND u.perfil='GESTOR') ORDER BY c.id LIMIT 21`, [input.email]);
    if (result.rows.length > 20) throw unauthorized('E-mail ou senha invalidos.');
    const matches = [];
    if (!result.rows.length) await argon2.verify(dummy, input.senha);
    for (const row of result.rows) if (await argon2.verify(row.senha_hash, input.senha)) matches.push(row);
    if (!matches.length) throw unauthorized('E-mail ou senha invalidos.');
    if (matches.length !== 1) throw conflict('Existem contas antigas distintas com essas credenciais. Acesse por empresa e solicite a regularizacao ao administrador master.');
    const account = matches[0]!;
    const companies = await this.pool.query<{ empresaId: string; codigoAcesso: string; nomeFantasia: string }>(
      `SELECT e.id AS "empresaId",e.codigo_acesso::text AS "codigoAcesso",e.nome_fantasia AS "nomeFantasia"
       FROM admtaxi.usuarios u JOIN admtaxi.empresas e ON e.id=u.empresa_id
       WHERE u.conta_gestor_id=$1 AND u.ativo AND e.ativo AND u.perfil='GESTOR' ORDER BY e.nome_fantasia,e.id`, [account.id]);
    return { selecaoToken: this.tokens.issueCompanySelection(account.id, account.senha_versao), empresas: companies.rows };
  }

  async select(input: { selecaoToken: string; empresaId: string }) {
    const selection = this.tokens.verifyCompanySelection(input.selecaoToken);
    const session = await withTransaction(this.pool, async client => {
      const account = await client.query('SELECT id FROM admtaxi.contas_gestor WHERE id=$1 AND senha_versao=$2 FOR UPDATE', [selection.sub, selection.versao]);
      if (!account.rowCount) throw unauthorized('Sessao invalida. Entre novamente.');
      const member = await client.query<{ id: string }>(
        `SELECT u.id FROM admtaxi.usuarios u JOIN admtaxi.empresas e ON e.id=u.empresa_id
         WHERE u.conta_gestor_id=$1 AND u.empresa_id=$2 AND u.perfil='GESTOR' AND u.ativo AND e.ativo`, [selection.sub, input.empresaId]);
      if (!member.rows[0]) throw unauthorized('Vinculo indisponivel. Entre novamente.');
      const repository = new PgAuthRepository(this.pool);
      const user = await repository.findById({ usuarioId: member.rows[0].id, empresaId: input.empresaId, perfil: 'GESTOR' }, client);
      if (!user?.ativo || !user.empresaAtiva || user.senhaVersao !== selection.versao) throw unauthorized();
      const issued = this.tokens.issueTokens(user);
      await client.query('INSERT INTO admtaxi.refresh_tokens(id,empresa_id,usuario_id,token_hash,expira_em) VALUES($1,$2,$3,$4,$5)',
        [issued.refreshRecord.id, user.empresaId, user.usuarioId, issued.refreshRecord.tokenHash, issued.refreshRecord.expiraEm]);
      return { accessToken: issued.accessToken, refreshToken: issued.refreshToken, tokenTipo: 'Bearer', expiraEmSegundos: this.expires,
        usuario: { usuarioId: user.usuarioId, empresaId: user.empresaId, nome: user.nome, email: user.email, perfil: user.perfil, deveAlterarSenha: user.deveAlterarSenha } };
    });
    // Do not take a membership update lock while holding its account lock.
    await new PgAuthRepository(this.pool).updateLastAccess(session.usuario);
    return session;
  }
}
