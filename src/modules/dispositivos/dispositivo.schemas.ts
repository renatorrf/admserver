import { z } from 'zod';

import { paginationSchema } from '../../shared/pagination/pagination';

export const notificacoesStatus = ['ATIVA', 'INATIVA', 'BLOQUEADA', 'NAO_SOLICITADA', 'NAO_SUPORTADA'] as const;
export const geolocalizacaoStatus = ['ATIVA', 'BLOQUEADA', 'NAO_SOLICITADA', 'NAO_SUPORTADA'] as const;

export const dispositivoAtualSchema = z.object({
  chaveDispositivo: z.string().uuid('Identificador do dispositivo invalido.'),
  plataforma: z.enum(['WEB', 'ANDROID', 'IOS']),
  nomeDispositivo: z.string().trim().min(1).max(120),
  navegador: z.string().trim().min(1).max(80).nullable().optional(),
  modoAcesso: z.enum(['NAVEGADOR', 'PWA']),
  notificacoesStatus: z.enum(notificacoesStatus),
  geolocalizacaoStatus: z.enum(geolocalizacaoStatus),
}).strict();

export const dispositivoGestaoListSchema = paginationSchema.pick({ pagina: true, limite: true, busca: true, ativo: true });

export const dispositivoAtualParamsSchema = z.object({
  chaveDispositivo: z.string().uuid('Identificador do dispositivo invalido.'),
}).strict();

export type DispositivoAtualInput = z.infer<typeof dispositivoAtualSchema>;
export type DispositivoGestaoListQuery = z.infer<typeof dispositivoGestaoListSchema>;
export type DispositivoAtualParams = z.infer<typeof dispositivoAtualParamsSchema>;
export type NotificacoesStatus = (typeof notificacoesStatus)[number];
export type GeolocalizacaoStatus = (typeof geolocalizacaoStatus)[number];
