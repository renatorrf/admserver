import { z } from 'zod';

export const companyAddressFields = {
  endereco: z.string().trim().min(3).max(500).nullable().optional(),
  enderecoLatitude: z.number().min(-90).max(90).nullable().optional(),
  enderecoLongitude: z.number().min(-180).max(180).nullable().optional(),
};

type AddressFields = { endereco?: string | null; enderecoLatitude?: number | null; enderecoLongitude?: number | null };
export function validateCompanyAddress(value: AddressFields, context: z.RefinementCtx): void {
  const fields = [value.endereco, value.enderecoLatitude, value.enderecoLongitude];
  if (fields.every(field => field === undefined) || fields.every(field => field === null)) return;
  if (fields.some(field => field == null)) context.addIssue({ code: 'custom', path: ['endereco'],
    message: 'Selecione o endereco completo da empresa com latitude e longitude, ou limpe os tres campos.' });
}
