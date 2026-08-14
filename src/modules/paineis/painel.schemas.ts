import { z } from 'zod';

import { paginationSchema } from '../../shared/pagination/pagination';
import { statusCorrida } from '../corridas/corrida.types';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Informe a data no formato AAAA-MM-DD.');

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
