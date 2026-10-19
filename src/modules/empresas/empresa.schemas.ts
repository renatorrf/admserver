import { z } from 'zod';
import { companyAddressFields, validateCompanyAddress } from './company-address.schema';

import { digits, optionalEmail, optionalText } from '../../shared/validation/common.schemas';

const nullableCnpj = z.union([
  digits(14, 'Informe um CNPJ com 14 digitos.'),
  z.literal('').transform(() => null),
  z.null(),
]).optional();

const nullableCoordinate = (minimum: number, maximum: number, message: string) => z.preprocess(
  value => value === '' ? null : value,
  z.coerce.number().min(minimum, message).max(maximum, message).nullable().optional(),
);

export const empresaUpdateSchema = z.object({
  ...companyAddressFields,
  codigoAcesso: z.string().trim().min(2).max(50)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]+$/, 'Codigo de acesso invalido.')
    .transform((value) => value.toUpperCase()).optional(),
  razaoSocial: z.string().trim().min(2).max(200).optional(),
  nomeFantasia: z.string().trim().min(2).max(150).optional(),
  cnpj: nullableCnpj,
  telefone: optionalText(20),
  email: optionalEmail,
  timezone: z.literal('America/Sao_Paulo').optional(),
  cidadePadrao: optionalText(120),
  estadoPadrao: z.union([
    z.string().trim().length(2, 'Informe a sigla do estado com 2 letras.').regex(/^[A-Za-z]{2}$/, 'Estado invalido.')
      .transform((value) => value.toUpperCase()),
    z.literal('').transform(() => null),
    z.null(),
  ]).optional(),
  latitudePadrao: nullableCoordinate(-90, 90, 'Latitude padrao invalida.'),
  longitudePadrao: nullableCoordinate(-180, 180, 'Longitude padrao invalida.'),
}).strict().refine((value) => Object.values(value).some((item) => item !== undefined), {
  message: 'Informe ao menos um campo para atualizar.',
}).superRefine((value, context) => {
  validateCompanyAddress(value, context);
  const latitudeProvided = value.latitudePadrao !== undefined;
  const longitudeProvided = value.longitudePadrao !== undefined;
  if (latitudeProvided !== longitudeProvided) {
    context.addIssue({ code: 'custom', path: ['latitudePadrao'], message: 'Informe latitude e longitude padrao juntas.' });
  }
});

export type EmpresaUpdateInput = z.infer<typeof empresaUpdateSchema>;
