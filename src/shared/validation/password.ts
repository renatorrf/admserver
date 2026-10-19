import { z } from 'zod';

export const passwordSchema = z.string()
  .min(6, 'A senha deve ter ao menos 6 caracteres.')
  .max(128, 'A senha deve ter no maximo 128 caracteres.');
