import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import express from 'express';
import request from 'supertest';
import pino from 'pino';
import { AuditRepository } from '../src/modules/auditoria/audit.repository';
import { FuncionarioUnificadoService } from '../src/modules/funcionarios/funcionario-unificado.service';
import { funcionarioUnificadoCreateSchema } from '../src/modules/funcionarios/funcionario-unificado.schemas';
import { createEmployeeLinkRouter } from '../src/modules/funcionarios/employee-link.routes';
import { createFuncionarioUnificadoRouter } from '../src/modules/funcionarios/funcionario-unificado.routes';
import { EmployeeLoginService } from '../src/modules/auth/employee-login.service';
import { ManagerLoginService } from '../src/modules/auth/manager-login.service';
import { DriverLoginService } from '../src/modules/auth/driver-login.service';
import { PgAuthRepository } from '../src/modules/auth/auth.repository';
import { AuthService } from '../src/modules/auth/auth.service';
import { PasswordService } from '../src/modules/auth/password.service';
import { TokenService } from '../src/modules/auth/token-service';
import { createAuthRouter } from '../src/modules/auth/auth.routes';
import { createAuthenticate } from '../src/modules/auth/auth.middleware';
import { createErrorHandler } from '../src/shared/http/error-handler';
import { CorridaService } from '../src/modules/corridas/corrida.service';
import type { AuthContext } from '../src/modules/auth/auth.types';

export async function testSharedEmployeeAccounts(pool: Pool, ok: (label: string) => void): Promise<void> {
  assert.equal(pool.options.host, '127.0.0.1');
  assert.equal((await pool.query('SELECT count(*) FROM admtaxi.schema_migrations WHERE versao=21')).rows[0].count, '1');
  const tenants = [];
  for (let i = 0; i < 3; i++) {
    const company = randomUUID(), manager = randomUUID(), center = randomUUID(), sector = randomUUID();
    await pool.query('INSERT INTO admtaxi.empresas(id,codigo_acesso,razao_social,nome_fantasia) VALUES($1,$2,$3,$3)', [company, `EMPLOYEE${i}`, `Employee company ${i}`]);
    await pool.query(`INSERT INTO admtaxi.usuarios(id,empresa_id,nome,email,senha_hash,perfil,deve_alterar_senha) VALUES($1,$2,$3,$4,'synthetic','GESTOR',FALSE)`, [manager, company, `Manager ${i}`, `employeemanager${i}@example.test`]);
    await pool.query(`INSERT INTO admtaxi.setores(id,empresa_id,codigo,nome) VALUES($1,$2,'S','Setor')`, [sector, company]);
    await pool.query(`INSERT INTO admtaxi.centros_custo(id,empresa_id,setor_id,codigo,nome) VALUES($1,$2,$3,'C','Centro')`, [center, company, sector]);
    tenants.push({ company, center, auth: { usuarioId: manager, empresaId: company, perfil: 'GESTOR', senhaVersao: 0, deveAlterarSenha: false } as AuthContext });
  }
  const a = tenants[0]!, b = tenants[1]!, c = tenants[2]!;
  const registrations = new FuncionarioUnificadoService(pool, new AuditRepository(pool));
  const email = 'shared.employee@example.test';
  const employee = { nome: 'Funcionario compartilhado', matricula: 'E1', email, centroCustoId: a.center };
  const created = await registrations.create(a.auth, funcionarioUnificadoCreateSchema.parse({ acesso: { senha: '123456' }, funcionario: employee }), {});
  const repo = new PgAuthRepository(pool);
  const tokens = new TokenService({ jwtAccessSecret: randomUUID() + randomUUID(), jwtRefreshSecret: randomUUID() + randomUUID(), jwtAccessExpiresInSeconds: 900, jwtRefreshExpiresInSeconds: 3600 }, auth => repo.accessAllowed(auth));
  const auth = new AuthService(repo, tokens), login = new EmployeeLoginService(pool, tokens, 900);
  const logger = pino({ level: 'silent' });
  const passwords = new PasswordService(pool, logger);
  const app = express(); app.use(express.json());
  app.use('/auth', createAuthRouter(auth, tokens, passwords, new ManagerLoginService(pool, tokens, 900), new DriverLoginService(pool, tokens, 900), login));
  app.use('/links', createAuthenticate(tokens), createEmployeeLinkRouter(pool));
  app.use('/employees', createAuthenticate(tokens), createFuncionarioUnificadoRouter(registrations));
  app.get('/protected', createAuthenticate(tokens), (_req, res) => res.sendStatus(204));
  app.use(createErrorHandler(logger));
  const initial = (await request(app).post('/auth/acesso').send({ email, senha: '123456' }).expect(200)).body.data;
  assert.equal(initial.perfilSelecao, 'FUNCIONARIO');
  assert.equal(initial.empresas.length, 1); assert.equal(initial.sessao, undefined);
  const first = (await request(app).post('/auth/funcionario/empresa').send({ selecaoToken: initial.selecaoToken, empresaId: a.company }).expect(200)).body.data;
  assert.equal(first.usuario.deveAlterarSenha, true);
  await request(app).get('/protected').auth(first.accessToken, { type: 'bearer' }).expect(403);
  await passwords.change(tokens.verifyAccess(first.accessToken), { senhaAtual: '123456', novaSenha: '654321' });
  await assert.rejects(login.select({ selecaoToken: initial.selecaoToken, empresaId: a.company }), { statusCode: 401 });
  ok('EMPLOYEE-01 migration preserves credentials, credential-first HTTP login, mandatory password change, stale selection denied');

  const managerToken = tokens.issueTokens(b.auth).accessToken;
  await request(app).get('/links').query({ email: 'shared' }).auth(managerToken, { type: 'bearer' }).expect(422);
  const found = (await request(app).get('/links').query({ email }).auth(managerToken, { type: 'bearer' }).expect(200)).body.data;
  assert.equal(found.length, 1); assert.deepEqual(Object.keys(found[0]).sort(), ['email', 'id', 'nome', 'vinculado']);
  const accountId = found[0].id;
  const linkInput = { acesso: { contaId: accountId }, funcionario: { ...employee, matricula: 'E2', centroCustoId: b.center } };
  await request(app).post('/employees').auth(managerToken, { type: 'bearer' }).send({ ...linkInput, funcionario: { ...linkInput.funcionario, centroCustoId: a.center } }).expect(422);
  assert.equal((await pool.query('SELECT count(*) FROM admtaxi.usuarios WHERE conta_funcionario_id=$1', [accountId])).rows[0].count, '1');
  const linked = (await request(app).post('/employees').auth(managerToken, { type: 'bearer' }).send(linkInput).expect(201)).body.data;
  assert.notEqual(created.usuarioId, linked.usuarioId); assert.equal(linked.centroCustoId, b.center); assert.equal(linked.matricula, 'E2');
  await request(app).post('/employees').auth(managerToken, { type: 'bearer' }).send(linkInput).expect(409);
  const resetByManager = await request(app).patch(`/employees/${linked.id}`).auth(managerToken, { type: 'bearer' }).send({ acesso: { senha: '999999' } }).expect(409);
  assert.equal(resetByManager.body.erro.codigo, 'CONTA_FUNCIONARIO');
  await assert.rejects(registrations.update(b.auth, linked.id, { funcionario: { email: 'other@example.test' } }, {}), { code: 'P2101' });
  await assert.rejects(registrations.create(c.auth, funcionarioUnificadoCreateSchema.parse({ acesso: { senha: '123456' }, funcionario: { ...employee, centroCustoId: c.center } }), {}), { code: 'P2101' });
  assert.equal((await pool.query('SELECT count(*) FROM admtaxi.contas_funcionario WHERE email=$1', [email])).rows[0].count, '1');
  ok('EMPLOYEE-02 exact-email minimal search, atomic link, independent cost center/registration, duplicate and shared-credential protection');

  const selection = await login.identify({ email, senha: '654321' });
  assert.deepEqual(new Set(selection.empresas.map(e => e.empresaId)), new Set([a.company, b.company]));
  await assert.rejects(login.identify({ email, senha: 'wrong' }), { statusCode: 401 });
  await assert.rejects(login.select({ selecaoToken: selection.selecaoToken, empresaId: c.company }), { statusCode: 401 });
  await assert.rejects(login.select({ selecaoToken: selection.selecaoToken + 'bad', empresaId: a.company }), { statusCode: 401 });
  await assert.rejects(login.select({ selecaoToken: tokens.issueCompanySelection(accountId, 1), empresaId: a.company }), { statusCode: 401 });
  const sa = await login.select({ selecaoToken: selection.selecaoToken, empresaId: a.company });
  const sb = await login.select({ selecaoToken: selection.selecaoToken, empresaId: b.company });
  assert.equal(sa.usuario.empresaId, a.company); assert.equal(sb.usuario.empresaId, b.company);
  assert.equal(sa.usuario.perfil, 'FUNCIONARIO'); assert.notEqual(sa.usuario.usuarioId, sb.usuario.usuarioId);
  await request(app).get('/links').query({ email }).auth(sa.accessToken, { type: 'bearer' }).expect(403);
  await request(app).get('/protected').auth(selection.selecaoToken, { type: 'bearer' }).expect(401);
  const rides = new CorridaService(pool, new AuditRepository(pool));
  const rideIds = [];
  for (const [tenant, person] of [[a, created], [b, linked]] as const) {
    rideIds.push((await pool.query<{ id: string }>(`INSERT INTO admtaxi.corridas(empresa_id,solicitante_usuario_id,funcionario_id,centro_custo_id,tipo,origem_descricao,destino_descricao)
      VALUES($1,$2,$3,$4,'IMEDIATA','Origem','Destino') RETURNING id`, [tenant.company, tenant.auth.usuarioId, person.id, tenant.center])).rows[0]!.id);
  }
  assert.deepEqual((await rides.list(tokens.verifyAccess(sa.accessToken), { pagina: 1, limite: 20 })).data.map(r => r.id), [rideIds[0]]);
  await assert.rejects(rides.get(tokens.verifyAccess(sa.accessToken), rideIds[1]!), { statusCode: 404 });
  ok('EMPLOYEE-03 company-scoped sessions, own rides only, unauthorized company/role/token tampering rejected');

  await passwords.change(tokens.verifyAccess(sb.accessToken), { senhaAtual: '654321', novaSenha: '987654' });
  await assert.rejects(tokens.authenticateAccess(sa.accessToken), { statusCode: 401 });
  await assert.rejects(auth.refresh({ refreshToken: sb.refreshToken }), { statusCode: 401 });
  await assert.rejects(login.select({ selecaoToken: selection.selecaoToken, empresaId: a.company }), { statusCode: 401 });
  await registrations.update(a.auth, created.id, { acesso: { ativo: false } }, {});
  assert.deepEqual((await login.identify({ email, senha: '987654' })).empresas.map(e => e.empresaId), [b.company]);
  const deliveries: string[] = [];
  const recovery = new PasswordService(pool, logger, {
    host: 'smtp.example.test', port: 587, secure: false, user: 'test', password: 'test', from: 'no-reply@example.test',
    resetUrl: 'https://app.example.test/redefinir-senha', resetTtlMinutes: 30,
  }, { send: async (_to, url) => { deliveries.push(url); } });
  await recovery.requestReset({ email }); await recovery.requestReset({ email });
  assert.equal(deliveries.length, 1);
  const resetToken = new URLSearchParams(new URL(deliveries[0]!).hash.slice(1)).get('token')!;
  await recovery.reset({ token: resetToken, novaSenha: '765432' });
  await assert.rejects(recovery.reset({ token: resetToken, novaSenha: '123456' }), { code: 'LINK_SENHA_INVALIDO' });
  const next = await login.identify({ email, senha: '765432' });
  await pool.query('UPDATE admtaxi.empresas SET ativo=FALSE WHERE id=$1', [b.company]);
  await assert.rejects(login.select({ selecaoToken: next.selecaoToken, empresaId: b.company }), { statusCode: 401 });
  await assert.rejects(login.identify({ email, senha: '765432' }), { statusCode: 401 });
  ok('EMPLOYEE-04 global password/session revocation, independent deactivation, email recovery/cooldown/single use, inactive-company denial');
}
