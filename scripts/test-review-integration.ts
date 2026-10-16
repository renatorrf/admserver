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
import { PainelParticipanteRepository } from '../src/modules/paineis/painel.repository';

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
    for (const file of files.filter(f => !f.startsWith('013_'))) {
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
        VALUES($1,$2,$3,$4,$5,'11999999999',$6,'2030-01-01',true)`,
      [id, company, drivers[i]!.usuarioId, `Prestador sintetico ${i}`, `1234567890${i}`, `TEST${i}`]);
      await pool.query(`INSERT INTO admtaxi.veiculos(id,empresa_id,prestador_id,placa,marca,modelo,cor,ano,capacidade_passageiros)
        VALUES($1,$2,$3,$4,'Teste','Teste','Teste',2026,4)`, [vehicles[i], company, id, `TST1A0${i}`]);
    }
    const legacyId = randomUUID();
    await pool.query(`INSERT INTO admtaxi.corridas(id,empresa_id,solicitante_usuario_id,funcionario_id,centro_custo_id,tipo,origem_descricao,destino_descricao)
      VALUES($1,$2,$3,$4,$5,'IMEDIATA','Origem historica','Destino historico')`, [legacyId, company, manager.usuarioId, employeeIds[0], center]);
    const migrate = (): void => {
      const result = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/db/migrate.ts', 'up'], {
        env: { ...process.env, DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:${port}/postgres?sslmode=disable` }, encoding: 'utf8', windowsHide: true,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    };
    migrate(); migrate();
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

    const stops = Array.from({ length: 4 }, (_, i) => ({ id: randomUUID(), descricao: `Ponto sintetico ${i}`, latitude: i, longitude: i }));
    const input = corridaCreateSchema.parse({ chaveSolicitacao: randomUUID(), funcionarioId: employeeIds[0], centroCustoId: center,
      tipo: 'IMEDIATA', quantidadePassageiros: 2, origemDescricao: 'Inicio sintetico', destinoDescricao: 'Fim sintetico',
      itinerario: { paradas: stops, participantes: [
        { funcionarioId: employeeIds[0], embarqueId: stops[0]!.id, desembarqueId: stops[2]!.id },
        { funcionarioId: employeeIds[1], embarqueId: stops[1]!.id, desembarqueId: stops[3]!.id },
      ] } });
    const [a, b] = await Promise.all([service.create(manager, input, {}), service.create(manager, input, {})]);
    assert.equal(a.id, b.id);
    assert.equal((await pool.query('SELECT COUNT(*) FROM admtaxi.corrida_eventos WHERE corrida_id=$1', [a.id])).rows[0].count, '1');
    ok('FORM-04 concurrent create retry has one ride/event');
    await assert.rejects(service.get({ ...manager, empresaId: otherCompany }, a.id), { statusCode: 404 });
    const privateView = await service.get(employees[1]!, a.id);
    assert.equal(privateView.itinerario?.participantes.length, 1);
    assert.equal(privateView.itinerario?.paradas[0]?.id, stops[1]!.id);
    assert(!('valorFinal' in privateView));
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
    await assert.rejects(service.editItinerary(manager, a.id, ride.itinerarioVersao!, input.itinerario!, {}), { statusCode: 409 });
    await assert.rejects(service.board(driver, a.id, {}), { statusCode: 409 });
    await assert.rejects(service.finish(driver, a.id, { valorFinal: '20.00' }, {}), { statusCode: 409 });
    ok('TRIP-09/10 cannot bypass individual execution or edit accepted ride');
    for (let i = 0; i < stops.length; i++) {
      const actions: Array<[ItineraryAction['acao'], string?]> = [['INICIAR'], ['CHEGAR'],
        [i < 2 ? 'EMBARCAR' : 'DESEMBARCAR', employeeIds[i < 2 ? i : i - 2]], ['CONCLUIR']];
      for (const [acao, funcionarioId] of actions) {
        const command: ItineraryAction = { chave: randomUUID(), versao: ride.itinerarioVersao!, paradaId: stops[i]!.id, acao, funcionarioId };
        ride = await service.executeItinerary(driver, a.id, command, {});
        const retry = await service.executeItinerary(driver, a.id, command, {});
        assert.equal(retry.itinerarioVersao, ride.itinerarioVersao);
        await assert.rejects(service.executeItinerary(driver, a.id, { ...command, acao: acao === 'CHEGAR' ? 'INICIAR' : 'CHEGAR' }, {}), { statusCode: 409 });
      }
    }
    assert(ride.itinerario!.participantes.every(p => p.estado === 'DESEMBARCADO'));
    assert(ride.desembarqueEm);
    ok('TRIP-02/11 individual journey and command deduplication');
    await service.finish(driver, a.id, { valorFinal: '20.00' }, {});
    await service.finish(driver, a.id, { valorFinal: '20.00' }, {});
    assert.equal((await pool.query("SELECT COUNT(*) FROM admtaxi.corrida_eventos WHERE corrida_id=$1 AND tipo_evento='CORRIDA_FINALIZADA'", [a.id])).rows[0].count, '1');
    assert.equal((await service.get(manager, a.id)).valorFinal, '20.00');
    ok('MONEY-01 finalization is unique, amount unchanged');
    const billing = new FaturamentoService(pool, new AuditRepository(pool));
    const billingInput = { periodoInicio: '2020-01-01', periodoFim: '2035-12-31', prestadorId: providerIds[winningIndex]!, corridaIds: [a.id], exclusoes: [] };
    await billing.create(manager, billingInput, {});
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
main().catch(error => { console.error(error instanceof Error ? error.message : 'Integration failed'); process.exitCode = 1; });
