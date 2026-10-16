import { z } from 'zod';

import { paginationSchema } from '../../shared/pagination/pagination';
import { statusCorrida } from '../corridas/corrida.types';
import { calendarDate } from '../../shared/validation/calendar-date';

const dateOnly = calendarDate;

export const painelParticipanteSchema = paginationSchema.extend({
  inicio: dateOnly.optional(),
  fim: dateOnly.optional(),
  status: z.enum(statusCorrida).optional(),
  solicitanteUsuarioId: z.string().uuid().optional(),
  prestadorId: z.string().uuid().optional(),
  centroCustoId: z.string().uuid().optional(),
  funcionarioId: z.string().uuid().optional(),
}).omit({ ativo: true }).strict().refine(
  (value) => !value.inicio || !value.fim || value.inicio <= value.fim,
  { message: 'O periodo informado e invalido.' },
);

export type PainelParticipanteQuery = z.infer<typeof painelParticipanteSchema>;
