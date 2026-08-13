import { z } from 'zod';

import { invalidReference } from '../../shared/errors/app-error';
import { paginationSchema } from '../../shared/pagination/pagination';
import { cpf, optionalEmail } from '../../shared/validation/common.schemas';
import type { CatalogDefinition } from '../cadastros/catalog.types';

const fields = {
  nome: z.string().trim().min(2).max(150),
  cpf,
  telefone: z.string().trim().min(8).max(20),
  email: optionalEmail,
  usuarioId: z.string().uuid('Usuario invalido.').nullable().optional(),
  numeroCnh: z.string().trim().min(3).max(20).transform((value) => value.toUpperCase()),
  validadeCnh: z.iso.date('Informe uma data de validade valida.').refine((value) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return new Date(`${value}T00:00:00`).getTime() >= today.getTime();
  }, 'A validade da CNH nao pode ser anterior a data atual.'),
  disponivel: z.boolean().optional(),
};

export const prestadorCreateSchema = z.object(fields).strict();
export const prestadorUpdateSchema = z.object({
  nome: fields.nome.optional(),
  cpf: fields.cpf.optional(),
  telefone: fields.telefone.optional(),
  email: fields.email,
  usuarioId: fields.usuarioId,
  numeroCnh: fields.numeroCnh.optional(),
  validadeCnh: fields.validadeCnh.optional(),
  disponivel: fields.disponivel,
}).strict().refine((value) => Object.values(value).some((item) => item !== undefined), {
  message: 'Informe ao menos um campo para atualizar.',
});
export const prestadorListSchema = paginationSchema.extend({
  disponivel: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
}).strict();

export const prestadorDefinition: CatalogDefinition = {
  table: 'prestadores',
  entity: 'prestador',
  entityLabel: 'Prestador',
  orderBy: 'nome ASC, id ASC',
  searchColumns: ['nome', 'cpf', 'numero_cnh', 'email'],
  fields: {
    nome: 'nome',
    cpf: 'cpf',
    telefone: 'telefone',
    email: 'email',
    usuarioId: 'usuario_id',
    numeroCnh: 'numero_cnh',
    validadeCnh: 'validade_cnh',
    disponivel: 'disponivel',
  },
  filters: { disponivel: 'disponivel' },
  deactivateFields: { disponivel: false },
  mapRow: (row) => ({
    id: row.id as string,
    empresaId: row.empresa_id as string,
    usuarioId: row.usuario_id as string | null,
    nome: row.nome as string,
    cpf: row.cpf as string,
    telefone: row.telefone as string,
    email: row.email as string | null,
    numeroCnh: row.numero_cnh as string,
    validadeCnh: row.validade_cnh as string,
    disponivel: row.disponivel as boolean,
    ativo: row.ativo as boolean,
    criadoEm: row.criado_em as Date,
    atualizadoEm: row.atualizado_em as Date,
  }),
  validateReferences: async (executor, empresaId, input) => {
    if (input.usuarioId === undefined || input.usuarioId === null) return;
    const result = await executor.query(
      `SELECT 1 FROM admtaxi.usuarios
        WHERE empresa_id = $1 AND id = $2 AND perfil = 'PRESTADOR' AND ativo = TRUE`,
      [empresaId, input.usuarioId],
    );
    if (result.rowCount !== 1) {
      throw invalidReference('Selecione um usuario prestador ativo da mesma empresa.');
    }
  },
};
