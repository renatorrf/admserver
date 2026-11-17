import { createHash } from 'node:crypto';
import type { QueryExecutor } from '../../db/pool';
import type { AuthContext } from '../auth/auth.types';
import { invalidReference } from '../../shared/errors/app-error';
import { whatsappPhone } from './requisition-access';

export async function enqueueAccountWhatsApp(db: QueryExecutor, auth: AuthContext, userId: string, authorized?: boolean): Promise<void> {
  if (!authorized) return;
  const user = (await db.query<{telefone: string | null; ativo: boolean; deve_alterar_senha: boolean}>(
    'SELECT telefone,ativo,deve_alterar_senha FROM admtaxi.usuarios WHERE empresa_id=$1 AND id=$2',[auth.empresaId,userId])).rows[0];
  const phone = whatsappPhone(user?.telefone ?? null);
  if (!phone) throw invalidReference('Informe o telefone com DDD para enviar o aviso pelo WhatsApp.');
  if (!user?.ativo || !user.deve_alterar_senha) return;
  await db.query('UPDATE admtaxi.usuarios SET whatsapp_autorizado_em=CURRENT_TIMESTAMP WHERE empresa_id=$1 AND id=$2',[auth.empresaId,userId]);
  await db.query(`INSERT INTO admtaxi.whatsapp_cadastros(empresa_id,usuario_id,autorizado_por,telefone_hash)
    VALUES($1,$2,$3,$4) ON CONFLICT(empresa_id,usuario_id) DO NOTHING`,
  [auth.empresaId,userId,auth.usuarioId,createHash('sha256').update(phone).digest('hex')]);
}
