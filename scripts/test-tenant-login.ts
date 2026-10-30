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
    const email = `${perfil.toLowerCase()}@example.test`, updatedEmail = `new.${email}`;
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

    const other = await users.create(b.context, { nome: `Pessoa ${perfil} B`, email, senha: '445566', perfil }, {});
    selection = await postLogin(email, '112233');
    assert.deepEqual(selection.empresas.map((row: { empresaId: string }) => row.empresaId), [a.id]);
    await assert.rejects(tenants.select({ selecaoToken: selection.selecaoToken, empresaId: b.id }), { statusCode: 401 });
    await users.update(b.context, other.id, { senha: '112233' }, {});
    selection = await postLogin(email, '112233');
    assert.deepEqual(new Set(selection.empresas.map((row: { empresaId: string }) => row.empresaId)), new Set([a.id, b.id]));
    const otherSession = await select(selection.selecaoToken, b.id);
    assert.equal(tokens.verifyAccess(otherSession.accessToken).empresaId, b.id);
    assert.equal(otherSession.usuario.usuarioId, other.id);
    await assert.rejects(tenants.select({ selecaoToken: selection.selecaoToken, empresaId: c.id }), { statusCode: 401 });
    await assert.rejects(tenants.select({ selecaoToken: selection.selecaoToken + 'tampered', empresaId: a.id }), { statusCode: 401 });
    await assert.rejects(tenants.select({ selecaoToken: session.accessToken, empresaId: a.id }), { statusCode: 401 });
    assert.throws(() => tokens.verifyAccess(selection.selecaoToken));
    await users.setActive(a.context, created.id, false, {});
    await assert.rejects(tenants.select({ selecaoToken: selection.selecaoToken, empresaId: a.id }), { statusCode: 401 });
    await pool.query('UPDATE admtaxi.empresas SET ativo=FALSE WHERE id=$1', [b.id]);
    await assert.rejects(tenants.select({ selecaoToken: selection.selecaoToken, empresaId: b.id }), { statusCode: 401 });
    await assert.rejects(tenants.identify({ email, senha: '112233' }), { statusCode: 401 });
    await pool.query('UPDATE admtaxi.empresas SET ativo=TRUE WHERE id=$1', [b.id]);
    await users.update(b.context, other.id, { perfil: perfil === 'GERENTE' ? 'PORTARIA' : 'GERENTE' }, {});
    await assert.rejects(tenants.select({ selecaoToken: selection.selecaoToken, empresaId: b.id }), { statusCode: 401 });
    ok(`TENANT-${perfil}-02 only verified companies, independent credentials, inactive/changed roles and token tampering denied`);
  }
}
