import { describe, expect, it } from 'vitest';

import { centroCustoUpdateSchema } from '../src/modules/centros-custo/centro-custo.catalog';
import { funcionarioCreateSchema } from '../src/modules/funcionarios/funcionario.catalog';
import { prestadorCreateSchema } from '../src/modules/prestadores/prestador.catalog';
import { veiculoCreateSchema } from '../src/modules/veiculos/veiculo.catalog';

describe('schemas dos cadastros', () => {
  it('normaliza CPF e rejeita empresa_id enviado pelo cliente', () => {
    const base = {
      nome: 'Motorista Teste', cpf: '123.456.789-01', telefone: '11999999999',
      numeroCnh: 'abc123', validadeCnh: '2030-12-31',
    };
    expect(prestadorCreateSchema.parse(base).cpf).toBe('12345678901');
    expect(prestadorCreateSchema.safeParse({ ...base, empresaId: '11111111-1111-4111-8111-111111111111' }).success).toBe(false);
  });

  it('normaliza placas antigas e Mercosul', () => {
    const common = { marca: 'Fiat', modelo: 'Cronos', cor: 'Prata', ano: 2025, capacidadePassageiros: 4 };
    expect(veiculoCreateSchema.parse({ ...common, placa: 'ABC-1234' }).placa).toBe('ABC1234');
    expect(veiculoCreateSchema.parse({ ...common, placa: 'BRA-1E23' }).placa).toBe('BRA1E23');
  });

  it('exige latitude e longitude em conjunto', () => {
    const employee = {
      centroCustoId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      nome: 'Funcionario Teste', matricula: '123', latitudePadrao: -23.5,
    };
    expect(funcionarioCreateSchema.safeParse(employee).success).toBe(false);
    expect(funcionarioCreateSchema.safeParse({ ...employee, longitudePadrao: -46.6 }).success).toBe(true);
  });

  it('rejeita atualizacao sem campos', () => {
    expect(centroCustoUpdateSchema.safeParse({}).success).toBe(false);
  });
});
