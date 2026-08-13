import { describe, expect, it } from 'vitest';

import { localizacaoCreateSchema } from '../src/modules/localizacoes/localizacao.schemas';

describe('localizacaoCreateSchema', () => {
  it('aceita coordenadas e metadados GPS validos', () => {
    expect(localizacaoCreateSchema.parse({
      latitude: -23.55052, longitude: -46.633308, precisaoMetros: 9, velocidade: 10, direcao: 270,
    })).toMatchObject({ latitude: -23.55052, longitude: -46.633308 });
  });

  it('rejeita coordenadas fora dos limites geograficos', () => {
    expect(localizacaoCreateSchema.safeParse({ latitude: -91, longitude: 181 }).success).toBe(false);
  });
});
