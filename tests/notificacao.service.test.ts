import { describe, expect, it, vi } from 'vitest';

vi.mock('web-push', () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() },
}));

import webpush from 'web-push';

import type { PushConfig } from '../src/config/env';
import type { Database } from '../src/db/pool';
import type { AuthContext } from '../src/modules/auth/auth.types';
import type { CorridaRecord } from '../src/modules/corridas/corrida.types';
import { NotificacaoService } from '../src/modules/notificacoes/notificacao.service';

const auth: AuthContext = {
  empresaId: '11111111-1111-4111-8111-111111111111',
  usuarioId: '22222222-2222-4222-8222-222222222222', perfil: 'PRESTADOR',
};
const subscriptionId = '33333333-3333-4333-8333-333333333333';
const now = new Date('2026-08-14T12:00:00Z');
const config: PushConfig = {
  subject: 'mailto:push@example.com', publicKey: 'public-key', privateKey: 'private-key',
  appUrl: 'https://app.example.com', notificationIconUrl: '/assets/icon/icon-192.webp',
  notificationBadgeUrl: '/assets/icon/badge-96.webp', defaultOpenUrl: '/app',
  rideOpenUrl: '/app/corridas',
};

function subscriptionRow() {
  return {
    id: subscriptionId, empresa_id: auth.empresaId, usuario_id: auth.usuarioId,
    endpoint: 'https://push.example.com/send/opaque-token', p256dh: 'p'.repeat(32), auth: 'a'.repeat(16),
    expiration_time: null, user_agent: 'Chrome test agent', dispositivo_descricao: 'Chrome no Windows',
    ativo: true, ultimo_sucesso_em: null, ultima_falha_em: null, codigo_ultima_falha: null,
    criado_em: now, atualizado_em: now,
  };
}

function ride(): CorridaRecord {
  return {
    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', empresaId: auth.empresaId,
    solicitanteUsuarioId: auth.usuarioId, funcionarioId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    centroCustoId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', prestadorId: null, veiculoId: null,
    status: 'SOLICITADA', tipo: 'IMEDIATA',
  };
}

describe('NotificacaoService', () => {
  it('registra a inscricao nativa usando empresa e usuario da sessao sem expor chaves', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [subscriptionRow()], rowCount: 1 });
    const service = new NotificacaoService({ query } as unknown as Database, config);

    const device = await service.register(auth, {
      endpoint: subscriptionRow().endpoint, expirationTime: null,
      keys: { p256dh: subscriptionRow().p256dh, auth: subscriptionRow().auth },
      dispositivoDescricao: 'Chrome no Windows',
    }, 'Chrome test agent');

    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO admtaxi.push_subscriptions'), [
      auth.empresaId, auth.usuarioId, subscriptionRow().endpoint, subscriptionRow().p256dh,
      subscriptionRow().auth, null, 'Chrome test agent', 'Chrome no Windows',
    ]);
    expect(device).toMatchObject({ id: subscriptionId, endpointHost: 'push.example.com', ativo: true });
    expect(device).not.toHaveProperty('endpoint');
    expect(device).not.toHaveProperty('p256dh');
    expect(device).not.toHaveProperty('auth');
  });

  it('nao revoga inscricao fora do tenant e usuario autenticados', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const service = new NotificacaoService({ query } as unknown as Database);

    await expect(service.revoke(auth, subscriptionId)).rejects.toMatchObject({ statusCode: 404 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('empresa_id=$1 AND usuario_id=$2'), [
      auth.empresaId, auth.usuarioId, subscriptionId,
    ]);
  });

  it('lista somente inscricoes do tenant e usuario autenticados', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [subscriptionRow()] });
    const service = new NotificacaoService({ query } as unknown as Database);

    const devices = await service.listDevices(auth);

    expect(devices).toHaveLength(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('empresa_id=$1 AND usuario_id=$2'), [
      auth.empresaId, auth.usuarioId,
    ]);
  });

  it('oferta corrida somente a prestadores ativos, disponiveis e da regiao da empresa', async () => {
    const users = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('SELECT DISTINCT p.usuario_id')) return Promise.resolve({ rows: users.map((usuario_id) => ({ usuario_id })) });
      if (sql.includes('FROM admtaxi.funcionarios f')) return Promise.resolve({ rows: [] });
      if (sql.includes('INSERT INTO admtaxi.notificacoes_push')) return Promise.resolve({ rows: [{ id: crypto.randomUUID() }] });
      if (sql.includes('FROM admtaxi.push_subscriptions')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const service = new NotificacaoService({ query } as unknown as Database);

    service.publishRideCreated(ride());

    await vi.waitFor(() => expect(query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO admtaxi.notificacoes_push'))).toHaveLength(2));
    const recipientQuery = query.mock.calls.find(([sql]) => String(sql).includes('SELECT DISTINCT p.usuario_id'));
    expect(recipientQuery?.[0]).toContain('p.ativo=TRUE AND p.disponivel=TRUE');
    expect(recipientQuery?.[0]).toContain('COALESCE(p.cidade_operacao,e.cidade_padrao)=e.cidade_padrao');
    expect(recipientQuery?.[1]).toEqual([auth.empresaId]);
  });

  it('deduplica o mesmo evento antes de consultar as inscricoes', async () => {
    let insertCount = 0;
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('SELECT DISTINCT p.usuario_id')) return Promise.resolve({ rows: [{ usuario_id: auth.usuarioId }] });
      if (sql.includes('FROM admtaxi.funcionarios f')) return Promise.resolve({ rows: [] });
      if (sql.includes('INSERT INTO admtaxi.notificacoes_push')) {
        insertCount += 1;
        return Promise.resolve({ rows: insertCount === 1 ? [{ id: crypto.randomUUID() }] : [] });
      }
      if (sql.includes('FROM admtaxi.push_subscriptions')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const service = new NotificacaoService({ query } as unknown as Database);

    service.publishRideCreated(ride());
    service.publishRideCreated(ride());

    await vi.waitFor(() => expect(insertCount).toBe(2));
    expect(query.mock.calls.filter(([sql]) => String(sql).includes('FROM admtaxi.push_subscriptions'))).toHaveLength(1);
  });

  it('inativa inscricao expirada quando o servico push responde 410', async () => {
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO admtaxi.notificacoes_push')) return Promise.resolve({ rows: [{ id: 'notification-id' }] });
      if (sql.includes('FROM admtaxi.push_subscriptions')) return Promise.resolve({ rows: [subscriptionRow()] });
      if (sql.includes('INSERT INTO admtaxi.push_tentativas')) return Promise.resolve({ rows: [{ id: 'attempt-id' }] });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    vi.mocked(webpush.sendNotification).mockRejectedValueOnce({ statusCode: 410 });
    const service = new NotificacaoService({ query } as unknown as Database, config);

    await service.sendTest(auth);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('ativo=CASE WHEN $2 THEN FALSE'), [
      subscriptionId, true, 'HTTP_410',
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("status=$2"), [
      'attempt-id', 'EXPIRADA', 410, 'HTTP_410',
    ]);
  });
});
