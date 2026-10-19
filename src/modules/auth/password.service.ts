import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { Logger } from 'pino';
import type { Pool } from 'pg';
import type { MailConfig } from '../../config/env';
import { withTransaction } from '../../db/pool';
import { AppError, unavailable, unauthorized } from '../../shared/errors/app-error';
import { AuditRepository } from '../auditoria/audit.repository';
import type { AuthContext } from './auth.types';
import type { PasswordMailer } from './password-mailer';
import { lockCredentials, setPassword } from './account-credentials';

const invalidLink = () => new AppError(400, 'LINK_SENHA_INVALIDO', 'Este link e invalido, expirou ou ja foi utilizado. Solicite outro link.');
export const recoveryMessage = 'Se houver uma conta ativa para os dados informados, voce recebera um link de recuperacao.';
export const hashResetToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export class PasswordService {
  constructor(private readonly database: Pool, private readonly logger: Logger,
    private readonly mail?: MailConfig, private readonly mailer?: PasswordMailer) {}

  async requestReset(input: { empresa?: string; email: string }): Promise<void> {
    if (!this.mail || !this.mailer) throw unavailable('Recuperacao por email ainda nao configurada. Contate o administrador.');
    const token = randomBytes(32).toString('hex');
    const hash = hashResetToken(token);
    const email = await withTransaction(this.database, async client => {
      const result = await client.query<{ id: string; empresa_id: string; email: string }>(
        `SELECT u.id,u.empresa_id,u.email::text FROM admtaxi.usuarios_autenticacao u
         JOIN admtaxi.empresas e ON e.id=u.empresa_id
         WHERE ($1::text IS NULL OR e.codigo_acesso=$1) AND u.email=$2 AND u.ativo AND e.ativo
           AND ($1::text IS NOT NULL OR u.conta_gestor_id IS NOT NULL)
         ORDER BY u.id`, [input.empresa ?? null, input.email]);
      const user = result.rows[0];
      if (!user) return null;
      const account = await lockCredentials(client, user.id, user.empresa_id);
      if (!input.empresa) {
        const identities = await client.query('SELECT id FROM admtaxi.contas_gestor WHERE email=$1', [input.email]);
        if (identities.rowCount !== 1) return null;
      }
      const attempts = await client.query<{ total: string; recente: boolean }>(
        `SELECT COUNT(*)::text AS total, COALESCE(MAX(criado_em) > CURRENT_TIMESTAMP - INTERVAL '60 seconds', FALSE) AS recente
         FROM admtaxi.recuperacoes_senha WHERE usuario_id IN
           (SELECT id FROM admtaxi.usuarios WHERE id=$1 OR ($2::uuid IS NOT NULL AND conta_gestor_id=$2))
         AND criado_em > CURRENT_TIMESTAMP - INTERVAL '1 hour'`, [user.id, account]);
      if (attempts.rows[0]?.recente || Number(attempts.rows[0]?.total) >= 5) return null;
      await client.query(`UPDATE admtaxi.recuperacoes_senha SET usado_em=COALESCE(usado_em,CURRENT_TIMESTAMP)
        WHERE usuario_id IN (SELECT id FROM admtaxi.usuarios WHERE id=$1 OR ($2::uuid IS NOT NULL AND conta_gestor_id=$2))`, [user.id, account]);
      await client.query(`INSERT INTO admtaxi.recuperacoes_senha(token_hash,empresa_id,usuario_id,expira_em)
        VALUES($1,$2,$3,CURRENT_TIMESTAMP + $4::int * INTERVAL '1 minute')`,
      [hash, user.empresa_id, user.id, this.mail!.resetTtlMinutes]);
      return user.email;
    });
    if (!email) return;
    const url = new URL(this.mail.resetUrl);
    // A fragment keeps the secret out of Hosting/access logs and Referer headers.
    url.hash = `token=${token}`;
    try {
      await this.mailer.send(email, url.toString(), this.mail.resetTtlMinutes);
    } catch {
      await this.database.query('UPDATE admtaxi.recuperacoes_senha SET usado_em=CURRENT_TIMESTAMP WHERE token_hash=$1', [hash]);
      this.logger.warn({ evento: 'RECUPERACAO_EMAIL_FALHOU' }, 'Falha no envio de recuperacao; verifique o SMTP.');
      // Same public response for unknown accounts, throttling and SMTP delivery failure.
    }
  }

  async reset(input: { token: string; novaSenha: string }): Promise<void> {
    const hash = hashResetToken(input.token);
    const passwordHash = await argon2.hash(input.novaSenha);
    await withTransaction(this.database, async client => {
      const lookup = await client.query<{ usuario_id: string; empresa_id: string }>(
        'SELECT usuario_id,empresa_id FROM admtaxi.recuperacoes_senha WHERE token_hash=$1', [hash]);
      const target = lookup.rows[0];
      if (!target) throw invalidLink();
      const account = await lockCredentials(client, target.usuario_id, target.empresa_id);
      const user = await client.query<{ id: string; senha_hash: string }>(
        `SELECT u.id,u.senha_hash FROM admtaxi.usuarios_autenticacao u JOIN admtaxi.empresas e ON e.id=u.empresa_id
         WHERE u.id=$1 AND u.empresa_id=$2 AND u.ativo AND e.ativo`,
        [target.usuario_id, target.empresa_id]);
      const valid = await client.query(`SELECT 1 FROM admtaxi.recuperacoes_senha
        WHERE token_hash=$1 AND usado_em IS NULL AND expira_em > CURRENT_TIMESTAMP`, [hash]);
      if (!user.rows[0] || !valid.rowCount) throw invalidLink();
      if (await argon2.verify(user.rows[0].senha_hash, input.novaSenha)) {
        throw new AppError(422, 'SENHA_REPETIDA', 'Escolha uma senha diferente da atual.');
      }
      await setPassword(client, account, target.usuario_id, target.empresa_id, passwordHash);
      await new AuditRepository(this.database).record(client, {
        empresaId: target.empresa_id, usuarioId: target.usuario_id, entidade: 'usuario',
        entidadeId: target.usuario_id, acao: 'RECUPERAR_SENHA', dadosNovos: { senhaAlterada: true },
      });
    });
  }

  async change(auth: AuthContext, input: { senhaAtual: string; novaSenha: string }): Promise<void> {
    const passwordHash = await argon2.hash(input.novaSenha);
    await withTransaction(this.database, async client => {
      const account = await lockCredentials(client, auth.usuarioId, auth.empresaId);
      const result = await client.query<{ senha_hash: string; senha_versao: number }>(
        `SELECT u.senha_hash,u.senha_versao FROM admtaxi.usuarios_autenticacao u JOIN admtaxi.empresas e ON e.id=u.empresa_id
         WHERE u.id=$1 AND u.empresa_id=$2 AND u.ativo AND e.ativo`,
        [auth.usuarioId, auth.empresaId]);
      const user = result.rows[0];
      if (!user || user.senha_versao !== (auth.senhaVersao ?? 0)) throw unauthorized();
      if (!await argon2.verify(user.senha_hash, input.senhaAtual)) {
        throw new AppError(422, 'SENHA_ATUAL_INVALIDA', 'A senha atual nao confere.');
      }
      if (input.senhaAtual === input.novaSenha) throw new AppError(422, 'SENHA_REPETIDA', 'Escolha uma senha diferente da atual.');
      await setPassword(client, account, auth.usuarioId, auth.empresaId, passwordHash);
      await new AuditRepository(this.database).record(client, {
        empresaId: auth.empresaId, usuarioId: auth.usuarioId, entidade: 'usuario', entidadeId: auth.usuarioId,
        acao: 'ALTERAR_SENHA', dadosNovos: { senhaAlterada: true },
      });
    });
  }
}
