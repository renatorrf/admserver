import { z } from 'zod';

export const dispositivoPushSchema = z.object({
  token: z.string().trim().min(20, 'Token do dispositivo invalido.').max(4096),
  plataforma: z.enum(['WEB', 'ANDROID', 'IOS']),
  nomeDispositivo: z.string().trim().min(1).max(120).nullable().optional(),
}).strict();

export const dispositivoIdSchema = z.object({
  id: z.string().uuid('Dispositivo invalido.'),
}).strict();

export type DispositivoPushInput = z.infer<typeof dispositivoPushSchema>;
export type DispositivoIdParams = z.infer<typeof dispositivoIdSchema>;
