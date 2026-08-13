import { z } from 'zod';

export const paginationSchema = z.object({
  pagina: z.coerce.number().int().min(1).default(1),
  limite: z.coerce.number().int().min(1).max(100).default(20),
  busca: z.string().trim().max(100).optional(),
  ativo: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
}).strict();

export type PaginationQuery = z.infer<typeof paginationSchema>;

export type PaginatedResult<T> = {
  data: T[];
  meta: {
    pagina: number;
    limite: number;
    total: number;
    totalPaginas: number;
  };
};

export function paginate<T>(rows: T[], total: number, query: Pick<PaginationQuery, 'pagina' | 'limite'>): PaginatedResult<T> {
  return {
    data: rows,
    meta: {
      pagina: query.pagina,
      limite: query.limite,
      total,
      totalPaginas: total === 0 ? 0 : Math.ceil(total / query.limite),
    },
  };
}
