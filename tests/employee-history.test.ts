import { describe, expect, it } from 'vitest';
import { employeeEvent } from '../src/modules/corridas/employee-history';
import type { CorridaEventoRecord } from '../src/modules/corridas/corrida.types';

const scope = { funcionarioId: 'employee', embarqueId: 'pickup', desembarqueId: 'dropoff', legacy: false };
const event = (tipoEvento: string, metadata = {}): CorridaEventoRecord => ({
  id: 'event', empresaId: 'company', corridaId: 'ride', usuarioId: 'private-user', tipoEvento,
  descricao: 'Other passenger, private address and financial information', metadata,
  statusAnterior: 'ACEITA', statusNovo: 'EM_CORRIDA', criadoEm: new Date().toISOString(),
});
describe('Employee history privacy and labels', () => {
  it.each([
    ['CORRIDA_ACEITA', {}, 'Viagem aceita pelo motorista.'],
    ['PARADA_INICIAR', { paradaId: 'pickup' }, 'Motorista a caminho do seu embarque.'],
    ['PARADA_CHEGAR', { paradaId: 'dropoff' }, 'Motorista chegou ao seu destino.'],
    ['PARADA_EMBARCAR', { funcionarioId: 'employee' }, 'Seu embarque foi confirmado.'],
    ['PARADA_DESEMBARCAR', { funcionarioId: 'employee' }, 'Seu desembarque foi confirmado.'],
    ['PARADA_AUSENTE', { funcionarioId: 'employee' }, 'Sua ausencia no embarque foi registrada.'],
    ['CORRIDA_FINALIZADA', { valorFinal: '100.00' }, 'Viagem finalizada.'],
  ])('describes %s without exposing private data', (type, metadata, description) => {
    const result = employeeEvent(event(type, metadata), scope);
    expect(result.descricao).toBe(description);
    expect(result.metadata).toEqual({});
    expect(result.usuarioId).toBeNull();
    expect(result.statusNovo).toBeNull();
    expect(result.statusAnterior).toBeNull();
  });
  it('never claims another passenger action as the current employee action', () => {
    expect(employeeEvent(event('PARADA_EMBARCAR', { funcionarioId: 'other' }), scope).descricao).toBe('Registro da viagem.');
    expect(employeeEvent(event('PARADA_CHEGAR', { paradaId: 'other' }), scope).descricao).toBe('Registro da viagem.');
  });
  it('supports legacy single-passenger rides only in legacy scope', () => {
    expect(employeeEvent(event('PASSAGEIRO_EMBARCOU'), { ...scope, legacy: true }).descricao).toBe('Embarque confirmado.');
    expect(employeeEvent(event('PASSAGEIRO_EMBARCOU'), scope).descricao).toBe('Registro da viagem.');
  });
});
