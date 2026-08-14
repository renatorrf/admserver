import { z } from 'zod';

import { paginationSchema } from '../../shared/pagination/pagination';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Informe a data no formato AAAA-MM-DD.');
const money = z.union([z.string(), z.number()])
  .transform((value) => String(value).replace(',', '.'))
  .pipe(z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Informe um valor monetario valido.'));

export const faturamentoFiltroSchema = z.object({
  periodoInicio: dateOnly,
  periodoFim: dateOnly,
  prestadorId: z.string().uuid('Prestador invalido.'),
  setorId: z.string().uuid('Setor invalido.').optional(),
  centroCustoId: z.string().uuid('Centro de custo invalido.').optional(),
  funcionarioId: z.string().uuid('Funcionario invalido.').optional(),
  solicitanteUsuarioId: z.string().uuid('Solicitante invalido.').optional(),
}).strict().refine((value) => value.periodoInicio <= value.periodoFim, {
  message: 'O periodo informado e invalido.',
});

export const faturamentoResumoSchema = faturamentoFiltroSchema.partial({ prestadorId: true }).strict();

export const faturamentoCreateSchema = faturamentoFiltroSchema.extend({
  corridaIds: z.array(z.string().uuid()).min(1, 'Selecione ao menos uma corrida.'),
  exclusoes: z.array(z.object({
    corridaId: z.string().uuid(),
    motivo: z.string().trim().min(5, 'Justifique a exclusao.').max(1000),
  }).strict()).default([]),
  observacao: z.string().trim().max(2000).nullable().optional(),
}).strict();

export const faturamentoListSchema = paginationSchema.extend({
  status: z.enum(['ABERTO', 'FECHADO', 'CANCELADO']).optional(),
  prestadorId: z.string().uuid().optional(),
  inicio: dateOnly.optional(),
  fim: dateOnly.optional(),
}).omit({ ativo: true }).strict();

export const faturamentoCancelSchema = z.object({
  motivo: z.string().trim().min(5, 'Informe o motivo do cancelamento.').max(1000),
}).strict();

export const corridaValorAjusteSchema = z.object({
  valorFinal: money,
  justificativa: z.string().trim().min(5, 'Informe a justificativa.').max(1000),
}).strict();

export type FaturamentoFiltro = z.infer<typeof faturamentoFiltroSchema>;
export type FaturamentoResumoFiltro = z.infer<typeof faturamentoResumoSchema>;
export type FaturamentoCreateInput = z.infer<typeof faturamentoCreateSchema>;
export type FaturamentoListQuery = z.infer<typeof faturamentoListSchema>;
export type FaturamentoCancelInput = z.infer<typeof faturamentoCancelSchema>;
export type CorridaValorAjusteInput = z.infer<typeof corridaValorAjusteSchema>;
