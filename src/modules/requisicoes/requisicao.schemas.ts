import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { coordinate, passengerMoney } from '../corridas/itinerary';
import { corridaCreateSchema } from '../corridas/corrida.schemas';
import { conflict, invalidReference } from '../../shared/errors/app-error';

export const addressSchema = z.object({ descricao: z.string().trim().min(3).max(1000),
  latitude: coordinate.pipe(z.number().min(-90).max(90)), longitude: coordinate.pipe(z.number().min(-180).max(180)) }).strict();
export const requisicaoSchema = z.object({
  chave: z.string().uuid(), tipo: z.enum(['IMEDIATA','AGENDADA']),
  agendadaPara: z.string().datetime({ offset: true }).nullable().optional(),
  observacao: z.string().trim().max(2000).optional(),
  participantes: z.array(z.object({ funcionarioId: z.string().uuid(),
    origem: addressSchema.nullable().optional(), destino: addressSchema.nullable().optional(),
    valor: passengerMoney.optional() }).strict()).min(1).max(16),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.participantes.map(p => p.funcionarioId)).size !== value.participantes.length)
    ctx.addIssue({ code: 'custom', path: ['participantes'], message: 'Nao repita funcionarios.' });
  if (value.tipo === 'AGENDADA' && !value.agendadaPara)
    ctx.addIssue({ code: 'custom', path: ['agendadaPara'], message: 'Informe data e horario.' });
  if (value.tipo === 'IMEDIATA' && value.agendadaPara)
    ctx.addIssue({ code: 'custom', path: ['agendadaPara'], message: 'Viagem imediata nao deve possuir agendamento.' });
});
export type RequisitionInput = z.infer<typeof requisicaoSchema>;
export type RequisitionRow = { id: string; empresa_id: string; solicitante_id: string; dados: RequisitionInput;
  status: 'PENDENTE' | 'AUTORIZADA' | 'REJEITADA' | 'SOLICITADA'; corrida_id: string | null;
  motivo: string | null; criada_em: string; conteudo_hash: string; solicitante?: string };
export const decisionSchema = z.object({ autorizar: z.boolean(), motivo: z.string().trim().max(1000).optional() }).strict()
  .refine(v => v.autorizar || (v.motivo?.length ?? 0) >= 5, { path: ['motivo'], message: 'Informe o motivo da recusa (minimo 5 caracteres).' });
export const conferenceSchema = z.object({ participantes: requisicaoSchema.shape.participantes }).strict();

// Conference may complete missing information, but never replace the approved employees or known addresses.
export function conferenceData(approved: RequisitionInput, participants: RequisitionInput['participantes']): RequisitionInput {
  if (participants.length !== approved.participantes.length) throw conflict('Mantenha os funcionarios da requisicao autorizada.');
  return { ...approved, participantes: approved.participantes.map(person => {
    const candidate = participants.find(p => p.funcionarioId === person.funcionarioId);
    if (!candidate) throw conflict('Mantenha os funcionarios da requisicao autorizada.');
    for (const field of ['origem','destino'] as const) {
      if (person[field] && (candidate[field]?.descricao !== person[field].descricao
        || candidate[field]?.latitude !== person[field].latitude || candidate[field]?.longitude !== person[field].longitude))
        throw conflict('O endereco autorizado nao pode ser alterado na conferencia. Crie uma nova requisicao.');
      if (!candidate[field]) throw invalidReference('Preencha origem e destino de todos os funcionarios.');
    }
    if (person.valor !== undefined && candidate.valor !== person.valor) throw conflict('Mantenha o valor autorizado.');
    return candidate;
  }) };
}
export function toRideInput(data: RequisitionInput, centers: Map<string,string>, monthly: boolean) {
  const points = data.participantes.map(p => ({ person: p, pickup: randomUUID(), dropoff: randomUUID() }));
  const paradas = [...points.map(p => ({ id: p.pickup, ...p.person.origem! })),
    ...points.map(p => ({ id: p.dropoff, ...p.person.destino! }))];
  const first = data.participantes[0]!;
  return corridaCreateSchema.parse({ chaveSolicitacao: data.chave, funcionarioId: first.funcionarioId,
    centroCustoId: centers.get(first.funcionarioId), tipo: data.tipo, agendadaPara: data.agendadaPara ?? null,
    quantidadePassageiros: points.length, observacaoSolicitante: data.observacao || null,
    origemDescricao: paradas[0]!.descricao, origemLatitude: paradas[0]!.latitude, origemLongitude: paradas[0]!.longitude,
    destinoDescricao: paradas.at(-1)!.descricao, destinoLatitude: paradas.at(-1)!.latitude, destinoLongitude: paradas.at(-1)!.longitude,
    itinerario: { paradas, participantes: points.map(p => ({ funcionarioId: p.person.funcionarioId,
      centroCustoId: centers.get(p.person.funcionarioId), ...(!monthly ? { valor: p.person.valor } : {}),
      embarqueId: p.pickup, desembarqueId: p.dropoff })) } });
}
