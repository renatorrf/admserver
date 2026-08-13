import type { QueryResultRow } from 'pg';

import type { QueryExecutor } from '../../db/pool';

export type CatalogInput = Record<string, unknown>;
export type CatalogRecord = Record<string, unknown> & {
  id: string;
  empresaId: string;
  ativo: boolean;
};

export type CatalogDefinition = {
  table: 'prestadores' | 'veiculos' | 'centros_custo' | 'funcionarios';
  entity: string;
  entityLabel: string;
  orderBy: string;
  searchColumns: string[];
  fields: Record<string, string>;
  filters?: Record<string, string>;
  deactivateFields?: Record<string, unknown>;
  mapRow: (row: QueryResultRow) => CatalogRecord;
  validateReferences?: (
    executor: QueryExecutor,
    empresaId: string,
    input: CatalogInput,
  ) => Promise<void>;
};
