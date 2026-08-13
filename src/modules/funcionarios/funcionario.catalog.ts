import { z } from 'zod';

import { invalidReference } from '../../shared/errors/app-error';
import { paginationSchema } from '../../shared/pagination/pagination';
import { digits, optionalEmail, optionalText } from '../../shared/validation/common.schemas';
import type { CatalogDefinition } from '../cadastros/catalog.types';

const optionalCpf = z.union([
  digits(11, 'Informe um CPF com 11 digitos.'),
  z.literal('').transform(() => null),
  z.null(),
]).optional();
const optionalCoordinate = z.preprocess(
  (value) => value === '' ? null : value,
  z.coerce.number().nullable().optional(),
);
const fields = {
  centroCustoId: z.string().uuid('Centro de custo invalido.'),
  nome: z.string().trim().min(2).max(150),
  matricula: z.string().trim().min(1).max(50).transform((value) => value.toUpperCase()),
  cpf: optionalCpf,
  telefone: optionalText(20),
  email: optionalEmail,
  enderecoPadrao: optionalText(2000),
  latitudePadrao: optionalCoordinate.refine((value) => value === null || value === undefined || (value >= -90 && value <= 90), 'Latitude invalida.'),
  longitudePadrao: optionalCoordinate.refine((value) => value === null || value === undefined || (value >= -180 && value <= 180), 'Longitude invalida.'),
};

const coordinatesTogether = (value: { latitudePadrao?: number | null; longitudePadrao?: number | null }): boolean => {
  const latitudeEmpty = value.latitudePadrao === undefined || value.latitudePadrao === null;
  const longitudeEmpty = value.longitudePadrao === undefined || value.longitudePadrao === null;
  return latitudeEmpty === longitudeEmpty;
};

export const funcionarioCreateSchema = z.object(fields).strict().refine(coordinatesTogether, {
  message: 'Informe latitude e longitude juntas.',
});
export const funcionarioUpdateSchema = z.object({
  centroCustoId: fields.centroCustoId.optional(),
  nome: fields.nome.optional(),
  matricula: fields.matricula.optional(),
  cpf: fields.cpf,
  telefone: fields.telefone,
  email: fields.email,
  enderecoPadrao: fields.enderecoPadrao,
  latitudePadrao: fields.latitudePadrao,
  longitudePadrao: fields.longitudePadrao,
}).strict().refine((value) => Object.values(value).some((item) => item !== undefined), {
  message: 'Informe ao menos um campo para atualizar.',
}).refine(coordinatesTogether, {
  message: 'Ao limpar coordenadas, informe latitude e longitude como nulas.',
});
export const funcionarioListSchema = paginationSchema.extend({
  centroCustoId: z.string().uuid('Centro de custo invalido.').optional(),
}).strict();

export const funcionarioDefinition: CatalogDefinition = {
  table: 'funcionarios',
  entity: 'funcionario',
  entityLabel: 'Funcionario',
  orderBy: 'nome ASC, id ASC',
  searchColumns: ['nome', 'matricula', 'cpf', 'email'],
  fields: {
    centroCustoId: 'centro_custo_id',
    nome: 'nome',
    matricula: 'matricula',
    cpf: 'cpf',
    telefone: 'telefone',
    email: 'email',
    enderecoPadrao: 'endereco_padrao',
    latitudePadrao: 'latitude_padrao',
    longitudePadrao: 'longitude_padrao',
  },
  filters: { centroCustoId: 'centro_custo_id' },
  mapRow: (row) => ({
    id: row.id as string,
    empresaId: row.empresa_id as string,
    centroCustoId: row.centro_custo_id as string,
    nome: row.nome as string,
    matricula: row.matricula as string,
    cpf: row.cpf as string | null,
    telefone: row.telefone as string | null,
    email: row.email as string | null,
    enderecoPadrao: row.endereco_padrao as string | null,
    latitudePadrao: row.latitude_padrao === null ? null : Number(row.latitude_padrao),
    longitudePadrao: row.longitude_padrao === null ? null : Number(row.longitude_padrao),
    ativo: row.ativo as boolean,
    criadoEm: row.criado_em as Date,
    atualizadoEm: row.atualizado_em as Date,
  }),
  validateReferences: async (executor, empresaId, input) => {
    if (input.centroCustoId === undefined) return;
    const result = await executor.query(
      'SELECT 1 FROM admtaxi.centros_custo WHERE empresa_id = $1 AND id = $2 AND ativo = TRUE',
      [empresaId, input.centroCustoId],
    );
    if (result.rowCount !== 1) throw invalidReference('Selecione um centro de custo ativo da mesma empresa.');
  },
};
