import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { coordinate, passengerMoney } from '../corridas/itinerary';
import { corridaCreateSchema } from '../corridas/corrida.schemas';
import { conflict, invalidReference } from '../../shared/errors/app-error';

export const addressSchema = z.object({ descricao: z.string().trim().min(3).max(1000),
  latitude: coordinate.pipe(z.number().min(-90).max(90)), longitude: coordinate.pipe(z.number().min(-180).max(180)) }).strict();
const phoneSchema = z.string().trim().max(30).transform(v => {
    const digits=v.replace(/\D/g,''); return /^55\d{10,11}$/.test(digits)?digits.slice(2):digits;
  }).pipe(z.string().regex(/^\d{10,11}$/, 'Informe o telefone com DDD.'));
const guestSchema = z.object({ id: z.string().uuid(), nome: z.string().trim().min(2).max(150),
  telefone: phoneSchema,
  email: z.email().trim().toLowerCase().max(254).optional(),
  centroCustoId: z.string().uuid('Selecione o centro de custo do pre-cadastro.'),
  matricula: z.string().trim().min(1).max(50).transform(v => v.toUpperCase()).optional(),
  setorId: z.string().uuid('Selecione o setor do funcionario.').optional(),
}).strict();
export const completedGuestSchema = guestSchema.extend({ telefone: phoneSchema,
  matricula: z.string().trim().min(1, 'Informe a matricula.').max(50).transform(v => v.toUpperCase()),
  setorId: z.string().uuid('Selecione o setor do funcionario.'),
});
const passengerSchema = z.object({ funcionarioId: z.string().uuid().optional(), avulso: guestSchema.optional(),
  origem: addressSchema.nullable().optional(), destino: addressSchema.nullable().optional(), valor: passengerMoney.optional()
}).strict().refine(p => !!p.funcionarioId !== !!p.avulso, { message: 'Selecione um funcionario ou informe um avulso, nunca os dois.' });
export const passengerKey = (p: { funcionarioId?: string; avulso?: { id: string } }): string => p.funcionarioId ?? p.avulso?.id ?? '';
export const requisicaoSchema = z.object({
  chave: z.string().uuid(), tipo: z.enum(['IMEDIATA','AGENDADA']),
  agendadaPara: z.string().datetime({ offset: true }).nullable().optional(),
  observacao: z.string().trim().max(2000).optional(),
  participantes: z.array(passengerSchema).min(1).max(16),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.participantes.map(passengerKey)).size !== value.participantes.length
    || new Set(value.participantes.filter(p=>p.avulso?.telefone).map(p=>p.avulso!.telefone)).size !== value.participantes.filter(p=>p.avulso?.telefone).length)
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
    const candidate = participants.find(p => passengerKey(p) === passengerKey(person));
    if (!candidate) throw conflict('Mantenha os funcionarios da requisicao autorizada.');
    if (candidate.funcionarioId!==person.funcionarioId || candidate.avulso?.nome!==person.avulso?.nome
      || (person.avulso?.telefone && candidate.avulso?.telefone!==person.avulso.telefone) || candidate.avulso?.centroCustoId!==person.avulso?.centroCustoId)
      throw conflict('Mantenha os passageiros e centros de custo da requisicao autorizada.');
    for (const field of ['origem','destino'] as const) {
      if (person[field] && (candidate[field]?.descricao !== person[field].descricao
        || candidate[field]?.latitude !== person[field].latitude || candidate[field]?.longitude !== person[field].longitude))
        throw conflict('O endereco autorizado nao pode ser alterado na conferencia. Crie uma nova requisicao.');
      if (!candidate[field]) throw invalidReference('Preencha origem e destino de todos os funcionarios.');
    }
    if (person.valor !== undefined && candidate.valor !== person.valor) throw conflict('Mantenha o valor autorizado.');
    if (candidate.avulso) {
      const completed = completedGuestSchema.safeParse(candidate.avulso);
      if (!completed.success) throw invalidReference('Complete matricula, setor e telefone com DDD do pre-cadastro.');
      return { ...candidate, avulso: completed.data };
    }
    return candidate;
  }) };
}
export function toRideInput(data: RequisitionInput, centers: Map<string,string>, monthly: boolean, resolved = new Map<string,string>()) {
  const points = data.participantes.map(p => ({ person: p, pickup: randomUUID(), dropoff: randomUUID() }));
  const paradas = [...points.map(p => ({ id: p.pickup, ...p.person.origem! })),
    ...points.map(p => ({ id: p.dropoff, ...p.person.destino! }))];
  const first = data.participantes[0]!;
  return corridaCreateSchema.parse({ chaveSolicitacao: data.chave, funcionarioId: resolved.get(passengerKey(first)) ?? first.funcionarioId,
    centroCustoId: centers.get(passengerKey(first)), tipo: data.tipo, agendadaPara: data.agendadaPara ?? null,
    quantidadePassageiros: points.length, observacaoSolicitante: data.observacao || null,
    origemDescricao: paradas[0]!.descricao, origemLatitude: paradas[0]!.latitude, origemLongitude: paradas[0]!.longitude,
    destinoDescricao: paradas.at(-1)!.descricao, destinoLatitude: paradas.at(-1)!.latitude, destinoLongitude: paradas.at(-1)!.longitude,
    itinerario: { paradas, participantes: points.map(p => ({ funcionarioId: resolved.get(passengerKey(p.person)) ?? p.person.funcionarioId,
      centroCustoId: centers.get(passengerKey(p.person)), ...(!monthly ? { valor: p.person.valor } : {}),
      embarqueId: p.pickup, desembarqueId: p.dropoff })) } });
}
