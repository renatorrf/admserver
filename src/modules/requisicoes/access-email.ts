import { randomBytes } from 'node:crypto';
import type { MailConfig } from '../../config/env';
import { withTransaction, type Database } from '../../db/pool';
import { lockCredentials } from '../auth/account-credentials';
import { hashResetToken } from '../auth/password.service';

export async function prepareAccessEmail(database: Database,
  row: { evento:string; empresa_id:string; destinatario:string; corpo:string },
  config?: Pick<MailConfig,'resetUrl'|'resetTtlMinutes'>): Promise<{text:string; tokenHash?:string}> {
  if (!config) throw new Error('PASSWORD_RESET_URL_NOT_CONFIGURED');
  const userId=row.evento.split(':')[1]!;
  const login=new URL('/login',config.resetUrl).toString();
  if (row.evento.startsWith('ACESSO_EXISTENTE:')) return {text:`${row.corpo}\nAcesse: ${login}`};
  return withTransaction(database,async client=>{
    await lockCredentials(client,userId,row.empresa_id);
    const user=(await client.query<{deve_alterar_senha:boolean}>(`SELECT u.deve_alterar_senha
      FROM admtaxi.usuarios_autenticacao u JOIN admtaxi.empresas e ON e.id=u.empresa_id
      WHERE u.empresa_id=$1 AND u.id=$2 AND u.email=$3 AND u.ativo AND e.ativo AND u.perfil='FUNCIONARIO'`,
      [row.empresa_id,userId,row.destinatario])).rows[0];
    if (!user) throw new Error('ACCESS_EMAIL_INELIGIBLE');
    if (!user.deve_alterar_senha) return {text:`${row.corpo}\nSua senha ja foi definida. Utilize sua senha atual em ${login}`};
    const token=randomBytes(32).toString('hex');const tokenHash=hashResetToken(token);
    await client.query(`INSERT INTO admtaxi.recuperacoes_senha(token_hash,empresa_id,usuario_id,expira_em)
      VALUES($1,$2,$3,CURRENT_TIMESTAMP+$4::int*INTERVAL '1 minute')`,[tokenHash,row.empresa_id,userId,config.resetTtlMinutes]);
    const url=new URL(config.resetUrl);url.hash=`token=${token}`;
    return {tokenHash,text:`${row.corpo}\nDefinir senha: ${url.toString()}\nLink de uso unico, valido por ${config.resetTtlMinutes} minutos.\nSe expirar, use Esqueci minha senha em ${login}`};
  });
}
