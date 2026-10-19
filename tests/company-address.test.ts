import express from 'express';
import pino from 'pino';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { empresaUpdateSchema } from '../src/modules/empresas/empresa.schemas';
import { provisionamentoSchema } from '../src/modules/provisionamento/provisionamento.schemas';
import { OperacaoRepository } from '../src/modules/operacao/operacao.repository';
import type { EnderecoService } from '../src/modules/enderecos/endereco.service';
import { createMasterRouter } from '../src/modules/master/master.routes';
import type { MasterTokenService } from '../src/modules/master/master-token.service';
import type { MasterService } from '../src/modules/master/master.service';
import { createErrorHandler } from '../src/shared/http/error-handler';

const address = { endereco: 'Rua da Empresa, 100', enderecoLatitude: 0, enderecoLongitude: -48.2 };
describe('company destination address', () => {
  it('accepts zero coordinates, omission for old clients, and explicit complete removal', () => {
    expect(empresaUpdateSchema.parse(address)).toEqual(address);
    expect(empresaUpdateSchema.safeParse({ nomeFantasia: 'Empresa' }).success).toBe(true);
    expect(empresaUpdateSchema.safeParse({ endereco: null, enderecoLatitude: null, enderecoLongitude: null }).success).toBe(true);
    expect(provisionamentoSchema.shape.empresa.safeParse({ codigoAcesso: 'TEST', razaoSocial: 'Empresa', nomeFantasia: 'Empresa', cidadePadrao: 'Uberlandia', estadoPadrao: 'MG', latitudePadrao: -18, longitudePadrao: -48, ...address }).success).toBe(true);
  });
  it.each([
    { endereco: 'Rua sem coordenadas' }, { enderecoLatitude: 0, enderecoLongitude: 0 },
    { ...address, enderecoLatitude: null }, { ...address, enderecoLatitude: 91 }, { ...address, enderecoLongitude: -181 },
    { ...address, endereco: '' }, { ...address, enderecoLongitude: '0' },
  ])('rejects incomplete or invalid address %j', input => {
    expect(empresaUpdateSchema.safeParse(input).success).toBe(false);
  });
  it('looks up only the authenticated company without exposing its administrative fields', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'current', endereco: address.endereco, endereco_latitude: '0', endereco_longitude: '-48.2', email: 'private@example.test' }] });
    const result = await new OperacaoRepository({ query } as never).getCompanyAddress({ empresaId: 'current', usuarioId: 'user', perfil: 'GERENTE' });
    expect(query.mock.calls[0]?.[1]).toEqual(['current']);
    expect(result).toMatchObject({ descricao: address.endereco, latitude: 0, longitude: -48.2 });
    expect(result).not.toHaveProperty('email');
    query.mockResolvedValueOnce({ rows: [] });
    expect(await new OperacaoRepository({ query } as never).getCompanyAddress({ empresaId: 'other', usuarioId: 'user', perfil: 'GERENTE' })).toBeNull();
  });
  it('requires a ready, active master account for address search', async () => {
    const service = { getCurrent: vi.fn().mockResolvedValue({}) };
    const addresses = { autocompleteForPlatform: vi.fn().mockResolvedValue([]) };
    const tokens = { verify: vi.fn().mockReturnValue({ administradorId: 'master', deveAlterarSenha: false }) };
    const app = express();
    app.use('/master', createMasterRouter(service as unknown as MasterService, tokens as unknown as MasterTokenService, undefined, addresses as unknown as EnderecoService));
    app.use(createErrorHandler(pino({ level: 'silent' })));
    await request(app).get('/master/enderecos/autocomplete?texto=Rua').expect(401);
    expect(addresses.autocompleteForPlatform).not.toHaveBeenCalled();
    await request(app).get('/master/enderecos/autocomplete?texto=Rua').set('Authorization', 'Bearer test').expect(200);
    expect(service.getCurrent).toHaveBeenCalled();
    expect(addresses.autocompleteForPlatform).toHaveBeenCalledWith({ texto: 'Rua' });
    tokens.verify.mockReturnValueOnce({ administradorId: 'master', deveAlterarSenha: true });
    await request(app).get('/master/enderecos/autocomplete?texto=Rua').set('Authorization', 'Bearer test').expect(409);
    expect(addresses.autocompleteForPlatform).toHaveBeenCalledTimes(1);
    service.getCurrent.mockResolvedValueOnce({ deveAlterarSenha: true });
    await request(app).get('/master/enderecos/autocomplete?texto=Rua').set('Authorization', 'Bearer test').expect(409);
    expect(addresses.autocompleteForPlatform).toHaveBeenCalledTimes(1);
  });
});
