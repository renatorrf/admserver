import { z } from 'zod';

import { perfisUsuario } from '../auth/auth.types';
import { paginationSchema } from '../../shared/pagination/pagination';
import { optionalText } from '../../shared/validation/common.schemas';

const fields = {
  nome: z.string().trim().min(2).max(150),
  email: z.string().trim().email('Informe um e-mail valido.').max(254).transform((value) => value.toLowerCase()),
  telefone: optionalText(20),
  senha: z.string().min(12, 'A senha deve ter ao menos 12 caracteres.').max(128),
  perfil: z.enum(['PRESTADOR', 'GERENTE', 'GESTOR']),
};

export const usuarioCreateSchema = z.object(fields).strict();
export const usuarioUpdateSchema = z.object({
  nome: fields.nome.optional(),
  email: fields.email.optional(),
  telefone: fields.telefone,
  senha: fields.senha.optional(),
  perfil: fields.perfil.optional(),
}).strict().refine((value) => Object.values(value).some((item) => item !== undefined), {
  message: 'Informe ao menos um campo para atualizar.',
});
export const usuarioListSchema = paginationSchema.extend({
  perfil: z.enum(perfisUsuario).optional(),
}).strict();
export const gerenteCentrosSchema = z.object({
  centroCustoIds: z.array(z.string().uuid('Centro de custo invalido.')).max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'Nao repita centros de custo.'),
}).strict();
export const gerenteEscopoSchema = z.object({
  setorIds: z.array(z.string().uuid('Setor invalido.')).max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'Nao repita setores.'),
  centroCustoIds: z.array(z.string().uuid('Centro de custo invalido.')).max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'Nao repita centros de custo.'),
}).strict();

export type UsuarioCreateInput = z.infer<typeof usuarioCreateSchema>;
export type UsuarioUpdateInput = z.infer<typeof usuarioUpdateSchema>;
export type UsuarioListQuery = z.infer<typeof usuarioListSchema>;
export type GerenteCentrosInput = z.infer<typeof gerenteCentrosSchema>;
export type GerenteEscopoInput = z.infer<typeof gerenteEscopoSchema>;
