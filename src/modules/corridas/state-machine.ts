import { conflict } from '../../shared/errors/app-error';
import type { StatusCorrida } from './corrida.types';

const transitions: Record<StatusCorrida, readonly StatusCorrida[]> = {
  SOLICITADA: ['OFERTADA', 'CANCELADA'],
  OFERTADA: ['ACEITA', 'RECUSADA', 'CANCELADA'],
  ACEITA: ['EM_DESLOCAMENTO', 'CANCELADA'],
  EM_DESLOCAMENTO: ['AGUARDANDO_PASSAGEIRO'],
  AGUARDANDO_PASSAGEIRO: ['EM_CORRIDA'],
  EM_CORRIDA: ['FINALIZADA'],
  FINALIZADA: [],
  CANCELADA: [],
  RECUSADA: ['SOLICITADA'],
};

export function canTransition(from: StatusCorrida, to: StatusCorrida): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: StatusCorrida, to: StatusCorrida): void {
  if (!canTransition(from, to)) {
    throw conflict(`A corrida nao pode mudar de ${from} para ${to}.`);
  }
}

export function isActiveRide(status: StatusCorrida): boolean {
  return ['ACEITA', 'EM_DESLOCAMENTO', 'AGUARDANDO_PASSAGEIRO', 'EM_CORRIDA'].includes(status);
}
