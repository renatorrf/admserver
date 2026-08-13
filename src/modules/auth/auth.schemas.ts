import { z } from 'zod';

export const loginSchema = z.object({
  empresa: z.string().trim().min(2, 'Informe o codigo da empresa.').max(50).transform((value) => value.toUpperCase()),
  email: z.string().trim().email('Informe um e-mail valido.').max(254).transform((value) => value.toLowerCase()),
  senha: z.string().min(1, 'Informe a senha.').max(200),
}).strict();

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Informe o refresh token.').max(4096, 'Refresh token invalido.'),
}).strict();

export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
