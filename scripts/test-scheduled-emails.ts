import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import pino from 'pino';
import { AuditRepository } from '../src/modules/auditoria/audit.repository';
import type { AuthContext } from '../src/modules/auth/auth.types';
import type { CorridaCreateInput } from '../src/modules/corridas/corrida.schemas';
import { CorridaService } from '../src/modules/corridas/corrida.service';
import { ScheduledRideEmails } from '../src/modules/corridas/scheduled-emails';
import type { ScheduledMailer } from '../src/modules/corridas/scheduled-mailer';

export async function testScheduledEmails(pool: Pool, ok: (label: string) => void): Promise<void> {
  const company = randomUUID(), center = randomUUID(), provider = randomUUID(), vehicle = randomUUID();
  const manager: AuthContext = { empresaId: company, usuarioId: randomUUID(), perfil: 'GESTOR' };
  const driver: AuthContext = { empresaId: company, usuarioId: randomUUID(), perfil: 'PRESTADOR' };
  await pool.query("INSERT INTO admtaxi.empresas(id,codigo_acesso,razao_social,nome_fantasia) VALUES($1,'MAIL-TEST','Empresa de emails sinteticos','Email teste')", [company]);
  for (const [i, auth] of [manager, driver].entries()) await pool.query(`INSERT INTO admtaxi.usuarios(id,empresa_id,nome,email,senha_hash,perfil)
    VALUES($1,$2,$3,$4,'synthetic-not-a-password',$5)`, [auth.usuarioId, company, `Email usuario ${i}`, `email-user-${i}@example.test`, auth.perfil]);
  const sector = randomUUID();
  await pool.query("INSERT INTO admtaxi.setores(id,empresa_id,codigo,nome) VALUES($1,$2,'MAIL','Setor emails')", [sector, company]);
  await pool.query("INSERT INTO admtaxi.centros_custo(id,empresa_id,setor_id,codigo,nome) VALUES($1,$2,$3,'MAIL','Centro emails')", [center, company, sector]);
  const employees = [randomUUID(), randomUUID()];
  for (const [i, id] of employees.entries()) await pool.query(`INSERT INTO admtaxi.funcionarios(id,empresa_id,nome,email,matricula,centro_custo_id)
    VALUES($1,$2,$3,$4,$5,$6)`, [id, company, `Email passageiro ${i}`, `passageiro-${i}@example.test`, `MAIL${i}`, center]);
  const employeeUser = randomUUID();
  await pool.query(`INSERT INTO admtaxi.usuarios(id,empresa_id,nome,email,senha_hash,perfil)
    VALUES($1,$2,'Passageiro email alternativo','email-alternativo@example.test','synthetic','FUNCIONARIO')`, [employeeUser, company]);
  await pool.query('UPDATE admtaxi.funcionarios SET usuario_id=$2,email=NULL WHERE id=$1', [employees[0], employeeUser]);
  await pool.query(`INSERT INTO admtaxi.prestadores(id,empresa_id,usuario_id,nome,cpf,telefone,numero_cnh,validade_cnh,disponivel)
    VALUES($1,$2,$3,'Prestador email','12345678909','34999990001','MAIL123','2035-01-01',TRUE)`, [provider, company, driver.usuarioId]);
  await pool.query(`INSERT INTO admtaxi.veiculos(id,empresa_id,prestador_id,placa,marca,modelo,cor,ano,capacidade_passageiros)
    VALUES($1,$2,$3,'EML1A23','Teste','Teste','Teste',2026,4)`, [vehicle, company, provider]);
  const stops = [0, 1, 2, 3].map(i => ({ id: randomUUID(), descricao: `Endereco email ${i}`, latitude: -18.9 + i / 100, longitude: -48.2 }));
  const base: CorridaCreateInput = { funcionarioId: employees[0]!, centroCustoId: center, tipo: 'IMEDIATA', quantidadePassageiros: 2,
    origemDescricao: stops[0]!.descricao, destinoDescricao: stops[3]!.descricao,
    itinerario: { paradas: stops, participantes: employees.map((id, i) => ({ funcionarioId: id, centroCustoId: center,
      valor: '10.00', embarqueId: stops[i]!.id, desembarqueId: stops[i + 2]!.id })) } };
  const logger = pino({ level: 'silent' });
  const queued = new ScheduledRideEmails(pool, logger, undefined, 'https://app.example.test/recuperar-senha');
  const service = new CorridaService(pool, new AuditRepository(pool), undefined, undefined, undefined, undefined, queued);
  const input = (): CorridaCreateInput => {
    const next = structuredClone(base);
    next.chaveSolicitacao = randomUUID(); next.tipo = 'AGENDADA'; next.agendadaPara = new Date(Date.now() + 7_200_000);
    const ids = new Map(next.itinerario!.paradas.map(p => [p.id, randomUUID()]));
    next.itinerario!.paradas.forEach(p => p.id = ids.get(p.id)!);
    next.itinerario!.participantes.forEach(p => { p.embarqueId = ids.get(p.embarqueId)!; p.desembarqueId = ids.get(p.desembarqueId)!; });
    return next;
  };
  const messages: Parameters<ScheduledMailer['send']>[0][] = [];
  const mailer: ScheduledMailer = { send: async message => { messages.push(message); } };
  const worker = new ScheduledRideEmails(pool, logger, mailer);
  const request = input();
  const ride = await service.create(manager, request, {});
  assert.equal((await service.create(manager, request, {})).id, ride.id);
  assert.equal(await queued.process(), 0);
  const rows = (await pool.query('SELECT * FROM admtaxi.emails_agendamento WHERE corrida_id=$1 ORDER BY funcionario_id', [ride.id])).rows;
  assert.equal(rows.length, 2);
  assert(rows.every(r => r.status === 'PENDENTE'));
  assert.equal(rows.find(r => r.funcionario_id === employees[0]).destinatario, 'email-alternativo@example.test');
  for (const row of rows) {
    const participant = request.itinerario!.participantes.find(p => p.funcionarioId === row.funcionario_id)!;
    const ownStops = [participant.embarqueId, participant.desembarqueId];
    for (const stop of request.itinerario!.paradas) assert.equal(row.corpo.includes(stop.descricao), ownStops.includes(stop.id));
    assert(row.corpo.includes(`https://app.example.test/app/corridas/${ride.id}`));
    assert(row.corpo.includes('horario de Brasilia'));
  }
  const competing = new ScheduledRideEmails(pool, logger, mailer);
  await Promise.all([worker.process(), competing.process()]);
  assert.equal(messages.length, 2); assert.equal(new Set(messages.map(m => m.id)).size, 2);
  assert.equal((await pool.query("SELECT count(*) FROM admtaxi.emails_agendamento WHERE corrida_id=$1 AND status='ENVIADO'", [ride.id])).rows[0].count, '2');
  ok('SCHEDULE-MAIL atomic enqueue, idempotency, private passenger routes, SMTP disabled and concurrent workers');

  await assert.rejects(service.accept(driver, ride.id, { veiculoId: vehicle }, {}), /uma hora antes/);
  assert.equal((await service.get(manager, ride.id)).status, 'SOLICITADA');
  await pool.query("UPDATE admtaxi.corridas SET agendada_para=CURRENT_TIMESTAMP+INTERVAL '59 minutes' WHERE id=$1", [ride.id]);
  assert.equal((await service.accept(driver, ride.id, { veiculoId: vehicle }, {})).status, 'ACEITA');
  await service.cancel(manager, ride.id, { motivo: 'Fim do teste sintetico' }, {});
  ok('SCHEDULE-ACCEPT server blocks early acceptance and allows it inside one hour');

  const retryRide = await service.create(manager, input(), {});
  const failure = new ScheduledRideEmails(pool, logger, { send: async () => { throw new Error('synthetic SMTP offline'); } });
  await failure.process();
  const retry = (await pool.query('SELECT status,tentativas,proxima_tentativa_em>CURRENT_TIMESTAMP AS delayed FROM admtaxi.emails_agendamento WHERE corrida_id=$1', [retryRide.id])).rows;
  assert(retry.every(r => r.status === 'PENDENTE' && r.tentativas === 1 && r.delayed));
  assert.equal(await worker.process(), 0);
  await pool.query('UPDATE admtaxi.emails_agendamento SET proxima_tentativa_em=CURRENT_TIMESTAMP WHERE corrida_id=$1', [retryRide.id]);
  await worker.process(); assert.equal(messages.length, 4);
  ok('SCHEDULE-MAIL SMTP failure preserves ride, delays retry and later sends successfully');

  const cancelled = await service.create(manager, input(), {});
  await service.cancel(manager, cancelled.id, { motivo: 'Cancelamento antes do envio' }, {});
  await worker.process(); assert.equal(messages.length, 4);
  assert.equal((await pool.query("SELECT count(*) FROM admtaxi.emails_agendamento WHERE corrida_id=$1 AND status='IGNORADO'", [cancelled.id])).rows[0].count, '2');

  const exhausted = await service.create(manager, input(), {});
  for (let attempt = 0; attempt < 5; attempt++) {
    await pool.query('UPDATE admtaxi.emails_agendamento SET proxima_tentativa_em=CURRENT_TIMESTAMP WHERE corrida_id=$1', [exhausted.id]);
    await failure.process();
  }
  assert.equal((await pool.query("SELECT count(*) FROM admtaxi.emails_agendamento WHERE corrida_id=$1 AND status='FALHOU' AND tentativas=5", [exhausted.id])).rows[0].count, '2');
  ok('SCHEDULE-MAIL cancelled schedules skipped and retries stop after five attempts');

  const recover = await service.create(manager, input(), {});
  await pool.query("UPDATE admtaxi.emails_agendamento SET status='ENVIANDO',tentativas=1,reserva=$2,reservada_ate=CURRENT_TIMESTAMP-INTERVAL '1 minute' WHERE corrida_id=$1", [recover.id, randomUUID()]);
  await worker.process(); assert.equal(messages.length, 6);
  const missing = request.itinerario!.participantes[1]!.funcionarioId;
  const old = (await pool.query('SELECT email,usuario_id FROM admtaxi.funcionarios WHERE id=$1', [missing])).rows[0];
  await pool.query('UPDATE admtaxi.funcionarios SET email=NULL,usuario_id=NULL WHERE id=$1', [missing]);
  const withoutEmail = await service.create(manager, input(), {});
  await pool.query('UPDATE admtaxi.funcionarios SET email=$2,usuario_id=$3 WHERE id=$1', [missing, old.email, old.usuario_id]);
  assert.equal((await pool.query("SELECT count(*) FROM admtaxi.emails_agendamento WHERE corrida_id=$1 AND status='SEM_EMAIL'", [withoutEmail.id])).rows[0].count, '1');
  await worker.process(); assert.equal(messages.length, 7);
  ok('SCHEDULE-MAIL expired leases recovered and employee without email explicitly recorded');

  const removed = await service.create(manager, input(), {});
  await pool.query('DELETE FROM admtaxi.corrida_participacoes WHERE corrida_id=$1 AND funcionario_id=$2', [removed.id, employees[1]]);
  await worker.process(); assert.equal(messages.length, 8);
  assert.equal((await pool.query('SELECT status FROM admtaxi.emails_agendamento WHERE corrida_id=$1 AND funcionario_id=$2', [removed.id, employees[1]])).rows[0].status, 'IGNORADO');
  const expired = await service.create(manager, input(), {});
  await pool.query("UPDATE admtaxi.corridas SET agendada_para=CURRENT_TIMESTAMP-INTERVAL '1 minute' WHERE id=$1", [expired.id]);
  await worker.process(); assert.equal(messages.length, 8);
  const otherCompany = (await pool.query('SELECT id FROM admtaxi.empresas WHERE id<>$1 LIMIT 1', [company])).rows[0].id;
  await assert.rejects(pool.query('UPDATE admtaxi.emails_agendamento SET empresa_id=$2 WHERE corrida_id=$1', [expired.id, otherCompany]), { code: '23503' });
  ok('SCHEDULE-MAIL removed participants and expired schedules skipped, foreign tenant denied');

  const failingQueue = new CorridaService(pool, new AuditRepository(pool), undefined, undefined, undefined, undefined,
    { enqueue: async () => { throw new Error('synthetic queue failure'); }, kick: () => { throw new Error('must not kick'); } });
  const before = (await pool.query('SELECT count(*) FROM admtaxi.corridas')).rows[0].count;
  await assert.rejects(failingQueue.create(manager, input(), {}), /synthetic queue failure/);
  assert.equal((await pool.query('SELECT count(*) FROM admtaxi.corridas')).rows[0].count, before);
  const immediate = input(); immediate.tipo = 'IMEDIATA'; immediate.agendadaPara = null;
  const now = await service.create(manager, immediate, {});
  assert.equal((await pool.query('SELECT count(*) FROM admtaxi.emails_agendamento WHERE corrida_id=$1', [now.id])).rows[0].count, '0');
  ok('SCHEDULE-MAIL enqueue failure rolls back ride, immediate rides never enqueue');
}
