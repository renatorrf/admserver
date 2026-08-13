import { z } from 'zod';

const latitude = z.coerce.number().min(-90, 'Latitude invalida.').max(90, 'Latitude invalida.');
const longitude = z.coerce.number().min(-180, 'Longitude invalida.').max(180, 'Longitude invalida.');

export const enderecoAutocompleteSchema = z.object({
  texto: z.string().trim().min(3, 'Digite ao menos 3 caracteres.').max(160),
  latitude: latitude.optional(),
  longitude: longitude.optional(),
}).strict().superRefine((value, context) => {
  if ((value.latitude === undefined) !== (value.longitude === undefined)) {
    context.addIssue({ code: 'custom', path: ['latitude'], message: 'Informe latitude e longitude juntas.' });
  }
});

export const enderecoReverseSchema = z.object({ latitude, longitude }).strict();

export type EnderecoAutocompleteQuery = z.infer<typeof enderecoAutocompleteSchema>;
export type EnderecoReverseQuery = z.infer<typeof enderecoReverseSchema>;
