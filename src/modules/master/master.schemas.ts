import { z } from 'zod';

export const masterLoginSchema = z.object({
  usuario: z.string().trim().min(3).max(50).transform((value) => value.toLowerCase()),
  senha: z.string().min(1).max(128),
}).strict();

export const masterPasswordSchema = z.object({
  senhaAtual: z.string().min(1).max(128),
  novaSenha: z.string().min(12, 'A nova senha deve ter ao menos 12 caracteres.').max(128),
}).strict().refine((value) => value.senhaAtual !== value.novaSenha, {
  message: 'A nova senha deve ser diferente da senha atual.', path: ['novaSenha'],
});

export const masterCreateSchema = z.object({
  usuario: z.string().trim().min(3).max(50)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]+$/, 'Usuario master invalido.')
    .transform((value) => value.toLowerCase()),
  nome: z.string().trim().min(2).max(150),
  senha: z.string().min(12, 'A senha deve ter ao menos 12 caracteres.').max(128),
}).strict();

export const masterActiveSchema = z.object({ ativo: z.boolean() }).strict();
export const masterIdSchema = z.object({ id: z.string().uuid('Administrador invalido.') }).strict();

export type MasterLoginInput = z.infer<typeof masterLoginSchema>;
export type MasterPasswordInput = z.infer<typeof masterPasswordSchema>;
export type MasterCreateInput = z.infer<typeof masterCreateSchema>;
