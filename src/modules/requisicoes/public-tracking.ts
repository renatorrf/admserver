import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { QueryExecutor } from '../../db/pool';
import { notFound } from '../../shared/errors/app-error';

export const trackingHash = (value: string) => createHash('sha256').update(value).digest('hex');

export async function issuePassengerTracking(db: QueryExecutor, company: string, request: string, employee: string, appUrl: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const row = await db.query(`INSERT INTO admtaxi.rastreios_passageiro(empresa_id,corrida_id,funcionario_id,token_hash,expira_em)
    SELECT r.empresa_id,r.corrida_id,$3,$4,
      LEAST(CURRENT_TIMESTAMP+INTERVAL '30 days',GREATEST(CURRENT_TIMESTAMP,c.agendada_para)+INTERVAL '24 hours')
    FROM admtaxi.requisicoes_viagem r JOIN admtaxi.corridas c ON c.empresa_id=r.empresa_id AND c.id=r.corrida_id
    JOIN admtaxi.corrida_participacoes p ON p.empresa_id=c.empresa_id AND p.corrida_id=c.id AND p.funcionario_id=$3
    WHERE r.empresa_id=$1 AND r.id=$2 AND c.status NOT IN ('CANCELADA','FINALIZADA')
      AND p.estado NOT IN ('AUSENTE','CANCELADO','DESEMBARCADO')`,[company,request,employee,trackingHash(token)]);
  if (!row.rowCount) throw notFound('Rastreamento');
  const url = new URL('/rastrear',appUrl);
  url.hash = 'token='+token;
  return url.toString();
}

export class PublicTrackingService {
  constructor(private readonly db: QueryExecutor) {}
  async get(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw notFound('Rastreamento indisponivel');
    const row = (await this.db.query<{
      status: string; estado: string; motorista: string | null; latitude: number; longitude: number; descricao: string;
      mostrar: boolean; motoristaLatitude: number | null; motoristaLongitude: number | null; registradoEm: Date | null;
    }>(`SELECT c.status,p.estado,prest.nome AS motorista,o.latitude::float8,o.longitude::float8,o.descricao,
       (c.status IN ('ACEITA','EM_DESLOCAMENTO','AGUARDANDO_PASSAGEIRO','EM_CORRIDA')
         AND p.estado='AGUARDANDO' AND EXISTS (
          SELECT 1 FROM admtaxi.corrida_paradas atual WHERE atual.empresa_id=c.empresa_id AND atual.corrida_id=c.id
            AND atual.id=p.embarque_id AND atual.estado<>'CONCLUIDA'
            AND NOT EXISTS(SELECT 1 FROM admtaxi.corrida_paradas anterior WHERE anterior.empresa_id=c.empresa_id
              AND anterior.corrida_id=c.id AND anterior.ordem<atual.ordem AND anterior.estado<>'CONCLUIDA')
         )) AS mostrar,
       loc.latitude::float8 AS "motoristaLatitude",loc.longitude::float8 AS "motoristaLongitude",loc.registrado_em AS "registradoEm"
      FROM admtaxi.rastreios_passageiro t
      JOIN admtaxi.corridas c ON c.empresa_id=t.empresa_id AND c.id=t.corrida_id
      JOIN admtaxi.empresas e ON e.id=c.empresa_id AND e.ativo
      JOIN admtaxi.corrida_participacoes p ON p.empresa_id=t.empresa_id AND p.corrida_id=t.corrida_id AND p.funcionario_id=t.funcionario_id
      JOIN admtaxi.funcionarios f ON f.empresa_id=p.empresa_id AND f.id=p.funcionario_id AND f.ativo
      JOIN admtaxi.corrida_paradas o ON o.empresa_id=p.empresa_id AND o.corrida_id=p.corrida_id AND o.id=p.embarque_id
      LEFT JOIN admtaxi.prestadores prest ON prest.empresa_id=c.empresa_id AND prest.id=c.prestador_id
      LEFT JOIN LATERAL(SELECT l.latitude,l.longitude,l.registrado_em FROM admtaxi.corrida_localizacoes l
        WHERE l.empresa_id=c.empresa_id AND l.corrida_id=c.id AND l.prestador_id=c.prestador_id
          AND l.registrado_em>CURRENT_TIMESTAMP-INTERVAL '2 minutes' AND l.precisao_metros<=200
        ORDER BY l.registrado_em DESC,l.id DESC LIMIT 1) loc ON TRUE
      WHERE t.token_hash=$1 AND t.revogado_em IS NULL AND t.expira_em>CURRENT_TIMESTAMP
        AND c.status NOT IN ('CANCELADA','FINALIZADA') AND p.estado NOT IN ('AUSENTE','CANCELADO','DESEMBARCADO')`,
    [trackingHash(token)])).rows[0];
    if (!row) throw notFound('Rastreamento indisponivel');
    const parts = row.motorista?.trim().split(/\s+/);
    const location = row.mostrar && row.motoristaLatitude!==null && row.motoristaLongitude!==null
      ? { latitude:row.motoristaLatitude,longitude:row.motoristaLongitude,registradoEm:row.registradoEm } : null;
    return {
      status: row.estado==='EMBARCADO' ? 'Em viagem' : !row.motorista ? 'Aguardando motorista'
        : row.mostrar ? 'Motorista a caminho do seu embarque' : 'Motorista atendendo outra etapa',
      motorista: parts?.length ? parts[0]+(parts.length>1 ? ' '+parts.at(-1)![0]+'.' : '') : null,
      embarque: { descricao:row.descricao,latitude:row.latitude,longitude:row.longitude },
      localizacao:location,
    };
  }
}

export function publicTrackingRouter(db: QueryExecutor): Router {
  const router = Router();
  const service = new PublicTrackingService(db);
  router.use(rateLimit({ windowMs:60_000,limit:40,standardHeaders:'draft-8',legacyHeaders:false }));
  router.get('/', async (req,res) => {
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Robots-Tag','noindex, nofollow');
    res.json({data:await service.get(req.get('x-tracking-token') ?? '')});
  });
  return router;
}
