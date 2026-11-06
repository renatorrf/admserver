import { z } from 'zod';

export const validadeCnhSchema = z.iso.date('Informe uma data de validade valida.').refine((value) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(`${value}T00:00:00`).getTime() >= today.getTime();
}, 'A validade da CNH nao pode ser anterior a data atual.').nullable().optional();

export function cnhDate(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  // pg parses SQL DATE as local midnight; UTC conversion can change the calendar day.
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  return value.slice(0, 10);
}
