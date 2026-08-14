import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db/pool';
import type { AuthContext } from '../src/modules/auth/auth.types';
import { NotificacaoService } from '../src/modules/notificacoes/notificacao.service';
import type { CorridaRecord } from '../src/modules/corridas/corrida.types';

const auth: AuthContext = {
  empresaId: '11111111-1111-4111-8111-111111111111',
  usuarioId: '22222222-2222-4222-8222-222222222222', perfil: 'PRESTADOR',
};

describe('NotificacaoService', () => {
  it('registers a device using company and user from the session', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      id: '33333333-3333-4333-8333-333333333333', plataforma: 'WEB', nome_dispositivo: 'Chrome', ativo: true, atualizado_em: new Date(),
    }] });
    const service = new NotificacaoService({ query } as unknown as Database);

    await service.register(auth, { token: 'token-with-more-than-twenty-characters', plataforma: 'WEB', nomeDispositivo: 'Chrome' });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO admtaxi.dispositivos_push'), [
      auth.empresaId, auth.usuarioId, 'token-with-more-than-twenty-characters', 'WEB', 'Chrome',
    ]);
  });

  it('cannot revoke a device outside the authenticated tenant and user', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const service = new NotificacaoService({ query } as unknown as Database);

    await expect(service.revoke(auth, '33333333-3333-4333-8333-333333333333'))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('empresa_id = $1 AND usuario_id = $2'), [
      auth.empresaId, auth.usuarioId, '33333333-3333-4333-8333-333333333333',
    ]);
  });

  it('lists only devices owned by the authenticated tenant and user', async () => {
    const now = new Date();
    const query = vi.fn().mockResolvedValue({ rows: [{
      id: '33333333-3333-4333-8333-333333333333', plataforma: 'WEB', nome_dispositivo: 'Chrome',
      ativo: true, ultimo_uso_em: now, criado_em: now, atualizado_em: now,
    }] });
    const service = new NotificacaoService({ query } as unknown as Database);

    const devices = await service.listDevices(auth);

    expect(devices).toHaveLength(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('empresa_id = $1 AND usuario_id = $2'), [
      auth.empresaId, auth.usuarioId,
    ]);
  });

  it('offers a new ride only to active and available providers in the tenant', async () => {
    const users = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('SELECT DISTINCT p.usuario_id')) return Promise.resolve({ rows: users.map((usuario_id) => ({ usuario_id })) });
      if (sql.includes('INSERT INTO admtaxi.notificacoes_push')) return Promise.resolve({ rows: [{ id: crypto.randomUUID() }] });
      if (sql.includes('SELECT id, token')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const service = new NotificacaoService({ query } as unknown as Database);
    const ride = {
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', empresaId: auth.empresaId,
      solicitanteUsuarioId: auth.usuarioId, funcionarioId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      centroCustoId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', prestadorId: null, veiculoId: null,
      status: 'SOLICITADA', tipo: 'IMEDIATA',
    } satisfies CorridaRecord;

    service.publishRideCreated(ride);

    await vi.waitFor(() => expect(query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO admtaxi.notificacoes_push'))).toHaveLength(2));
    expect(query).toHaveBeenCalledWith(expect.stringContaining('p.ativo = TRUE AND p.disponivel = TRUE'), [auth.empresaId]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM admtaxi.funcionarios f'), [
      auth.empresaId, ride.funcionarioId,
    ]);
  });

  it('restricts test notifications to managers outside development', async () => {
    const service = new NotificacaoService({ query: vi.fn() } as unknown as Database);
    await expect(service.sendTest(auth)).rejects.toMatchObject({ statusCode: 403 });
  });
});
