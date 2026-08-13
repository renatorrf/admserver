import express from 'express';
import pino from 'pino';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createProvisionamentoRouter } from '../src/modules/provisionamento/provisionamento.routes';
import { ProvisionamentoService } from '../src/modules/provisionamento/provisionamento.service';
import { createErrorHandler } from '../src/shared/http/error-handler';

const secret = 'provisioning-secret-used-only-in-tests-123456';
const input = {
  empresa: {
    codigoAcesso: 'ADM-BR', razaoSocial: 'ADM Brasil Ltda', nomeFantasia: 'ADM Brasil',
    cidadePadrao: 'Uberlandia', estadoPadrao: 'MG', latitudePadrao: -18.9186, longitudePadrao: -48.2772,
    cnpj: '12345678000199', telefone: '(11) 3000-0000', email: 'contato@adm.example',
  },
  gestor: {
    nome: 'Gestor Principal', email: 'gestor@adm.example', telefone: '(11) 99999-0000',
    senha: 'senha-inicial-forte',
  },
};

function testApp(service: ProvisionamentoService) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/provisionamento', createProvisionamentoRouter(service, secret));
  app.use(createErrorHandler(pino({ level: 'silent' })));
  return app;
}

describe('provisionamento de empresa', () => {
  it('exige o segredo de provisionamento sem chamar o servico', async () => {
    const service = { create: vi.fn() } as unknown as ProvisionamentoService;
    const response = await request(testApp(service)).post('/api/v1/provisionamento/empresas').send(input);

    expect(response.status).toBe(401);
    expect(response.body.erro.codigo).toBe('NAO_AUTORIZADO');
    expect(service.create).not.toHaveBeenCalled();
  });

  it('valida os dados antes de provisionar', async () => {
    const service = { create: vi.fn() } as unknown as ProvisionamentoService;
    const response = await request(testApp(service))
      .post('/api/v1/provisionamento/empresas')
      .set('X-Provisioning-Secret', secret)
      .send({ ...input, gestor: { ...input.gestor, senha: 'curta' } });

    expect(response.status).toBe(422);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('cria empresa e gestor com resposta sem senha', async () => {
    const result = {
      empresa: { id: 'company-1', codigoAcesso: 'ADM-BR', razaoSocial: 'ADM Brasil Ltda', nomeFantasia: 'ADM Brasil' },
      gestor: { id: 'user-1', nome: 'Gestor Principal', email: 'gestor@adm.example', perfil: 'GESTOR' as const },
    };
    const service = { create: vi.fn().mockResolvedValue(result) } as unknown as ProvisionamentoService;
    const response = await request(testApp(service))
      .post('/api/v1/provisionamento/empresas')
      .set('X-Provisioning-Secret', secret)
      .send(input);

    expect(response.status).toBe(201);
    expect(response.body.data).toEqual(result);
    expect(JSON.stringify(response.body)).not.toContain(input.gestor.senha);
  });

  it('usa hash e grava empresa, gestor e auditoria na mesma transacao', async () => {
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO admtaxi.empresas')) return Promise.resolve({ rows: [{
        id: 'company-1', codigo_acesso: 'ADM-BR', razao_social: 'ADM Brasil Ltda', nome_fantasia: 'ADM Brasil',
      }] });
      if (sql.includes('INSERT INTO admtaxi.usuarios')) return Promise.resolve({ rows: [{
        id: 'user-1', nome: 'Gestor Principal', email: 'gestor@adm.example', perfil: 'GESTOR',
      }] });
      return Promise.resolve({ rows: [] });
    });
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };
    const hasher = vi.fn().mockResolvedValue('argon2id-hash');
    const service = new ProvisionamentoService(pool as never, hasher);

    const result = await service.create(input, { ip: '127.0.0.1', userAgent: 'test' });

    expect(hasher).toHaveBeenCalledWith(input.gestor.senha);
    expect(query.mock.calls.map(([sql]) => sql.trim().split(/\s+/)[0])).toEqual([
      'BEGIN', 'SELECT', 'INSERT', 'INSERT', 'INSERT', 'COMMIT',
    ]);
    const userInsert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO admtaxi.usuarios'));
    expect(userInsert?.[1]).toContain('argon2id-hash');
    expect(userInsert?.[1]).not.toContain(input.gestor.senha);
    const auditInsert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO admtaxi.auditoria'));
    expect(JSON.stringify(auditInsert?.[1])).not.toContain(input.gestor.senha);
    expect(auditInsert?.[0]).toContain('$1::uuid');
    expect(auditInsert?.[0]).toContain('$3::text');
    expect(auditInsert?.[1]).toEqual([
      'company-1', 'user-1', 'company-1', JSON.stringify(result), '127.0.0.1', 'test',
    ]);
    expect(result.gestor.perfil).toBe('GESTOR');
    expect(release).toHaveBeenCalledOnce();
  });
});
