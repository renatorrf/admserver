import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db/pool';
import type { AuthContext } from '../src/modules/auth/auth.types';
import { EnderecoService } from '../src/modules/enderecos/endereco.service';

const auth: AuthContext = {
  empresaId: '11111111-1111-4111-8111-111111111111',
  usuarioId: '22222222-2222-4222-8222-222222222222', perfil: 'GESTOR',
};

describe('EnderecoService', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the authenticated company region when geolocation is absent', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      latitude_padrao: '-18.918600', longitude_padrao: '-48.277200', cidade_padrao: 'Uberlandia', estado_padrao: 'MG',
    }] });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [{
      place_id: 'p1', formatted: 'Avenida A, Uberlandia', street: 'Avenida A', city: 'Uberlandia', state_code: 'MG', lat: -18.9, lon: -48.2,
    }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new EnderecoService({ query } as unknown as Database, 'test-key-with-more-than-20-characters');

    const result = await service.autocomplete(auth, { texto: 'Avenida A' });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM admtaxi.empresas'), [auth.empresaId]);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get('text')).toBe('Avenida A, Uberlandia, MG');
    expect(url.searchParams.get('bias')).toBe('proximity:-48.2772,-18.9186');
    expect(result[0]).toMatchObject({ cidade: 'Uberlandia', latitude: -18.9 });
  });

  it('prioritizes current coordinates without querying company reference', async () => {
    const query = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new EnderecoService({ query } as unknown as Database, 'test-key-with-more-than-20-characters');

    await service.autocomplete(auth, { texto: 'Rua B', latitude: -20, longitude: -47 });

    expect(query).not.toHaveBeenCalled();
    expect(decodeURIComponent(String(fetchMock.mock.calls[0]?.[0]))).toContain('bias=proximity:-47,-20');
  });
});
