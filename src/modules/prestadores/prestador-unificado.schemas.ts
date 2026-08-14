import { z } from 'zod';

import { paginationSchema } from '../../shared/pagination/pagination';
import { cpf, optionalEmail, optionalText } from '../../shared/validation/common.schemas';

const accessFields = {
  nome: z.string().trim().min(2).max(150),
  email: z.string().trim().email('Informe um e-mail valido.').max(254).transform((value) => value.toLowerCase()),
  telefone: optionalText(20),
  ativo: z.boolean().default(true),
  formaAtivacao: z.literal('SENHA_TEMPORARIA'),
  senha: z.string().min(12, 'A senha deve ter ao menos 12 caracteres.').max(128),
};

const providerFields = {
  reutilizarDadosAcesso: z.boolean().default(true),
  nome: z.string().trim().min(2).max(150).optional(),
  cpf,
  telefone: z.string().trim().min(8).max(20).optional(),
  email: optionalEmail,
  numeroCnh: z.string().trim().min(3).max(20).transform((value) => value.toUpperCase()),
  validadeCnh: z.iso.date('Informe uma data de validade valida.').refine((value) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return new Date(`${value}T00:00:00`).getTime() >= today.getTime();
  }, 'A validade da CNH nao pode ser anterior a data atual.'),
  disponivel: z.boolean().default(true),
  ativo: z.boolean().default(true),
};

const vehicleFields = {
  placa: z.string().trim().transform((value) => value.toUpperCase().replace(/[^A-Z0-9]/g, ''))
    .pipe(z.string().regex(/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/, 'Informe uma placa valida.')),
  marca: z.string().trim().min(2).max(80),
  modelo: z.string().trim().min(1).max(100),
  cor: z.string().trim().min(2).max(50),
  ano: z.coerce.number().int().min(1900).max(new Date().getFullYear() + 1),
  capacidadePassageiros: z.coerce.number().int().min(1).max(99),
  ativo: z.boolean().default(true),
};

const newVehicle = z.object({ modo: z.literal('NOVO'), dados: z.object(vehicleFields).strict() }).strict();
const existingVehicle = z.object({ modo: z.literal('EXISTENTE'), veiculoId: z.string().uuid('Veiculo invalido.') }).strict();
const laterVehicle = z.object({ modo: z.literal('DEPOIS') }).strict();

export const prestadorUnificadoCreateSchema = z.object({
  acesso: z.object(accessFields).strict(),
  prestador: z.object(providerFields).strict(),
  veiculo: z.discriminatedUnion('modo', [newVehicle, existingVehicle, laterVehicle]),
}).strict().superRefine((value, context) => {
  if (value.prestador.reutilizarDadosAcesso) {
    if (!value.acesso.telefone) context.addIssue({ code: 'custom', path: ['acesso', 'telefone'], message: 'Informe o telefone de acesso.' });
    return;
  }
  if (!value.prestador.nome) context.addIssue({ code: 'custom', path: ['prestador', 'nome'], message: 'Informe o nome do prestador.' });
  if (!value.prestador.telefone) context.addIssue({ code: 'custom', path: ['prestador', 'telefone'], message: 'Informe o telefone do prestador.' });
});

const accessUpdate = z.object({
  nome: accessFields.nome.optional(),
  email: accessFields.email.optional(),
  telefone: accessFields.telefone,
  ativo: z.boolean().optional(),
  senha: accessFields.senha.optional(),
}).strict();

const providerUpdate = z.object({
  nome: z.string().trim().min(2).max(150).optional(),
  cpf: cpf.optional(),
  telefone: z.string().trim().min(8).max(20).optional(),
  email: optionalEmail,
  numeroCnh: providerFields.numeroCnh.optional(),
  validadeCnh: providerFields.validadeCnh.optional(),
  disponivel: z.boolean().optional(),
  ativo: z.boolean().optional(),
}).strict();

const editVehicle = z.discriminatedUnion('acao', [
  z.object({ acao: z.literal('MANTER') }).strict(),
  z.object({ acao: z.literal('NOVO'), dados: z.object(vehicleFields).strict() }).strict(),
  z.object({ acao: z.literal('EXISTENTE'), veiculoId: z.string().uuid('Veiculo invalido.') }).strict(),
  z.object({ acao: z.literal('DESVINCULAR') }).strict(),
]);

export const prestadorUnificadoUpdateSchema = z.object({
  acesso: accessUpdate.optional(),
  prestador: providerUpdate.optional(),
  veiculo: editVehicle.optional(),
}).strict().refine((value) => value.acesso !== undefined || value.prestador !== undefined || value.veiculo !== undefined, {
  message: 'Informe ao menos um bloco para atualizar.',
});

export const veiculoVinculoListSchema = paginationSchema.extend({
  busca: z.string().trim().max(120).optional(),
  prestadorId: z.string().uuid('Prestador invalido.').optional(),
}).strict();

export type PrestadorUnificadoCreateInput = z.infer<typeof prestadorUnificadoCreateSchema>;
export type PrestadorUnificadoUpdateInput = z.infer<typeof prestadorUnificadoUpdateSchema>;
export type VeiculoVinculoListQuery = z.infer<typeof veiculoVinculoListSchema>;
