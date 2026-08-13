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
    listCompanies: vi.fn().mockResolvedValue([]),
    createCompany: vi.fn(),
    listAdministrators: vi.fn().mockResolvedValue([]),
    createAdministrator: vi.fn(),
    setAdministratorActive: vi.fn(),
  } as unknown as MasterService;
}

describe('rotas master', () => {
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
});
