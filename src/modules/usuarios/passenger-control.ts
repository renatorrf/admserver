import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../db/pool';
import { asyncHandler } from '../../shared/http/async-handler';
import { authorize, requireAuthContext } from '../auth/auth.middleware';

const querySchema=z.object({ busca:z.string().trim().max(150).optional(),
  situacao:z.enum(['ATIVO','INATIVO','SEM_VIAGEM']).optional(),
  pagina:z.coerce.number().int().min(1).default(1) }).strict();
export async function passengerControl(database: Database, empresaId: string, input: unknown) {
  const query=querySchema.parse(input);
  // Global usage is aggregate only. Names, contacts and travel dates remain tenant-scoped.
  const result=await database.query(`WITH base AS (
    SELECT f.id,f.nome,f.telefone,f.avulso,c.nome AS "centroCusto",f.ativo AS "cadastroAtivo",
      local.ultima_viagem AS "ultimaViagem",
      COALESCE(uso.reservado,FALSE) AS reservado,
      CASE WHEN uso.ativo_plano THEN 'ATIVO' WHEN uso.ultima_viagem IS NOT NULL THEN 'INATIVO' ELSE 'SEM_VIAGEM' END AS situacao
    FROM admtaxi.funcionarios f JOIN admtaxi.centros_custo c ON c.empresa_id=f.empresa_id AND c.id=f.centro_custo_id
    LEFT JOIN admtaxi.uso_plano_passageiros uso ON uso.identidade_transporte=f.identidade_transporte
    LEFT JOIN LATERAL (SELECT MAX(r.finalizada_em) AS ultima_viagem FROM admtaxi.corridas r
      LEFT JOIN admtaxi.corrida_participacoes p ON p.empresa_id=r.empresa_id AND p.corrida_id=r.id AND p.funcionario_id=f.id
      WHERE r.empresa_id=f.empresa_id AND r.status='FINALIZADA' AND
        (p.estado='DESEMBARCADO' OR (r.funcionario_id=f.id AND r.desembarque_em IS NOT NULL AND NOT EXISTS
          (SELECT 1 FROM admtaxi.corrida_participacoes other WHERE other.empresa_id=r.empresa_id AND other.corrida_id=r.id)))) local ON TRUE
    WHERE f.empresa_id=$1
  ), filtrados AS (SELECT * FROM base WHERE ($2::text IS NULL OR nome ILIKE $2 OR telefone ILIKE $2)
      AND ($3::text IS NULL OR situacao=$3)),
  pagina AS (SELECT * FROM filtrados ORDER BY nome,id LIMIT 20 OFFSET $4),
  global AS (SELECT COUNT(*) FILTER(WHERE ativo_plano)::int AS ativos,
    COUNT(*) FILTER(WHERE reservado AND NOT ativo_plano)::int AS reservas
    FROM admtaxi.uso_plano_passageiros)
  SELECT COALESCE((SELECT json_agg(pagina) FROM pagina),'[]'::json) AS data,
    (SELECT COUNT(*)::int FROM filtrados) AS total,
    json_build_object('limite',200,'janelaDias',62,'ativos',ativos,'reservas',reservas,
      'disponiveis',GREATEST(0,200-ativos-reservas)) AS plano FROM global`,
  [empresaId,query.busca ? `%${query.busca}%`:null,query.situacao??null,(query.pagina-1)*20]);
  return { ...result.rows[0],pagina:query.pagina };
}
export function passengerControlRouter(database: Database) {
  const router=Router();
  router.get('/',authorize('GESTOR'),asyncHandler(async(req,res)=>{
    res.json(await passengerControl(database,requireAuthContext(req).empresaId,req.query));
  }));
  return router;
}
