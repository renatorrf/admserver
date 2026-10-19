import argon2 from 'argon2';
import type { Pool } from 'pg';
import { withTransaction } from '../../db/pool';
import { conflict, unauthorized } from '../../shared/errors/app-error';
import { PgAuthRepository } from './auth.repository';
import type { TokenService } from './token-service';

export class EmployeeLoginService {
  constructor(private readonly pool: Pool, private readonly tokens: TokenService, private readonly expires: number) {}

  async identify(input: { email: string; senha: string }) {
    const result = await this.pool.query<{ id: string; senha_hash: string; senha_versao: number }>(
      `SELECT c.id,c.senha_hash,c.senha_versao FROM admtaxi.contas_funcionario c WHERE c.email=$1
       AND EXISTS(SELECT 1 FROM admtaxi.usuarios u JOIN admtaxi.empresas e ON e.id=u.empresa_id
         JOIN admtaxi.funcionarios f ON f.usuario_id=u.id AND f.empresa_id=u.empresa_id
         WHERE u.conta_funcionario_id=c.id AND u.perfil='FUNCIONARIO' AND u.ativo AND e.ativo AND f.ativo)
       ORDER BY c.id LIMIT 21`, [input.email]);
    if (result.rows.length > 20) throw unauthorized('E-mail ou senha invalidos.');
    const matches = [];
    for (const row of result.rows) if (await argon2.verify(row.senha_hash, input.senha)) matches.push(row);
    if (!matches.length) throw unauthorized('E-mail ou senha invalidos.');
    if (matches.length !== 1) throw conflict('Existem contas antigas distintas com essas credenciais. Acesse por empresa e solicite a regularizacao ao administrador.');
    const account = matches[0]!;
    const companies = await this.pool.query<{ empresaId: string; codigoAcesso: string; nomeFantasia: string }>(
      `SELECT e.id AS "empresaId",e.codigo_acesso::text AS "codigoAcesso",e.nome_fantasia AS "nomeFantasia"
       FROM admtaxi.usuarios u JOIN admtaxi.empresas e ON e.id=u.empresa_id
       JOIN admtaxi.funcionarios f ON f.usuario_id=u.id AND f.empresa_id=u.empresa_id
       WHERE u.conta_funcionario_id=$1 AND u.perfil='FUNCIONARIO' AND u.ativo AND e.ativo AND f.ativo
       ORDER BY e.nome_fantasia,e.id`, [account.id]);
    return {
      perfilSelecao: 'FUNCIONARIO' as const,
      selecaoToken: this.tokens.issueEmployeeSelection(account.id, account.senha_versao),
      empresas: companies.rows,
    };
  }

  async select(input: { selecaoToken: string; empresaId: string }) {
    const selection = this.tokens.verifyEmployeeSelection(input.selecaoToken);
    const repository = new PgAuthRepository(this.pool);
    const session = await withTransaction(this.pool, async client => {
      const account = await client.query('SELECT id FROM admtaxi.contas_funcionario WHERE id=$1 AND senha_versao=$2 FOR UPDATE', [selection.sub, selection.versao]);
      if (!account.rowCount) throw unauthorized('Sessao invalida. Entre novamente.');
      const member = (await client.query<{ id: string }>(
        `SELECT u.id FROM admtaxi.usuarios u JOIN admtaxi.empresas e ON e.id=u.empresa_id
         JOIN admtaxi.funcionarios f ON f.usuario_id=u.id AND f.empresa_id=u.empresa_id
         WHERE u.conta_funcionario_id=$1 AND u.empresa_id=$2 AND u.perfil='FUNCIONARIO' AND u.ativo AND e.ativo AND f.ativo`,
        [selection.sub, input.empresaId])).rows[0];
      if (!member) throw unauthorized('Vinculo indisponivel. Entre novamente.');
      const user = await repository.findById({ usuarioId: member.id, empresaId: input.empresaId, perfil: 'FUNCIONARIO' }, client);
      if (!user?.ativo || !user.empresaAtiva || user.perfil !== 'FUNCIONARIO'
        || user.senhaVersao !== selection.versao) {
        throw unauthorized('Sessao invalida. Entre novamente.');
      }
      const issued = this.tokens.issueTokens(user);
      await client.query('INSERT INTO admtaxi.refresh_tokens(id,empresa_id,usuario_id,token_hash,expira_em) VALUES($1,$2,$3,$4,$5)',
        [issued.refreshRecord.id, user.empresaId, user.usuarioId, issued.refreshRecord.tokenHash, issued.refreshRecord.expiraEm]);
      return { accessToken: issued.accessToken, refreshToken: issued.refreshToken, tokenTipo: 'Bearer' as const, expiraEmSegundos: this.expires,
        usuario: { usuarioId: user.usuarioId, empresaId: user.empresaId, nome: user.nome, email: user.email, perfil: user.perfil, deveAlterarSenha: user.deveAlterarSenha } };
    });
    await repository.updateLastAccess(session.usuario);
    return session;
  }
}
