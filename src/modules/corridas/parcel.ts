import { z } from 'zod';

const contact = z.object({
  nome: z.string().trim().min(2).max(150),
  telefone: z.string().trim().max(30).transform(value => value.replace(/\D/g, ''))
    .pipe(z.string().regex(/^(?:55)?\d{10,11}$/, 'Informe o telefone com DDD.')),
}).strict();

export const parcelSchema = z.object({
  tipo: z.enum(['ENVIO', 'RETIRADA']),
  descricao: z.string().trim().min(3, 'Descreva a encomenda.').max(500),
  empresaOrigem: z.string().trim().min(1).max(150).optional(),
  contatoOrigem: contact.optional(),
  contatoDestino: contact.optional(),
}).strict();
export type Parcel = z.infer<typeof parcelSchema>;

export const parcelOrigin = (parcel: Parcel): string => parcel.tipo === 'RETIRADA' ? 'Retirada' : 'Coleta';
