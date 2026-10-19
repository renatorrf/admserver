import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { MailConfig } from '../../config/env';
import { withTransaction } from '../../db/pool';
import { AppError, unavailable } from '../../shared/errors/app-error';
import type { PasswordMailer } from '../auth/password-mailer';
import { hashResetToken } from '../auth/password.service';

export const masterRecoveryMessage = 'Se houver um administrador ativo com este email, voce recebera um link de recuperacao.';
const invalidLink = () => new AppError(400, 'LINK_SENHA_INVALIDO', 'Este link e invalido, expirou ou ja foi utilizado. Solicite outro link.');

export class MasterRecoveryService {
  constructor(private readonly pool: Pool, private readonly logger: Logger,
    private readonly mail?: MailConfig, private readonly mailer?: PasswordMailer) {}

  async requestReset(input: { email: string }): Promise<void> {
    if (!this.mail?.masterResetUrl || !this.mailer) throw unavailable('Recuperacao master por email ainda nao configurada. Contate o administrador.');
    const token = randomBytes(32).toString('hex'), hash = hashResetToken(token);
    const recipient = await withTransaction(this.pool, async client => {
      const result = await client.query<{ id: string; email: string }>(
        'SELECT id,email::text FROM admtaxi.administradores_plataforma WHERE email=$1 AND ativo FOR UPDATE', [input.email]);
      const master = result.rows[0];
      if (!master) return null;
      const attempts = await client.query<{ total: string; recente: boolean }>(
        `SELECT COUNT(*)::text AS total, COALESCE(MAX(criado_em)>CURRENT_TIMESTAMP-INTERVAL '60 seconds',FALSE) AS recente
         FROM admtaxi.recuperacoes_senha_master WHERE administrador_id=$1 AND criado_em>CURRENT_TIMESTAMP-INTERVAL '1 hour'`, [master.id]);
      if (attempts.rows[0]?.recente || Number(attempts.rows[0]?.total) >= 5) return null;
      await client.query(`UPDATE admtaxi.recuperacoes_senha_master SET usado_em=COALESCE(usado_em,CURRENT_TIMESTAMP)
        WHERE administrador_id=$1`, [master.id]);
      await client.query(`INSERT INTO admtaxi.recuperacoes_senha_master(token_hash,administrador_id,expira_em)
        VALUES($1,$2,CURRENT_TIMESTAMP+$3::int*INTERVAL '1 minute')`, [hash,master.id,this.mail!.resetTtlMinutes]);
      return master.email;
    });
    if (!recipient) return;
    const url = new URL(this.mail.masterResetUrl);
    url.hash = `token=${token}`;
    try { await this.mailer.send(recipient,url.toString(),this.mail.resetTtlMinutes); }
    catch {
      await this.pool.query('UPDATE admtaxi.recuperacoes_senha_master SET usado_em=CURRENT_TIMESTAMP WHERE token_hash=$1',[hash]);
      this.logger.warn({ evento:'RECUPERACAO_MASTER_EMAIL_FALHOU' },'Falha na recuperacao master; verifique o SMTP.');
    }
  }

  async reset(input: { token: string; novaSenha: string }): Promise<void> {
    const hash = hashResetToken(input.token), passwordHash = await argon2.hash(input.novaSenha);
    await withTransaction(this.pool,async client => {
      const lookup = await client.query<{ administrador_id: string }>(
        'SELECT administrador_id FROM admtaxi.recuperacoes_senha_master WHERE token_hash=$1',[hash]);
      const id = lookup.rows[0]?.administrador_id;
      if (!id) throw invalidLink();
      // Account lock serializes reset, email change and inactivation before token consumption.
      const account = await client.query<{ senha_hash: string }>(
        'SELECT senha_hash FROM admtaxi.administradores_plataforma WHERE id=$1 AND ativo FOR UPDATE',[id]);
      const valid = await client.query(`SELECT 1 FROM admtaxi.recuperacoes_senha_master
        WHERE token_hash=$1 AND usado_em IS NULL AND expira_em>CURRENT_TIMESTAMP`,[hash]);
      if (!account.rows[0] || !valid.rowCount) throw invalidLink();
      if (await argon2.verify(account.rows[0].senha_hash,input.novaSenha)) throw new AppError(422,'SENHA_REPETIDA','Escolha uma senha diferente da atual.');
      await client.query('UPDATE admtaxi.administradores_plataforma SET senha_hash=$2,deve_alterar_senha=FALSE WHERE id=$1',[id,passwordHash]);
      await client.query(`INSERT INTO admtaxi.auditoria_plataforma(administrador_id,entidade,entidade_id,acao,dados_novos)
        VALUES($1::uuid,'administrador_plataforma',$1::text,'RECUPERAR_SENHA','{"senhaAlterada":true}'::jsonb)`,[id]);
    });
  }
}
