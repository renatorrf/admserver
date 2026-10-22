import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Message } from 'firebase-admin/messaging';
import { FcmService } from '../src/modules/notificacoes/fcm.service';
import type { AuthContext } from '../src/modules/auth/auth.types';

export async function testFcm(pool: Pool, ok: (label:string)=>void) {
  const companies = [randomUUID(),randomUUID(),randomUUID()], users = companies.map(()=>randomUUID());
  let account: string | undefined;
  for (let i=0;i<3;i++) {
    await pool.query('INSERT INTO admtaxi.empresas(id,codigo_acesso,razao_social,nome_fantasia) VALUES($1,$2::text,$2::text,$2::text)', [companies[i],`FCM-${i}-${randomUUID()}`]);
    const inserted = await pool.query(`INSERT INTO admtaxi.usuarios(id,empresa_id,nome,email,senha_hash,perfil,deve_alterar_senha,conta_motorista_id)
      VALUES($1,$2,'Motorista sintetico',$3,'synthetic','PRESTADOR',FALSE,$4) RETURNING conta_motorista_id`,
    [users[i],companies[i],i===1 ? 'fcm-driver@example.test' : i===0 ? 'fcm-driver@example.test' : 'fcm-other@example.test',i===1 ? account : null]);
    if(i===0) account=inserted.rows[0].conta_motorista_id;
    await pool.query("INSERT INTO admtaxi.prestadores(empresa_id,usuario_id,nome,telefone,cpf,numero_cnh,validade_cnh) VALUES($1,$2,'Motorista sintetico','34999990000','52998224725','12345678901','2030-01-01')",[companies[i],users[i]]);
  }
  const auth: AuthContext = {empresaId:companies[0]!,usuarioId:users[0]!,perfil:'PRESTADOR',contaMotoristaId:account,senhaVersao:0};
  const messages: Message[] = []; let fail: string | undefined;
  const sender = {send: async (m:Message) => { if(fail) throw {code:fail}; messages.push(m); return 'message-id'; }};
  const service = new FcmService(pool,{warn:()=>undefined},sender);
  const registration = {token:'synthetic_fcm_token_123456789',instalacaoId:randomUUID(),vinculoId:randomUUID()};
  await service.register(auth,registration);
  assert.equal((await service.status(auth,registration.vinculoId)).ativo,true);
  const notify = async (i:number) => (await pool.query(`INSERT INTO admtaxi.notificacoes_push(empresa_id,usuario_id,evento,titulo,corpo,chave_deduplicacao)
    VALUES($1,$2,'CORRIDA_OFERTADA','Nova corrida','Abra o app',$3) RETURNING id`,[companies[i],users[i],randomUUID()])).rows[0].id as string;
  const first=await notify(0),shared=await notify(1),foreign=await notify(2);
  assert.equal((await pool.query('SELECT count(*) FROM admtaxi.fcm_entregas WHERE notificacao_id=$1',[foreign])).rows[0].count,'0');
  await Promise.all([service.process(),new FcmService(pool,{warn:()=>undefined},sender).process()]);
  assert.equal(messages.length,2);
  assert.deepEqual(new Set(messages.map(m=>m.data?.notificationId)),new Set([first,shared]));
  assert(messages.every(m=>!('notification' in m) && m.android?.priority==='high' && m.android.restrictedPackageName==='com.admbrasil.taxi'));
  ok('FCM atomic queue, shared driver companies, tenant isolation, data-only high priority and concurrent workers');

  const stale=await notify(0);
  await service.register(auth,{...registration,vinculoId:randomUUID()});
  await service.process();
  assert.equal((await pool.query('SELECT status FROM admtaxi.fcm_entregas WHERE notificacao_id=$1',[stale])).rows[0].status,'EXPIRADA');
  const newer={...registration,vinculoId:randomUUID(),token:'rotated_synthetic_fcm_token_123456789'};
  await service.register(auth,newer);
  assert.equal((await pool.query('SELECT count(*) FROM admtaxi.dispositivos_push WHERE usuario_id=$1 AND ativo',[auth.usuarioId])).rows[0].count,'1');
  const retry=await notify(0); fail='messaging/server-unavailable'; await service.process();
  assert.equal((await pool.query('SELECT status FROM admtaxi.fcm_entregas WHERE notificacao_id=$1',[retry])).rows[0].status,'PENDENTE');
  await pool.query('UPDATE admtaxi.fcm_entregas SET proxima_tentativa_em=CURRENT_TIMESTAMP WHERE notificacao_id=$1',[retry]);
  fail=undefined; await service.process(); assert.equal(messages.length,3);
  fail='messaging/registration-token-not-registered'; await notify(0); await service.process();
  assert.equal((await service.status(auth,newer.vinculoId)).ativo,false);
  ok('FCM stale binding, token rotation, backoff retry and invalid token deactivation');

  fail=undefined; await service.register(auth,newer); const revoked=await notify(1);
  await pool.query('UPDATE admtaxi.usuarios SET ativo=FALSE WHERE id=$1',[users[1]]); await service.process();
  assert.equal((await pool.query('SELECT status FROM admtaxi.fcm_entregas WHERE notificacao_id=$1',[revoked])).rows[0].status,'EXPIRADA');
  const expired=await notify(0); await pool.query("UPDATE admtaxi.fcm_entregas SET expira_em=CURRENT_TIMESTAMP-INTERVAL '1 minute' WHERE notificacao_id=$1",[expired]);
  await service.process(); assert.equal(messages.length,3);
  await service.revoke({...auth,empresaId:companies[2]!,usuarioId:users[2]!},newer.vinculoId);
  assert.equal((await service.status(auth,newer.vinculoId)).ativo,true);
  await service.revoke(auth,newer.vinculoId);
  assert.equal((await service.status(auth,newer.vinculoId)).ativo,false);
  await assert.rejects(service.register({...auth,perfil:'FUNCIONARIO'},newer),{statusCode:403});
  ok('FCM revoked company, TTL expiry, ownership checks and role restrictions');
}
