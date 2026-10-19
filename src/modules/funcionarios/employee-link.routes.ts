import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authorize, requireAuthContext } from '../auth/auth.middleware';
import { asyncHandler } from '../../shared/http/async-handler';
import { getValidatedQuery, validateQuery } from '../../shared/validation/validate';

export function createEmployeeLinkRouter(pool: Pool): Router {
  const router = Router();
  router.use(authorize('GESTOR'), rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }));
  router.get('/', validateQuery(z.object({ email: z.string().trim().email().max(254).toLowerCase() }).strict()), asyncHandler(async (req, res) => {
    const auth = requireAuthContext(req);
    const { email } = getValidatedQuery<{ email: string }>(req);
    const result = await pool.query<{ id: string; nome: string; email: string; vinculado: boolean }>(
      `SELECT c.id,c.nome,c.email::text,EXISTS(SELECT 1 FROM admtaxi.usuarios u WHERE u.conta_funcionario_id=c.id AND u.empresa_id=$2) AS vinculado
       FROM admtaxi.contas_funcionario c WHERE c.email=$1
       AND EXISTS(SELECT 1 FROM admtaxi.usuarios u JOIN admtaxi.empresas e ON e.id=u.empresa_id
         JOIN admtaxi.funcionarios f ON f.usuario_id=u.id AND f.empresa_id=u.empresa_id
         WHERE u.conta_funcionario_id=c.id AND u.perfil='FUNCIONARIO' AND u.ativo AND e.ativo AND f.ativo)
       ORDER BY c.id LIMIT 20`, [email, auth.empresaId]);
    res.json({ data: result.rows });
  }));
  return router;
}
