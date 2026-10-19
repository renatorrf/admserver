import { z } from 'zod';
import { conflict, invalidReference } from '../../shared/errors/app-error';

export const passengerMoney = z.union([z.string(), z.number()]).transform(value => String(value).replace(',', '.'))
  .pipe(z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Informe um valor individual valido.'));
export const moneyCents = (value: string): bigint => {
  const [integer, fraction = ''] = value.split('.');
  return BigInt(integer!) * 100n + BigInt(fraction.padEnd(2, '0'));
};
export function passengerTotal(input: ItineraryInput): string | undefined {
  if (!input.participantes.some(p => p.valor !== undefined)) return undefined;
  if (input.participantes.some(p => p.valor === undefined)) throw invalidReference('Informe o valor de cada funcionario.');
  const cents = input.participantes.reduce((sum, p) => sum + moneyCents(p.valor!), 0n);
  if (cents > 999999999999n) throw invalidReference('O total da corrida excede o valor permitido.');
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

export const coordinate = z.union([z.number(), z.string().trim().min(1)])
  .transform(value => Number(value)).pipe(z.number().finite());
export const itinerarySchema = z.object({
  paradas: z.array(z.object({
    id: z.string().uuid(), descricao: z.string().trim().min(3).max(1000),
    latitude: coordinate.pipe(z.number().min(-90).max(90)),
    longitude: coordinate.pipe(z.number().min(-180).max(180)),
  }).strict()).min(2).max(32),
  participantes: z.array(z.object({
    funcionarioId: z.string().uuid(), embarqueId: z.string().uuid(), desembarqueId: z.string().uuid(),
    centroCustoId: z.string().uuid().optional(), valor: passengerMoney.optional(),
  }).strict()).min(1).max(99),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.paradas.map(p => p.id)).size !== value.paradas.length) {
    ctx.addIssue({ code: 'custom', path: ['paradas'], message: 'Nao repita identificadores de paradas.' });
  }
  if (new Set(value.participantes.map(p => p.funcionarioId)).size !== value.participantes.length) {
    ctx.addIssue({ code: 'custom', path: ['participantes'], message: 'Cada funcionario deve possuir uma unica participacao.' });
  }
  value.participantes.forEach((p, i) => {
    if (value.participantes.some(item => item.valor !== undefined) && (p.valor === undefined || !p.centroCustoId)) {
      ctx.addIssue({ code: 'custom', path: ['participantes', i, 'valor'], message: 'Informe centro de custo e valor para cada funcionario.' });
    }
    const start = value.paradas.findIndex(s => s.id === p.embarqueId);
    const end = value.paradas.findIndex(s => s.id === p.desembarqueId);
    if (start < 0 || end <= start) ctx.addIssue({ code: 'custom', path: ['participantes', i, 'desembarqueId'],
      message: `Participante ${i + 1}: desembarque deve ocorrer depois do embarque, em parada deste itinerario.` });
  });
});
export type ItineraryInput = z.infer<typeof itinerarySchema>;
export type StopState = 'PENDENTE' | 'EM_DESLOCAMENTO' | 'CHEGADA' | 'CONCLUIDA';
export type PassengerState = 'AGUARDANDO' | 'EMBARCADO' | 'DESEMBARCADO' | 'AUSENTE' | 'CANCELADO';
export type ItineraryStop = ItineraryInput['paradas'][number] & {
  ordem: number; estado: StopState; chegadaEm?: string | null; saidaEm?: string | null;
};
export type Participation = ItineraryInput['participantes'][number] & {
  funcionarioNome: string; estado: PassengerState; motivo?: string | null;
  embarqueEm?: string | null; desembarqueEm?: string | null;
};
export type ItinerarySnapshot = { versao: number; paradas: ItineraryStop[]; participantes: Participation[] };
export const itineraryEditSchema = z.object({ versao: z.number().int().min(1), itinerario: itinerarySchema }).strict();
export const itineraryActionSchema = z.object({
  chave: z.string().uuid(), versao: z.number().int().min(1), paradaId: z.string().uuid(),
  acao: z.enum(['INICIAR', 'CHEGAR', 'EMBARCAR', 'DESEMBARCAR', 'AUSENTE', 'CANCELAR_PASSAGEIRO', 'CONCLUIR']),
  funcionarioId: z.string().uuid().optional(), motivo: z.string().trim().min(5).max(1000).optional(),
  avancoAutomatico: z.boolean().optional(),
}).strict();
export type ItineraryAction = z.infer<typeof itineraryActionSchema>;

export function peakOccupancy(input: ItineraryInput): number {
  // Drop-offs free seats before pickups at the same physical stop.
  itinerarySchema.parse(input);
  let occupancy = 0;
  let peak = 0;
  for (const stop of input.paradas) {
    occupancy -= input.participantes.filter(p => p.desembarqueId === stop.id).length;
    occupancy += input.participantes.filter(p => p.embarqueId === stop.id).length;
    peak = Math.max(peak, occupancy);
  }
  return peak;
}

export function advanceItinerary(snapshot: ItinerarySnapshot, action: ItineraryAction, now: string): ItinerarySnapshot {
  if (snapshot.versao !== action.versao) throw conflict('A viagem foi atualizada. Recarregue antes de continuar.');
  const next = structuredClone(snapshot);
  const stop = next.paradas.find(p => p.estado !== 'CONCLUIDA');
  if (!stop || stop.id !== action.paradaId) throw conflict('Execute a proxima parada pendente na ordem do itinerario.');
  if (action.acao === 'INICIAR') {
    if (stop.estado !== 'PENDENTE') throw conflict('Esta parada ja foi iniciada.');
    stop.estado = 'EM_DESLOCAMENTO';
  } else if (action.acao === 'CHEGAR') {
    if (stop.estado !== 'EM_DESLOCAMENTO') throw conflict('Inicie o deslocamento antes de registrar a chegada.');
    stop.estado = 'CHEGADA'; stop.chegadaEm = now;
  } else {
    if (stop.estado !== 'CHEGADA') throw conflict('Registre a chegada antes de atender os passageiros.');
    if (action.acao === 'CONCLUIR') {
      if (next.participantes.some(p => (p.embarqueId === stop.id && p.estado === 'AGUARDANDO')
        || (p.desembarqueId === stop.id && p.estado === 'EMBARCADO'))) {
        throw conflict('Resolva todos os embarques e desembarques desta parada.');
      }
      stop.estado = 'CONCLUIDA'; stop.saidaEm = now;
    } else {
      const passenger = next.participantes.find(p => p.funcionarioId === action.funcionarioId);
      if (!passenger) throw invalidReference('Participante nao encontrado nesta viagem.');
      if (action.acao === 'DESEMBARCAR') {
        if (passenger.desembarqueId !== stop.id || passenger.estado !== 'EMBARCADO') {
          throw conflict('Desembarque permitido apenas no destino de um passageiro embarcado.');
        }
        passenger.estado = 'DESEMBARCADO'; passenger.desembarqueEm = now;
      } else {
        if (passenger.embarqueId !== stop.id || passenger.estado !== 'AGUARDANDO') {
          throw conflict('O passageiro nao aguarda embarque nesta parada.');
        }
        if (action.acao === 'EMBARCAR') {
          if (next.participantes.some(p => p.desembarqueId === stop.id && p.estado === 'EMBARCADO')) {
            throw conflict('Confirme os desembarques desta parada antes dos embarques.');
          }
          passenger.estado = 'EMBARCADO'; passenger.embarqueEm = now;
        } else {
          if (!action.motivo) throw invalidReference('Informe o motivo da ausencia ou cancelamento.');
          passenger.estado = action.acao === 'AUSENTE' ? 'AUSENTE' : 'CANCELADO'; passenger.motivo = action.motivo;
        }
      }
    }
  }
  // Older installed clients still send explicit CONCLUIR/INICIAR commands.
  if (action.avancoAutomatico) {
    const pending = next.participantes.some(p => (p.embarqueId === stop.id && p.estado === 'AGUARDANDO')
      || (p.desembarqueId === stop.id && p.estado === 'EMBARCADO'));
    if (stop.estado === 'CHEGADA' && action.acao !== 'CHEGAR' && !pending) {
      stop.estado = 'CONCLUIDA'; stop.saidaEm = now;
    }
    if (stop.estado === 'CONCLUIDA') {
      const following = next.paradas.find(p => p.estado !== 'CONCLUIDA');
      if (following?.estado === 'PENDENTE') following.estado = 'EM_DESLOCAMENTO';
    }
  }
  next.versao++;
  return next;
}

export function itineraryResolved(snapshot: ItinerarySnapshot): boolean {
  return snapshot.paradas.length >= 2 && snapshot.paradas.every(p => p.estado === 'CONCLUIDA')
    && snapshot.participantes.every(p => ['DESEMBARCADO', 'AUSENTE', 'CANCELADO'].includes(p.estado));
}
