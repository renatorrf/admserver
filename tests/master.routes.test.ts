import express from 'express';
import pino from 'pino';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createMasterRouter } from '../src/modules/master/master.routes';
import type { MasterService } from '../src/modules/master/master.service';
import { MasterTokenService } from '../src/modules/master/master-token.service';
import { createErrorHandler } from '../src/shared/http/error-handler';

const tokens = new MasterTokenService('master-access-secret-used-only-for-tests-12345');
const context = {
  administradorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', usuario: 'master', deveAlterarSenha: false,
};

function appWith(service: MasterService) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/master', createMasterRouter(service, tokens));
  app.use(createErrorHandler(pino({ level: 'silent' })));
  return app;
}

function serviceMock(): MasterService {
  return {
    login: vi.fn().mockResolvedValue({ accessToken: 'token' }),
    getCurrent: vi.fn().mockResolvedValue({ ...context, nome: 'Administrador', ativo: true }),
    changePassword: vi.fn(),
    changeEmail: vi.fn().mockResolvedValue({ accessToken: 'updated' }),
    listCompanies: vi.fn().mockResolvedValue([]),
    createCompany: vi.fn(),
    getCompany: vi.fn().mockResolvedValue({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
    updateCompany: vi.fn().mockResolvedValue({ nomeFantasia: 'Empresa editada' }),
    setCompanyActive: vi.fn().mockResolvedValue({ ativo: false }),
    listAdministrators: vi.fn().mockResolvedValue([]),
    createAdministrator: vi.fn(),
    setAdministratorActive: vi.fn(),
  } as unknown as MasterService;
}

describe('rotas master', () => {
  const companyPath = '/api/v1/master/empresas/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  it('protege consulta, edicao e inativacao com autenticacao master e troca de senha', async () => {
    const service = serviceMock(), app = appWith(service);
    for (const [method, path, body] of [
      ['get', companyPath, {}], ['patch', companyPath, { nomeFantasia: 'Empresa editada' }], ['patch', `${companyPath}/ativo`, { ativo: false }],
    ] as const) {
      await request(app)[method](path).send(body).expect(401);
      await request(app)[method](path).auth(tokens.issue({ ...context, deveAlterarSenha: true }), { type: 'bearer' }).send(body).expect(409);
    }
    expect(service.updateCompany).not.toHaveBeenCalled(); expect(service.setCompanyActive).not.toHaveBeenCalled();
  });
  it('consulta e edita dados sem alterar o gestor nem aceitar campos extras', async () => {
    const service = serviceMock(), app = appWith(service), token = tokens.issue(context);
    await request(app).get(companyPath).auth(token, { type: 'bearer' }).expect(200);
    for (const body of [{}, { ativo: false }, { empresaId: context.administradorId }, { nomeFantasia: 'A' }, { latitudePadrao: 5 }]) {
      await request(app).patch(companyPath).auth(token, { type: 'bearer' }).send(body).expect(422);
    }
    await request(app).patch(companyPath).auth(token, { type: 'bearer' }).send({ nomeFantasia: 'Empresa editada', latitudePadrao: null, longitudePadrao: null }).expect(200);
    expect(service.updateCompany).toHaveBeenCalledWith(context, companyPath.split('/').pop(),
      { nomeFantasia: 'Empresa editada', latitudePadrao: null, longitudePadrao: null }, expect.any(Object));
    await request(app).patch('/api/v1/master/empresas/invalido').auth(token, { type: 'bearer' }).send({ nomeFantasia: 'Teste' }).expect(422);
  });
  it('inativa e reativa somente com booleano valido', async () => {
    const service = serviceMock(), app = appWith(service), token = tokens.issue(context);
    await request(app).patch(`${companyPath}/ativo`).auth(token, { type: 'bearer' }).send({ ativo: 'false' }).expect(422);
    for (const ativo of [false, true]) {
      await request(app).patch(`${companyPath}/ativo`).auth(token, { type: 'bearer' }).send({ ativo }).expect(200);
      expect(service.setCompanyActive).toHaveBeenLastCalledWith(context, companyPath.split('/').pop(), ativo, expect.any(Object));
    }
  });
  it('emite token de acesso apenas com payload de login valido', async () => {
    const service = serviceMock();
    const response = await request(appWith(service)).post('/api/v1/master/auth/login')
      .send({ usuario: 'MASTER', senha: 'senha-inicial-forte' });

    expect(response.status).toBe(200);
    expect(service.login).toHaveBeenCalledWith({ usuario: 'master', senha: 'senha-inicial-forte' });
  });

  it('bloqueia operacoes sem token master', async () => {
    const response = await request(appWith(serviceMock())).get('/api/v1/master/empresas');
    expect(response.status).toBe(401);
  });

  it('obriga a troca da senha inicial antes do painel', async () => {
    const service = serviceMock();
    const token = tokens.issue({ ...context, deveAlterarSenha: true });
    const response = await request(appWith(service)).get('/api/v1/master/empresas')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(409);
    expect(response.body.erro.mensagem).toContain('senha inicial');
    expect(service.listCompanies).not.toHaveBeenCalled();
  });

  it('permite listar empresas com token master pronto', async () => {
    const service = serviceMock();
    const response = await request(appWith(service)).get('/api/v1/master/empresas')
      .set('Authorization', `Bearer ${tokens.issue(context)}`);

    expect(response.status).toBe(200);
    expect(service.listCompanies).toHaveBeenCalledWith(context);
  });

  it('valida senha inicial ao criar outro administrador', async () => {
    const service = serviceMock();
    const response = await request(appWith(service)).post('/api/v1/master/administradores')
      .set('Authorization', `Bearer ${tokens.issue(context)}`)
      .send({ usuario: 'outro.master', nome: 'Outro Master', senha: 'curta' });

    expect(response.status).toBe(422);
    expect(service.createAdministrator).not.toHaveBeenCalled();
  });
  it('exige email para novos masters e aceita senha com seis caracteres', async () => {
    const service = serviceMock(), app = appWith(service);
    const input = { usuario: 'outro.master', nome: 'Outro Master', senha: '123456' };
    await request(app).post('/api/v1/master/administradores').auth(tokens.issue(context), { type: 'bearer' }).send(input).expect(422);
    await request(app).post('/api/v1/master/administradores').auth(tokens.issue(context), { type: 'bearer' })
      .send({ ...input, email: 'MASTER@example.test' }).expect(201);
    expect(service.createAdministrator).toHaveBeenCalledWith(context, { ...input, email: 'master@example.test' }, expect.any(Object));
  });
  it('altera apenas o email do master autenticado com confirmacao de senha', async () => {
    const service = serviceMock(), app = appWith(service);
    const input = { email: 'MASTER@example.test', senhaAtual: '123456' };
    await request(app).post('/api/v1/master/auth/email').send(input).expect(401);
    await request(app).post('/api/v1/master/auth/email').auth(tokens.issue(context), { type: 'bearer' }).send({ email: input.email }).expect(422);
    await request(app).post('/api/v1/master/auth/email').auth(tokens.issue(context), { type: 'bearer' }).send({ ...input, administradorId: context.administradorId }).expect(422);
    await request(app).post('/api/v1/master/auth/email').auth(tokens.issue(context), { type: 'bearer' }).send(input).expect(200);
    expect(service.changeEmail).toHaveBeenCalledExactlyOnceWith(context, { email: 'master@example.test', senhaAtual: '123456' });
  });
});
