import { passwordSchema } from '../../shared/validation/password';
import { z } from 'zod';

const emailSchema = z.string().trim().email('Informe um email valido.').max(254).transform(value => value.toLowerCase());
export const masterRecoverySchema = z.object({ email: emailSchema }).strict();
export const masterEmailSchema = z.object({ email: emailSchema, senhaAtual: z.string().min(1).max(128) }).strict();

export const masterLoginSchema = z.object({
  usuario: z.string().trim().min(3).max(50).transform((value) => value.toLowerCase()),
  senha: z.string().min(1).max(128),
}).strict();

export const masterPasswordSchema = z.object({
  senhaAtual: z.string().min(1).max(128),
  novaSenha: passwordSchema,
}).strict().refine((value) => value.senhaAtual !== value.novaSenha, {
  message: 'A nova senha deve ser diferente da senha atual.', path: ['novaSenha'],
});

export const masterCreateSchema = z.object({
  usuario: z.string().trim().min(3).max(50)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]+$/, 'Usuario master invalido.')
    .transform((value) => value.toLowerCase()),
  nome: z.string().trim().min(2).max(150),
  email: emailSchema,
  senha: passwordSchema,
}).strict();

export const masterActiveSchema = z.object({ ativo: z.boolean() }).strict();
export const masterIdSchema = z.object({ id: z.string().uuid('Administrador invalido.') }).strict();

export type MasterLoginInput = z.infer<typeof masterLoginSchema>;
export type MasterPasswordInput = z.infer<typeof masterPasswordSchema>;
export type MasterCreateInput = z.infer<typeof masterCreateSchema>;
