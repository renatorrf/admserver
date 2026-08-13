import { z } from 'zod';

import { paginationSchema } from '../../shared/pagination/pagination';
import { optionalText } from '../../shared/validation/common.schemas';
import { statusCorrida, tiposCorrida } from './corrida.types';

const decimalMoney = z.union([z.string(), z.number()]).transform((value) => String(value).replace(',', '.'))
  .pipe(z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Informe um valor monetario valido.'));
const optionalCoordinate = z.preprocess(
  (value) => value === '' ? null : value,
  z.coerce.number().nullable().optional(),
);
const coordinatePairValid = (latitude?: number | null, longitude?: number | null): boolean => {
  const latitudeEmpty = latitude === undefined || latitude === null;
  const longitudeEmpty = longitude === undefined || longitude === null;
  return latitudeEmpty === longitudeEmpty;
};
const isNil = (value: number | null | undefined): value is null | undefined => value === null || value === undefined;

export const corridaCreateSchema = z.object({
  funcionarioId: z.string().uuid('Funcionario invalido.'),
  centroCustoId: z.string().uuid('Centro de custo invalido.'),
  tipo: z.enum(tiposCorrida),
  agendadaPara: z.coerce.date().nullable().optional(),
  quantidadePassageiros: z.coerce.number().int().min(1).max(99).default(1),
  origemDescricao: z.string().trim().min(3).max(1000),
  origemLatitude: optionalCoordinate.refine((value) => isNil(value) || (value >= -90 && value <= 90), 'Latitude de origem invalida.'),
  origemLongitude: optionalCoordinate.refine((value) => isNil(value) || (value >= -180 && value <= 180), 'Longitude de origem invalida.'),
  destinoDescricao: z.string().trim().min(3).max(1000),
  destinoLatitude: optionalCoordinate.refine((value) => isNil(value) || (value >= -90 && value <= 90), 'Latitude de destino invalida.'),
  destinoLongitude: optionalCoordinate.refine((value) => isNil(value) || (value >= -180 && value <= 180), 'Longitude de destino invalida.'),
  observacaoSolicitante: optionalText(2000),
  valorEstimado: decimalMoney.nullable().optional(),
}).strict().superRefine((value, context) => {
  if (value.tipo === 'AGENDADA' && !value.agendadaPara) {
    context.addIssue({ code: 'custom', path: ['agendadaPara'], message: 'Informe a data da corrida agendada.' });
  }
  if (value.tipo === 'IMEDIATA' && value.agendadaPara) {
    context.addIssue({ code: 'custom', path: ['agendadaPara'], message: 'Corrida imediata nao deve possuir agendamento.' });
  }
  if (!coordinatePairValid(value.origemLatitude, value.origemLongitude)) {
    context.addIssue({ code: 'custom', path: ['origemLatitude'], message: 'Informe as coordenadas de origem juntas.' });
  }
  if (!coordinatePairValid(value.destinoLatitude, value.destinoLongitude)) {
    context.addIssue({ code: 'custom', path: ['destinoLatitude'], message: 'Informe as coordenadas de destino juntas.' });
  }
});

export const corridaAssignSchema = z.object({
  prestadorId: z.string().uuid('Prestador invalido.'),
  veiculoId: z.string().uuid('Veiculo invalido.').nullable().optional(),
}).strict();

export const corridaAcceptSchema = z.object({
  veiculoId: z.string().uuid('Veiculo invalido.').optional(),
}).strict();

export const corridaCancelSchema = z.object({
  motivo: z.string().trim().min(5, 'Informe o motivo do cancelamento.').max(1000),
}).strict();

export const corridaFinishSchema = z.object({
  valorFinal: decimalMoney,
  observacaoPrestador: optionalText(2000),
}).strict();

export const disponibilidadeSchema = z.object({ disponivel: z.boolean() }).strict();

export const corridaListSchema = paginationSchema.extend({
  status: z.enum(statusCorrida).optional(),
  tipo: z.enum(tiposCorrida).optional(),
  centroCustoId: z.string().uuid('Centro de custo invalido.').optional(),
  funcionarioId: z.string().uuid('Funcionario invalido.').optional(),
  prestadorId: z.string().uuid('Prestador invalido.').optional(),
  solicitanteUsuarioId: z.string().uuid('Solicitante invalido.').optional(),
  inicio: z.coerce.date().optional(),
  fim: z.coerce.date().optional(),
}).omit({ ativo: true }).strict().refine(
  (value) => !value.inicio || !value.fim || value.inicio <= value.fim,
  { message: 'O periodo informado e invalido.' },
);

export const eventoListSchema = paginationSchema.omit({ busca: true, ativo: true }).strict();

export type CorridaCreateInput = z.infer<typeof corridaCreateSchema>;
export type CorridaAssignInput = z.infer<typeof corridaAssignSchema>;
export type CorridaAcceptInput = z.infer<typeof corridaAcceptSchema>;
export type CorridaCancelInput = z.infer<typeof corridaCancelSchema>;
export type CorridaFinishInput = z.infer<typeof corridaFinishSchema>;
export type DisponibilidadeInput = z.infer<typeof disponibilidadeSchema>;
export type CorridaListQuery = z.infer<typeof corridaListSchema>;
export type EventoListQuery = z.infer<typeof eventoListSchema>;
