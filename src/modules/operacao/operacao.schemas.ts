import { z } from 'zod';
import { paginationSchema } from '../../shared/pagination/pagination';

export const funcionarioLookupSchema = z.object({
  centroCustoId: z.string().uuid('Centro de custo invalido.').optional(),
}).strict();

export type FuncionarioLookupQuery = z.infer<typeof funcionarioLookupSchema>;

export const funcionarioSearchSchema = paginationSchema.extend({
  centroCustoId: z.string().uuid('Centro de custo invalido.').optional(),
}).strict();

export const prestadorSearchSchema = paginationSchema.extend({
  disponivel: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
}).strict();

export type FuncionarioSearchQuery = z.infer<typeof funcionarioSearchSchema>;
export type PrestadorSearchQuery = z.infer<typeof prestadorSearchSchema>;
