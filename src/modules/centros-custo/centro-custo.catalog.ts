import { z } from 'zod';

import { paginationSchema } from '../../shared/pagination/pagination';
import { optionalText } from '../../shared/validation/common.schemas';
import { invalidReference } from '../../shared/errors/app-error';
import type { CatalogDefinition } from '../cadastros/catalog.types';

const fields = {
  setorId: z.string().uuid('Setor invalido.'),
  codigo: z.string().trim().min(1).max(50).transform((value) => value.toUpperCase()),
  nome: z.string().trim().min(2).max(150),
  descricao: optionalText(2000),
};

export const centroCustoCreateSchema = z.object(fields).strict();
export const centroCustoUpdateSchema = z.object({
  setorId: fields.setorId.optional(),
  codigo: fields.codigo.optional(),
  nome: fields.nome.optional(),
  descricao: fields.descricao,
}).strict().refine((value) => Object.values(value).some((item) => item !== undefined), {
  message: 'Informe ao menos um campo para atualizar.',
});
export const centroCustoListSchema = paginationSchema.extend({ setorId: fields.setorId.optional() });

export const centroCustoDefinition: CatalogDefinition = {
  table: 'centros_custo',
  entity: 'centro_custo',
  entityLabel: 'Centro de custo',
  orderBy: 'codigo ASC, id ASC',
  searchColumns: ['codigo', 'nome', 'descricao'],
  fields: { setorId: 'setor_id', codigo: 'codigo', nome: 'nome', descricao: 'descricao' },
  filters: { setorId: 'setor_id' },
  mapRow: (row) => ({
    id: row.id as string,
    empresaId: row.empresa_id as string,
    setorId: row.setor_id as string | null,
    codigo: row.codigo as string,
    nome: row.nome as string,
    descricao: row.descricao as string | null,
    ativo: row.ativo as boolean,
    criadoEm: row.criado_em as Date,
    atualizadoEm: row.atualizado_em as Date,
  }),
  validateReferences: async (executor, empresaId, input) => {
    if (input['setorId'] === undefined) return;
    const result = await executor.query(
      'SELECT 1 FROM admtaxi.setores WHERE empresa_id = $1 AND id = $2 AND ativo = TRUE',
      [empresaId, input['setorId']],
    );
    if (result.rowCount !== 1) throw invalidReference('Setor inexistente, inativo ou pertencente a outra empresa.');
  },
};
