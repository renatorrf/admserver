import { describe, expect, it } from 'vitest';

import { assertTransition, canTransition, isActiveRide } from '../src/modules/corridas/state-machine';

describe('maquina de estados da corrida', () => {
  it('permite o fluxo principal completo', () => {
    expect(canTransition('SOLICITADA', 'OFERTADA')).toBe(true);
    expect(canTransition('OFERTADA', 'ACEITA')).toBe(true);
    expect(canTransition('ACEITA', 'EM_DESLOCAMENTO')).toBe(true);
    expect(canTransition('EM_DESLOCAMENTO', 'AGUARDANDO_PASSAGEIRO')).toBe(true);
    expect(canTransition('AGUARDANDO_PASSAGEIRO', 'EM_CORRIDA')).toBe(true);
    expect(canTransition('EM_CORRIDA', 'FINALIZADA')).toBe(true);
  });

  it('permite recusa e reabertura', () => {
    expect(canTransition('OFERTADA', 'RECUSADA')).toBe(true);
    expect(canTransition('RECUSADA', 'SOLICITADA')).toBe(true);
  });

  it('bloqueia saltos e alteracoes de estados terminais', () => {
    expect(() => assertTransition('SOLICITADA', 'FINALIZADA')).toThrow('A corrida nao pode mudar');
    expect(() => assertTransition('FINALIZADA', 'CANCELADA')).toThrow('A corrida nao pode mudar');
    expect(() => assertTransition('CANCELADA', 'SOLICITADA')).toThrow('A corrida nao pode mudar');
  });

  it('identifica apenas os estados operacionais ativos', () => {
    expect(isActiveRide('ACEITA')).toBe(true);
    expect(isActiveRide('EM_CORRIDA')).toBe(true);
    expect(isActiveRide('OFERTADA')).toBe(false);
    expect(isActiveRide('FINALIZADA')).toBe(false);
  });
});
