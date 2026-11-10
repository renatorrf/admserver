import { z } from 'zod';

export const INITIAL_ACCOUNT_PASSWORD = '123456';

export const passwordSchema = z.string()
  .min(6, 'A senha deve ter ao menos 6 caracteres.')
  .max(128, 'A senha deve ter no maximo 128 caracteres.');

export const personalPasswordSchema = passwordSchema.refine(
  (value) => value.trim() !== INITIAL_ACCOUNT_PASSWORD,
  'Escolha uma senha diferente da senha inicial.',
);
