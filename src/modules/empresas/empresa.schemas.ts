import { z } from 'zod';

import { digits, optionalEmail, optionalText } from '../../shared/validation/common.schemas';

const nullableCnpj = z.union([
  digits(14, 'Informe um CNPJ com 14 digitos.'),
  z.literal('').transform(() => null),
  z.null(),
]).optional();

export const empresaUpdateSchema = z.object({
  codigoAcesso: z.string().trim().min(2).max(50)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]+$/, 'Codigo de acesso invalido.')
    .transform((value) => value.toUpperCase()).optional(),
  razaoSocial: z.string().trim().min(2).max(200).optional(),
  nomeFantasia: z.string().trim().min(2).max(150).optional(),
  cnpj: nullableCnpj,
  telefone: optionalText(20),
  email: optionalEmail,
  timezone: z.literal('America/Sao_Paulo').optional(),
}).strict().refine((value) => Object.values(value).some((item) => item !== undefined), {
  message: 'Informe ao menos um campo para atualizar.',
});

export type EmpresaUpdateInput = z.infer<typeof empresaUpdateSchema>;
