import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { advanceItinerary, coordinate, itineraryResolved, itinerarySchema, peakOccupancy, type ItineraryAction, type ItinerarySnapshot } from '../src/modules/corridas/itinerary';
import { employeeRide } from '../src/modules/corridas/corrida-visibility';
import type { CorridaRecord } from '../src/modules/corridas/corrida.types';

const stops = Array.from({ length: 4 }, (_, index) => ({ id: randomUUID(), descricao: `Ponto ficticio ${index}`, latitude: index, longitude: index }));
const people = [
  { funcionarioId: randomUUID(), embarqueId: stops[0]!.id, desembarqueId: stops[2]!.id },
  { funcionarioId: randomUUID(), embarqueId: stops[1]!.id, desembarqueId: stops[3]!.id },
];
const plan = { paradas: stops, participantes: people };
const snapshot = (): ItinerarySnapshot => ({ versao: 1,
  paradas: stops.map((s, index) => ({ ...s, ordem: index + 1, estado: 'PENDENTE' })),
  participantes: people.map((p, index) => ({ ...p, funcionarioNome: `Teste ${index}`, estado: 'AGUARDANDO' })),
});
const command = (s: ItinerarySnapshot, acao: ItineraryAction['acao'], index: number, funcionarioId?: string, motivo?: string): ItinerarySnapshot =>
  advanceItinerary(s, { chave: randomUUID(), versao: s.versao, paradaId: stops[index]!.id, acao, funcionarioId, motivo }, '2026-10-15T12:00:00Z');

describe('Itinerario individual', () => {
  it('TRIP-02 calcula lotacao e executa A embarca Ana, B embarca Bruno, C/D desembarcam', () => {
    expect(peakOccupancy(plan)).toBe(2);
    let s = snapshot();
    for (let i = 0; i < 4; i++) {
      s = command(command(s, 'INICIAR', i), 'CHEGAR', i);
      if (i < 2) s = command(s, 'EMBARCAR', i, people[i]!.funcionarioId);
      else s = command(s, 'DESEMBARCAR', i, people[i - 2]!.funcionarioId);
      s = command(s, 'CONCLUIR', i);
    }
    expect(itineraryResolved(s)).toBe(true);
    expect(s.participantes.every(p => p.estado === 'DESEMBARCADO')).toBe(true);
  });
  it('TRIP-03/05 libera assentos antes de embarcar no mesmo ponto', () => {
    const participants = Array.from({ length: 5 }, (_, i) => ({ funcionarioId: randomUUID(),
      embarqueId: stops[i < 4 ? 0 : 1]!.id, desembarqueId: stops[i === 0 ? 1 : 3]!.id }));
    expect(peakOccupancy({ paradas: stops, participantes: participants })).toBe(4);
  });
  it('TRIP-04 rejeita desembarque anterior, inexistente ou no mesmo ponto', () => {
    for (const desembarqueId of [stops[0]!.id, randomUUID()]) expect(itinerarySchema.safeParse({ ...plan,
      participantes: [{ ...people[0], desembarqueId }] }).success).toBe(false);
  });
  it('rejeita parada e funcionario duplicados', () => {
    expect(itinerarySchema.safeParse({ ...plan, paradas: [...stops, stops[0]] }).success).toBe(false);
    expect(itinerarySchema.safeParse({ ...plan, participantes: [people[0], people[0]] }).success).toBe(false);
  });
  it.each([null, true, false, '', ' ', NaN, Infinity])('nao converte coordenada invalida %s em zero', value => {
    expect(coordinate.safeParse(value).success).toBe(false);
  });
  it('TRIP-08 exige motivo para ausencia e nao deixa embarcar passageiro ausente', () => {
    const s = command(command(snapshot(), 'INICIAR', 0), 'CHEGAR', 0);
    expect(() => command(s, 'AUSENTE', 0, people[0]!.funcionarioId)).toThrow(/motivo/);
    const absent = command(s, 'AUSENTE', 0, people[0]!.funcionarioId, 'Nao compareceu');
    expect(() => command(absent, 'EMBARCAR', 0, people[0]!.funcionarioId)).toThrow();
    expect(command(absent, 'CONCLUIR', 0).paradas[0]!.estado).toBe('CONCLUIDA');
  });
  it('TRIP-09 nao conclui parada com embarque pendente e nao resolve passageiro a bordo', () => {
    const s = command(command(snapshot(), 'INICIAR', 0), 'CHEGAR', 0);
    expect(() => command(s, 'CONCLUIR', 0)).toThrow(/Resolva/);
    expect(itineraryResolved(command(s, 'EMBARCAR', 0, people[0]!.funcionarioId))).toBe(false);
  });
  it('TRIP-10/13 bloqueia salto de parada e versao antiga sem alterar snapshot', () => {
    const s = snapshot();
    expect(() => command(s, 'INICIAR', 1)).toThrow();
    expect(() => advanceItinerary(s, { chave: randomUUID(), versao: 0, paradaId: stops[0]!.id, acao: 'INICIAR' }, '')).toThrow(/atualizada/);
    expect(s).toEqual(snapshot());
  });
  it('AUTH-03 projeta somente os pontos e dados do proprio passageiro', () => {
    const ride: CorridaRecord = { id: randomUUID(), empresaId: randomUUID(), solicitanteUsuarioId: randomUUID(),
      funcionarioId: people[0]!.funcionarioId, centroCustoId: randomUUID(), prestadorId: null, veiculoId: null,
      status: 'ACEITA', tipo: 'IMEDIATA', itinerarioVersao: 1, itinerario: snapshot(),
      funcionarioTelefone: 'PROTECTED', funcionarioMatricula: 'PROTECTED', valorFinal: '800.00',
      observacaoSolicitante: 'PROTECTED', secretFutureField: 'PROTECTED' };
    const visible = employeeRide(ride, people[1]!.funcionarioId);
    expect(visible.itinerario?.paradas.map(p => p.id)).toEqual([stops[1]!.id, stops[3]!.id]);
    expect(visible.itinerario?.participantes).toHaveLength(1);
    expect(JSON.stringify(visible)).not.toContain('PROTECTED');
    expect(visible).not.toHaveProperty('valorFinal');
    expect(visible.funcionarioId).toBe(people[1]!.funcionarioId);
  });
});
