import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { QueryExecutor } from '../../db/pool';
import { conflict } from '../../shared/errors/app-error';

// Called only inside the authorized conference transaction. Never reset an existing account.
export async function completeGuestAccess(client: QueryExecutor, empresaId: string, requestId: string,
  employee: { id: string; usuario_id?: unknown; email?: unknown }, guest: { nome: string; telefone: string; email?: string }) {
  if (!guest.email) return;
  const email = guest.email.toLowerCase();
  if (typeof employee.email==='string' && employee.email.toLowerCase()!==email)
    throw conflict('O funcionario ja possui outro e-mail cadastrado. Solicite a revisao ao gestor.');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('conta_funcionario:' || $1))", [email]);
  const users = await client.query<{ id:string; ativo:boolean; perfil:string; mesma_pessoa:boolean }>(
    `SELECT u.id,u.ativo,u.perfil,
      (admtaxi.normalizar_cadastro(u.nome,'nome')=admtaxi.normalizar_cadastro($3,'nome')
       AND admtaxi.normalizar_cadastro(u.telefone,'telefone')=$4) AS mesma_pessoa
     FROM admtaxi.usuarios u WHERE u.empresa_id=$1 AND u.email=$2 FOR UPDATE`,
    [empresaId,email,guest.nome,guest.telefone]);
  const found=users.rows[0];
  if (found && (!found.ativo || found.perfil!=='FUNCIONARIO' || !found.mesma_pessoa
    || (employee.usuario_id && employee.usuario_id!==found.id)))
    throw conflict('Este e-mail pertence a outro acesso ou esta inativo. Solicite a revisao ao gestor.');
  if (employee.usuario_id && !found)
    throw conflict('O funcionario ja possui acesso com outro e-mail. Solicite a revisao ao gestor.');
  if (found && (await client.query(`SELECT id FROM admtaxi.funcionarios
    WHERE empresa_id=$1 AND usuario_id=$2 AND id<>$3`,[empresaId,found.id,employee.id])).rowCount)
    throw conflict('Este acesso ja pertence a outro cadastro. Selecione o funcionario existente.');
  if (!found && (await client.query('SELECT id FROM admtaxi.contas_funcionario WHERE email=$1',[email])).rowCount)
    throw conflict('Ja existe uma conta com este e-mail em outra empresa. O gestor deve vincular o funcionario existente.');
  let userId=found?.id;
  if (!userId) {
    const hash=await argon2.hash(randomBytes(32).toString('hex'));
    userId=(await client.query<{id:string}>(`INSERT INTO admtaxi.usuarios
      (empresa_id,nome,email,telefone,senha_hash,perfil,ativo,deve_alterar_senha)
      VALUES($1,$2,$3,$4,$5,'FUNCIONARIO',TRUE,TRUE) RETURNING id`,
      [empresaId,guest.nome,email,guest.telefone,hash])).rows[0]!.id;
  }
  await client.query(`UPDATE admtaxi.funcionarios SET usuario_id=$3,email=$4
    WHERE empresa_id=$1 AND id=$2`,[empresaId,employee.id,userId,email]);
  const company=(await client.query<{nome:string}>(
    'SELECT COALESCE(nome_fantasia,razao_social) AS nome FROM admtaxi.empresas WHERE id=$1',[empresaId])).rows[0]!;
  const text=`Ola, ${guest.nome}.\n\nSeu cadastro no ADM Taxi foi concluido.\nEmpresa: ${company.nome}\nLogin: ${email}\n\n`
    +(found ? 'Utilize sua senha atual. Ela nao foi alterada.\n' : 'Seu primeiro acesso esta disponivel.\n');
  await client.query(`INSERT INTO admtaxi.emails_viagem(empresa_id,requisicao_id,evento,destinatario,assunto,corpo)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(requisicao_id,evento,destinatario) DO NOTHING`,
    [empresaId,requestId,`${found?'ACESSO_EXISTENTE':'PRIMEIRO_ACESSO'}:${userId}`,email,'Seu acesso ao ADM Taxi',text]);
}
