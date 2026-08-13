import { z } from 'zod';

import { paginationSchema } from '../../shared/pagination/pagination';
import { statusCorrida } from '../corridas/corrida.types';

const filters = {
  inicio: z.coerce.date().optional(),
  fim: z.coerce.date().optional(),
  status: z.enum(statusCorrida).optional(),
  centroCustoId: z.string().uuid('Centro de custo invalido.').optional(),
  funcionarioId: z.string().uuid('Funcionario invalido.').optional(),
  prestadorId: z.string().uuid('Prestador invalido.').optional(),
  solicitanteUsuarioId: z.string().uuid('Solicitante invalido.').optional(),
};

const validPeriod = (value: { inicio?: Date; fim?: Date }): boolean =>
  !value.inicio || !value.fim || value.inicio <= value.fim;

export const relatorioListSchema = paginationSchema.omit({ busca: true, ativo: true }).extend(filters)
  .strict().refine(validPeriod, { message: 'O periodo informado e invalido.' });

export const relatorioExportSchema = z.object(filters).strict()
  .refine(validPeriod, { message: 'O periodo informado e invalido.' });

export type RelatorioListQuery = z.infer<typeof relatorioListSchema>;
export type RelatorioExportQuery = z.infer<typeof relatorioExportSchema>;
export type RelatorioFilters = RelatorioExportQuery;
