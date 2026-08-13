import { z } from 'zod';

import { digits, optionalEmail, optionalText } from '../../shared/validation/common.schemas';

export const provisionamentoSchema = z.object({
  empresa: z.object({
    codigoAcesso: z.string().trim().min(2).max(50)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]+$/, 'Codigo de acesso invalido.')
      .transform((value) => value.toUpperCase()),
    razaoSocial: z.string().trim().min(2).max(200),
    nomeFantasia: z.string().trim().min(2).max(150),
    cnpj: z.union([digits(14, 'Informe um CNPJ com 14 digitos.'), z.literal('').transform(() => null), z.null()]).optional(),
    telefone: optionalText(20),
    email: optionalEmail,
    cidadePadrao: z.string().trim().min(2, 'Informe a cidade padrao.').max(120),
    estadoPadrao: z.string().trim().length(2, 'Informe a sigla do estado com 2 letras.')
      .regex(/^[A-Za-z]{2}$/, 'Estado invalido.').transform((value) => value.toUpperCase()),
    latitudePadrao: z.coerce.number().min(-90, 'Latitude padrao invalida.').max(90, 'Latitude padrao invalida.'),
    longitudePadrao: z.coerce.number().min(-180, 'Longitude padrao invalida.').max(180, 'Longitude padrao invalida.'),
  }).strict(),
  gestor: z.object({
    nome: z.string().trim().min(2).max(150),
    email: z.string().trim().email('Informe um e-mail valido.').max(254)
      .transform((value) => value.toLowerCase()),
    telefone: optionalText(20),
    senha: z.string().min(12, 'A senha deve ter ao menos 12 caracteres.').max(128),
  }).strict(),
}).strict();

export type ProvisionamentoInput = z.infer<typeof provisionamentoSchema>;
