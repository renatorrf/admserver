import argon2 from 'argon2';
import type { Pool } from 'pg';
import { withTransaction } from '../../db/pool';
import { conflict, unauthorized } from '../../shared/errors/app-error';
import { PgAuthRepository } from './auth.repository';
import type { TokenService } from './token-service';
import type { AuthResult } from './auth.types';

export class DriverLoginService {
  constructor(private readonly pool: Pool, private readonly tokens: TokenService, private readonly expires: number) {}

  async identify(input: { email: string; senha: string }): Promise<AuthResult | null> {
    const rows = (await this.pool.query<{ id: string; senha_hash: string }>(
      `SELECT c.id,c.senha_hash FROM admtaxi.contas_motorista c WHERE c.email=$1
       AND EXISTS(SELECT 1 FROM admtaxi.motorista_vinculos_ativos m WHERE m.conta_id=c.id) ORDER BY c.id LIMIT 21`, [input.email])).rows;
    if (rows.length > 20) throw unauthorized();
    const matches: typeof rows = [];
    for (const row of rows) if (await argon2.verify(row.senha_hash, input.senha)) matches.push(row);
    if (!matches.length) return null;
    if (matches.length !== 1) throw conflict('Existem contas antigas distintas para este motorista. Solicite a regularizacao ao administrador, sem criar outro cadastro.');
    const repository = new PgAuthRepository(this.pool);
    const result = await withTransaction(this.pool, async client => {
      const account = (await client.query<{ senha_hash: string }>('SELECT senha_hash FROM admtaxi.contas_motorista WHERE id=$1 FOR UPDATE', [matches[0]!.id])).rows[0];
      if (!account || account.senha_hash !== matches[0]!.senha_hash) throw unauthorized();
      const member = (await client.query<{ usuario_id: string; empresa_id: string }>(
        'SELECT usuario_id,empresa_id FROM admtaxi.motorista_vinculos_ativos WHERE conta_id=$1 ORDER BY usuario_id LIMIT 1', [matches[0]!.id])).rows[0];
      if (!member) throw unauthorized();
      const user = await repository.findById({ usuarioId: member.usuario_id, empresaId: member.empresa_id, perfil: 'PRESTADOR' }, client);
      if (!user?.ativo) throw unauthorized();
      const issued = this.tokens.issueTokens(user);
      await client.query('INSERT INTO admtaxi.refresh_tokens(id,empresa_id,usuario_id,token_hash,expira_em) VALUES($1,$2,$3,$4,$5)',
        [issued.refreshRecord.id, user.empresaId, user.usuarioId, issued.refreshRecord.tokenHash, issued.refreshRecord.expiraEm]);
      const usuario = { usuarioId: user.usuarioId, empresaId: user.empresaId, contaMotoristaId: user.contaMotoristaId,
        nome: user.nome, email: user.email, perfil: user.perfil, deveAlterarSenha: user.deveAlterarSenha };
      return { accessToken: issued.accessToken, refreshToken: issued.refreshToken, tokenTipo: 'Bearer' as const, expiraEmSegundos: this.expires, usuario };
    });
    await repository.updateLastAccess(result.usuario);
    return result;
  }
}
