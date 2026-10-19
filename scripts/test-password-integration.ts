import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import argon2 from 'argon2';
import pino from 'pino';
import express from 'express';
import request from 'supertest';
import { PgAuthRepository } from '../src/modules/auth/auth.repository';
import { AuthService } from '../src/modules/auth/auth.service';
import { TokenService } from '../src/modules/auth/token-service';
import { PasswordService, hashResetToken } from '../src/modules/auth/password.service';
import { createAuthRouter } from '../src/modules/auth/auth.routes';
import { createAuthenticate } from '../src/modules/auth/auth.middleware';
import { createErrorHandler } from '../src/shared/http/error-handler';
import { MasterService } from '../src/modules/master/master.service';
import { MasterRecoveryService } from '../src/modules/master/master-recovery.service';
import { MasterTokenService } from '../src/modules/master/master-token.service';
import { createMasterRouter } from '../src/modules/master/master.routes';
import { ProvisionamentoService } from '../src/modules/provisionamento/provisionamento.service';

async function main(): Promise<void> {
  // Never use DATABASE_URL: this test owns an isolated local PostgreSQL cluster.
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address(); assert(address && typeof address !== 'string');
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const directory = path.resolve('.artifacts', `password-pg-${randomUUID()}`);
  await mkdir(path.dirname(directory), { recursive: true });
  const password = randomUUID();
  const embedded = new EmbeddedPostgres({ databaseDir: directory, port: address.port, user: 'postgres', password,
    persistent: true, postgresFlags: ['-h', '127.0.0.1'], onLog: () => undefined, onError: () => undefined });
  let pool: Pool | undefined, started = false;
  let checks = 0;
  const ok = (name: string) => { checks++; console.log(`PASS ${name}`); };
  try {
    await embedded.initialise(); await embedded.start(); started = true;
    pool = new Pool({ host: '127.0.0.1', port: address.port, user: 'postgres', password, database: 'postgres' });
    await pool.query('CREATE EXTENSION pgcrypto; CREATE EXTENSION citext; CREATE SCHEMA admtaxi');
    const migrations = (await readdir('src/db/migrations')).filter(f => /^\d+_.+\.up\.sql$/.test(f)).sort();
    for (const file of migrations.filter(f => Number(f.slice(0,3)) < 14)) await pool.query(await readFile(path.join('src/db/migrations',file),'utf8'));
    const company = randomUUID(), other = randomUUID(), legacy = randomUUID(), fresh = randomUUID();
    for (const [id,code] of [[company,'TEST'],[other,'OTHER']]) await pool.query(
      'INSERT INTO admtaxi.empresas(id,codigo_acesso,razao_social,nome_fantasia) VALUES($1,$2::text,$2::text,$2::text)',[id,code]);
    const initialHash = await argon2.hash('123456');
    await pool.query(`INSERT INTO admtaxi.usuarios(id,empresa_id,nome,email,senha_hash,perfil)
      VALUES($1,$2,'Legacy','legacy@example.test',$3,'GESTOR')`,[legacy,company,initialHash]);
    const sql = await readFile('src/db/migrations/014_recuperacao_senha.up.sql','utf8');
    await pool.query('BEGIN'); await pool.query(sql); await pool.query('ROLLBACK');
    await pool.query('BEGIN'); await pool.query(sql); await pool.query('COMMIT');
    assert.equal((await pool.query('SELECT deve_alterar_senha FROM admtaxi.usuarios WHERE id=$1',[legacy])).rows[0].deve_alterar_senha,false);
    await pool.query(`INSERT INTO admtaxi.usuarios(id,empresa_id,nome,email,senha_hash,perfil)
      VALUES($1,$2,'Fresh','fresh@example.test',$3,'FUNCIONARIO')`,[fresh,company,initialHash]);
    ok('014 rollback/apply preserves existing users and marks new accounts temporary');

    const repository = new PgAuthRepository(pool);
    const tokens = new TokenService({ jwtAccessSecret:randomUUID()+randomUUID(),jwtRefreshSecret:randomUUID()+randomUUID(),
      jwtAccessExpiresInSeconds:900,jwtRefreshExpiresInSeconds:3600 }, auth=>repository.accessAllowed(auth));
    const authService = new AuthService(repository,tokens);
    const deliveries: { to: string; url: string }[] = [];
    let failMail = false;
    const logger = pino({level:'silent'});
    const service = new PasswordService(pool,logger,{host:'smtp.example.test',port:587,secure:false,user:'test',password:'test',
      from:'no-reply@example.test',resetUrl:'https://app.example.test/redefinir-senha',resetTtlMinutes:30},
    {send:async(to,url)=>{if(failMail) throw new Error('simulated smtp failure');deliveries.push({to,url});}});
    const app=express(); app.use(express.json());
    app.use('/auth',createAuthRouter(authService,tokens,service));
    app.get('/protected',createAuthenticate(tokens),(_req,res)=>{res.sendStatus(204);});
    app.use(createErrorHandler(logger));
    const session=await authService.login({empresa:'TEST',email:'fresh@example.test',senha:'123456'});
    assert.equal(session.usuario.deveAlterarSenha,true);
    const denied=await request(app).get('/protected').auth(session.accessToken,{type:'bearer'}).expect(403);
    assert.equal(denied.body.erro.codigo,'TROCA_SENHA_OBRIGATORIA');
    await request(app).get('/auth/me').auth(session.accessToken,{type:'bearer'}).expect(200);
    await request(app).post('/auth/senha').auth(session.accessToken,{type:'bearer'}).send({senhaAtual:'123456',novaSenha:'12345'}).expect(422);
    await request(app).post('/auth/senha').auth(session.accessToken,{type:'bearer'}).send({senhaAtual:'wrong',novaSenha:'abcdef'}).expect(422);
    await request(app).post('/auth/senha').auth(session.accessToken,{type:'bearer'}).send({senhaAtual:'123456',novaSenha:'123456'}).expect(422);
    await request(app).post('/auth/senha').auth(session.accessToken,{type:'bearer'}).send({senhaAtual:'123456',novaSenha:'abcdef'}).expect(204);
    await request(app).get('/protected').auth(session.accessToken,{type:'bearer'}).expect(401);
    await assert.rejects(authService.refresh({refreshToken:session.refreshToken}),{statusCode:401});
    await assert.rejects(authService.login({empresa:'TEST',email:'fresh@example.test',senha:'123456'}),{statusCode:401});
    const active=await authService.login({empresa:'TEST',email:'fresh@example.test',senha:'abcdef'});
    assert.equal(active.usuario.deveAlterarSenha,false);
    await request(app).get('/protected').auth(active.accessToken,{type:'bearer'}).expect(204);
    ok('first login HTTP restriction, 6-character policy, password proof and token revocation');

    await service.requestReset({empresa:'OTHER',email:'fresh@example.test'});
    await service.requestReset({empresa:'TEST',email:'missing@example.test'});
    assert.equal(deliveries.length,0);
    await pool.query('UPDATE admtaxi.usuarios SET ativo=FALSE WHERE id=$1',[fresh]);
    await service.requestReset({empresa:'TEST',email:'fresh@example.test'}); assert.equal(deliveries.length,0);
    await pool.query('UPDATE admtaxi.usuarios SET ativo=TRUE WHERE id=$1',[fresh]);
    await service.requestReset({empresa:'TEST',email:'fresh@example.test'});
    await service.requestReset({empresa:'TEST',email:'fresh@example.test'}); assert.equal(deliveries.length,1);
    const tokenOf = (index: number) => new URLSearchParams(new URL(deliveries[index]!.url).hash.slice(1)).get('token')!;
    const token=tokenOf(0);
    const record=(await pool.query('SELECT token_hash,expira_em,criado_em FROM admtaxi.recuperacoes_senha WHERE usuario_id=$1',[fresh])).rows[0];
    assert.equal(record.token_hash,hashResetToken(token)); assert.notEqual(record.token_hash,token);
    assert.equal(record.expira_em.getTime()-record.criado_em.getTime(),30*60_000);
    ok('email scope, inactive users, cooldown, hashed secrets and 30-minute expiry');

    const result=await Promise.allSettled([service.reset({token,novaSenha:'ghijkl'}),service.reset({token,novaSenha:'mnopqr'})]);
    assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
    await assert.rejects(service.reset({token,novaSenha:'stuvwx'}),{code:'LINK_SENHA_INVALIDO'});
    await assert.rejects(tokens.authenticateAccess(active.accessToken),{statusCode:401});
    await assert.rejects(authService.refresh({refreshToken:active.refreshToken}),{statusCode:401});
    const winner=result[0]!.status==='fulfilled'?'ghijkl':'mnopqr';
    const recovered=await authService.login({empresa:'TEST',email:'fresh@example.test',senha:winner});
    assert.equal(recovered.usuario.deveAlterarSenha,false);
    ok('concurrent reset consumes link once and revokes access/refresh sessions');

    await pool.query("UPDATE admtaxi.recuperacoes_senha SET criado_em=CURRENT_TIMESTAMP-INTERVAL '2 minutes' WHERE usuario_id=$1",[fresh]);
    await service.requestReset({empresa:'TEST',email:'fresh@example.test'});
    const expired=tokenOf(1);
    await pool.query("UPDATE admtaxi.recuperacoes_senha SET expira_em=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE token_hash=$1",[hashResetToken(expired)]);
    await assert.rejects(service.reset({token:expired,novaSenha:'654321'}),{code:'LINK_SENHA_INVALIDO'});
    ok('expired link does not change password');

    failMail=true;
    await service.requestReset({empresa:'TEST',email:'legacy@example.test'});
    assert.equal((await pool.query('SELECT usado_em IS NOT NULL AS invalid FROM admtaxi.recuperacoes_senha WHERE usuario_id=$1',[legacy])).rows[0].invalid,true);
    await assert.rejects(new PasswordService(pool,logger).requestReset({empresa:'TEST',email:'any@example.test'}),{statusCode:503});
    ok('SMTP failure invalidates link and missing configuration fails explicitly');

    await pool.query('UPDATE admtaxi.usuarios SET senha_hash=$2,deve_alterar_senha=TRUE WHERE id=$1',[fresh,initialHash]);
    await assert.rejects(tokens.authenticateAccess(recovered.accessToken),{statusCode:401});
    const temporary=await authService.login({empresa:'TEST',email:'fresh@example.test',senha:'123456'});
    assert.equal(temporary.usuario.deveAlterarSenha,true);
    const audit=(await pool.query("SELECT acao FROM admtaxi.auditoria WHERE acao IN ('ALTERAR_SENHA','RECUPERAR_SENHA')")).rows;
    assert.equal(audit.length,2);
    ok('administrative reset re-requires change; personal change/reset audited');
    const masterId = randomUUID();
    await pool.query(`INSERT INTO admtaxi.administradores_plataforma(id,usuario,nome,senha_hash,deve_alterar_senha)
      VALUES($1,'master.test','Legacy Master',$2,FALSE)`, [masterId,initialHash]);
    const masterSql = await readFile('src/db/migrations/015_recuperacao_master.up.sql','utf8');
    await pool.query('BEGIN'); await pool.query(masterSql); await pool.query('ROLLBACK');
    await pool.query('BEGIN'); await pool.query(masterSql); await pool.query('COMMIT');
    const preserved = (await pool.query('SELECT email,senha_versao FROM admtaxi.administradores_plataforma WHERE id=$1',[masterId])).rows[0];
    assert.equal(preserved.email,null); assert.equal(preserved.senha_versao,0);
    ok('015 rollback/apply preserves legacy masters without inventing email addresses');

    const masterTokens = new MasterTokenService(randomUUID()+randomUUID());
    const masters = new MasterService(pool,masterTokens,new ProvisionamentoService(pool));
    const masterDeliveries: { to: string; url: string }[] = [];
    let masterMailFails = false;
    const masterRecovery = new MasterRecoveryService(pool,logger,{host:'smtp.example.test',port:587,secure:false,user:'test',password:'test',
      from:'no-reply@example.test',resetUrl:'https://app.example.test/redefinir-senha',masterResetUrl:'https://app.example.test/master/redefinir-senha',resetTtlMinutes:30},
    {send:async(to,url)=>{if(masterMailFails) throw new Error('simulated');masterDeliveries.push({to,url});}});
    const masterApp=express();masterApp.use(express.json());
    masterApp.use('/master',createMasterRouter(masters,masterTokens,masterRecovery));masterApp.use(createErrorHandler(logger));
    const legacyMaster = await masters.login({usuario:'master.test',senha:'123456'});
    const contextOf = (s: { accessToken: string }) => masterTokens.verify(s.accessToken);
    await assert.rejects(masters.changeEmail(contextOf(legacyMaster),{email:'master@example.test',senhaAtual:'wrong'}),{statusCode:401});
    const registered = await masters.changeEmail(contextOf(legacyMaster),{email:'master@example.test',senhaAtual:'123456'});
    assert.equal(registered.administrador.email,'master@example.test');
    await request(masterApp).get('/master/auth/me').auth(legacyMaster.accessToken,{type:'bearer'}).expect(401);
    const child = await masters.createAdministrator(contextOf(registered),{usuario:'new.master',nome:'New Master',email:'new@example.test',senha:'123456'},{ip:null,userAgent:null});
    assert.equal(child.deveAlterarSenha,true);
    await assert.rejects(masters.createAdministrator(contextOf(registered),{usuario:'duplicate',nome:'Duplicate',email:'MASTER@example.test',senha:'123456'},{ip:null,userAgent:null}),{code:'23505'});
    const childSession = await masters.login({usuario:'new.master',senha:'123456'});
    await request(masterApp).get('/master/empresas').auth(childSession.accessToken,{type:'bearer'}).expect(409);
    const childChanged = await masters.changePassword(contextOf(childSession),{senhaAtual:'123456',novaSenha:'abcdef'});
    await request(masterApp).get('/master/empresas').auth(childSession.accessToken,{type:'bearer'}).expect(409);
    await request(masterApp).get('/master/auth/me').auth(childSession.accessToken,{type:'bearer'}).expect(401);
    await request(masterApp).get('/master/empresas').auth(childChanged.accessToken,{type:'bearer'}).expect(200);
    ok('master email needs current password, is unique; first-login change and session version enforced');

    await masterRecovery.requestReset({email:'fresh@example.test'});
    await masterRecovery.requestReset({email:'missing@example.test'});assert.equal(masterDeliveries.length,0);
    await masterRecovery.requestReset({email:'MASTER@example.test'});
    await masterRecovery.requestReset({email:'master@example.test'});assert.equal(masterDeliveries.length,1);
    const masterTokenOf = (i: number) => new URLSearchParams(new URL(masterDeliveries[i]!.url).hash.slice(1)).get('token')!;
    const masterToken = masterTokenOf(0);
    assert.equal(new URL(masterDeliveries[0]!.url).pathname,'/master/redefinir-senha');
    const stored = (await pool.query('SELECT token_hash,criado_em,expira_em FROM admtaxi.recuperacoes_senha_master WHERE administrador_id=$1',[masterId])).rows[0];
    assert.equal(stored.token_hash,hashResetToken(masterToken));
    assert.equal(stored.expira_em.getTime()-stored.criado_em.getTime(),30*60_000);
    await assert.rejects(masterRecovery.reset({token,novaSenha:'654321'}),{code:'LINK_SENHA_INVALIDO'});
    await assert.rejects(service.reset({token:masterToken,novaSenha:'654321'}),{code:'LINK_SENHA_INVALIDO'});
    const concurrent = await Promise.allSettled([masterRecovery.reset({token:masterToken,novaSenha:'ghijkl'}),masterRecovery.reset({token:masterToken,novaSenha:'mnopqr'})]);
    assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);
    await request(masterApp).post('/master/auth/senha/redefinir').send({token:masterToken,novaSenha:'654321'}).expect(400);
    await request(masterApp).get('/master/empresas').auth(registered.accessToken,{type:'bearer'}).expect(401);
    const masterWinner = concurrent[0]!.status==='fulfilled'?'ghijkl':'mnopqr';
    const recoveredMaster = await masters.login({usuario:'master.test',senha:masterWinner});
    assert.equal(recoveredMaster.administrador.deveAlterarSenha,false);
    ok('master recovery is realm-isolated, throttled, hashed, single-use under concurrency and revokes sessions');

    const allowAnotherMasterLink = async () => pool!.query("UPDATE admtaxi.recuperacoes_senha_master SET criado_em=CURRENT_TIMESTAMP-INTERVAL '2 minutes' WHERE administrador_id=$1",[masterId]);
    await allowAnotherMasterLink();await masterRecovery.requestReset({email:'master@example.test'});
    const expiredMaster=masterTokenOf(1);
    await pool.query("UPDATE admtaxi.recuperacoes_senha_master SET expira_em=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE token_hash=$1",[hashResetToken(expiredMaster)]);
    await assert.rejects(masterRecovery.reset({token:expiredMaster,novaSenha:'654321'}),{code:'LINK_SENHA_INVALIDO'});
    await allowAnotherMasterLink();await masterRecovery.requestReset({email:'master@example.test'});
    const oldEmailLink=masterTokenOf(2);
    const changedEmail = await masters.changeEmail(contextOf(recoveredMaster),{email:'changed@example.test',senhaAtual:masterWinner});
    await assert.rejects(masterRecovery.reset({token:oldEmailLink,novaSenha:'654321'}),{code:'LINK_SENHA_INVALIDO'});
    await assert.rejects(masters.getCurrent(contextOf(recoveredMaster)),{statusCode:401});
    await masterRecovery.requestReset({email:'master@example.test'});assert.equal(masterDeliveries.length,3);
    await masters.setAdministratorActive(contextOf(changedEmail),child.administradorId,false,{ip:null,userAgent:null});
    await masterRecovery.requestReset({email:'new@example.test'});assert.equal(masterDeliveries.length,3);
    await masters.setAdministratorActive(contextOf(changedEmail),child.administradorId,true,{ip:null,userAgent:null});
    await assert.rejects(masters.getCurrent(contextOf(childChanged)),{statusCode:401});
    ok('expiry/email change invalidate master links; inactivation/reactivation cannot restore old sessions');

    masterMailFails=true; await masterRecovery.requestReset({email:'new@example.test'});
    assert.equal((await pool.query('SELECT usado_em IS NOT NULL AS invalid FROM admtaxi.recuperacoes_senha_master WHERE administrador_id=$1',[child.administradorId])).rows[0].invalid,true);
    await assert.rejects(new MasterRecoveryService(pool,logger).requestReset({email:'master@example.test'}),{statusCode:503});
    const masterAudit=(await pool.query("SELECT acao FROM admtaxi.auditoria_plataforma WHERE acao='RECUPERAR_SENHA'")).rows;
    assert.equal(masterAudit.length,1);
    ok('master SMTP failure invalidates token, missing configuration explicit, recovery audited');
    console.log(`PASSWORD_INTEGRATION_OK checks=${checks}`);
  } finally {
    await pool?.end();
    if (started && process.platform === 'win32') {
      const stopped = spawnSync(path.resolve('node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe'),
        ['stop', '-D', directory, '-m', 'fast', '-w'], { encoding: 'utf8', windowsHide: true });
      assert.equal(stopped.status, 0, 'Falha ao encerrar PostgreSQL isolado.');
    } else if (started) await embedded.stop();
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
