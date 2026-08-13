import { z } from 'zod';

export const funcionarioLookupSchema = z.object({
  centroCustoId: z.string().uuid('Centro de custo invalido.').optional(),
}).strict();

export type FuncionarioLookupQuery = z.infer<typeof funcionarioLookupSchema>;
