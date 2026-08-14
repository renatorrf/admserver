import { z } from 'zod';

export const uuidParamsSchema = z.object({
  id: z.string().uuid('Identificador invalido.'),
}).strict();

export type UuidParams = z.infer<typeof uuidParamsSchema>;

export const optionalEmail = z.union([
  z.string().trim().email('Informe um e-mail valido.').max(254).transform((value) => value.toLowerCase()),
  z.literal('').transform(() => null),
  z.null(),
]).optional();

export const optionalText = (max: number) => z.union([
  z.string().trim().max(max).transform((value) => value || null),
  z.null(),
]).optional();

export const digits = (length: number, message: string) => z.string()
  .transform((value) => value.replace(/\D/g, ''))
  .pipe(z.string().length(length, message));

function isValidCpf(value: string): boolean {
  if (/^(\d)\1{10}$/.test(value)) return false;
  const digit = (length: number): number => {
    const sum = value.slice(0, length).split('').reduce((total, item, index) => total + Number(item) * (length + 1 - index), 0);
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };
  return digit(9) === Number(value[9]) && digit(10) === Number(value[10]);
}

export const cpf = z.string()
  .transform((value) => value.replace(/\D/g, ''))
  .pipe(z.string().length(11, 'Informe um CPF valido.'))
  .refine(isValidCpf, 'Informe um CPF valido.');

export function atLeastOneField<T extends z.ZodRawShape>(shape: T): z.ZodObject<T> {
  return z.object(shape).strict().refine(
    (value) => Object.values(value).some((item) => item !== undefined),
    { message: 'Informe ao menos um campo para atualizar.' },
  ) as z.ZodObject<T>;
}
