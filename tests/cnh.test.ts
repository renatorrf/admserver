import { describe, expect, it } from 'vitest';
import { cnhDate, validadeCnhSchema } from '../src/modules/prestadores/cnh';
import { prestadorCreateSchema, prestadorDefinition, prestadorUpdateSchema } from '../src/modules/prestadores/prestador.catalog';
import { prestadorUnificadoCreateSchema, prestadorUnificadoUpdateSchema } from '../src/modules/prestadores/prestador-unificado.schemas';

const provider = { nome: 'Motorista Teste', cpf: '52998224725', telefone: '34999991234', numeroCnh: '123456' };
const access = { nome: provider.nome, email: 'driver@example.test', telefone: provider.telefone,
  formaAtivacao: 'SENHA_TEMPORARIA', senha: '123456' };

describe('validade opcional da CNH', () => {
  it.each([undefined, null, '2035-12-31'])('aceita %s nos dois cadastros', (validadeCnh) => {
    expect(prestadorCreateSchema.safeParse({ ...provider, validadeCnh }).success).toBe(true);
    expect(prestadorUnificadoCreateSchema.safeParse({ acesso: access,
      prestador: { ...provider, validadeCnh }, veiculo: { modo: 'DEPOIS' } }).success).toBe(true);
  });

  it('distingue omissao de remocao explicita na atualizacao', () => {
    expect(prestadorUpdateSchema.parse({ nome: provider.nome })).not.toHaveProperty('validadeCnh');
    expect(prestadorUpdateSchema.parse({ validadeCnh: null })).toEqual({ validadeCnh: null });
    expect(prestadorUnificadoUpdateSchema.parse({ prestador: { nome: provider.nome } }).prestador).not.toHaveProperty('validadeCnh');
    expect(prestadorUnificadoUpdateSchema.parse({ prestador: { validadeCnh: null } }).prestador).toEqual({ validadeCnh: null });
  });

  it.each(['', '2035-02-30', '2035-12-31T03:00:00.000Z', '2020-01-01'])('recusa data informada invalida ou vencida: %s', (value) => {
    expect(validadeCnhSchema.safeParse(value).success).toBe(false);
  });

  it('serializa DATE local sem horario nem deslocamento de dia', () => {
    const date = new Date(2035, 11, 31);
    expect(cnhDate(date)).toBe('2035-12-31');
    expect(prestadorDefinition.mapRow({ validade_cnh: date }).validadeCnh).toBe('2035-12-31');
    expect(cnhDate('2035-12-31')).toBe('2035-12-31');
    expect(cnhDate(null)).toBeNull();
    expect(prestadorDefinition.mapRow({ validade_cnh: null }).validadeCnh).toBeNull();
  });
});
