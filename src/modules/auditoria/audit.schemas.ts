import { z } from 'zod';

import { paginationSchema } from '../../shared/pagination/pagination';

export const auditListSchema = paginationSchema.omit({ busca: true, ativo: true }).extend({
  entidade: z.string().trim().max(80).optional(),
  acao: z.string().trim().max(50).optional(),
  usuarioId: z.string().uuid('Usuario invalido.').optional(),
  inicio: z.coerce.date().optional(),
  fim: z.coerce.date().optional(),
}).strict().refine(
  (value) => !value.inicio || !value.fim || value.inicio <= value.fim,
  { message: 'O periodo informado e invalido.' },
);

export type AuditListQuery = z.infer<typeof auditListSchema>;
