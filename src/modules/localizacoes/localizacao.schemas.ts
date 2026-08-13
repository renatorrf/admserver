import { z } from 'zod';

export const localizacaoCreateSchema = z.object({
  latitude: z.number().finite().min(-90, 'Latitude invalida.').max(90, 'Latitude invalida.'),
  longitude: z.number().finite().min(-180, 'Longitude invalida.').max(180, 'Longitude invalida.'),
  precisaoMetros: z.number().finite().min(0).max(10_000).nullable().optional(),
  velocidade: z.number().finite().min(0).max(150).nullable().optional(),
  direcao: z.number().finite().min(0).max(360).nullable().optional(),
}).strict();

export const localizacaoListSchema = z.object({
  pagina: z.coerce.number().int().min(1).default(1),
  limite: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export const acompanharCorridaSchema = z.object({
  corridaId: z.string().uuid('Identificador invalido.'),
}).strict();

export const enviarLocalizacaoSocketSchema = acompanharCorridaSchema.extend(localizacaoCreateSchema.shape).strict();

export type LocalizacaoCreateInput = z.infer<typeof localizacaoCreateSchema>;
export type LocalizacaoListQuery = z.infer<typeof localizacaoListSchema>;
export type AcompanharCorridaInput = z.infer<typeof acompanharCorridaSchema>;
export type EnviarLocalizacaoSocketInput = z.infer<typeof enviarLocalizacaoSocketSchema>;
