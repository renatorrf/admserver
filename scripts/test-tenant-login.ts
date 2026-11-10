import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import pino from 'pino';
import type { Pool } from 'pg';
import { AuditRepository } from '../src/modules/auditoria/audit.repository';
import { UsuarioService } from '../src/modules/usuarios/usuario.service';
import { createUsuarioRouter } from '../src/modules/usuarios/usuario.routes';
import { createAuthenticate } from '../src/modules/auth/auth.middleware';
import { PgAuthRepository } from '../src/modules/auth/auth.repository';
import { AuthService } from '../src/modules/auth/auth.service';
import { PasswordService } from '../src/modules/auth/password.service';
import { TokenService } from '../src/modules/auth/token-service';
import { TenantLoginService } from '../src/modules/auth/tenant-login.service';
import { ManagerLoginService } from '../src/modules/auth/manager-login.service';
import { EmployeeLoginService } from '../src/modules/auth/employee-login.service';
import { DriverLoginService } from '../src/modules/auth/driver-login.service';
import { createAuthRouter } from '../src/modules/auth/auth.routes';
import { createErrorHandler } from '../src/shared/http/error-handler';

export async function testTenantLogin(pool: Pool, ok: (label: string) => void): Promise<void> {
  assert.equal(pool.options.host, '127.0.0.1');
  const repo = new PgAuthRepository(pool);
  const tokens = new TokenService({ jwtAccessSecret: randomUUID() + randomUUID(), jwtRefreshSecret: randomUUID() + randomUUID(),
    jwtAccessExpiresInSeconds: 900, jwtRefreshExpiresInSeconds: 3600 }, auth => repo.accessAllowed(auth));
  const auth = new AuthService(repo, tokens), tenants = new TenantLoginService(pool, tokens, 900);
  const users = new UsuarioService(pool, new AuditRepository(pool));
  const passwords = new PasswordService(pool, pino({ level: 'silent' }));
  const companies = [];
  for (let i = 0; i < 3; i++) {
    const id = randomUUID(), managerId = randomUUID(), code = `TENANTLOGIN${i}`;
    await pool.query('INSERT INTO admtaxi.empresas(id,codigo_acesso,razao_social,nome_fantasia) VALUES($1,$2::text,$2::text,$2::text)', [id, code]);
    await pool.query(`INSERT INTO admtaxi.usuarios(id,empresa_id,nome,email,senha_hash,perfil,deve_alterar_senha)
      VALUES($1,$2,$3,$4,'synthetic','GESTOR',FALSE)`, [managerId, id, `Gestor login ${i}`, `tenantlogin${i}@example.test`]);
    const context = { usuarioId: managerId, empresaId: id, perfil: 'GESTOR' as const, senhaVersao: 0, deveAlterarSenha: false };
    companies.push({ id, code, context, token: tokens.issueTokens(context).accessToken });
  }
  const [a, b, c] = [companies[0]!, companies[1]!, companies[2]!];
  for (const perfil of ['GERENTE', 'PORTARIA'] as const) {
    const app = express(); app.use(express.json());
    app.use('/auth', createAuthRouter(auth, tokens, passwords, new ManagerLoginService(pool, tokens, 900),
      new DriverLoginService(pool, tokens, 900), new EmployeeLoginService(pool, tokens, 900), tenants));
    app.use('/users', createAuthenticate(tokens), createUsuarioRouter(users));
    app.get('/protected', createAuthenticate(tokens), (_req, res) => res.sendStatus(204));
    app.use(createErrorHandler(pino({ level: 'silent' })));
    const email = `tenant.${perfil.toLowerCase()}@example.test`, updatedEmail = `new.${email}`;
    const postLogin = async (email: string, senha: string) => (await request(app).post('/auth/acesso').send({ email, senha }).expect(200)).body.data;
    const select = async (selecaoToken: string, empresaId = a.id) =>
      (await request(app).post('/auth/empresa/selecionar').send({ selecaoToken, empresaId }).expect(200)).body.data;
    const created = (await request(app).post('/users').auth(a.token, { type: 'bearer' })
      .send({ nome: `Pessoa ${perfil}`, email, senha: '123456', perfil }).expect(201)).body.data;
    assert.equal(created.empresaId, a.id);
    await request(app).post('/auth/login').send({ empresa: a.code, email, senha: '123456' }).expect(200);
    let selection = await postLogin(email, '123456');
    assert.equal(selection.perfilSelecao, 'EMPRESA');
    assert.deepEqual(selection.empresas.map((row: { empresaId: string }) => row.empresaId), [a.id]);
    let session = await select(selection.selecaoToken);
    assert.equal(session.usuario.perfil, perfil); assert.equal(session.usuario.empresaId, a.id);
    await request(app).patch(`/users/${created.id}`).auth(a.token, { type: 'bearer' }).send({ nome: `Pessoa editada ${perfil}` }).expect(200);
    await postLogin(email, '123456');
    await request(app).patch(`/users/${created.id}`).auth(a.token, { type: 'bearer' }).send({ email: updatedEmail }).expect(200);
    await request(app).post('/auth/acesso').send({ email, senha: '123456' }).expect(401);
    await assert.rejects(tenants.select({ selecaoToken: selection.selecaoToken, empresaId: a.id }), { statusCode: 401 });
    selection = await postLogin(updatedEmail.toUpperCase(), '123456');
    session = await select(selection.selecaoToken);
    await request(app).patch(`/users/${created.id}`).auth(b.token, { type: 'bearer' }).send({ email: 'attack@example.test' }).expect(404);
    await request(app).patch(`/users/${created.id}`).auth(a.token, { type: 'bearer' }).send({ senha: '654321' }).expect(200);
    await assert.rejects(auth.refresh({ refreshToken: session.refreshToken }), { statusCode: 401 });
    await assert.rejects(tenants.select({ selecaoToken: selection.selecaoToken, empresaId: a.id }), { statusCode: 401 });
    await request(app).post('/auth/acesso').send({ email: updatedEmail, senha: '123456' }).expect(401);
    selection = await postLogin(updatedEmail, '654321'); session = await select(selection.selecaoToken);
    assert.equal(session.usuario.deveAlterarSenha, true);
    await request(app).get('/protected').auth(session.accessToken, { type: 'bearer' }).expect(403);
    await request(app).post('/auth/senha').auth(session.accessToken, { type: 'bearer' })
      .send({ senhaAtual: '654321', novaSenha: '987654' }).expect(204);
    session = await select((await postLogin(updatedEmail, '987654')).selecaoToken);
    assert.equal(session.usuario.deveAlterarSenha, false);
    await request(app).get('/protected').auth(session.accessToken, { type: 'bearer' }).expect(204);
    await request(app).patch(`/users/${created.id}`).auth(a.token, { type: 'bearer' })
      .send({ email, senha: '112233' }).expect(200);
    selection = await postLogin(email, '112233');
    session = await select(selection.selecaoToken);
    assert.equal(session.usuario.email, email); assert.equal(session.usuario.empresaId, a.id);
    ok(`TENANT-${perfil}-01 company binding, unchanged password, email/password edits and mandatory password change through HTTP`);

    await request(app).get('/users/contas-equipe').auth(b.token, { type: 'bearer' }).query({ email: 'partial' }).expect(422);
    const matches = (await request(app).get('/users/contas-equipe').auth(b.token, { type: 'bearer' }).query({ email }).expect(200)).body.data;
    assert.equal(matches.length, 1);
    assert.deepEqual(Object.keys(matches[0]).sort(), ['email','id','nome','vinculado']);
    const link = { contaId: matches[0].id, perfil };
    await request(app).post('/users/vincular-conta').auth(b.token, { type: 'bearer' }).send({ ...link, empresaId: c.id }).expect(422);
    await request(app).post('/users/vincular-conta').auth(b.token, { type: 'bearer' }).send({ ...link, perfil: 'GESTOR' }).expect(422);
    const other = (await request(app).post('/users/vincular-conta').auth(b.token, { type: 'bearer' }).send(link).expect(201)).body.data;
    assert.equal(other.empresaId, b.id); assert.equal(other.perfil, perfil);
    await request(app).post('/users/vincular-conta').auth(b.token, { type: 'bearer' }).send(link).expect(409);
    await assert.rejects(users.create(c.context, { nome: `Pessoa ${perfil} C`, email, senha: '445566', perfil }, {}), { code: 'P2901' });
    await request(app).patch(`/users/${other.id}`).auth(b.token, { type: 'bearer' }).send({ senha: '445566' }).expect(409);
    await request(app).patch(`/users/${other.id}`).auth(b.token, { type: 'bearer' }).send({ email: 'hijack@example.test' }).expect(409);
    if (perfil === 'GERENTE') assert.equal((await users.getManagerScope(b.context, other.id)).centrosCusto.length, 0);
    selection = await postLogin(email, '112233');
    assert.deepEqual(new Set(selection.empresas.map((row: { empresaId: string }) => row.empresaId)), new Set([a.id, b.id]));
    const otherSession = await select(selection.selecaoToken, b.id);
    assert.equal(tokens.verifyAccess(otherSession.accessToken).empresaId, b.id);
    assert.equal(otherSession.usuario.usuarioId, other.id);
    await assert.rejects(tenants.select({ selecaoToken: selection.selecaoToken, empresaId: c.id }), { statusCode: 401 });
    await assert.rejects(tenants.select({ selecaoToken: selection.selecaoToken + 'tampered', empresaId: a.id }), { statusCode: 401 });
    await assert.rejects(tenants.select({ selecaoToken: session.accessToken, empresaId: a.id }), { statusCode: 401 });
    assert.throws(() => tokens.verifyAccess(selection.selecaoToken));
    await passwords.change(tokens.verifyAccess(otherSession.accessToken), { senhaAtual: '112233', novaSenha: '778899' });
    await assert.rejects(auth.refresh({ refreshToken: session.refreshToken }), { statusCode: 401 });
    await assert.rejects(auth.refresh({ refreshToken: otherSession.refreshToken }), { statusCode: 401 });
    await assert.rejects(tenants.select({ selecaoToken: selection.selecaoToken, empresaId: a.id }), { statusCode: 401 });
    const newSession = await select((await postLogin(email, '778899')).selecaoToken, b.id);
    if (perfil === 'GERENTE') {
      const scopes = [];
      for (const tenant of [a, b]) {
        const sector = randomUUID(), center = randomUUID();
        await pool.query("INSERT INTO admtaxi.setores(id,empresa_id,codigo,nome) VALUES($1,$2,'LOGIN','Setor local')", [sector, tenant.id]);
        await pool.query("INSERT INTO admtaxi.centros_custo(id,empresa_id,setor_id,codigo,nome) VALUES($1,$2,$3,'LOGIN','Centro local')", [center, tenant.id, sector]);
        scopes.push({ setorIds: [sector], centroCustoIds: [center] });
      }
      await users.replaceManagerScope(a.context, created.id, scopes[0]!, {});
      await users.replaceManagerScope(b.context, other.id, scopes[1]!, {});
      await assert.rejects(users.replaceManagerScope(b.context, other.id, scopes[0]!, {}), { statusCode: 422 });
      assert.deepEqual((await users.getManagerScope(a.context, created.id)).centrosCusto.map(x => x.id), scopes[0]!.centroCustoIds);
      assert.deepEqual((await users.getManagerScope(b.context, other.id)).centrosCusto.map(x => x.id), scopes[1]!.centroCustoIds);
      ok('SHARED-SCOPE different sectors/centers per membership; foreign references rejected without changing original scope');
    }
    await request(app).get('/users/contas-gestor').auth(newSession.accessToken, { type: 'bearer' }).query({ email }).expect(403);
    await request(app).post('/users/vincular-gestor').auth(newSession.accessToken, { type: 'bearer' }).send({ contaId: matches[0].id }).expect(403);
    await request(app).get('/users/contas-equipe').auth(newSession.accessToken, { type: 'bearer' }).query({ email }).expect(403);
    await request(app).post('/users/vincular-conta').auth(newSession.accessToken, { type: 'bearer' }).send(link).expect(403);
    const deliveries: string[] = [];
    const recovery = new PasswordService(pool, pino({ level: 'silent' }), {
      host: 'smtp.example.test', port: 587, secure: false, user: 'test', password: 'test', from: 'no-reply@example.test',
      resetUrl: 'https://app.example.test/redefinir-senha', resetTtlMinutes: 30,
    }, { send: async (_to, url) => { deliveries.push(url); } });
    await recovery.requestReset({ email }); await recovery.requestReset({ email });
    assert.equal(deliveries.length, 1);
    const resetToken = new URLSearchParams(new URL(deliveries[0]!).hash.slice(1)).get('token')!;
    await recovery.reset({ token: resetToken, novaSenha: '765432' });
    await assert.rejects(recovery.reset({ token: resetToken, novaSenha: '123456' }), { code: 'LINK_SENHA_INVALIDO' });
    await assert.rejects(tokens.authenticateAccess(newSession.accessToken), { statusCode: 401 });
    selection = await postLogin(email, '765432');
    assert.equal(selection.empresas.length, 2);
    ok(`SHARED-STAFF-${perfil} exact-email lookup, authorized link, no foreign scope, shared password/reset and global revocation`);
    await users.setActive(a.context, created.id, false, {});
    await assert.rejects(tenants.select({ selecaoToken: selection.selecaoToken, empresaId: a.id }), { statusCode: 401 });
    await pool.query('UPDATE admtaxi.empresas SET ativo=FALSE WHERE id=$1', [b.id]);
    await assert.rejects(tenants.select({ selecaoToken: selection.selecaoToken, empresaId: b.id }), { statusCode: 401 });
    await assert.rejects(tenants.identify({ email, senha: '765432' }), { statusCode: 401 });
    await pool.query('UPDATE admtaxi.empresas SET ativo=TRUE WHERE id=$1', [b.id]);
    await users.update(b.context, other.id, { perfil: perfil === 'GERENTE' ? 'PORTARIA' : 'GERENTE' }, {});
    await assert.rejects(tenants.select({ selecaoToken: selection.selecaoToken, empresaId: b.id }), { statusCode: 401 });
    ok(`TENANT-${perfil}-02 only verified companies, independent memberships, inactive/changed roles and token tampering denied`);
  }

  const managers = new ManagerLoginService(pool, tokens, 900);
  const app = express(); app.use(express.json());
  app.use('/auth', createAuthRouter(auth, tokens, passwords, managers, new DriverLoginService(pool, tokens, 900), undefined, tenants));
  app.use('/users', createAuthenticate(tokens), createUsuarioRouter(users));
  app.use(createErrorHandler(pino({ level: 'silent' })));
  const email = 'shared.local.manager@example.test';
  const original = await users.create(a.context, { nome: 'Gestor vinculado', email, senha: '123456', perfil: 'GESTOR' }, {});
  await request(app).get('/users/contas-gestor').auth(b.token, { type: 'bearer' }).query({ email: 'partial' }).expect(422);
  const matches = (await request(app).get('/users/contas-gestor').auth(b.token, { type: 'bearer' }).query({ email }).expect(200)).body.data;
  assert.equal(matches.length, 1); assert.deepEqual(Object.keys(matches[0]).sort(), ['email', 'id', 'nome', 'vinculado']);
  const body = { contaId: matches[0].id };
  await request(app).post('/users/vincular-gestor').auth(b.token, { type: 'bearer' }).send({ ...body, empresaId: c.id }).expect(422);
  await request(app).post('/users/vincular-gestor').auth(b.token, { type: 'bearer' }).send({ ...body, perfil: 'PORTARIA' }).expect(422);
  const linked = (await request(app).post('/users/vincular-gestor').auth(b.token, { type: 'bearer' }).send({ ...body, recebeAvisosViagem: false }).expect(201)).body.data;
  assert.equal(linked.recebeAvisosViagem, false);
  assert.equal((await users.get(a.context, original.id)).recebeAvisosViagem, true);
  await request(app).patch(`/users/${linked.id}`).auth(a.token, { type: 'bearer' }).send({ recebeAvisosViagem: true }).expect(404);
  const reenabled = (await request(app).patch(`/users/${linked.id}`).auth(b.token, { type: 'bearer' }).send({ recebeAvisosViagem: true }).expect(200)).body.data;
  assert.equal(reenabled.recebeAvisosViagem, true);
  assert.equal(linked.empresaId, b.id); assert.notEqual(linked.id, original.id); assert.equal(linked.perfil, 'GESTOR');
  await request(app).post('/users/vincular-gestor').auth(b.token, { type: 'bearer' }).send(body).expect(409);
  const selection = (await request(app).post('/auth/acesso').send({ email, senha: '123456' }).expect(200)).body.data;
  assert.deepEqual(new Set(selection.empresas.map((e: { empresaId: string }) => e.empresaId)), new Set([a.id, b.id]));
  const sessionA = await managers.select({ selecaoToken: selection.selecaoToken, empresaId: a.id });
  const sessionB = await managers.select({ selecaoToken: selection.selecaoToken, empresaId: b.id });
  assert.equal(sessionA.usuario.usuarioId, original.id); assert.equal(sessionB.usuario.usuarioId, linked.id);
  await assert.rejects(managers.select({ selecaoToken: selection.selecaoToken, empresaId: c.id }), { statusCode: 401 });
  await users.setActive(b.context, linked.id, false, {});
  assert.deepEqual((await managers.identify({ email, senha: '123456' })).empresas.map(e => e.empresaId), [a.id]);
  assert.equal((await users.get(a.context, original.id)).ativo, true);
  ok('MANAGER-LINK tenant gestor links an existing manager by exact email; same credentials, tenant-only insertion, duplicate and independent deactivation');
}
