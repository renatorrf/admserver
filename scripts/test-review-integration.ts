import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { AuditRepository } from '../src/modules/auditoria/audit.repository';
import { CorridaService } from '../src/modules/corridas/corrida.service';
import { RideRouteOptimizer } from '../src/modules/corridas/route-optimizer';
import { corridaCreateSchema } from '../src/modules/corridas/corrida.schemas';
import type { AuthContext } from '../src/modules/auth/auth.types';
import type { ItineraryAction } from '../src/modules/corridas/itinerary';
import express from 'express';
import request from 'supertest';
import pino from 'pino';
import { createCorridaRouter } from '../src/modules/corridas/corrida.routes';
import { createErrorHandler } from '../src/shared/http/error-handler';
import { createAuthenticate } from '../src/modules/auth/auth.middleware';
import { TokenService } from '../src/modules/auth/token-service';
import { FaturamentoService } from '../src/modules/faturamentos/faturamento.service';
import { MonthlyBillingService } from '../src/modules/faturamentos/monthly-billing.service';
import { PainelParticipanteRepository } from '../src/modules/paineis/painel.repository';
import { RelatorioRepository } from '../src/modules/relatorios/relatorio.repository';
import { DashboardRepository } from '../src/modules/dashboard/dashboard.repository';
import { EmpresaService } from '../src/modules/empresas/empresa.service';
import { OperacaoRepository } from '../src/modules/operacao/operacao.repository';
import { MasterService } from '../src/modules/master/master.service';
import { MasterTokenService } from '../src/modules/master/master-token.service';
import { ProvisionamentoService } from '../src/modules/provisionamento/provisionamento.service';
import { PgAuthRepository } from '../src/modules/auth/auth.repository';
import { AuthService } from '../src/modules/auth/auth.service';
import { PasswordService } from '../src/modules/auth/password.service';
import { ManagerLoginService } from '../src/modules/auth/manager-login.service';
import { createAuthRouter } from '../src/modules/auth/auth.routes';
import { PrestadorUnificadoService } from '../src/modules/prestadores/prestador-unificado.service';
import { prestadorUnificadoCreateSchema } from '../src/modules/prestadores/prestador-unificado.schemas';
import { createPrestadorUnificadoRouter } from '../src/modules/prestadores/prestador-unificado.routes';
import { testSharedDriverAccounts } from './test-shared-driver-accounts';
import { testSharedEmployeeAccounts } from './test-shared-employee-accounts';
import { testScheduledEmails } from './test-scheduled-emails';
import { UsuarioService } from '../src/modules/usuarios/usuario.service';
import { NotificacaoService } from '../src/modules/notificacoes/notificacao.service';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function main(): Promise<void> {
  // No DATABASE_URL is read. Every connection targets this newly created local cluster.
  const root = path.resolve('.artifacts');
  const directory = path.join(root, `review-pg-${randomUUID()}`);
  assert(directory.startsWith(`${root}${path.sep}`));
  await mkdir(root, { recursive: true });
  const port = await freePort();
  const password = randomUUID();
  const embedded = new EmbeddedPostgres({ databaseDir: directory, port, user: 'postgres', password,
    persistent: true, postgresFlags: ['-h', '127.0.0.1'], onLog: () => undefined, onError: () => undefined });
  let pool: Pool | undefined;
  let started = false;
  let checks = 0;
  const ok = (label: string): void => { checks++; console.log(`PASS ${label}`); };
  try {
    await embedded.initialise();
    await embedded.start(); started = true;
    pool = new Pool({ host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres', max: 8 });
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS citext; CREATE SCHEMA admtaxi');
    await pool.query(`CREATE TABLE admtaxi.schema_migrations (
      versao INTEGER PRIMARY KEY,nome TEXT NOT NULL,checksum CHAR(64) NOT NULL,aplicada_em TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`);
    const files = (await readdir('src/db/migrations')).filter(f => /^\d+_.+\.up\.sql$/.test(f)).sort();
    for (const file of files.filter(f => Number(f.slice(0, 3)) < 13)) {
      const sql = await readFile(path.join('src/db/migrations', file), 'utf8');
      await pool.query(sql);
      await pool.query('INSERT INTO admtaxi.schema_migrations(versao,nome,checksum) VALUES ($1,$2,$3)',
        [Number(file.slice(0, 3)), file.slice(4, -7), createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex')]);
    }
    const company = randomUUID(), otherCompany = randomUUID(), center = randomUUID(), sector = randomUUID();
    const manager: AuthContext = { usuarioId: randomUUID(), empresaId: company, perfil: 'GESTOR' };
    const providerIds = [randomUUID(), randomUUID()];
    const drivers: AuthContext[] = [0, 1].map(() => ({ usuarioId: randomUUID(), empresaId: company, perfil: 'PRESTADOR' }));
    const employeeIds = Array.from({ length: 5 }, () => randomUUID());
    const employees: AuthContext[] = employeeIds.map(() => ({ usuarioId: randomUUID(), empresaId: company, perfil: 'FUNCIONARIO' }));
    const vehicles = [randomUUID(), randomUUID()];
    for (const [i, id] of [company, otherCompany].entries()) await pool.query(
      'INSERT INTO admtaxi.empresas(id,codigo_acesso,razao_social,nome_fantasia) VALUES($1,$2,$3,$3)', [id, `test_${i}`, `Empresa sintetica ${i}`]);
    for (const [i, user] of [manager, ...drivers, ...employees].entries()) await pool.query(
      `INSERT INTO admtaxi.usuarios(id,empresa_id,nome,email,senha_hash,perfil) VALUES($1,$2,$3,$4,'synthetic-not-a-login-hash',$5)`,
      [user.usuarioId, company, `Usuario sintetico ${i}`, `review${i}@example.invalid`, user.perfil]);
    await pool.query('INSERT INTO admtaxi.setores(id,empresa_id,codigo,nome) VALUES($1,$2,$3,$4)', [sector, company, 'TEST', 'Setor sintetico']);
    await pool.query('INSERT INTO admtaxi.centros_custo(id,empresa_id,setor_id,codigo,nome) VALUES($1,$2,$3,$4,$5)', [center, company, sector, 'TEST', 'Centro sintetico']);
    for (const [i, id] of employeeIds.entries()) await pool.query(
      `INSERT INTO admtaxi.funcionarios(id,empresa_id,usuario_id,centro_custo_id,nome,matricula) VALUES($1,$2,$3,$4,$5,$6)`,
      [id, company, employees[i]!.usuarioId, center, `Passageiro sintetico ${i}`, `TEST${i}`]);
    for (const [i, id] of providerIds.entries()) {
      await pool.query(`INSERT INTO admtaxi.prestadores(id,empresa_id,usuario_id,nome,cpf,telefone,numero_cnh,validade_cnh,disponivel)
        VALUES($1,$2,$3,$4,$5,$7,$6,'2030-01-01',true)`,
      [id, company, drivers[i]!.usuarioId, `Prestador sintetico ${i}`, `1234567890${i}`, `TEST${i}`, `1199999999${i}`]);
      await pool.query(`INSERT INTO admtaxi.veiculos(id,empresa_id,prestador_id,placa,marca,modelo,cor,ano,capacidade_passageiros)
        VALUES($1,$2,$3,$4,'Teste','Teste','Teste',2026,4)`, [vehicles[i], company, id, `TST1A0${i}`]);
    }
    const legacyId = randomUUID();
    await pool.query(`INSERT INTO admtaxi.corridas(id,empresa_id,solicitante_usuario_id,funcionario_id,centro_custo_id,tipo,origem_descricao,destino_descricao)
      VALUES($1,$2,$3,$4,$5,'IMEDIATA','Origem historica','Destino historico')`, [legacyId, company, manager.usuarioId, employeeIds[0], center]);
    await pool.query('BEGIN');
    await pool.query(`INSERT INTO admtaxi.usuarios(empresa_id,nome,email,senha_hash,perfil)
      VALUES($1,' USUARIO   SINTETICO 0 ','preflight@example.test','synthetic','FUNCIONARIO')`, [company]);
    await assert.rejects(pool.query(await readFile('src/db/migrations/019_cadastros_sem_duplicidade.up.sql', 'utf8')), /Migration 019 bloqueada/);
    await pool.query('ROLLBACK');
    assert.equal((await pool.query("SELECT count(*) FROM pg_proc WHERE proname='normalizar_cadastro'")).rows[0].count, '0');
    ok('DUPLICATES migration refuses historical conflicts and rolls back without changing data');
    const migrate = (): void => {
      const result = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/db/migrate.ts', 'up'], {
        env: { ...process.env, DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:${port}/postgres?sslmode=disable` }, encoding: 'utf8', windowsHide: true,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    };
    migrate(); migrate();
    assert.equal((await pool.query(`SELECT count(*) FROM admtaxi.usuarios u JOIN admtaxi.contas_funcionario c ON c.id=u.conta_funcionario_id
      WHERE u.perfil='FUNCIONARIO' AND (u.senha_hash<>c.senha_hash OR u.senha_versao<>c.senha_versao OR u.deve_alterar_senha<>c.deve_alterar_senha)`)).rows[0].count, '0');
    assert.equal((await pool.query('SELECT COUNT(*) FROM admtaxi.schema_migrations WHERE versao=18')).rows[0].count, '1');
    const companies = new EmpresaService(pool, new AuditRepository(pool));
    const operations = new OperacaoRepository(pool);
    assert.equal(await operations.getCompanyAddress(manager), null);
    const companyAddress = { endereco: 'Rua da Empresa, 100', enderecoLatitude: 0, enderecoLongitude: -48.2 };
    const updatedCompany = await companies.updateCurrent(manager, { ...companyAddress, latitudePadrao: -18.9, longitudePadrao: -48.25 }, { ip: null, userAgent: null });
    assert.equal(updatedCompany.endereco, companyAddress.endereco);
    assert.equal(updatedCompany.enderecoLatitude, 0);
    assert.equal((await operations.getCompanyAddress(manager))?.longitude, -48.2);
    assert.deepEqual(await operations.getMapLocation(manager), { latitudePadrao: 0, longitudePadrao: -48.2 });
    assert.equal((await companies.getCurrent(manager)).latitudePadrao, -18.9);
    assert.equal(await operations.getCompanyAddress({ ...manager, empresaId: otherCompany }), null);
    await assert.rejects(pool.query('UPDATE admtaxi.empresas SET endereco_latitude=NULL WHERE id=$1', [company]), { code: '23514' });
    await companies.updateCurrent(manager, { endereco: null, enderecoLatitude: null, enderecoLongitude: null }, { ip: null, userAgent: null });
    assert.equal(await operations.getCompanyAddress(manager), null);
    assert.deepEqual(await operations.getMapLocation(manager), { latitudePadrao: -18.9, longitudePadrao: -48.25 });
    assert.equal((await companies.getCurrent(manager)).latitudePadrao, -18.9);
    ok('COMPANY-ADDRESS migration, tenant isolation, null/zero coordinates, clearing and independent map position');
    const masterContext = { administradorId: randomUUID(), usuario: 'test-master', deveAlterarSenha: false, senhaVersao: 0 };
    await pool.query(`INSERT INTO admtaxi.administradores_plataforma(id,usuario,nome,senha_hash,deve_alterar_senha)
      VALUES($1,'test-master','Master teste','synthetic-hash',FALSE)`, [masterContext.administradorId]);
    const masterService = new MasterService(pool, new MasterTokenService(randomUUID() + randomUUID()), new ProvisionamentoService(pool));
    const authRepository = new PgAuthRepository(pool);
    const authState = await authRepository.findById(manager);
    assert(authState);
    const liveAuth = { ...manager, senhaVersao: authState.senhaVersao, deveAlterarSenha: authState.deveAlterarSenha };
    const originalCompany = await masterService.getCompany(masterContext, company);
    await masterService.updateCompany(masterContext, company, { nomeFantasia: 'Empresa editada', ...companyAddress }, { ip: null, userAgent: null });
    assert.equal((await masterService.getCompany(masterContext, company)).nomeFantasia, 'Empresa editada');
    assert.equal((await masterService.getCompany(masterContext, otherCompany)).nomeFantasia, 'Empresa sintetica 1');
    assert(await authRepository.accessAllowed(liveAuth));
    await masterService.setCompanyActive(masterContext, company, false, { ip: null, userAgent: null });
    assert.equal(await authRepository.accessAllowed(liveAuth), false);
    assert(!(await authRepository.listActiveCompanies()).some(e => e.codigoAcesso === originalCompany.codigoAcesso));
    assert.equal((await masterService.listCompanies(masterContext)).find(e => e.id === company)?.ativo, false);
    await masterService.setCompanyActive(masterContext, company, true, { ip: null, userAgent: null });
    assert(await authRepository.accessAllowed(liveAuth));
    assert.equal((await pool.query('SELECT COUNT(*) FROM admtaxi.auditoria_plataforma WHERE entidade_id=$1', [company])).rows[0].count, '3');
    await assert.rejects(masterService.updateCompany(masterContext, company, { codigoAcesso: 'test_1', nomeFantasia: 'Nao persistir' }, { ip: null, userAgent: null }), { code: '23505' });
    assert.equal((await masterService.getCompany(masterContext, company)).nomeFantasia, 'Empresa editada');
    await assert.rejects(masterService.getCompany(masterContext, randomUUID()));
    await assert.rejects(masterService.setCompanyActive(masterContext, randomUUID(), false, { ip: null, userAgent: null }));
    await pool.query('UPDATE admtaxi.administradores_plataforma SET ativo=FALSE WHERE id=$1', [masterContext.administradorId]);
    await assert.rejects(masterService.setCompanyActive(masterContext, company, false, { ip: null, userAgent: null }));
    assert.equal((await companies.getCurrent(manager)).ativo, true);
    ok('MASTER-COMPANY edit/status audit, rollback, tenant preservation and inactive access denial');
    assert.equal((await pool.query('SELECT COUNT(*) FROM admtaxi.schema_migrations WHERE versao=13')).rows[0].count, '1');
    const service = new CorridaService(pool, new AuditRepository(pool));
    const tokens = new TokenService({ jwtAccessSecret: randomUUID() + randomUUID(), jwtRefreshSecret: randomUUID() + randomUUID(),
      jwtAccessExpiresInSeconds: 900, jwtRefreshExpiresInSeconds: 3600 });
    const app = express(); app.use(express.json());
    app.use('/corridas', createAuthenticate(tokens), createCorridaRouter(service));
    app.use(createErrorHandler(pino({ level: 'silent' })));
    const bearer = (auth: AuthContext): string => `Bearer ${tokens.issueTokens(auth).accessToken}`;
    await request(app).get(`/corridas/${legacyId}`).expect(401);
    await request(app).get(`/corridas/${legacyId}`).set('Authorization', bearer({ ...manager, empresaId: otherCompany })).expect(404);
    await request(app).post('/corridas').set('Authorization', bearer(employees[0]!)).send({}).expect(403);
    const invalid = await request(app).post('/corridas').set('Authorization', bearer(manager)).send({}).expect(422);
    assert.equal(invalid.body.erro.codigo, 'DADOS_INVALIDOS');
    ok('AUTH-01/03 FORM-01 authenticated HTTP authorization and validation');
    assert.equal((await service.get(manager, legacyId)).itinerarioVersao, 0);
    ok('MIG-01 historical ride and repeated migration runner');
    const secondCenter = randomUUID();
    await pool.query('INSERT INTO admtaxi.centros_custo(id,empresa_id,setor_id,codigo,nome) VALUES($1,$2,$3,$4,$5)',
      [secondCenter, company, sector, 'TEST2', 'Segundo centro']);
    await pool.query('UPDATE admtaxi.funcionarios SET centro_custo_id=$2 WHERE id=$1', [employeeIds[1], secondCenter]);

    const stops = Array.from({ length: 4 }, (_, i) => ({ id: randomUUID(), descricao: `Ponto sintetico ${i}`, latitude: i, longitude: i }));
    const input = corridaCreateSchema.parse({ chaveSolicitacao: randomUUID(), funcionarioId: employeeIds[0], centroCustoId: center,
      tipo: 'IMEDIATA', quantidadePassageiros: 2, origemDescricao: 'Inicio sintetico', destinoDescricao: 'Fim sintetico',
      itinerario: { paradas: stops, participantes: [
        { funcionarioId: employeeIds[0], embarqueId: stops[0]!.id, desembarqueId: stops[2]!.id, centroCustoId: center, valor: '12.30' },
        { funcionarioId: employeeIds[1], embarqueId: stops[1]!.id, desembarqueId: stops[3]!.id, centroCustoId: secondCenter, valor: '7.70' },
      ] } });
    const [a, b] = await Promise.all([service.create(manager, input, {}), service.create(manager, input, {})]);
    assert.equal(a.id, b.id);
    assert.equal((await pool.query('SELECT COUNT(*) FROM admtaxi.corrida_eventos WHERE corrida_id=$1', [a.id])).rows[0].count, '1');
    ok('FORM-04 concurrent create retry has one ride/event');
    assert.equal(a.valorEstimado, '20.00');
    assert.equal(a.itinerario?.participantes.find(p => p.funcionarioId === employeeIds[1])?.centroCustoId, secondCenter);
    const limited = new CorridaService(pool, new AuditRepository(pool), undefined, undefined, undefined,
      { resolve: async () => ({ kind: 'GERENTE', empresaId: company, usuarioId: manager.usuarioId, setorIds: [sector], centroCustoIds: [center] }) });
    await assert.rejects(limited.create({ ...manager, perfil: 'GERENTE' }, { ...input, chaveSolicitacao: randomUUID() }, {}), { statusCode: 403 });
    await assert.rejects(limited.get({ ...manager, perfil: 'GERENTE' }, a.id), { statusCode: 404 });
    const invalidCenter = structuredClone(input);
    invalidCenter.chaveSolicitacao = randomUUID(); invalidCenter.itinerario!.participantes[1]!.centroCustoId = randomUUID();
    await assert.rejects(service.create(manager, invalidCenter, {}), { statusCode: 422 });
    ok('COST-01 individual amounts and centers; manager and foreign-reference boundaries');
    await assert.rejects(service.get({ ...manager, empresaId: otherCompany }, a.id), { statusCode: 404 });
    const privateView = await service.get(employees[1]!, a.id);
    assert.equal(privateView.itinerario?.participantes.length, 1);
    assert.equal(privateView.itinerario?.paradas[0]?.id, stops[1]!.id);
    assert(!('valorFinal' in privateView));
    assert(!('valor' in privateView.itinerario!.participantes[0]!));
    ok('AUTH-03 cross-company denial and participant projection');
    const edits = await Promise.allSettled([service.editItinerary(manager, a.id, 1, input.itinerario!, {}), service.editItinerary(manager, a.id, 1, input.itinerario!, {})]);
    assert.equal(edits.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(edits.filter(r => r.status === 'rejected').length, 1);
    ok('TRIP-13 concurrent edits cannot overwrite');
    await pool.query('UPDATE admtaxi.veiculos SET capacidade_passageiros=1 WHERE id=$1', [vehicles[0]]);
    await assert.rejects(service.accept(drivers[0]!, a.id, { veiculoId: vehicles[0] }, {}), { statusCode: 409 });
    assert.equal((await service.get(manager, a.id)).status, 'SOLICITADA');
    await pool.query('UPDATE admtaxi.veiculos SET capacidade_passageiros=4 WHERE id=$1', [vehicles[0]]);
    ok('TRIP-06 capacity rejection rolls back');
    const accepts = await Promise.allSettled(drivers.map((driver, i) => service.accept(driver, a.id, { veiculoId: vehicles[i] }, {})));
    assert.equal(accepts.filter(r => r.status === 'fulfilled').length, 1);
    let ride = await service.get(manager, a.id);
    const winningIndex = providerIds.indexOf(ride.prestadorId!);
    const driver = drivers[winningIndex]!;
    await service.accept(driver, a.id, { veiculoId: vehicles[winningIndex] }, {});
    assert.equal((await pool.query("SELECT COUNT(*) FROM admtaxi.corrida_eventos WHERE corrida_id=$1 AND tipo_evento='CORRIDA_ACEITA'", [a.id])).rows[0].count, '1');
    ok('TRIP-12 concurrent accept and same-driver retry');
    const optimizationPosition = { latitude: -18.91, longitude: -48.27, versao: ride.itinerarioVersao! };
    let optimizationCalls = 0;
    let beforePlan: (() => Promise<void>) | undefined;
    let stopOrder = [stops[1]!.id, stops[3]!.id, stops[0]!.id, stops[2]!.id];
    const optimizer = new RideRouteOptimizer('synthetic-key', async () => {
      optimizationCalls++;
      await beforePlan?.();
      const actions = stopOrder.flatMap(id => ride.itinerario!.participantes.flatMap((p, shipment_index) =>
        p.embarqueId === id ? [{ type: 'pickup', shipment_index }] : p.desembarqueId === id ? [{ type: 'delivery', shipment_index }] : []));
      return new Response(JSON.stringify({ features: [{ properties: { agent_index: 0, actions } }] }));
    });
    await assert.rejects(service.optimizeRoute(manager, a.id, optimizationPosition, optimizer, {}), { statusCode: 403 });
    await assert.rejects(service.optimizeRoute(drivers[1 - winningIndex]!, a.id, optimizationPosition, optimizer, {}));
    await assert.rejects(service.optimizeRoute({ ...driver, empresaId: otherCompany }, a.id, optimizationPosition, optimizer, {}));
    assert.equal(optimizationCalls, 0);
    const originalParticipants = ride.itinerario!.participantes;
    const optimized = await Promise.allSettled([service.optimizeRoute(driver, a.id, optimizationPosition, optimizer, {}),
      service.optimizeRoute(driver, a.id, optimizationPosition, optimizer, {})]);
    assert.equal(optimized.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(optimized.filter(r => r.status === 'rejected').length, 1);
    ride = await service.get(manager, a.id);
    assert.deepEqual(ride.itinerario!.paradas.map(p => p.id), stopOrder);
    assert.deepEqual(ride.itinerario!.participantes, originalParticipants);
    assert.equal(ride.valorEstimado, '20.00');
    assert.equal((await pool.query("SELECT COUNT(*) FROM admtaxi.corrida_eventos WHERE corrida_id=$1 AND tipo_evento='TRAJETO_CALCULADO'", [a.id])).rows[0].count, '1');
    assert.equal((await pool.query("SELECT COUNT(*) FROM admtaxi.auditoria WHERE entidade_id=$1 AND acao='CALCULAR_TRAJETO'", [a.id])).rows[0].count, '1');
    ok('ROUTE-01 assigned-driver authorization, tenant isolation, concurrency and unchanged individual costs');
    stopOrder = stops.map(p => p.id);
    beforePlan = async () => { await pool!.query('UPDATE admtaxi.veiculos SET capacidade_passageiros=1 WHERE id=$1', [vehicles[winningIndex]]); };
    await assert.rejects(service.optimizeRoute(driver, a.id, { ...optimizationPosition, versao: ride.itinerarioVersao! }, optimizer, {}), { statusCode: 409 });
    assert.deepEqual((await service.get(manager, a.id)).itinerario!.paradas.map(p => p.id), [stops[1]!.id, stops[3]!.id, stops[0]!.id, stops[2]!.id]);
    beforePlan = undefined;
    await pool.query('UPDATE admtaxi.veiculos SET capacidade_passageiros=4 WHERE id=$1', [vehicles[winningIndex]]);
    ride = await service.optimizeRoute(driver, a.id, { ...optimizationPosition, versao: ride.itinerarioVersao! }, optimizer, {});
    ok('ROUTE-02 capacity rechecked after external call and failed update rolled back');
    await assert.rejects(service.editItinerary(manager, a.id, ride.itinerarioVersao!, input.itinerario!, {}), { statusCode: 409 });
    await assert.rejects(service.board(driver, a.id, {}), { statusCode: 409 });
    await assert.rejects(service.finish(driver, a.id, { valorFinal: '20.00' }, {}), { statusCode: 409 });
    ok('TRIP-09/10 cannot bypass individual execution or edit accepted ride');
    for (let i = 0; i < stops.length; i++) {
      const actions: Array<[ItineraryAction['acao'], string?]> = [ ...(i === 0 ? [['INICIAR'] as [ItineraryAction['acao']]] : []), ['CHEGAR'],
        [i < 2 ? 'EMBARCAR' : 'DESEMBARCAR', employeeIds[i < 2 ? i : i - 2]]];
      for (const [acao, funcionarioId] of actions) {
        const command: ItineraryAction = { chave: randomUUID(), versao: ride.itinerarioVersao!, paradaId: stops[i]!.id, acao, funcionarioId, avancoAutomatico: true };
        ride = await service.executeItinerary(driver, a.id, command, {});
        if (i === 0 && acao === 'INICIAR') {
          assert.equal((await service.get(employees[0]!, a.id)).acompanhamentoLiberado, true);
          assert.equal((await service.get(employees[1]!, a.id)).acompanhamentoLiberado, false);
          const calls = optimizationCalls;
          await assert.rejects(service.optimizeRoute(driver, a.id, { ...optimizationPosition, versao: ride.itinerarioVersao! }, optimizer, {}), { statusCode: 409 });
          assert.equal(optimizationCalls, calls);
        }
        const retry = await service.executeItinerary(driver, a.id, command, {});
        assert.equal(retry.itinerarioVersao, ride.itinerarioVersao);
        await assert.rejects(service.executeItinerary(driver, a.id, { ...command, acao: acao === 'CHEGAR' ? 'INICIAR' : 'CHEGAR' }, {}), { statusCode: 409 });
      }
      assert.equal(ride.itinerario!.paradas[i]!.estado, 'CONCLUIDA');
      if (i === 0) assert.equal((await service.get(employees[1]!, a.id)).acompanhamentoLiberado, true);
    }
    const executionEvents = await service.listEvents(manager, a.id, { pagina: 1, limite: 100 });
    assert.equal(executionEvents.data.filter(e => e.tipoEvento === 'PARADA_CONCLUIR').length, 4);
    assert.equal(executionEvents.data.filter(e => e.tipoEvento === 'PARADA_INICIAR').length, 4);
    assert(executionEvents.data.some(e => e.descricao?.includes('Embarque confirmado: Passageiro sintetico')));
    ok('EXECUTION-01 automatic stages persisted, deduplicated and passenger GPS released sequentially');
    assert(ride.itinerario!.participantes.every(p => p.estado === 'DESEMBARCADO'));
    assert(ride.desembarqueEm);
    ok('TRIP-02/11 individual journey and command deduplication');
    await assert.rejects(service.finish(driver, a.id, { valorFinal: '21.00' }, {}), { statusCode: 409 });
    await service.finish(driver, a.id, { valorFinal: '20.00' }, {});
    await service.finish(driver, a.id, { valorFinal: '20.00' }, {});
    assert.equal((await pool.query("SELECT COUNT(*) FROM admtaxi.corrida_eventos WHERE corrida_id=$1 AND tipo_evento='CORRIDA_FINALIZADA'", [a.id])).rows[0].count, '1');
    assert.equal((await service.get(manager, a.id)).valorFinal, '20.00');
    ok('MONEY-01 finalization is unique, amount unchanged');
    const billing = new FaturamentoService(pool, new AuditRepository(pool));
    const billingInput = { periodoInicio: '2020-01-01', periodoFim: '2035-12-31', prestadorId: providerIds[winningIndex]!, corridaIds: [a.id], exclusoes: [] };
    const closed = await billing.create(manager, billingInput, {});
    assert.equal(closed.itens.length, 2);
    assert.equal(closed.valorTotal, '20.00');
    assert.deepEqual(closed.itens.map(p => p.valorFaturado).sort(), ['12.30', '7.70']);
    const summary = await billing.summary(manager, { periodoInicio: '2020-01-01', periodoFim: '2035-12-31' });
    assert.equal(summary.quantidadeCorridas, 1);
    assert.equal(summary.valorTotal, '20.00');
    assert.equal(summary.porCentroCusto.find(p => p.id === secondCenter)?.valor, '7.70');
    const report = await new RelatorioRepository(pool).list(manager, { pagina: 1, limite: 20, centroCustoId: secondCenter });
    assert.equal(report.resumo.valorFinal, '7.70');
    assert.equal(report.resumo.corridas, 1);
    const dashboard = await new DashboardRepository(pool).get(manager);
    assert.equal(dashboard.custosPorCentro.find(p => p.id === secondCenter)?.valor, '7.70');
    assert((await billing.csv(manager, closed.id)).includes('Segundo centro'));
    ok('COST-02 dashboard/report/billing/CSV allocate exact cents without multiplying rides');
    await assert.rejects(billing.create(manager, billingInput, {}));
    assert.equal((await pool.query('SELECT COUNT(*) FROM admtaxi.faturamento_itens WHERE corrida_id=$1 AND ativo=TRUE', [a.id])).rows[0].count, '1');
    ok('MONEY-01 multiple passengers produce one billing item');
    const count = await pool.query('SELECT COUNT(*) FROM admtaxi.corridas');
    await assert.rejects(service.create(manager, { ...input, chaveSolicitacao: randomUUID(), itinerario: {
      ...input.itinerario!, participantes: [{ ...input.itinerario!.participantes[0]!, funcionarioId: randomUUID() }],
    } }, {}));
    assert.equal((await pool.query('SELECT COUNT(*) FROM admtaxi.corridas')).rows[0].count, count.rows[0].count);
    ok('TRIP-07 invalid references leave no partial ride');
    await pool.query('UPDATE admtaxi.corridas SET solicitada_em=$2 WHERE id=$1', [a.id, '2026-11-01T02:30:00Z']);
    const panel = new PainelParticipanteRepository(pool);
    const october = await panel.get(employees[1]!, { inicio: '2026-10-31', fim: '2026-10-31', pagina: 1, limite: 20 });
    assert.equal(october.resumo.total, 1);
    assert.equal(october.corridas.data.length, 1);
    assert.equal(october.resumo.valorTotal, null);
    const november = await panel.get(employees[1]!, { inicio: '2026-11-01', fim: '2026-11-01', pagina: 1, limite: 20 });
    assert.equal(november.resumo.total, 0);
    assert.equal(november.corridas.data.length, 0);
    ok('DATE-01 operation-day boundary matches summary and history');
    const newIds = new Map(stops.map(s => [s.id, randomUUID()]));
    const scheduled = corridaCreateSchema.parse({ ...input, chaveSolicitacao: randomUUID(), tipo: 'AGENDADA',
      agendadaPara: new Date(Date.now() + 60_000), itinerario: {
        paradas: stops.map(s => ({ ...s, id: newIds.get(s.id)! })),
        participantes: input.itinerario!.participantes.map(p => ({ ...p, embarqueId: newIds.get(p.embarqueId)!, desembarqueId: newIds.get(p.desembarqueId)! })),
      } });
    const scheduledRide = await service.create(manager, scheduled, {});
    const clock = Date.now;
    try {
      Date.now = () => scheduled.agendadaPara!.getTime() + 1000;
      const retry = corridaCreateSchema.parse(scheduled);
      assert.equal((await service.create(manager, retry, {})).id, scheduledRide.id);
      await assert.rejects(service.create(manager, { ...retry, chaveSolicitacao: randomUUID() }, {}), { statusCode: 409 });
    } finally { Date.now = clock; }
    ok('FORM-04 scheduled retry remains idempotent after its scheduled time');
    await assert.rejects(billing.adjustRideValue(manager, a.id, { valorFinal: '21.00', justificativa: 'Teste de bloqueio' }, {}), { statusCode: 409 });
    await billing.cancel(manager, closed.id, { motivo: 'Correcao de valores individuais' }, {});
    await assert.rejects(billing.adjustRideValue(manager, a.id, { valorFinal: '21.00', justificativa: 'Teste sem detalhamento' }, {}), { statusCode: 422 });
    await billing.adjustRideValue(manager, a.id, { valorFinal: '21.00', justificativa: 'Correcao individual aprovada', participantes: [
      { funcionarioId: employeeIds[0]!, valor: '13.30' }, { funcionarioId: employeeIds[1]!, valor: '7.70' },
    ] }, {});
    assert.equal((await service.get(manager, a.id)).valorFinal, '21.00');
    const historical = await billing.get(manager, closed.id);
    assert.deepEqual(historical.itens.map(p => p.valorFaturado).sort(), ['12.30', '7.70']);
    ok('COST-03 corrections require all allocations and preserve closed billing snapshots');
    const legacyStops = stops.slice(0, 2).map(p => ({ ...p, id: randomUUID() }));
    const legacyInput = corridaCreateSchema.parse({ ...input, chaveSolicitacao: randomUUID(), funcionarioId: employeeIds[2],
      valorEstimado: '38.00', itinerario: { paradas: legacyStops, participantes: [employeeIds[2], employeeIds[3]].map(funcionarioId => ({
        funcionarioId, embarqueId: legacyStops[0]!.id, desembarqueId: legacyStops[1]!.id,
      })) } });
    const legacyCreated = await service.create(manager, legacyInput, {});
    assert.equal(legacyCreated.valorEstimado, '38.00');
    const allocation = await pool.query('SELECT * FROM admtaxi.corrida_custos WHERE corrida_id=$1', [legacyCreated.id]);
    assert.equal(allocation.rows.length, 1); assert.equal(allocation.rows[0].valor_estimado, '38.00');
    await pool.query('DELETE FROM admtaxi.corrida_participacoes WHERE corrida_id=$1 AND funcionario_id=$2', [legacyCreated.id, employeeIds[3]]);
    await pool.query('INSERT INTO admtaxi.corrida_participacoes(empresa_id,corrida_id,funcionario_id,embarque_id,desembarque_id) VALUES($1,$2,$3,$4,$5)',
      [company, legacyCreated.id, employeeIds[3], legacyStops[0]!.id, legacyStops[1]!.id]);
    const oldInsert = await pool.query('SELECT centro_custo_id FROM admtaxi.corrida_participacoes WHERE corrida_id=$1 AND funcionario_id=$2', [legacyCreated.id, employeeIds[3]]);
    assert.equal(oldInsert.rows[0].centro_custo_id, center);
    await assert.rejects(pool.query('UPDATE admtaxi.corrida_participacoes SET valor=NULL WHERE corrida_id=$1', [a.id]), { code: '23514' });
    const secondaryPreview = await billing.preview(manager, { ...billingInput, centroCustoId: secondCenter });
    assert.equal(secondaryPreview.length, 1); assert.equal(secondaryPreview[0]!.id, a.id); assert.equal(secondaryPreview[0]!.valorFinal, '21.00');
    ok('COST-04 legacy insert compatibility, no retrospective splitting and secondary-center filter');
    assert.equal((await operations.recentEmployeeDestinations(manager, employeeIds[0]!))[0]?.descricao, stops[2]!.descricao);
    assert.equal((await operations.recentEmployeeDestinations(manager, employeeIds[1]!))[0]?.descricao, stops[3]!.descricao);
    assert.deepEqual(await operations.recentEmployeeDestinations({ ...manager, empresaId: otherCompany }, employeeIds[0]!), []);
    const limitedHistory = new OperacaoRepository(pool, { resolve: async () => ({ kind: 'GERENTE', empresaId: company,
      usuarioId: manager.usuarioId, setorIds: [sector], centroCustoIds: [center] }) });
    assert.deepEqual(await limitedHistory.recentEmployeeDestinations({ ...manager, perfil: 'GERENTE' }, employeeIds[1]!), []);
    for (let i = 0; i < 8; i++) {
      await pool.query(`INSERT INTO admtaxi.corridas(empresa_id,solicitante_usuario_id,funcionario_id,centro_custo_id,tipo,
        origem_descricao,destino_descricao,destino_latitude,destino_longitude,criado_em)
        VALUES($1,$2,$3,$4,'IMEDIATA','Origem teste',$5,$6,$6,CURRENT_TIMESTAMP + ($7 || ' seconds')::interval)`,
      [company, manager.usuarioId, employeeIds[4], center, `Destino ${i % 7}`, i % 7, i]);
    }
    const recent = await operations.recentEmployeeDestinations(manager, employeeIds[4]!);
    assert.deepEqual(recent.map(a => a.descricao), ['Destino 0', 'Destino 6', 'Destino 5', 'Destino 4', 'Destino 3']);
    assert.equal(recent[0]?.latitude, 0);
    await pool.query(`UPDATE admtaxi.corridas SET status='CANCELADA', cancelada_em=CURRENT_TIMESTAMP, motivo_cancelamento='Cancelamento sintetico'
      WHERE empresa_id=$1 AND funcionario_id=$2 AND destino_descricao='Destino 0'`, [company, employeeIds[4]]);
    assert.equal((await operations.recentEmployeeDestinations(manager, employeeIds[4]!))[0]?.descricao, 'Destino 6');
    await pool.query('UPDATE admtaxi.funcionarios SET ativo=FALSE WHERE id=$1', [employeeIds[4]]);
    assert.deepEqual(await operations.recentEmployeeDestinations(manager, employeeIds[4]!), []);
    ok('RECENT-DESTINATIONS individual stops, legacy, deduplication, ordering/limit, zero coordinates, tenant/scope/status');
    const racingRide = await service.accept(driver, legacyCreated.id, { veiculoId: vehicles[winningIndex] }, {});
    const racingOptimizer = new RideRouteOptimizer('synthetic-key', async () => {
      await service.executeItinerary(driver, racingRide.id, { chave: randomUUID(), versao: racingRide.itinerarioVersao!,
        paradaId: racingRide.itinerario!.paradas[0]!.id, acao: 'INICIAR' }, {});
      return new Response(JSON.stringify({ features: [{ properties: { agent_index: 0, actions: [
        { type: 'pickup', shipment_index: 0 }, { type: 'pickup', shipment_index: 1 },
        { type: 'delivery', shipment_index: 0 }, { type: 'delivery', shipment_index: 1 },
      ] } }] }));
    });
    await assert.rejects(service.optimizeRoute(driver, racingRide.id, { ...optimizationPosition, versao: racingRide.itinerarioVersao! }, racingOptimizer, {}), { statusCode: 409 });
    const afterRace = await service.get(manager, racingRide.id);
    assert.equal(afterRace.status, 'EM_DESLOCAMENTO');
    assert.equal(afterRace.itinerario!.paradas[0]!.estado, 'EM_DESLOCAMENTO');
    assert.equal(afterRace.valorEstimado, '38.00');
    ok('ROUTE-03 execution during external planning is not overwritten or blocked by database locks');
    for (const scenario of ['single', 'allAbsent', 'mixed'] as const) {
      const draft = structuredClone(input); draft.chaveSolicitacao = randomUUID();
      const itinerary = draft.itinerario!;
      const ids = new Map(itinerary.paradas.map(p => [p.id, randomUUID()]));
      itinerary.paradas.forEach(p => p.id = ids.get(p.id)!);
      itinerary.participantes.forEach(p => { p.embarqueId = ids.get(p.embarqueId)!; p.desembarqueId = ids.get(p.desembarqueId)!; });
      if (scenario === 'single') {
        itinerary.participantes = itinerary.participantes.slice(0, 1);
        itinerary.paradas = itinerary.paradas.filter(p => [itinerary.participantes[0]!.embarqueId, itinerary.participantes[0]!.desembarqueId].includes(p.id));
        draft.quantidadePassageiros = 1;
      }
      const created = await service.create(manager, draft, {});
      const absentDriver = drivers[1 - winningIndex]!;
      let current = await service.accept(absentDriver, created.id, { veiculoId: vehicles[1 - winningIndex] }, {});
      const execute = async (acao: ItineraryAction['acao'], funcionarioId?: string) => {
        const paradaId = current.itinerario!.paradas.find(p => p.estado !== 'CONCLUIDA')!.id;
        const command: ItineraryAction = { chave: randomUUID(), versao: current.itinerarioVersao!, paradaId, acao, funcionarioId,
          motivo: acao === 'AUSENTE' ? 'Nao compareceu ao embarque' : undefined, avancoAutomatico: true };
        current = await service.executeItinerary(absentDriver, created.id, command, {});
        const retry = await service.executeItinerary(absentDriver, created.id, command, {});
        assert.equal(retry.itinerarioVersao, current.itinerarioVersao);
      };
      await execute('INICIAR'); await execute('CHEGAR'); await execute('AUSENTE', employeeIds[0]);
      if (scenario !== 'single') {
        assert.equal((await service.get(employees[1]!, created.id)).acompanhamentoLiberado, true);
        await execute('CHEGAR'); await execute(scenario === 'mixed' ? 'EMBARCAR' : 'AUSENTE', employeeIds[1]);
        if (scenario === 'mixed') { await execute('CHEGAR'); await execute('DESEMBARCAR', employeeIds[1]); }
      }
      assert.equal(current.status, 'EM_CORRIDA'); assert(current.desembarqueEm);
      assert(current.itinerario!.paradas.every(p => p.estado === 'CONCLUIDA'));
      assert.equal(current.itinerario!.participantes.find(p => p.funcionarioId === employeeIds[0])!.estado, 'AUSENTE');
      assert.equal(current.itinerario!.participantes.find(p => p.funcionarioId === employeeIds[0])!.desembarqueEm, null);
      const history = await service.listEvents(manager, created.id, { pagina: 1, limite: 100 });
      assert.equal(history.data.filter(e => e.tipoEvento === 'PARADA_DISPENSADA').length, scenario === 'allAbsent' ? 2 : 1);
      await service.finish(absentDriver, created.id, { valorFinal: created.valorEstimado! }, {});
      const visible = await service.get(employees[0]!, created.id);
      assert.equal(visible.etapaPassageiro, 'Funcionario ausente');
      assert.equal(visible.acompanhamentoLiberado, false);
      const listed = await service.list(manager, { pagina: 1, limite: 100 });
      assert.equal(listed.data.find(r => r.id === created.id)!.itinerario!.participantes.find(p => p.funcionarioId === employeeIds[0])!.estado, 'AUSENTE');
    }
    ok('ABSENCE single/multiple passengers, automatic skipped destinations, persisted history, idempotency and finalization');
    const providers = new PrestadorUnificadoService(pool, new AuditRepository(pool));
    const driverRegistration = prestadorUnificadoCreateSchema.parse({
      acesso: { nome: 'Motorista temporario', email: 'driver.temp@example.test', telefone: '(34) 99999-1234',
        senha: '123456', formaAtivacao: 'SENHA_TEMPORARIA' },
      prestador: { cpf: '11144477735', numeroCnh: 'TEMP12345', validadeCnh: '2035-01-01', reutilizarDadosAcesso: true },
      veiculo: { modo: 'NOVO', dados: { placa: 'qat-1b23', marca: 'Teste', modelo: 'Teste', cor: 'Prata', ano: 2026, capacidadePassageiros: 4 } },
    });
    const registeredDriver = await providers.create(manager, driverRegistration, {});
    const loginTokens = new TokenService({ jwtAccessSecret: randomUUID() + randomUUID(), jwtRefreshSecret: randomUUID() + randomUUID(),
      jwtAccessExpiresInSeconds: 900, jwtRefreshExpiresInSeconds: 3600 }, context => authRepository.accessAllowed(context));
    const loginApp = express(); loginApp.use(express.json());
    const passwords = new PasswordService(pool, pino({ level: 'silent' }));
    loginApp.use('/auth', createAuthRouter(new AuthService(authRepository, loginTokens), loginTokens, passwords,
      new ManagerLoginService(pool, loginTokens, 900)));
    loginApp.get('/protected', createAuthenticate(loginTokens), (_req, res) => res.json({ ok: true }));
    loginApp.use('/cadastros', createAuthenticate(tokens), createPrestadorUnificadoRouter(providers));
    loginApp.use(createErrorHandler(pino({ level: 'silent' })));
    await request(loginApp).post('/auth/gestor/login').send({ email: driverRegistration.acesso.email, senha: '123456' }).expect(401);
    const temporary = await request(loginApp).post('/auth/login')
      .send({ empresa: 'test_0', email: 'DRIVER.TEMP@example.test', senha: '123456' }).expect(200);
    assert.equal(temporary.body.data.usuario.perfil, 'PRESTADOR');
    assert.equal(temporary.body.data.usuario.deveAlterarSenha, true);
    await request(loginApp).get('/protected').set('Authorization', `Bearer ${temporary.body.data.accessToken}`).expect(403);
    await request(loginApp).post('/auth/senha').set('Authorization', `Bearer ${temporary.body.data.accessToken}`)
      .send({ senhaAtual: '123456', novaSenha: '654321' }).expect(204);
    await request(loginApp).post('/auth/login').send({ empresa: 'TEST_0', email: driverRegistration.acesso.email, senha: '123456' }).expect(401);
    const personal = await request(loginApp).post('/auth/login').send({ empresa: 'TEST_0', email: driverRegistration.acesso.email, senha: '654321' }).expect(200);
    assert.equal(personal.body.data.usuario.deveAlterarSenha, false);
    await request(loginApp).get('/protected').set('Authorization', `Bearer ${personal.body.data.accessToken}`).expect(200);
    await providers.update(manager, registeredDriver.id, { acesso: { senha: '112233' } }, {});
    const resetDriver = await request(loginApp).post('/auth/login').send({ empresa: 'TEST_0', email: driverRegistration.acesso.email, senha: '112233' }).expect(200);
    assert.equal(resetDriver.body.data.usuario.deveAlterarSenha, true);
    await request(loginApp).get('/protected').set('Authorization', `Bearer ${personal.body.data.accessToken}`).expect(401);
    ok('DRIVER-LOGIN temporary password, correct company endpoint, mandatory change, administrator reset and session revocation');

    for (const [field, duplicate] of [['nome', '  MOTORISTA   TEMPORARIO  '], ['telefone', '+55 34 99999-1234'], ['email', 'DRIVER.TEMP@EXAMPLE.TEST']] as const) {
      const candidate = structuredClone(driverRegistration);
      candidate.acesso.nome = 'Outro motorista'; candidate.acesso.email = 'other.driver@example.test'; candidate.acesso.telefone = '34988881234';
      candidate.acesso[field] = duplicate;
      const before = await pool.query('SELECT count(*) FROM admtaxi.usuarios WHERE empresa_id=$1', [company]);
      const denied = await request(loginApp).post('/cadastros/prestadores').set('Authorization', bearer(manager)).send(candidate).expect(409);
      assert.equal(denied.body.erro.codigo, field === 'email' ? 'CONTA_MOTORISTA' : 'REGISTRO_DUPLICADO');
      if (field !== 'email') assert.equal(denied.body.erro.detalhes.campos[0].campo, field);
      else assert(denied.body.erro.mensagem.includes('Vincular motorista existente'));
      assert.equal((await pool.query('SELECT count(*) FROM admtaxi.usuarios WHERE empresa_id=$1', [company])).rows[0].count, before.rows[0].count);
    }
    await providers.update(manager, registeredDriver.id, { acesso: { ativo: false } }, {});
    await assert.rejects(pool.query(`INSERT INTO admtaxi.usuarios(empresa_id,nome,email,telefone,senha_hash,perfil)
      VALUES($1,'Novo nome','new.duplicate@example.test','34999991234','synthetic','PRESTADOR')`, [company]), { code: '23505' });
    await assert.rejects(pool.query(`INSERT INTO admtaxi.usuarios(empresa_id,nome,email,telefone,senha_hash,perfil)
      VALUES($1,'Motorista temporario','driver.temp@example.test','34999991234','synthetic','PRESTADOR')`, [otherCompany]), { code: 'P2001' });
    const plateDuplicate = await request(loginApp).post('/cadastros/prestadores').set('Authorization', bearer(manager)).send({
      ...driverRegistration, acesso: { ...driverRegistration.acesso, nome: 'Placa duplicada', email: 'plate@example.test', telefone: '34988881234' },
      prestador: { ...driverRegistration.prestador, cpf: '52998224725', numeroCnh: 'OTHER12345' },
    }).expect(409);
    assert.equal(plateDuplicate.body.erro.detalhes.campos[0].campo, 'placa');
    assert.equal((await pool.query("SELECT count(*) FROM admtaxi.usuarios WHERE email='plate@example.test'")).rows[0].count, '0');
    for (const table of ['usuarios', 'prestadores', 'funcionarios']) {
      const ids = (await pool.query(`SELECT id FROM admtaxi.${table} WHERE empresa_id=$1 ${table === 'usuarios' ? "AND perfil='FUNCIONARIO'" : ''} ORDER BY id LIMIT 2`, [company])).rows.map(row => row.id);
      for (const field of ['nome', 'email', 'telefone']) {
        const value = field === 'nome' ? `Nome exclusivo ${table}` : field === 'email' ? `${table}@example.test` : '31912345678';
        await pool.query(`UPDATE admtaxi.${table} SET ${field}=$3 WHERE empresa_id=$1 AND id=$2`, [company, ids[0], value]);
        await assert.rejects(pool.query(`UPDATE admtaxi.${table} SET ${field}=$3 WHERE empresa_id=$1 AND id=$2`, [company, ids[1], value]), { code: table === 'usuarios' && field === 'email' ? 'P2101' : '23505' });
        await pool.query(`UPDATE admtaxi.${table} SET ${field}=$3 WHERE empresa_id=$1 AND id=$2`, [company, ids[0], value]);
      }
    }
    const concurrent = await Promise.allSettled([0, 1].map(i => pool!.query(`INSERT INTO admtaxi.usuarios(empresa_id,nome,email,telefone,senha_hash,perfil)
      VALUES($1,$2,$3,'31988881234','synthetic','FUNCIONARIO')`, [company, `Concorrente ${i}`, `concurrent${i}@example.test`])));
    assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(concurrent.filter(r => r.status === 'rejected').length, 1);
    ok('DUPLICATES normalized names/phones/emails/plates, inactive records, tenant scope, unchanged edits, atomic rollback and concurrent writes');
    await testSharedDriverAccounts(pool, ok);
    await testSharedEmployeeAccounts(pool, ok);
    await testScheduledEmails(pool, ok);
    const users = new UsuarioService(pool, new AuditRepository(pool));
    const portaria = await users.create(manager, {
      nome: 'Portaria teste', email: 'portaria@example.test', senha: '123456', perfil: 'PORTARIA',
    }, {});
    const portariaLogin = await request(loginApp).post('/auth/login')
      .send({ empresa: 'TEST_0', email: 'portaria@example.test', senha: '123456' }).expect(200);
    assert.equal(portariaLogin.body.data.usuario.perfil, 'PORTARIA');
    assert.equal(portariaLogin.body.data.usuario.deveAlterarSenha, true);
    await request(loginApp).post('/auth/senha').set('Authorization', `Bearer ${portariaLogin.body.data.accessToken}`)
      .send({ senhaAtual: '123456', novaSenha: '654321' }).expect(204);
    const access = await request(loginApp).post('/auth/login')
      .send({ empresa: 'TEST_0', email: 'portaria@example.test', senha: '654321' }).expect(200);
    const portariaAuth: AuthContext = { empresaId: company, usuarioId: portaria.id, perfil: 'PORTARIA' };
    const stopIds = new Map(input.itinerario!.paradas.map(stop => [stop.id, randomUUID()]));
    const command = { ...input, chaveSolicitacao: randomUUID(), itinerario: {
      ...input.itinerario!, paradas: input.itinerario!.paradas.map(stop => ({ ...stop, id: stopIds.get(stop.id)! })),
      participantes: input.itinerario!.participantes.map(participant => ({ ...participant,
        embarqueId: stopIds.get(participant.embarqueId)!, desembarqueId: stopIds.get(participant.desembarqueId)!,
      })),
    } };
    const requested = await service.create(portariaAuth, command, {});
    const repeated = await service.create(portariaAuth, command, {});
    assert.equal(requested.id, repeated.id);
    assert.equal(requested.solicitanteUsuarioId, portaria.id);
    await request(app).get(`/corridas/${requested.id}`).set('Authorization', bearer(portariaAuth)).expect(403);
    const notifications = new NotificacaoService(pool);
    notifications.publishRideUpdate({ ...requested, status: 'ACEITA' }, 'ACEITA');
    let inbox: Awaited<ReturnType<typeof notifications.listOwn>> = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      inbox = await notifications.listOwn(portariaAuth);
      if (inbox.length) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(inbox[0]?.titulo, 'Corrida aceita');
    assert.deepEqual(await notifications.listOwn({ ...portariaAuth, empresaId: otherCompany }), []);
    const log = await pool.query('SELECT url_abertura FROM admtaxi.notificacoes_push WHERE id=$1', [inbox[0]!.id]);
    assert.equal(log.rows[0].url_abertura, '/app/notificacoes');
    await users.setActive(manager, portaria.id, false, {});
    await request(loginApp).post('/auth/login').send({ empresa: 'TEST_0', email: 'portaria@example.test', senha: '654321' }).expect(401);
    await request(loginApp).get('/protected').set('Authorization', `Bearer ${access.body.data.accessToken}`).expect(401);
    ok('PORTARIA migration, creation, temporary password, request retry, denied tracking, own notifications and deactivation');
    await companies.updateCurrent(manager, { modoCobranca: 'MENSAL_FIXO' }, {});
    assert.equal((await service.get(manager, a.id)).modoCobranca, 'MANUAL');
    const monthly = new MonthlyBillingService(pool, new AuditRepository(pool));
    const monthlyIndex = 1 - winningIndex;
    const monthlyDriver = drivers[monthlyIndex]!;
    const monthlyProvider = providerIds[monthlyIndex]!;
    await monthly.setValue(manager, monthlyProvider, '100.01', {});
    await assert.rejects(monthly.providers(monthlyDriver), { statusCode: 403 });
    const monthlyIds: string[] = [];
    for (const scenario of ['two', 'one', 'absent']) {
      const payload = structuredClone(input);
      payload.chaveSolicitacao = randomUUID(); delete payload.valorEstimado;
      const ids = new Map(payload.itinerario!.paradas.map(stop => [stop.id, randomUUID()]));
      payload.itinerario!.paradas.forEach(stop => { stop.id = ids.get(stop.id)!; });
      payload.itinerario!.participantes.forEach(p => {
        p.embarqueId = ids.get(p.embarqueId)!; p.desembarqueId = ids.get(p.desembarqueId)!; delete p.valor;
      });
      if (scenario !== 'two') {
        const p = payload.itinerario!.participantes[0]!;
        payload.itinerario!.participantes = [p]; payload.quantidadePassageiros = 1;
        payload.itinerario!.paradas = payload.itinerario!.paradas.filter(stop => [p.embarqueId, p.desembarqueId].includes(stop.id));
      }
      const created = await service.create(manager, payload, {});
      monthlyIds.push(created.id);
      assert.equal(created.modoCobranca, 'MENSAL_FIXO'); assert.equal(created.valorEstimado, null);
      assert.equal((await service.create(manager, payload, {})).id, created.id);
      let current = await service.accept(monthlyDriver, created.id, { veiculoId: vehicles[monthlyIndex]! }, {});
      const execute = async (acao: ItineraryAction['acao'], funcionarioId?: string) => {
        const stop = current.itinerario!.paradas.find(p => !['CONCLUIDA', 'CANCELADA'].includes(p.estado))!;
        current = await service.executeItinerary(monthlyDriver, created.id, {
          chave: randomUUID(), versao: current.itinerarioVersao!, paradaId: stop.id, acao,
          funcionarioId, avancoAutomatico: true, ...(acao === 'AUSENTE' ? { motivo: 'Ausente no embarque de teste' } : {}),
        }, {});
      };
      while (current.itinerario!.paradas.some(p => !['CONCLUIDA', 'CANCELADA'].includes(p.estado))) {
        const stop = current.itinerario!.paradas.find(p => !['CONCLUIDA', 'CANCELADA'].includes(p.estado))!;
        if (stop.estado === 'PENDENTE') await execute('INICIAR');
        await execute('CHEGAR');
        for (const p of current.itinerario!.participantes.filter(p => p.desembarqueId === stop.id && p.estado === 'EMBARCADO')) await execute('DESEMBARCAR', p.funcionarioId);
        for (const p of current.itinerario!.participantes.filter(p => p.embarqueId === stop.id && p.estado === 'AGUARDANDO')) await execute(scenario === 'absent' ? 'AUSENTE' : 'EMBARCAR', p.funcionarioId);
      }
      await assert.rejects(service.finish(monthlyDriver, created.id, { valorFinal: '1.00' }, {}), { statusCode: 422 });
      const finished = await service.finish(monthlyDriver, created.id, {}, {});
      assert.equal(finished.status, 'FINALIZADA'); assert.equal(finished.valorFinal, null);
      await pool.query("UPDATE admtaxi.corridas SET finalizada_em='2000-01-15T12:00:00Z' WHERE id=$1", [created.id]);
    }
    const monthlyInput = { prestadorId: monthlyProvider, competencia: '2000-01' };
    await assert.rejects(monthly.preview({ ...manager, empresaId: otherCompany }, monthlyInput), { statusCode: 404 });
    const preview = await monthly.preview(manager, monthlyInput);
    assert.equal(preview.quantidadeCorridas, 2);
    assert.deepEqual(preview.porCentroCusto.map(c => c.percentual).sort(), [25, 75]);
    await monthly.setValue(manager, monthlyProvider, '200.00', {});
    await assert.rejects(monthly.close(manager, { ...monthlyInput, previsaoHash: preview.previsaoHash }, {}), { statusCode: 409 });
    await monthly.setValue(manager, monthlyProvider, '100.01', {});
    const closings = await Promise.allSettled([0, 1].map(() => monthly.close(manager, { ...monthlyInput, previsaoHash: preview.previsaoHash }, {})));
    assert.equal(closings.filter(c => c.status === 'fulfilled').length, 1);
    assert.equal(closings.filter(c => c.status === 'rejected').length, 1);
    const closedMonthly = closings.find(c => c.status === 'fulfilled')! as PromiseFulfilledResult<string>;
    const monthlyBill = await billing.get(manager, closedMonthly.value);
    assert.equal(monthlyBill.valorTotal, '100.01'); assert.equal(monthlyBill.quantidadeCorridas, 2);
    const allocated = () => pool!.query('SELECT sum(valor_final)::text AS total FROM admtaxi.corrida_custos WHERE corrida_id=ANY($1::uuid[])', [monthlyIds]);
    assert.equal((await allocated()).rows[0].total, '100.01');
    await billing.cancel(manager, closedMonthly.value, { motivo: 'Teste de cancelamento mensal' }, {});
    assert.equal((await allocated()).rows[0].total, null);
    ok('MONTHLY policy snapshot, rides without prices, no-show exclusion, exact allocation, stale preview, concurrent closing, reports and cancellation');
    console.log(JSON.stringify({ result: 'passed', checks, database: 'temporary PostgreSQL 18, loopback only', remoteDatabaseUsed: false }));
  } finally {
    await pool?.end();
    if (started && process.platform === 'win32') {
      const stopped = spawnSync(path.resolve('node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe'),
        ['stop', '-D', directory, '-m', 'fast', '-w'], { encoding: 'utf8', windowsHide: true });
      assert.equal(stopped.status, 0, 'Falha ao encerrar PostgreSQL isolado.');
    } else if (started) await embedded.stop();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.stack : 'Integration failed'); process.exit(1); });
