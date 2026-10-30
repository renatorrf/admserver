import type { CorridaEventoRecord } from './corrida.types';

const labels: Record<string, string> = {
  CORRIDA_SOLICITADA: 'Viagem solicitada.', CORRIDA_OFERTADA: 'Viagem oferecida ao motorista.',
  ATRIBUICAO_ALTERADA: 'Motorista da viagem atualizado.', CORRIDA_REABERTA: 'Viagem aguardando novo motorista.',
  CORRIDA_REIVINDICADA: 'Motorista selecionou a viagem.', CORRIDA_ACEITA: 'Viagem aceita pelo motorista.',
  CORRIDA_RECUSADA: 'Viagem recusada pelo motorista.', CORRIDA_FINALIZADA: 'Viagem finalizada.',
  CORRIDA_CANCELADA: 'Viagem cancelada.', ITINERARIO_EDITADO: 'Itinerario da viagem atualizado.',
  TRAJETO_CALCULADO: 'Trajeto definido pelo motorista.',
};
const legacyLabels: Record<string, string> = {
  DESLOCAMENTO_INICIADO: 'Motorista iniciou o deslocamento.', CHEGADA_AO_EMBARQUE: 'Motorista chegou ao embarque.',
  PASSAGEIRO_EMBARCOU: 'Embarque confirmado.', DESEMBARQUE_CONFIRMADO: 'Desembarque confirmado.',
};
const personalLabels: Record<string, string> = {
  PARADA_EMBARCAR: 'Seu embarque foi confirmado.', PARADA_DESEMBARCAR: 'Seu desembarque foi confirmado.',
  PARADA_AUSENTE: 'Sua ausencia no embarque foi registrada.', PARADA_CANCELAR_PASSAGEIRO: 'Sua participacao foi cancelada.',
};
export const employeeGlobalEvents = Object.keys(labels);
export const employeeLegacyEvents = Object.keys(legacyLabels);
export const employeePersonalEvents = Object.keys(personalLabels);
export const employeeStopEvents = ['PARADA_INICIAR', 'PARADA_CHEGAR', 'PARADA_CONCLUIR', 'PARADA_DISPENSADA'];
export type EmployeeHistoryScope = { funcionarioId: string; embarqueId?: string; desembarqueId?: string; legacy: boolean };

export function employeeEvent(event: CorridaEventoRecord, scope: EmployeeHistoryScope): CorridaEventoRecord {
  const label = (values: Record<string, string>) => Object.hasOwn(values, event.tipoEvento) ? values[event.tipoEvento] : undefined;
  let description = label(labels);
  if (scope.legacy) description ??= label(legacyLabels);
  if (event.metadata.funcionarioId === scope.funcionarioId) description ??= label(personalLabels);
  const stop = event.metadata.paradaId;
  const ownStop = stop && (stop === scope.embarqueId || stop === scope.desembarqueId);
  if (!description && ownStop) {
    const place = stop === scope.embarqueId ? 'embarque' : 'destino';
    description = label({ PARADA_INICIAR: `Motorista a caminho do seu ${place}.`,
      PARADA_CHEGAR: `Motorista chegou ao seu ${place}.`, PARADA_CONCLUIR: `Atendimento do seu ${place} concluido.`,
      PARADA_DISPENSADA: `Parada do seu ${place} dispensada.` });
  }
  // Never reuse free text or metadata: they may contain another passenger's address or financial data.
  return { ...event, usuarioId: null, descricao: description ?? 'Registro da viagem.', metadata: {},
    statusAnterior: null, statusNovo: null };
}
