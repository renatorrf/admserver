import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import pino from 'pino';
import { AuditRepository } from '../src/modules/auditoria/audit.repository';
import type { AuthContext } from '../src/modules/auth/auth.types';
import { CorridaService } from '../src/modules/corridas/corrida.service';
import { OperacaoRepository } from '../src/modules/operacao/operacao.repository';
import { requisicaoSchema } from '../src/modules/requisicoes/requisicao.schemas';
import { RequisitionService } from '../src/modules/requisicoes/requisicao.service';
import { TravelEmails } from '../src/modules/requisicoes/travel-emails';
import { passengerControl } from '../src/modules/usuarios/passenger-control';
import { PasswordService } from '../src/modules/auth/password.service';

export async function testGuestPassengers(pool:Pool,manager:AuthContext,gate:AuthContext,center:string,driver:AuthContext,vehicle:string,ok:(s:string)=>void) {
  const audit=new AuditRepository(pool);const emails=new TravelEmails(pool,pino({level:'silent'}));
  const rides=new CorridaService(pool,audit,undefined,undefined,undefined,undefined,undefined,emails);
  const service=new RequisitionService(pool,audit,rides,emails);
  const address={descricao:'Endereco sintetico para teste',latitude:-18.9,longitude:-48.2};
  const input=requisicaoSchema.parse({chave:randomUUID(),tipo:'IMEDIATA',participantes:[{
    avulso:{id:randomUUID(),nome:'Avulso de integracao',telefone:'+55 (34) 98888-1212',centroCustoId:center},
    origem:address,destino:address,valor:'10.00'}]});
  const users=(await pool.query('SELECT count(*) FROM admtaxi.usuarios')).rows[0].count;
  const req=await service.create(manager,input,{});
  const tampered=structuredClone(input.participantes);tampered[0]!.avulso!.telefone='34988881213';
  await assert.rejects(service.dispatch(gate,req.id,tampered,{}),{statusCode:409});
  const invalid=structuredClone(input);invalid.chave=randomUUID();invalid.participantes[0]!.avulso!.centroCustoId=randomUUID();
  await assert.rejects(service.create(manager,invalid,{}),{statusCode:422});
  await assert.rejects(service.dispatch(gate,req.id,input.participantes,{}),{statusCode:422});
  const sector=(await pool.query('SELECT setor_id FROM admtaxi.centros_custo WHERE id=$1',[center])).rows[0].setor_id as string;
  const conference=structuredClone(input.participantes);
  Object.assign(conference[0]!.avulso!,{matricula:'PRE-001',setorId:sector});
  const wrongSector=structuredClone(conference);wrongSector[0]!.avulso!.setorId=randomUUID();
  await assert.rejects(service.dispatch(gate,req.id,wrongSector,{}),{statusCode:422});
  let ride=await service.dispatch(gate,req.id,conference,{});
  assert.equal((await service.dispatch(gate,req.id,input.participantes,{})).id,ride.id);
  const id=ride.itinerario!.participantes[0]!.funcionarioId;
  const guest=(await pool.query('SELECT * FROM admtaxi.funcionarios WHERE id=$1',[id])).rows[0];
  assert.equal(guest.avulso,false);assert.equal(guest.matricula,'PRE-001');assert.equal(guest.usuario_id,null);
  assert.equal(guest.endereco_padrao,address.descricao);
  assert.equal((await pool.query('SELECT count(*) FROM admtaxi.usuarios')).rows[0].count,users);
  assert.equal(ride.itinerario!.participantes[0]!.funcionarioTelefone,'34988881212');
  assert.equal(ride.itinerario!.participantes[0]!.centroCustoId,center);
  assert((await new OperacaoRepository(pool).listEmployees(manager,{})).some(f=>f.id===id));
  const search=await new OperacaoRepository(pool).searchEmployees(manager,{busca:'Avulso de integracao',ativo:true,pagina:1,limite:8});
  assert.equal(search.data[0]!.setorId,sector);assert(search.data[0]!.setorNome);
  assert((await pool.query('SELECT corpo FROM admtaxi.emails_viagem WHERE requisicao_id=$1',[req.id])).rows.every(r=>r.corpo.includes('Avulso de integracao')));
  ride=await rides.accept(driver,ride.id,{veiculoId:vehicle},{});
  while(ride.itinerario!.paradas.some(s=>s.estado!=='CONCLUIDA')) {
    const stop=ride.itinerario!.paradas.find(s=>s.estado!=='CONCLUIDA')!;
    const p=ride.itinerario!.participantes[0]!;
    const action=stop.estado==='PENDENTE'?'INICIAR':stop.estado==='EM_DESLOCAMENTO'?'CHEGAR':p.embarqueId===stop.id?'EMBARCAR':'DESEMBARCAR';
    ride=await rides.executeItinerary(driver,ride.id,{chave:randomUUID(),versao:ride.itinerario!.versao,paradaId:stop.id,
      acao:action,funcionarioId:id,avancoAutomatico:true},{});
  }
  await rides.finish(driver,ride.id,{valorFinal:'10.00'},{});
  const usage=async()=> (await pool.query('SELECT * FROM admtaxi.uso_plano_passageiros WHERE identidade_transporte=$1',[guest.identidade_transporte])).rows[0];
  assert.equal((await usage()).ativo_plano,true);assert.equal((await usage()).reservado,false);
  await pool.query("UPDATE admtaxi.corridas SET finalizada_em=CURRENT_TIMESTAMP-INTERVAL '62 days' WHERE id=$1",[ride.id]);
  assert.equal((await usage()).ativo_plano,false);
  const control=await passengerControl(pool,manager.empresaId,{busca:'Avulso de integracao',situacao:'INATIVO'});
  assert.equal(control.data[0].cadastroAtivo,true);assert.equal(control.total,1);
  const other=await service.create(manager,{...input,chave:randomUUID()},{});
  const repeat=await service.dispatch(gate,other.id,conference,{});
  assert.equal(repeat.funcionarioId,id);assert.equal((await usage()).reservado,true);assert.equal((await usage()).ativo_plano,false);
  await rides.cancel(manager,repeat.id,{motivo:'Cancelamento sintetico de teste'},{});
  assert.equal((await usage()).reservado,false);
  ok('PRE-REGISTRATION required enrollment/sector/phone, authorized center, searchable completed employee, no login without email, reuse and rate allocation');
  ok('PLAN 62-day expiry releases slot without blocking access; reservation, cancellation and reactivation remain distinct from completed transport');
  await testPreRegistrationAccess(pool,manager,gate,center,sector,service,rides,ok);
}

async function testPreRegistrationAccess(pool:Pool,manager:AuthContext,gate:AuthContext,center:string,sector:string,
  service:RequisitionService,rides:CorridaService,ok:(s:string)=>void) {
  const email='precadastro@example.test';
  const input=requisicaoSchema.parse({chave:randomUUID(),tipo:'IMEDIATA',participantes:[{
    avulso:{id:randomUUID(),nome:'Pessoa pre cadastro acesso',centroCustoId:center,telefone:'34998882222'},valor:'5.00'}]});
  const req=await service.create(manager,input,{});
  assert.equal((await pool.query('SELECT id FROM admtaxi.funcionarios WHERE nome=$1',[input.participantes[0]!.avulso!.nome])).rowCount,0);
  const address={descricao:'Rua teste de pre cadastro',latitude:-18.9,longitude:-48.2};
  const complete=[{...input.participantes[0]!,origem:address,destino:address,
    avulso:{...input.participantes[0]!.avulso!,matricula:'PRE-EMAIL',setorId:sector,telefone:'34998882222',email}}];
  const unauthorized={...input,chave:randomUUID(),participantes:complete};
  await assert.rejects(service.create(manager,unauthorized,{}),{statusCode:403});
  const badAudit={record:async()=>{throw Error('synthetic audit failure');}};
  const failed=new RequisitionService(pool,badAudit,new CorridaService(pool,badAudit),new TravelEmails(pool,pino({level:'silent'})));
  await assert.rejects(failed.dispatch(gate,req.id,complete,{}),/synthetic audit failure/);
  assert.equal((await pool.query('SELECT id FROM admtaxi.usuarios WHERE email=$1',[email])).rowCount,0);
  assert.equal((await pool.query('SELECT id FROM admtaxi.emails_viagem WHERE destinatario=$1',[email])).rowCount,0);
  const results=await Promise.all([service.dispatch(gate,req.id,complete,{}),service.dispatch(gate,req.id,complete,{})]);
  assert.equal(results[0]!.id,results[1]!.id);
  const user=(await pool.query('SELECT * FROM admtaxi.usuarios_autenticacao WHERE email=$1',[email])).rows[0];
  assert(user && user.perfil==='FUNCIONARIO' && user.deve_alterar_senha);
  assert.equal((await pool.query('SELECT id FROM admtaxi.usuarios WHERE email=$1',[email])).rowCount,1);
  assert.equal((await pool.query("SELECT id FROM admtaxi.emails_viagem WHERE requisicao_id=$1 AND evento LIKE 'PRIMEIRO_ACESSO:%'",[req.id])).rowCount,1);
  const logger=pino({level:'silent'});const config={resetUrl:'https://example.test/redefinir-senha',resetTtlMinutes:30};
  const failureWorker=new TravelEmails(pool,logger,{send:async()=>{throw Error('synthetic SMTP failure');}},config);
  while(await failureWorker.process()) { /* Drain due messages without contacting SMTP. */ }
  assert.equal((await pool.query('SELECT count(*) FROM admtaxi.recuperacoes_senha WHERE usuario_id=$1 AND usado_em IS NULL',[user.id])).rows[0].count,'0');
  await pool.query("UPDATE admtaxi.emails_viagem SET proxima_tentativa_em=CURRENT_TIMESTAMP WHERE status='PENDENTE'");
  const messages:{to:string;text:string;subject:string}[]=[];
  const worker=new TravelEmails(pool,logger,{send:async message=>{messages.push(message);}},config);
  while(await worker.process()) { /* Drain using the fake mailer. */ }
  const welcome=messages.find(m=>m.to===email && m.subject==='Seu acesso ao ADM Taxi')!;
  assert(welcome?.text.includes(`Login: ${email}`));
  const token=welcome.text.match(/#token=([a-f0-9]{64})/)![1]!;
  assert(!messages.some(m=>m.to!==email && m.text.includes(token)));
  assert(!(await pool.query('SELECT corpo FROM admtaxi.emails_viagem WHERE destinatario=$1',[email])).rows.some(r=>r.corpo.includes(token)));
  const passwords=new PasswordService(pool,logger);
  await passwords.reset({token,novaSenha:'NovaSenha123'});
  await assert.rejects(passwords.reset({token,novaSenha:'OutraSenha123'}),{statusCode:400});
  const credential=(await pool.query('SELECT senha_hash,deve_alterar_senha FROM admtaxi.usuarios_autenticacao WHERE id=$1',[user.id])).rows[0];
  assert.equal(credential.deve_alterar_senha,false);
  await rides.cancel(manager,results[0]!.id,{motivo:'Teste de cadastro e acesso concluido'},{});
  const again=await service.create(manager,{...input,chave:randomUUID()},{});
  const repeated=await service.dispatch(gate,again.id,complete,{});
  assert.equal(repeated.funcionarioId,results[0]!.funcionarioId);
  assert.equal((await pool.query('SELECT senha_hash FROM admtaxi.usuarios_autenticacao WHERE id=$1',[user.id])).rows[0].senha_hash,credential.senha_hash);
  assert.equal((await pool.query("SELECT id FROM admtaxi.emails_viagem WHERE requisicao_id=$1 AND evento LIKE 'PRIMEIRO_ACESSO:%'",[again.id])).rowCount,0);
  await rides.cancel(manager,repeated.id,{motivo:'Teste de reutilizacao concluido'},{});
  ok('PRE-REGISTRATION access atomic rollback, concurrent dispatch once, SMTP retry, private one-use link, password creation and existing credentials preserved');
}

export async function testGlobalPassengerLimit(pool:Pool,ok:(s:string)=>void) {
  // Called only by the temporary local PostgreSQL runner, never by a migration or live server.
  const tenants=[] as {empresa:string;user:string;center:string}[];
  for(let i=0;i<2;i++) {
    const empresa=randomUUID(),user=randomUUID(),center=randomUUID(),sector=randomUUID();
    await pool.query('INSERT INTO admtaxi.empresas(id,codigo_acesso,razao_social,nome_fantasia) VALUES($1,$2::text,$2::text,$2::text)',[empresa,`QUOTA-${i}`]);
    await pool.query("INSERT INTO admtaxi.usuarios(id,empresa_id,nome,email,senha_hash,perfil) VALUES($1,$2,'Gestor quota',$3,'synthetic','GESTOR')",[user,empresa,`quota${i}@example.test`]);
    await pool.query("INSERT INTO admtaxi.setores(id,empresa_id,codigo,nome) VALUES($1,$2,'Q','Quota')",[sector,empresa]);
    await pool.query("INSERT INTO admtaxi.centros_custo(id,empresa_id,setor_id,codigo,nome) VALUES($1,$2,$3,'Q','Quota')",[center,empresa,sector]);
    tenants.push({empresa,user,center});
  }
  const person=async(t:typeof tenants[number],name:string,phone:string)=> (await pool.query(`INSERT INTO admtaxi.funcionarios(empresa_id,centro_custo_id,nome,telefone,avulso)
    VALUES($1,$2,$3,$4,TRUE) RETURNING id,identidade_transporte`,[t.empresa,t.center,name,phone])).rows[0];
  const book=async(t:typeof tenants[number],id:string)=> (await pool.query(`INSERT INTO admtaxi.corridas(empresa_id,solicitante_usuario_id,funcionario_id,centro_custo_id,tipo,origem_descricao,destino_descricao)
    VALUES($1,$2,$3,$4,'IMEDIATA','Origem sintetica','Destino sintetico') RETURNING id`,[t.empresa,t.user,id,t.center])).rows[0].id as string;
  const count=async()=>Number((await pool.query('SELECT count(*) FROM admtaxi.uso_plano_passageiros WHERE ativo_plano OR reservado')).rows[0].count);
  const one=await person(tenants[0]!,'Pessoa compartilhada quota','34998761234');
  const two=await person(tenants[1]!,'Pessoa compartilhada quota','34998761234');
  assert.equal(one.identidade_transporte,two.identidade_transporte);
  const before=await count();await book(tenants[0]!,one.id);await book(tenants[1]!,two.id);assert.equal(await count(),before+1);
  const isolated=await passengerControl(pool,tenants[1]!.empresa,{});
  assert.equal(isolated.total,1);assert.equal(isolated.data[0].nome,'Pessoa compartilhada quota');
  const missing=199-await count();
  for(let i=0;i<missing;i++) {const p=await person(tenants[0]!,`Passageiro quota ${i}`,`3499${String(i).padStart(7,'0')}`);await book(tenants[0]!,p.id);}
  assert.equal(await count(),199);
  const a=await person(tenants[0]!,'Ultima vaga A','34998760001');
  const b=await person(tenants[1]!,'Ultima vaga B','34998760002');
  const results=await Promise.allSettled([book(tenants[0]!,a.id),book(tenants[1]!,b.id)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const failure=results.find(r=>r.status==='rejected') as PromiseRejectedResult;
  assert.equal(failure.reason.code,'P2601');assert.equal(await count(),200);
  // Completion must never be blocked after reserving a slot, even while the limit is full.
  const winner=(results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<string>).value;
  await pool.query("UPDATE admtaxi.corridas SET status='FINALIZADA',desembarque_em=CURRENT_TIMESTAMP,finalizada_em=CURRENT_TIMESTAMP,valor_final=0 WHERE id=$1",[winner]);
  assert.equal(await count(),200);
  await pool.query("UPDATE admtaxi.corridas SET finalizada_em=CURRENT_TIMESTAMP-INTERVAL '62 days' WHERE id=$1",[winner]);
  assert.equal(await count(),199);
  const loser=results[0]!.status==='rejected'?0:1;
  await book(tenants[loser]!,loser===0?a.id:b.id);assert.equal(await count(),200);
  ok('PLAN global 200 limit: same person across companies once, no slot before ride, concurrent final slot, 201 rejected, expiry and completion at capacity');
}
