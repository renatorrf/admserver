import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import express from 'express';
import request from 'supertest';
import pino from 'pino';
import { AuditRepository } from '../src/modules/auditoria/audit.repository';
import type { AuthContext } from '../src/modules/auth/auth.types';
import { CorridaService } from '../src/modules/corridas/corrida.service';
import { createCorridaRouter } from '../src/modules/corridas/corrida.routes';
import { RequisitionService } from '../src/modules/requisicoes/requisicao.service';
import { requisicaoSchema } from '../src/modules/requisicoes/requisicao.schemas';
import { requisitionRouter } from '../src/modules/requisicoes/requisicao.routes';
import { TravelEmails } from '../src/modules/requisicoes/travel-emails';
import { createErrorHandler } from '../src/shared/http/error-handler';
import { createAuthenticate } from '../src/modules/auth/auth.middleware';
import { TokenService } from '../src/modules/auth/token-service';
import { RealtimeBus } from '../src/realtime/realtime-bus';
import { RequisitionAccessService } from '../src/modules/requisicoes/requisition-access';
import { WhatsAppDelivery } from '../src/modules/requisicoes/whatsapp-delivery';
import { whatsappWebhook } from '../src/modules/requisicoes/whatsapp-webhook';
import { NotificacaoService } from '../src/modules/notificacoes/notificacao.service';
import { MonthlyBillingService, monthlyAllocation } from '../src/modules/faturamentos/monthly-billing.service';

export async function testRequisitions(pool: Pool,manager: AuthContext,gate: AuthContext,employeeIds: string[],center: string,sector: string,otherCompany: string,driver: AuthContext,vehicle: string,ok: (s: string)=>void) {
  const logger=pino({level:'silent'}); const audit=new AuditRepository(pool);
  const emails=new TravelEmails(pool,logger);
  const bus=new RealtimeBus();
  const changes:Parameters<RealtimeBus['publishRequisition']>[0][]=[];
  const rideChanges:string[]=[];
  bus.onRequisition(event=>changes.push(event));bus.onRide(ride=>rideChanges.push(ride.id));
  const rides=new CorridaService(pool,audit,undefined,bus,undefined,undefined,undefined,emails);
  const access=new RequisitionAccessService(pool,audit,{resetUrl:'https://example.test/redefinir-senha',resetTtlMinutes:30});
  const sent: Array<{ to:string; biz_opaque_callback_data:string; template:{components:Array<{parameters:Array<{text:string}>}>} }> = [];
  const whatsapp=new WhatsAppDelivery(pool,logger,{version:'v99.0',phoneNumberId:'123456',accessToken:'test',
    rideTemplate:'corrida',firstAccessTemplate:'primeiro_acesso',language:'pt_BR',appUrl:'https://example.test/'},access,async (_url,init)=>{
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({messages:[{id:`wamid.test.${sent.length}`}]});
  });
  const service=new RequisitionService(pool,audit,rides,emails,bus,whatsapp);
  const supervisor: AuthContext={...manager,usuarioId:randomUUID(),perfil:'GERENTE'};
  const observer = randomUUID(), optedOut = randomUUID(), inactive = randomUUID(), foreign = randomUUID();
  for (const [id, company, name, active, receives] of [
    [observer, manager.empresaId, 'observer', true, true], [optedOut, manager.empresaId, 'opt-out', true, false],
    [inactive, manager.empresaId, 'inactive', false, true], [foreign, otherCompany, 'foreign', true, true],
  ] as const) {
    await pool.query(`INSERT INTO admtaxi.usuarios(id,empresa_id,nome,email,senha_hash,perfil,ativo,recebe_avisos_viagem)
      VALUES($1,$2,$3,$4,'synthetic','GESTOR',$5,$6)`, [id, company, `Gestor avisos ${name}`, `${name}-travel@example.test`, active, receives]);
  }
  await pool.query(`INSERT INTO admtaxi.usuarios(id,empresa_id,nome,email,senha_hash,perfil) VALUES($1,$2,'Supervisor requisicoes','supervisor-travel@example.test','synthetic','GERENTE')`,[supervisor.usuarioId,manager.empresaId]);
  await pool.query('INSERT INTO admtaxi.gerente_setores(empresa_id,gerente_usuario_id,setor_id) VALUES($1,$2,$3)',[manager.empresaId,supervisor.usuarioId,sector]);
  await pool.query('INSERT INTO admtaxi.gerente_centros_custo(empresa_id,gerente_usuario_id,centro_custo_id) VALUES($1,$2,$3)',[manager.empresaId,supervisor.usuarioId,center]);
  await pool.query(`INSERT INTO admtaxi.gerente_centros_custo(empresa_id,gerente_usuario_id,centro_custo_id)
    SELECT DISTINCT empresa_id,$2::uuid,centro_custo_id FROM admtaxi.funcionarios WHERE empresa_id=$1 AND id=ANY($3::uuid[])
    ON CONFLICT DO NOTHING`,[manager.empresaId,supervisor.usuarioId,employeeIds.slice(0,2)]);
  const input=requisicaoSchema.parse({chave:randomUUID(),tipo:'IMEDIATA',participantes:employeeIds.slice(0,2).map(funcionarioId=>({funcionarioId,valor:'10.00'}))});
  const before=Number((await pool.query('SELECT count(*) FROM admtaxi.corridas WHERE empresa_id=$1',[manager.empresaId])).rows[0].count);
  const created=await service.create(supervisor,input,{});
  assert.equal(created.status,'PENDENTE');
  assert.deepEqual(changes[0],{empresaId:manager.empresaId,id:created.id,solicitanteId:supervisor.usuarioId});
  assert.equal((await service.create(supervisor,input,{})).id,created.id);
  assert.equal(Number((await pool.query('SELECT count(*) FROM admtaxi.corridas WHERE empresa_id=$1',[manager.empresaId])).rows[0].count),before);
  assert.equal((await service.list(supervisor))[0]!.id,created.id);
  await assert.rejects(service.get({...manager,empresaId:otherCompany},created.id),{statusCode:404});
  await assert.rejects(service.get({...supervisor,usuarioId:manager.usuarioId},created.id),{statusCode:404});
  await assert.rejects(service.create(gate,input,{}),{statusCode:403});
  await assert.rejects(service.decide(supervisor,created.id,{autorizar:true},{}),{statusCode:403});
  await assert.rejects(service.dispatch(gate,created.id,input.participantes,{}),{statusCode:409});
  await service.decide(manager,created.id,{autorizar:true},{});
  await service.decide(manager,created.id,{autorizar:true},{});
  await assert.rejects(service.decide(manager,created.id,{autorizar:false,motivo:'Mudanca de ideia'},{}),{statusCode:409});
  await assert.rejects(service.dispatch(manager,created.id,input.participantes,{}),{statusCode:403});
  await assert.rejects(service.dispatch(gate,created.id,input.participantes,{}),{statusCode:422});
  const participants=input.participantes.map((p,i)=>({...p,origem:{descricao:`Origem privada ${i}`,latitude:-18.9-i/100,longitude:-48.2},destino:{descricao:`Destino privado ${i}`,latitude:-18.8,longitude:-48.3}}));
  const testPhones=['34997650001','34997650002'];
  for (const [index,phone] of testPhones.entries()) await pool.query('UPDATE admtaxi.funcionarios SET telefone=$2 WHERE id=$1',[employeeIds[index],phone]);
  await pool.query(`INSERT INTO admtaxi.dispositivos_usuario(empresa_id,usuario_id,chave_dispositivo,plataforma,nome_dispositivo,navegador,modo_acesso,notificacoes_status)
    SELECT empresa_id,usuario_id,gen_random_uuid(),'ANDROID','Test','Android WebView (APK)','NAVEGADOR','BLOQUEADA'
    FROM admtaxi.funcionarios WHERE id=$1`,[employeeIds[1]]);
  const results=await Promise.all([service.dispatch(gate,created.id,participants,{},undefined,employeeIds.slice(0,2)),
    service.dispatch(gate,created.id,participants,{},undefined,employeeIds.slice(0,2))]);
  assert.equal(results[0]!.id,results[1]!.id);
  assert.equal(sent.length,1);
  assert.equal(sent[0]!.to,'55'+testPhones[0]);
  assert.deepEqual(sent[0]!.template.components[0]!.parameters.slice(2).map(p=>p.text),['Origem privada 0','Destino privado 0','https://example.test/']);
  const callback=express(), appSecret=randomUUID(), verifyToken=randomUUID();
  callback.use('/webhook',whatsappWebhook({verifyToken,appSecret,phoneNumberId:'123456'},pool));
  await request(callback).get('/webhook').query({'hub.mode':'subscribe','hub.verify_token':verifyToken,'hub.challenge':'9876'}).expect(200,'9876');
  await request(callback).get('/webhook').query({'hub.mode':'subscribe','hub.verify_token':'wrong','hub.challenge':'9876'}).expect(403);
  const statusBody=(status:string,phone='123456')=>JSON.stringify({object:'whatsapp_business_account',entry:[{changes:[{
    field:'messages',value:{metadata:{phone_number_id:phone},statuses:[{id:'wamid.test.1',status,
      biz_opaque_callback_data:sent[0]!.biz_opaque_callback_data}]},
  }]}]});
  const callbackPost=(body:string,signature:string)=>request(callback).post('/webhook').type('json').set('x-hub-signature-256',signature).send(body);
  const signed=(body:string)=>'sha256='+createHmac('sha256',appSecret).update(body).digest('hex');
  await callbackPost(statusBody('read'),'sha256=invalid').expect(403);
  await callbackPost(statusBody('read','99999'),signed(statusBody('read','99999'))).expect(200);
  assert.equal((await pool.query('SELECT status FROM admtaxi.whatsapp_viagem WHERE requisicao_id=$1',[created.id])).rows[0].status,'ACEITO');
  for (const state of ['read','sent','delivered','read']) await callbackPost(statusBody(state),signed(statusBody(state))).expect(200);
  assert.equal((await pool.query('SELECT status FROM admtaxi.whatsapp_viagem WHERE requisicao_id=$1',[created.id])).rows[0].status,'LIDO');
  ok('WHATSAPP conference dedupe, installed APK without push excluded, own passenger addresses, webhook verification and monotonic statuses');
  assert.equal(results[0]!.itinerario?.participantes.length,2);
  assert.equal(Number((await pool.query('SELECT count(*) FROM admtaxi.corridas WHERE empresa_id=$1',[manager.empresaId])).rows[0].count),before+1);
  assert.equal((await service.get(gate,created.id)).status,'SOLICITADA');
  const queue=await pool.query('SELECT * FROM admtaxi.emails_viagem WHERE requisicao_id=$1',[created.id]);
  assert.equal(queue.rows.filter(r=>r.evento==='PENDENTE').length,4);
  assert.equal(queue.rows.filter(r=>r.evento==='AUTORIZADA').length,6);
  assert.equal(queue.rows.filter(r=>r.evento==='SOLICITADA').length,6);
  const email=(await pool.query(`SELECT u.email::text AS email FROM admtaxi.funcionarios f
    JOIN admtaxi.usuarios_autenticacao u ON u.empresa_id=f.empresa_id AND u.id=f.usuario_id WHERE f.id=$1`,[employeeIds[0]])).rows[0].email.toLowerCase();
  const own=queue.rows.find(r=>r.evento==='SOLICITADA'&&r.destinatario===email);
  assert(own); assert(own.corpo.includes('Origem privada 0')); assert(!own.corpo.includes('Origem privada 1'));
  const gateEmail = (await pool.query('SELECT email::text FROM admtaxi.usuarios WHERE id=$1',[gate.usuarioId])).rows[0].email;
  assert(!queue.rows.some(row => row.evento === 'PENDENTE' && row.destinatario === gateEmail));
  assert(queue.rows.some(row => row.evento === 'AUTORIZADA' && row.destinatario === gateEmail));
  assert(queue.rows.some(row => row.evento === 'AUTORIZADA' && row.destinatario === 'supervisor-travel@example.test'));
  assert(!queue.rows.some(row => /^(opt-out|inactive|foreign)-travel@/.test(row.destinatario)));
  const notices = async (id: string, event: string) => (await pool.query(
    'SELECT usuario_id,url_abertura,corpo,status FROM admtaxi.notificacoes_push WHERE chave_deduplicacao LIKE $1',
    [`${manager.empresaId}:${id}:VIAGEM_${event}:%`])).rows;
  const pending = await notices(created.id, 'PENDENTE');
  assert.equal(pending.length, 4); assert(pending.some(row => row.usuario_id === observer));
  assert(!pending.some(row => [gate.usuarioId, supervisor.usuarioId, optedOut, inactive, foreign].includes(row.usuario_id)));
  const approved = await notices(created.id, 'AUTORIZADA');
  assert.equal(approved.length, 6);
  for (const id of [supervisor.usuarioId, gate.usuarioId, observer]) assert(approved.some(row => row.usuario_id === id && row.url_abertura === '/app/requisicoes'));
  const dispatched = await notices(created.id, 'SOLICITADA');
  assert.equal(dispatched.length, 6);
  assert.equal(dispatched.filter(row => row.url_abertura === `/app/corridas/${results[0]!.id}`).length, 2);
  assert(dispatched.every(row => !row.corpo.includes('Origem privada')));
  await new NotificacaoService(pool).processTravelPush();
  assert((await notices(created.id, 'SOLICITADA')).every(row => row.status === 'IGNORADA'));
  ok('TRAVEL-NOTICES email/app recipients, manager preference, no early gate notification, tenant isolation and inbox without Web Push');
  let ride=await rides.accept(driver,results[0]!.id,{veiculoId:vehicle},{});
  let summary=(await service.list(gate)).find(row=>row.id===created.id)!.corridaResumo!;
  assert.equal(summary.status,'ACEITA');assert(summary.motoristaNome);assert.equal(summary.paradasConcluidas,0);
  assert.deepEqual(Object.keys(summary).sort(),['motoristaNome','paradasConcluidas','paradasTotal','passageirosAusentes','status'].sort());
  assert.equal((await service.get(supervisor,created.id)).corridaResumo,undefined);
  assert.equal((await service.get(supervisor,created.id)).corridaStatus,'ACEITA');
  assert.equal((await service.list(manager)).find(row=>row.id===created.id)?.corridaResumo,undefined);
  assert(!((await service.list({...gate,empresaId:otherCompany})).some(row=>row.id===created.id)));
  while(ride.itinerario!.paradas.some(s=>s.estado!=='CONCLUIDA')) {
    const stop=ride.itinerario!.paradas.find(s=>s.estado!=='CONCLUIDA')!;
    const person=ride.itinerario!.participantes.find(p=>p.embarqueId===stop.id||p.desembarqueId===stop.id)!;
    const action=stop.estado==='PENDENTE'?'INICIAR':stop.estado==='EM_DESLOCAMENTO'?'CHEGAR':person.embarqueId===stop.id?'EMBARCAR':'DESEMBARCAR';
    ride=await rides.executeItinerary(driver,ride.id,{chave:randomUUID(),versao:ride.itinerario!.versao,paradaId:stop.id,
      acao:action,funcionarioId:person.funcionarioId,avancoAutomatico:true},{});
    summary=(await service.get(gate,created.id)).corridaResumo!;
    assert.equal(summary.status,ride.status);
    assert.equal(summary.paradasConcluidas,ride.itinerario!.paradas.filter(stop=>stop.estado==='CONCLUIDA').length);
  }
  await rides.finish(driver,ride.id,{valorFinal:'20.00'},{}); await rides.finish(driver,ride.id,{valorFinal:'20.00'},{});
  summary=(await service.get(gate,created.id)).corridaResumo!;
  assert.equal(summary.status,'FINALIZADA');assert.equal(summary.paradasConcluidas,summary.paradasTotal);
  for(const auth of [supervisor,manager,gate]) {
    assert.equal((await service.get(auth,created.id)).corridaStatus,'FINALIZADA');
    assert.equal((await service.list(auth)).find(row=>row.id===created.id)?.corridaStatus,'FINALIZADA');
  }
  assert(rideChanges.filter(id=>id===ride.id).length>5);
  ok('REQUISITIONS-LIVE post-commit events, restricted portaria summary, driver acceptance, itinerary progress, completion and tenant isolation');
  assert.equal((await pool.query("SELECT count(*) FROM admtaxi.emails_viagem WHERE requisicao_id=$1 AND evento='FINALIZADA'",[created.id])).rows[0].count,'6');
  assert.equal((await notices(created.id, 'FINALIZADA')).length,6);
  const auto=await service.create(manager,{...input,chave:randomUUID(),participantes:[participants[0]!]},{ });
  assert.equal(auto.status,'AUTORIZADA');
  await assert.rejects(service.dispatch(gate,auto.id,[{...participants[0]!,origem:{...participants[0]!.origem,descricao:'Alterado indevidamente'}}],{}),{statusCode:409});
  const rejected=await service.create(supervisor,{...input,chave:randomUUID()},{});
  await service.decide(manager,rejected.id,{autorizar:false,motivo:'Sem necessidade operacional'},{});
  const rejection = await notices(rejected.id, 'REJEITADA');
  assert.equal(rejection.length,5); assert(rejection.some(row => row.usuario_id === supervisor.usuarioId));
  assert(!rejection.some(row => row.usuario_id === gate.usuarioId));
  await assert.rejects(service.dispatch(gate,rejected.id,participants,{}),{statusCode:409});
  const failing=new RequisitionService(pool,{record:async()=>{throw Error('audit unavailable');}},rides,emails,bus);
  const eventCount=changes.length;
  await assert.rejects(failing.create(manager,{...input,chave:randomUUID()},{}),/audit unavailable/);
  assert.equal(changes.length,eventCount);
  ok('REQUISITIONS optional addresses, supervisor scope, approval, rejection, manager auto-authorization, conference-only release and atomic idempotency');

  const tokens=new TokenService({jwtAccessSecret:randomUUID()+randomUUID(),jwtRefreshSecret:randomUUID()+randomUUID(),jwtAccessExpiresInSeconds:900,jwtRefreshExpiresInSeconds:3600});
  const app=express();app.use(express.json());app.use('/requisicoes',createAuthenticate(tokens),requisitionRouter(service,access));app.use('/corridas',createAuthenticate(tokens),createCorridaRouter(rides));app.use(createErrorHandler(logger));
  const bearer=(auth:AuthContext)=>`Bearer ${tokens.issueTokens(auth).accessToken}`;
  for(const auth of [manager,supervisor,driver]) {
    await request(app).get(`/requisicoes/${created.id}/acessos`).set('Authorization',bearer(auth)).expect(403);
    await request(app).post(`/requisicoes/${created.id}/acessos/${employeeIds[0]}/whatsapp`).set('Authorization',bearer(auth)).send({}).expect(403);
  }
  await request(app).get(`/requisicoes/${created.id}/acessos`).set('Authorization',bearer(gate)).expect('Cache-Control','no-store').expect(200);
  await request(app).get(`/requisicoes/${created.id}/acessos`).set('Authorization',bearer({...gate,empresaId:otherCompany})).expect(404);
  await request(app).get(`/requisicoes/${auto.id}/acessos`).set('Authorization',bearer(gate)).expect(409);
  await request(app).post(`/requisicoes/${created.id}/acessos/${employeeIds[0]}/whatsapp`).set('Authorization',bearer(gate)).send({telefone:'11999999999'}).expect(422);
  for(const auth of [manager,supervisor,gate]) await request(app).post('/corridas').set('Authorization',bearer(auth)).send({}).expect(403);
  await request(app).post('/requisicoes').set('Authorization',bearer(gate)).send(input).expect(403);
  await request(app).post(`/requisicoes/${auto.id}/decisao`).set('Authorization',bearer(gate)).send({autorizar:true}).expect(403);
  await request(app).post(`/requisicoes/${auto.id}/solicitar`).set('Authorization',bearer(manager)).send({participantes:participants}).expect(403);
  await request(app).get('/requisicoes').set('Authorization',bearer({...manager,perfil:'PRESTADOR'})).expect(403);
  const gateList=await request(app).get('/requisicoes').set('Authorization',bearer(gate)).expect(200);
  assert.equal(gateList.body.data.find((row:{id:string})=>row.id===created.id).corridaResumo.status,'FINALIZADA');
  await request(app).get(`/corridas/${ride.id}`).set('Authorization',bearer(gate)).expect(403);
  await request(app).post('/requisicoes').set('Authorization',bearer(supervisor)).send({...input,chave:randomUUID(),empresaId:otherCompany}).expect(422);
  await request(app).post(`/requisicoes/${created.id}/decisao`).set('Authorization',bearer(manager)).send({autorizar:false}).expect(422);
  ok('REQUISITIONS HTTP boundaries prevent bypass, tenant injection, driver access and unauthorized decision/release');

  const parcelInput = {
    chave: randomUUID(), tipo: 'IMEDIATA', participantes: [],
    encomenda: { tipo: 'RETIRADA', descricao: 'Envelope lacrado', centroCustoId: center, empresaOrigem: '  Empresa de teste  ',
      origem: participants[0]!.origem, destino: participants[0]!.destino },
  };
  const postParcel = (auth: AuthContext, data: object) => request(app).post('/requisicoes')
    .set('Authorization',bearer(auth)).send(data);
  await postParcel(supervisor,{...parcelInput,participantes:[participants[0]]}).expect(422);
  await postParcel(supervisor,{...parcelInput,encomenda:{...parcelInput.encomenda,empresaOrigem:'A'.repeat(151)}}).expect(422);
  await postParcel(supervisor,{...parcelInput,encomenda:{...parcelInput.encomenda,centroCustoId:randomUUID()}}).expect(403);
  await postParcel(gate,parcelInput).expect(403);
  await pool.query("UPDATE admtaxi.empresas SET modo_cobranca='MENSAL_FIXO' WHERE id=$1", [manager.empresaId]);
  const parcelRequest = (await postParcel(supervisor,parcelInput).expect(201)).body.data;
  assert.equal(parcelRequest.status,'PENDENTE');
  await assert.rejects(service.dispatch(gate,parcelRequest.id,[],{}),{statusCode:409});
  await service.decide(manager,parcelRequest.id,{autorizar:true},{});
  await assert.rejects(service.dispatch(gate,parcelRequest.id,[],{},'20.00'),{statusCode:422});
  const parcelRide = await service.dispatch(gate,parcelRequest.id,[],{});
  assert.equal((await service.dispatch(gate,parcelRequest.id,[],{})).id,parcelRide.id);
  assert.equal(parcelRide.funcionarioId,null); assert.equal(parcelRide.quantidadePassageiros,0);
  assert.equal(parcelRide.centroCustoId,center); assert.equal(parcelRide.encomenda?.tipo,'RETIRADA');
  assert.equal(parcelRide.encomenda?.empresaOrigem,'Empresa de teste');
  assert.equal((await rides.list(driver,{pagina:1,limite:20,grupo:'FILA',busca:'Envelope'})).data[0]?.id,parcelRide.id);
  const passengerUser = (await pool.query('SELECT usuario_id FROM admtaxi.funcionarios WHERE empresa_id=$1 AND id=$2',
    [manager.empresaId,employeeIds[0]])).rows[0]?.usuario_id;
  await assert.rejects(rides.get({...manager,perfil:'FUNCIONARIO',usuarioId:passengerUser},parcelRide.id),{statusCode:404});
  await rides.accept(driver,parcelRide.id,{veiculoId:vehicle},{});
  await rides.startDisplacement(driver,parcelRide.id,{});
  await rides.arrive(driver,parcelRide.id,{});
  await rides.board(driver,parcelRide.id,{});
  assert.equal((await service.get(gate,parcelRequest.id)).corridaResumo?.paradasConcluidas,1);
  await assert.rejects(rides.finish(driver,parcelRide.id,{},{}),{statusCode:409});
  await rides.disembark(driver,parcelRide.id,{});
  await assert.rejects(rides.cancel(driver,parcelRide.id,{motivo:'Entrega concluida'},{}),{statusCode:409});
  await rides.finish(driver,parcelRide.id,{},{});
  assert.equal((await service.get(gate,parcelRequest.id)).corridaResumo?.paradasConcluidas,2);
  assert.equal((await pool.query('SELECT count(*) FROM admtaxi.corrida_participacoes WHERE corrida_id=$1',[parcelRide.id])).rows[0].count,'0');
  assert((await pool.query("SELECT assunto,corpo FROM admtaxi.emails_viagem WHERE requisicao_id=$1 AND evento='FINALIZADA'",
    [parcelRequest.id])).rows.some(row=>row.assunto==='Encomenda concluída' && row.corpo.includes('Envelope lacrado')
      && row.corpo.includes('Empresa de retirada: Empresa de teste')));
  ok('PARCEL approval, scoped cost center, idempotent gate dispatch, driver queue/search, collection, delivery, completion and internal notifications');

  const interrupted = await service.create(manager,requisicaoSchema.parse({...parcelInput,chave:randomUUID(),
    encomenda:{...parcelInput.encomenda,tipo:'ENVIO'}}),{});
  assert.equal(interrupted.status,'AUTORIZADA');
  const undelivered = await service.dispatch(gate,interrupted.id,[],{});
  await rides.accept(driver,undelivered.id,{veiculoId:vehicle},{});
  await rides.startDisplacement(driver,undelivered.id,{});
  await rides.arrive(driver,undelivered.id,{});
  assert.equal((await rides.cancel(driver,undelivered.id,{motivo:'Objeto indisponivel na origem'},{})).status,'CANCELADA');
  await assert.rejects(rides.cancel(driver,ride.id,{motivo:'Nao pode cancelar viagem comum'},{}),{statusCode:403});
  await pool.query("UPDATE admtaxi.corridas SET finalizada_em='2024-03-12 12:00-03' WHERE id=$1", [parcelRide.id]);
  await pool.query('UPDATE admtaxi.prestadores SET valor_mensal_fixo=1200 WHERE empresa_id=$1 AND id=$2',
    [manager.empresaId,ride.prestadorId]);
  const billing = new MonthlyBillingService(pool,audit);
  const period = {prestadorId:ride.prestadorId!,competencia:'2024-03'};
  const preview = await billing.preview(manager,period);
  assert.equal(preview.quantidadeCorridas,1);
  assert.equal(preview.porCentroCusto[0]?.corridasEquivalentes,1);
  assert.equal(preview.porCentroCusto[0]?.id,center);
  const invoice = await billing.close(manager,{...period,previsaoHash:preview.previsaoHash},{});
  const detail = await pool.query(`SELECT a.funcionario_id,a.centro_custo_id,a.valor::text
    FROM admtaxi.faturamento_custos a JOIN admtaxi.faturamento_itens i ON i.empresa_id=a.empresa_id AND i.id=a.item_id
    WHERE i.faturamento_id=$1`,[invoice]);
  assert.deepEqual(detail.rows,[{funcionario_id:null,centro_custo_id:center,valor:'1200.00'}]);
  const allocation = monthlyAllocation('120.00',[
    {corridaId:'parcel',funcionarioId:null,centroCustoId:center,codigo:'C',nome:'Centro'},
    {corridaId:'travel',funcionarioId:'p1',centroCustoId:'other',codigo:'O',nome:'Outro'},
    {corridaId:'travel',funcionarioId:'p2',centroCustoId:'other',codigo:'O',nome:'Outro'},
  ]);
  assert.equal(allocation.find(row=>row.corridaId==='parcel')?.valor,'60.00');
  assert(allocation.filter(row=>row.corridaId==='travel').every(row=>row.valor==='30.00'));
  await pool.query("UPDATE admtaxi.empresas SET modo_cobranca='MANUAL' WHERE id=$1", [manager.empresaId]);
  const manual = await service.create(manager,requisicaoSchema.parse({...parcelInput,chave:randomUUID()}),{});
  await assert.rejects(service.dispatch(gate,manual.id,[],{}),{statusCode:422});
  const manualRide = await service.dispatch(gate,manual.id,[],{},'25.00');
  assert.equal(manualRide.valorEstimado,'25.00');
  await rides.cancel(manager,manualRide.id,{motivo:'Encerramento do teste manual'},{});
  ok('PARCEL unsuccessful delivery exclusion, monthly closing without fake passenger and manual dispatch value');

  const held = await service.create(supervisor,{...input,chave:randomUUID()},{});
  assert.equal(held.status,'PENDENTE');
  await pool.query('UPDATE admtaxi.empresas SET exige_aprovacao_gestor=FALSE WHERE id=$1',[manager.empresaId]);
  const noApprovalTravel = await service.create(supervisor,{...input,chave:randomUUID()},{});
  const noApprovalParcel = await service.create(supervisor,requisicaoSchema.parse({...parcelInput,chave:randomUUID()}),{});
  for (const automatic of [noApprovalTravel,noApprovalParcel]) {
    assert.equal(automatic.status,'AUTORIZADA');
    assert.equal(automatic.decisor_id,null);
    assert.equal(automatic.corrida_id,null);
    const records = (await pool.query('SELECT evento,assunto,destinatario FROM admtaxi.emails_viagem WHERE requisicao_id=$1',
      [automatic.id])).rows;
    assert(records.some(record=>record.destinatario===gateEmail && /aguardando conferência/.test(record.assunto)));
    assert(!records.some(record=>record.evento==='PENDENTE'));
  }
  assert.equal((await service.get(supervisor,held.id)).status,'PENDENTE');
  await assert.rejects(service.dispatch(supervisor,noApprovalParcel.id,[],{},'25.00'),{statusCode:403});
  const released = await service.dispatch(gate,noApprovalParcel.id,[],{},'25.00');
  await rides.cancel(manager,released.id,{motivo:'Encerramento do teste de conferencia'},{});
  await pool.query('UPDATE admtaxi.empresas SET exige_aprovacao_gestor=TRUE WHERE id=$1',[manager.empresaId]);
  assert.equal((await service.create(supervisor,{...input,chave:randomUUID()},{})).status,'PENDENTE');
  ok('APPROVAL-POLICY new supervisor travel/parcel requests skip manager when disabled; gate remains mandatory and old requests stay pending');

  assert.equal(await emails.process(),0);
  const failingWorker=new TravelEmails(pool,logger,{send:async()=>{throw Error('SMTP unavailable');}});
  await failingWorker.process();
  assert(Number((await pool.query("SELECT count(*) FROM admtaxi.emails_viagem WHERE tentativas=1 AND status='PENDENTE' AND ultimo_erro='FALHA_SMTP'")).rows[0].count)>0);
  await pool.query("UPDATE admtaxi.emails_viagem SET proxima_tentativa_em=CURRENT_TIMESTAMP WHERE status='PENDENTE'");
  const sentEmails:string[]=[];
  const worker=new TravelEmails(pool,logger,{send:async message=>{sentEmails.push(message.id);}});
  for(let n=0;n<5;n++) if(await worker.process()<20)break;
  assert.equal(new Set(sentEmails).size,sentEmails.length);assert(sentEmails.length>0);
  assert.equal((await pool.query("SELECT count(*) FROM admtaxi.emails_viagem WHERE status<>'ENVIADO'")).rows[0].count,'0');
  ok('TRAVEL-EMAIL recipient privacy, all four stages, unique notifications, SMTP retry, missing SMTP retention and successful retry');
}
