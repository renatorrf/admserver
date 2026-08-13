import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../src/db/pool';
import type { AuthContext } from '../src/modules/auth/auth.types';
import { OperacaoRepository } from '../src/modules/operacao/operacao.repository';
import { OperacaoService } from '../src/modules/operacao/operacao.service';

const EMPRESA = '11111111-1111-4111-8111-111111111111';
const USUARIO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CENTRO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const gerente: AuthContext = { empresaId: EMPRESA, usuarioId: USUARIO, perfil: 'GERENTE' };
const prestador: AuthContext = { empresaId: EMPRESA, usuarioId: USUARIO, perfil: 'PRESTADOR' };

describe('OperacaoService', () => {
  it('impede prestador de consultar centros e funcionarios', async () => {
    const repository = {
      listCenters: vi.fn(), listEmployees: vi.fn(), getMyProvider: vi.fn(), listMyVehicles: vi.fn(),
    } as unknown as OperacaoRepository;
    const service = new OperacaoService(repository);

    expect(() => service.listCenters(prestador)).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(() => service.listEmployees(prestador, {})).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  it('retorna somente o cadastro ativo ligado ao usuario prestador', async () => {
    const repository = {
      getMyProvider: vi.fn().mockResolvedValue({ id: 'p1', nome: 'Motorista', disponivel: true, ativo: true }),
    } as unknown as OperacaoRepository;
    const service = new OperacaoService(repository);

    await expect(service.getMyProvider(prestador)).resolves.toMatchObject({ id: 'p1', disponivel: true });
    expect(repository.getMyProvider).toHaveBeenCalledWith(prestador);
  });

  it('recusa prestador inexistente ou inativo', async () => {
    const repository = { getMyProvider: vi.fn().mockResolvedValue(null) } as unknown as OperacaoRepository;
    await expect(new OperacaoService(repository).getMyProvider(prestador))
      .rejects.toMatchObject({ statusCode: 404, code: 'REGISTRO_NAO_ENCONTRADO' });
  });
});

describe('OperacaoRepository', () => {
  it('aplica empresa e usuario ao escopo de centros do gerente', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: CENTRO, codigo: 'FIN', nome: 'Financeiro' }] });
    const repository = new OperacaoRepository({ query } as unknown as Database);

    const result = await repository.listCenters(gerente);

    expect(result).toHaveLength(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('gerente_usuario_id = $2'), [EMPRESA, USUARIO]);
  });

  it('mapeia coordenadas e restringe funcionarios pelo centro solicitado', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      id: 'f1', centro_custo_id: CENTRO, nome: 'Ana', matricula: 'M1', telefone: null,
      endereco_padrao: 'Rua A', latitude_padrao: '-23.55', longitude_padrao: '-46.63',
    }] });
    const repository = new OperacaoRepository({ query } as unknown as Database);

    const result = await repository.listEmployees(gerente, { centroCustoId: CENTRO });

    expect(result[0]).toMatchObject({ centroCustoId: CENTRO, latitudePadrao: -23.55, longitudePadrao: -46.63 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('f.centro_custo_id = $3'), [EMPRESA, USUARIO, CENTRO]);
  });
});
