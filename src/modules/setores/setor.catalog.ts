import { z } from 'zod';

import { paginationSchema } from '../../shared/pagination/pagination';
import { optionalText } from '../../shared/validation/common.schemas';
import type { CatalogDefinition } from '../cadastros/catalog.types';

const fields = {
  codigo: z.string().trim().min(1).max(50).transform((value) => value.toUpperCase()),
  nome: z.string().trim().min(2).max(150),
  descricao: optionalText(2000),
};

export const setorCreateSchema = z.object(fields).strict();
export const setorUpdateSchema = z.object({
  codigo: fields.codigo.optional(),
  nome: fields.nome.optional(),
  descricao: fields.descricao,
}).strict().refine((value) => Object.values(value).some((item) => item !== undefined), {
  message: 'Informe ao menos um campo para atualizar.',
});
export const setorListSchema = paginationSchema;

export const setorDefinition: CatalogDefinition = {
  table: 'setores',
  entity: 'setor',
  entityLabel: 'Setor',
  orderBy: 'codigo ASC, id ASC',
  searchColumns: ['codigo', 'nome', 'descricao'],
  fields: { codigo: 'codigo', nome: 'nome', descricao: 'descricao' },
  mapRow: (row) => ({
    id: row.id as string,
    empresaId: row.empresa_id as string,
    codigo: row.codigo as string,
    nome: row.nome as string,
    descricao: row.descricao as string | null,
    ativo: row.ativo as boolean,
    criadoEm: row.criado_em as Date,
    atualizadoEm: row.atualizado_em as Date,
  }),
};

