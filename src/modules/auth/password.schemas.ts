import { z } from 'zod';
import { passwordSchema, personalPasswordSchema } from '../../shared/validation/password';
import { loginSchema } from './auth.schemas';

export const forgotPasswordSchema = loginSchema.pick({ empresa: true, email: true }).partial({ empresa: true }).strict();
export const masterResetPasswordSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/, 'Link de recuperacao invalido.'),
  novaSenha: passwordSchema,
}).strict();
export const resetPasswordSchema = masterResetPasswordSchema.extend({ novaSenha: personalPasswordSchema });
export const changePasswordSchema = z.object({
  senhaAtual: z.string().min(1, 'Informe a senha atual.').max(200),
  novaSenha: personalPasswordSchema,
}).strict();
