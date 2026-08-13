import { z } from 'zod';

import { invalidReference } from '../../shared/errors/app-error';
import { paginationSchema } from '../../shared/pagination/pagination';
import type { CatalogDefinition } from '../cadastros/catalog.types';

const plate = z.string().trim()
  .transform((value) => value.toUpperCase().replace(/[^A-Z0-9]/g, ''))
  .pipe(z.string().regex(/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/, 'Informe uma placa valida.'));
const fields = {
  prestadorId: z.string().uuid('Prestador invalido.').nullable().optional(),
  placa: plate,
  marca: z.string().trim().min(2).max(80),
  modelo: z.string().trim().min(1).max(100),
  cor: z.string().trim().min(2).max(50),
  ano: z.coerce.number().int().min(1900).max(new Date().getFullYear() + 1),
  capacidadePassageiros: z.coerce.number().int().min(1).max(99),
};

export const veiculoCreateSchema = z.object(fields).strict();
export const veiculoUpdateSchema = z.object({
  prestadorId: fields.prestadorId,
  placa: fields.placa.optional(),
  marca: fields.marca.optional(),
  modelo: fields.modelo.optional(),
  cor: fields.cor.optional(),
  ano: fields.ano.optional(),
  capacidadePassageiros: fields.capacidadePassageiros.optional(),
}).strict().refine((value) => Object.values(value).some((item) => item !== undefined), {
  message: 'Informe ao menos um campo para atualizar.',
});
export const veiculoListSchema = paginationSchema.extend({
  prestadorId: z.string().uuid('Prestador invalido.').optional(),
}).strict();

export const veiculoDefinition: CatalogDefinition = {
  table: 'veiculos',
  entity: 'veiculo',
  entityLabel: 'Veiculo',
  orderBy: 'placa ASC, id ASC',
  searchColumns: ['placa', 'marca', 'modelo', 'cor'],
  fields: {
    prestadorId: 'prestador_id',
    placa: 'placa',
    marca: 'marca',
    modelo: 'modelo',
    cor: 'cor',
    ano: 'ano',
    capacidadePassageiros: 'capacidade_passageiros',
  },
  filters: { prestadorId: 'prestador_id' },
  mapRow: (row) => ({
    id: row.id as string,
    empresaId: row.empresa_id as string,
    prestadorId: row.prestador_id as string | null,
    placa: row.placa as string,
    marca: row.marca as string,
    modelo: row.modelo as string,
    cor: row.cor as string,
    ano: row.ano as number,
    capacidadePassageiros: row.capacidade_passageiros as number,
    ativo: row.ativo as boolean,
    criadoEm: row.criado_em as Date,
    atualizadoEm: row.atualizado_em as Date,
  }),
  validateReferences: async (executor, empresaId, input) => {
    if (input.prestadorId === undefined || input.prestadorId === null) return;
    const result = await executor.query(
      'SELECT 1 FROM admtaxi.prestadores WHERE empresa_id = $1 AND id = $2 AND ativo = TRUE',
      [empresaId, input.prestadorId],
    );
    if (result.rowCount !== 1) throw invalidReference('Selecione um prestador ativo da mesma empresa.');
  },
};
