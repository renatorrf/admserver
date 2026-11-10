import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { Database, QueryExecutor } from '../src/db/pool';
import { perfisUsuario } from '../src/modules/auth/auth.types';
import { FcmService } from '../src/modules/notificacoes/fcm.service';
import { TravelEmails } from '../src/modules/requisicoes/travel-emails';

const device = { token: 'test-token', instalacaoId: 'installation', vinculoId: 'binding' };
const result = (rows: unknown[] = []) => ({ rows, rowCount: rows.length });
function database(query: ReturnType<typeof vi.fn>): Database {
  return { query: query as QueryExecutor['query'],
    connect: async () => ({ query, release: vi.fn() }) as unknown as PoolClient };
}

describe('FCM do fluxo de viagens', () => {
  it.each(perfisUsuario)('registra o APK de %s no usuario e unidade da sessao', async perfil => {
    const query = vi.fn().mockResolvedValue(result());
    const fcm = new FcmService(database(query), { warn: vi.fn() }, { send: vi.fn() });
    await expect(fcm.register({ empresaId: 'unit', usuarioId: 'user', perfil, senhaVersao: 4 }, device))
      .resolves.toEqual({ ativo: true });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO admtaxi.dispositivos_push'),
      ['unit', 'user', device.token, device.instalacaoId, device.vinculoId, 4]);
  });

  it('envia uma requisicao sem corrida pelo FCM com prazo e destino restritos', async () => {
    const expire = new Date(Date.now() + 10_000);
    let selected = false;
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT j.*') && !selected) {
        selected = true;
        return result([{ id: 'job', notificacao_id: 'notification', dispositivo_id: 'device', vinculo_id: 'binding',
          empresa_id: 'unit', usuario_id: 'user', corrida_id: null, tentativas: 0, expira_em: expire,
          titulo: 'Viagem autorizada', corpo: 'A viagem foi aprovada.', url_abertura: '/app/requisicoes' }]);
      }
      return result(sql.startsWith('SELECT token') ? [{ token: device.token }] : []);
    });
    const send = vi.fn().mockResolvedValue('message-id');
    const fcm = new FcmService(database(query), { warn: vi.fn() }, { send });
    await expect(fcm.process()).resolves.toBe(1);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ target: 'requisicoes', corridaId: '', vinculoId: 'binding', expiresAt: String(expire.getTime()) }),
      android: { priority: 'high', ttl: expect.any(Number), restrictedPackageName: 'com.admbrasil.taxi' },
    }));
    expect(send.mock.calls[0]![0].android.ttl).toBeLessThanOrEqual(10_000);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("status='ENVIADA'"), ['job']);
  });

  it('inicia Web Push e FCM no fluxo da viagem mesmo sem SMTP', async () => {
    const processTravelPush = vi.fn().mockResolvedValue(undefined);
    let complete!: (count: number) => void;
    const processAndroidPush = vi.fn(() => new Promise<number>(resolve => { complete = resolve; }));
    const emails = new TravelEmails(database(vi.fn()), { warn: vi.fn(), error: vi.fn() }, undefined, undefined,
      { processTravelPush, processAndroidPush });
    const ready = emails.kick();
    expect(processTravelPush).toHaveBeenCalledOnce();
    expect(processAndroidPush).toHaveBeenCalledOnce();
    complete(1);
    await ready;
  });
});
