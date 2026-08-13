import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db/pool';
import type { AuthContext } from '../src/modules/auth/auth.types';
import { NotificacaoService } from '../src/modules/notificacoes/notificacao.service';

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
});
