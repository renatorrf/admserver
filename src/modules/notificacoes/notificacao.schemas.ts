import { z } from 'zod';

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().startsWith('https://').max(4096),
  expirationTime: z.number().int().nonnegative().nullable(),
  keys: z.object({
    p256dh: z.string().min(20).max(512),
    auth: z.string().min(8).max(256),
  }).strict(),
  dispositivoDescricao: z.string().trim().min(1).max(160).nullable().optional(),
}).strict();

export const subscriptionIdSchema = z.object({
  id: z.string().uuid('Inscricao invalida.'),
}).strict();

export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;
export type SubscriptionIdParams = z.infer<typeof subscriptionIdSchema>;
