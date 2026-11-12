import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../../config/env';
import type { QueryExecutor } from '../../db/pool';

export const whatsappWebhookPath = '/api/v1/webhooks/whatsapp';

const status = z.object({
  id: z.string().min(1).max(512),
  status: z.enum(['sent','delivered','read','failed']),
  biz_opaque_callback_data: z.string().uuid().optional().catch(undefined),
});
const envelope = z.object({ object: z.literal('whatsapp_business_account'), entry: z.array(z.object({
  changes: z.array(z.object({ field: z.string(), value: z.object({
    metadata: z.object({ phone_number_id: z.string() }).optional(),
    statuses: z.array(z.unknown()).optional(),
  }) })),
})) });
const states = { sent: 'ENVIADO', delivered: 'ENTREGUE', read: 'LIDO', failed: 'FALHOU' } as const;

function equal(first: string, second: string): boolean {
  const a = Buffer.from(first), b = Buffer.from(second);
  return a.length === b.length && timingSafeEqual(a,b);
}

export function whatsappWebhook(config: NonNullable<AppConfig['whatsappWebhook']>, db: QueryExecutor): Router {
  const router = Router();
  router.get('/', (req,res) => {
    const token = req.query['hub.verify_token'], challenge = req.query['hub.challenge'];
    if (!config.verifyToken || typeof token !== 'string' || !equal(token,config.verifyToken)
      || req.query['hub.mode'] !== 'subscribe' || typeof challenge !== 'string' || !/^\d{1,64}$/.test(challenge)) {
      res.sendStatus(403); return;
    }
    res.type('text/plain').send(challenge);
  });
  router.post('/', express.raw({ type:'application/json', limit:'256kb', inflate:false }), async (req,res) => {
    const signature = req.get('x-hub-signature-256');
    if (!config.appSecret || !signature || !Buffer.isBuffer(req.body)
      || !equal(signature,'sha256='+createHmac('sha256',config.appSecret).update(req.body).digest('hex'))) {
      res.sendStatus(403); return;
    }
    let decoded: unknown;
    try { decoded = JSON.parse(req.body.toString('utf8')); } catch { res.sendStatus(400); return; }
    const events = envelope.safeParse(decoded);
    if (events.success && config.phoneNumberId) for (const entry of events.data.entry) for (const change of entry.changes) {
      if (change.field !== 'messages' || change.value.metadata?.phone_number_id !== config.phoneNumberId) continue;
      for (const item of change.value.statuses ?? []) {
        const result = status.safeParse(item);
        if (!result.success) continue;
        const message = result.data;
        await db.query(`UPDATE admtaxi.whatsapp_viagem SET status=$3,mensagem_id=$1,atualizado_em=CURRENT_TIMESTAMP
          WHERE (mensagem_id=$1 OR (id=$2 AND mensagem_id IS NULL))
            AND (status IN ('ENVIANDO','INCERTO','ACEITO')
              OR (status='ENVIADO' AND $3 IN ('ENTREGUE','LIDO','FALHOU'))
              OR (status='FALHOU' AND $3 IN ('ENTREGUE','LIDO'))
              OR (status='ENTREGUE' AND $3='LIDO'))`,
        [message.id,message.biz_opaque_callback_data ?? null,states[message.status]]);
      }
    }
    res.sendStatus(200);
  });
  return router;
}
