import type { QueryExecutor } from '../../db/pool';
import { notFound } from '../../shared/errors/app-error';
import type { AuthContext } from './auth.types';

export type DriverMembership = { usuario_id: string; empresa_id: string; prestador_id: string; empresa_nome: string; disponivel: boolean };

export async function driverMemberships(db: QueryExecutor, auth: AuthContext): Promise<DriverMembership[]> {
  if (!auth.contaMotoristaId || auth.perfil !== 'PRESTADOR') return [];
  return (await db.query<DriverMembership>(
    'SELECT * FROM admtaxi.motorista_vinculos_ativos WHERE conta_id=$1 AND empresa_id=$2 AND usuario_id=$3 ORDER BY empresa_nome,empresa_id',
    [auth.contaMotoristaId, auth.empresaId, auth.usuarioId])).rows;
}

// A shared identity never expands the selected membership's ride access.
export async function driverRideContext(db: QueryExecutor, auth: AuthContext, rideId: string): Promise<AuthContext> {
  if (!auth.contaMotoristaId || auth.perfil !== 'PRESTADOR') return auth;
  const member = (await db.query<DriverMembership>(
    `SELECT m.* FROM admtaxi.motorista_vinculos_ativos m JOIN admtaxi.corridas c ON c.empresa_id=m.empresa_id
     WHERE m.conta_id=$1 AND c.id=$2 AND m.empresa_id=$3 AND m.usuario_id=$4 AND (c.prestador_id=m.prestador_id
       OR (c.prestador_id IS NULL AND c.status='SOLICITADA' AND m.disponivel))`, [auth.contaMotoristaId, rideId, auth.empresaId, auth.usuarioId])).rows[0];
  if (!member) throw notFound('Corrida');
  return { ...auth, usuarioId: member.usuario_id, empresaId: member.empresa_id };
}
