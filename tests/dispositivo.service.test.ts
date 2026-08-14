import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../src/db/pool';
import type { AuthContext } from '../src/modules/auth/auth.types';
import { dispositivoAtualSchema } from '../src/modules/dispositivos/dispositivo.schemas';
import { DispositivoService } from '../src/modules/dispositivos/dispositivo.service';

const auth: AuthContext = {
  empresaId: '11111111-1111-4111-8111-111111111111',
  usuarioId: '22222222-2222-4222-8222-222222222222',
  perfil: 'GESTOR',
};
const deviceId = '33333333-3333-4333-8333-333333333333';
const input = dispositivoAtualSchema.parse({
  chaveDispositivo: deviceId,
  plataforma: 'ANDROID',
  nomeDispositivo: 'Dispositivo Android',
  navegador: 'Chrome 151',
  modoAcesso: 'PWA',
  notificacoesStatus: 'ATIVA',
  geolocalizacaoStatus: 'ATIVA',
});

function row() {
  const now = new Date();
  return {
    id: '44444444-4444-4444-8444-444444444444', empresa_id: auth.empresaId,
    usuario_id: auth.usuarioId, chave_dispositivo: deviceId, plataforma: 'ANDROID',
    nome_dispositivo: 'Dispositivo Android', navegador: 'Chrome 151', modo_acesso: 'PWA',
    notificacoes_status: 'ATIVA', geolocalizacao_status: 'ATIVA', ativo: true,
    ultimo_uso_em: now, criado_em: now, atualizado_em: now,
  };
}

describe('DispositivoService', () => {
  it('synchronizes the current device inside the authenticated tenant and user', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row()], rowCount: 1 });
    const service = new DispositivoService({ query } as unknown as Database);

    const device = await service.syncCurrent(auth, input);

    expect(device).toMatchObject({ usuarioId: auth.usuarioId, chaveDispositivo: deviceId, modoAcesso: 'PWA' });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT (empresa_id, usuario_id, chave_dispositivo)'), [
      auth.empresaId, auth.usuarioId, deviceId, 'ANDROID', 'Dispositivo Android', 'Chrome 151',
      'PWA', 'ATIVA', 'ATIVA',
    ]);
  });

  it('marks only the current user device inactive on logout', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const service = new DispositivoService({ query } as unknown as Database);

    await service.deactivateCurrent(auth, deviceId);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('empresa_id = $1 AND usuario_id = $2'), [
      auth.empresaId, auth.usuarioId, deviceId,
    ]);
  });

  it('lists tenant devices with user and permission status for management', async () => {
    const managedRow = {
      ...row(), usuario_nome: 'Gestor', usuario_email: 'gestor@empresa.test', usuario_perfil: 'GESTOR',
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ total: '1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [managedRow], rowCount: 1 });
    const service = new DispositivoService({ query } as unknown as Database);

    const result = await service.listManaged(auth, { pagina: 1, limite: 20 });

    expect(result.meta.total).toBe(1);
    expect(result.data[0]).toMatchObject({
      empresaId: auth.empresaId,
      usuario: { nome: 'Gestor', email: 'gestor@empresa.test', perfil: 'GESTOR' },
      notificacoesStatus: 'ATIVA', geolocalizacaoStatus: 'ATIVA',
    });
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('d.empresa_id = $1'), [auth.empresaId]);
  });
});
