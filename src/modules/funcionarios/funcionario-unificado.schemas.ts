import { passwordSchema } from '../../shared/validation/password';
import { z } from 'zod';

import { funcionarioCreateSchema, funcionarioUpdateSchema } from './funcionario.catalog';

const senha = passwordSchema;

export const funcionarioUnificadoCreateSchema = z.object({
  acesso: z.union([
    z.object({ senha, ativo: z.boolean().default(true) }).strict(),
    z.object({ contaId: z.string().uuid(), ativo: z.boolean().default(true) }).strict(),
  ]),
  funcionario: funcionarioCreateSchema,
}).strict().superRefine((value, context) => {
  if (!value.funcionario.email) {
    context.addIssue({ code: 'custom', path: ['funcionario', 'email'], message: 'Informe o e-mail de acesso do funcionario.' });
  }
});

export const funcionarioUnificadoUpdateSchema = z.object({
  acesso: z.object({ senha: senha.optional(), ativo: z.boolean().optional() }).strict().optional(),
  funcionario: funcionarioUpdateSchema.optional(),
}).strict().refine((value) => value.acesso !== undefined || value.funcionario !== undefined, {
  message: 'Informe ao menos um bloco para atualizar.',
});

export type FuncionarioUnificadoCreateInput = z.infer<typeof funcionarioUnificadoCreateSchema>;
export type FuncionarioUnificadoUpdateInput = z.infer<typeof funcionarioUnificadoUpdateSchema>;
