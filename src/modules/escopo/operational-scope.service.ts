import type { QueryResultRow } from 'pg';

import { queryOne, type Database, type QueryExecutor } from '../../db/pool';
import { forbidden } from '../../shared/errors/app-error';
import type { AuthContext } from '../auth/auth.types';

type ManagerScopeRow = QueryResultRow & {
  setor_ids: string[];
  centro_custo_ids: string[];
};

export type OperationalScope =
  | { kind: 'GESTOR'; empresaId: string }
  | {
    kind: 'GERENTE';
    empresaId: string;
    usuarioId: string;
    setorIds: string[];
    centroCustoIds: string[];
  };

export interface OperationalScopeResolver {
  resolve(auth: AuthContext, executor?: QueryExecutor): Promise<OperationalScope>;
}

export class OperationalScopeService implements OperationalScopeResolver {
  constructor(private readonly database: Database) {}

  async resolve(auth: AuthContext, executor: QueryExecutor = this.database): Promise<OperationalScope> {
    if (auth.perfil === 'GESTOR') return { kind: 'GESTOR', empresaId: auth.empresaId };
    if (auth.perfil !== 'GERENTE') throw forbidden();

    const row = await queryOne<ManagerScopeRow>(
      executor,
      `SELECT
         ARRAY(
           SELECT gs.setor_id
             FROM admtaxi.gerente_setores gs
             JOIN admtaxi.setores s
               ON s.empresa_id = gs.empresa_id AND s.id = gs.setor_id
            WHERE gs.empresa_id = u.empresa_id
              AND gs.gerente_usuario_id = u.id
              AND s.ativo = TRUE
            ORDER BY gs.setor_id
         ) AS setor_ids,
         ARRAY(
           SELECT gcc.centro_custo_id
             FROM admtaxi.gerente_centros_custo gcc
             JOIN admtaxi.centros_custo cc
               ON cc.empresa_id = gcc.empresa_id AND cc.id = gcc.centro_custo_id
             JOIN admtaxi.setores s
               ON s.empresa_id = cc.empresa_id AND s.id = cc.setor_id AND s.ativo = TRUE
             JOIN admtaxi.gerente_setores gs
               ON gs.empresa_id = gcc.empresa_id
              AND gs.gerente_usuario_id = gcc.gerente_usuario_id
              AND gs.setor_id = cc.setor_id
            WHERE gcc.empresa_id = u.empresa_id
              AND gcc.gerente_usuario_id = u.id
              AND cc.ativo = TRUE
            ORDER BY gcc.centro_custo_id
         ) AS centro_custo_ids
       FROM admtaxi.usuarios u
      WHERE u.empresa_id = $1 AND u.id = $2 AND u.perfil = 'GERENTE' AND u.ativo = TRUE`,
      [auth.empresaId, auth.usuarioId],
    );
    if (!row) throw forbidden();
    return {
      kind: 'GERENTE', empresaId: auth.empresaId, usuarioId: auth.usuarioId,
      setorIds: row.setor_ids, centroCustoIds: row.centro_custo_ids,
    };
  }
}

export function addCenterScope(
  conditions: string[],
  values: unknown[],
  scope: OperationalScope,
  centerExpression: string,
): void {
  if (scope.kind !== 'GERENTE') return;
  values.push(scope.centroCustoIds);
  conditions.push(`${centerExpression} = ANY($${values.length}::uuid[])`);
}

export function centerAllowed(scope: OperationalScope, centerId: string): boolean {
  return scope.kind === 'GESTOR' || scope.centroCustoIds.includes(centerId);
}

