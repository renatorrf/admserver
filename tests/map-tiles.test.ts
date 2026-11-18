import express from 'express';
import helmet from 'helmet';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createMapTileRouter } from '../src/modules/enderecos/map-tiles';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const tileResponse = (cacheControl?: string, age?: string) => new Response(png, { headers: {
  'Content-Type': 'image/png', ...(cacheControl ? { 'Cache-Control': cacheControl } : {}), ...(age ? { Age: age } : {}),
} });

function appWith(fetcher: typeof fetch, key: string | undefined = 'test-secret') {
  return express().use(helmet()).use('/api/v1/public/mapa', createMapTileRouter(key, fetcher));
}

describe('Mapa Geoapify', () => {
  it('entrega PNG sem expor a chave e permite uso pelo site e WebView', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(tileResponse());
    const response = await request(appWith(fetcher)).get('/api/v1/public/mapa/12/1500/2200.png');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(png);
    expect(response.headers['content-type']).toContain('image/png');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(fetcher).toHaveBeenCalledWith('https://maps.geoapify.com/v1/tile/osm-carto/12/1500/2200.png?apiKey=test-secret', expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }));
    expect(JSON.stringify(response.headers)).not.toContain('test-secret');
  });

  it.each(['21/0/0', '0/1/0', '0/0/1', '3/-1/2', '3/2/8', '1/no/0', '1/99999999/0'])('rejeita coordenadas invalidas %s antes de acessar o provedor', async coords => {
    const fetcher = vi.fn<typeof fetch>();
    expect((await request(appWith(fetcher)).get(`/api/v1/public/mapa/${coords}.png`)).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('retorna indisponibilidade sem configuracao', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const app = express().use(createMapTileRouter(undefined, fetcher));
    expect((await request(app).get('/0/0/0.png')).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([403, 429, 500])('nao repassa imagem de bloqueio ou erro %s', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(png, { status, headers: { 'Content-Type': 'image/png' } }));
    const response = await request(appWith(fetcher)).get('/api/v1/public/mapa/0/0/0.png');
    expect(response.status).toBe(503);
    expect(response.body.erro.codigo).toBe('MAPA_INDISPONIVEL');
  });

  it('trata timeout e permite nova tentativa sem gravar resposta de erro', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('request test-secret failed')).mockResolvedValueOnce(tileResponse());
    const app = appWith(fetcher);
    const response = await request(app).get('/api/v1/public/mapa/0/0/0.png');
    expect(response.status).toBe(503);
    expect(response.text).not.toContain('test-secret');
    expect((await request(app).get('/api/v1/public/mapa/0/0/0.png')).status).toBe(200);
  });

  it.each([
    new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
    new Response('<html>blocked</html>', { headers: { 'Content-Type': 'image/png' } }),
  ])('nao retorna conteudo invalido como imagem', async providerResponse => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(providerResponse);
    expect((await request(appWith(fetcher)).get('/api/v1/public/mapa/0/0/0.png')).status).toBe(503);
  });

  it('compartilha downloads simultaneos mas nao mantem cache persistente', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(tileResponse());
    const app = appWith(fetcher);
    const first = request(app).get('/api/v1/public/mapa/0/0/0.png').then(response => response.status);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const second = request(app).get('/api/v1/public/mapa/0/0/0.png').then(response => response.status);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(fetcher).toHaveBeenCalledTimes(1);
    finish(tileResponse());
    expect(await first).toBe(200);
    expect(await second).toBe(200);
    expect((await request(app).get('/api/v1/public/mapa/0/0/0.png')).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('espaca downloads distintos para reduzir rajadas no provedor', async () => {
    const started: number[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { started.push(Date.now()); return tileResponse(); });
    const app = appWith(fetcher);
    await Promise.all([
      request(app).get('/api/v1/public/mapa/1/0/0.png'),
      request(app).get('/api/v1/public/mapa/1/1/0.png'),
    ]);
    expect(started).toHaveLength(2);
    expect(started[1]! - started[0]!).toBeGreaterThanOrEqual(90);
  });

  it('reutiliza imagem publica e permite cache no navegador sem expor credenciais', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(tileResponse('public, max-age=86400'));
    const app = appWith(fetcher);
    const first = await request(app).get('/api/v1/public/mapa/0/0/0.png');
    const second = await request(app).get('/api/v1/public/mapa/0/0/0.png');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first.headers['x-map-cache']).toBe('MISS');
    expect(second.headers['x-map-cache']).toBe('HIT');
    expect(second.body).toEqual(png);
    expect(Number(second.headers['cache-control'].split('=')[1])).toBeGreaterThan(590);
    expect(Number(second.headers['cache-control'].split('=')[1])).toBeLessThanOrEqual(600);
    expect(first.headers.etag).toBe(second.headers.etag);
    const conditional = await request(app).get('/api/v1/public/mapa/0/0/0.png').set('If-None-Match', first.headers.etag as string);
    expect(conditional.status).toBe(304);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['private, max-age=86400', 'public, no-cache, max-age=600', 'public, no-store, max-age=600', 'public, max-age=600, s-maxage=0', 'public, max-age=invalid'])('respeita restricao do provedor: %s', async policy => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => tileResponse(policy));
    const app = appWith(fetcher);
    await request(app).get('/api/v1/public/mapa/0/0/0.png');
    const second = await request(app).get('/api/v1/public/mapa/0/0/0.png');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(second.headers['cache-control']).toBe('no-store');
  });

  it('desconta Age e renova imagens expiradas', async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => tileResponse('public, max-age=120', '110'));
      const app = appWith(fetcher);
      const first = await request(app).get('/api/v1/public/mapa/0/0/0.png');
      expect(first.headers['cache-control']).toBe('public, max-age=10');
      now += 11_000;
      const second = await request(app).get('/api/v1/public/mapa/0/0/0.png');
      expect(second.headers['x-map-cache']).toBe('MISS');
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { clock.mockRestore(); }
  });

  it('limita o cache a 256 imagens usando descarte LRU', async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => { now += 100; return now; });
    try {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => tileResponse('public, max-age=86400'));
      const app = appWith(fetcher);
      for (let x = 0; x < 257; x++) await request(app).get(`/api/v1/public/mapa/9/${x}/0.png`);
      expect((await request(app).get('/api/v1/public/mapa/9/256/0.png')).headers['x-map-cache']).toBe('HIT');
      expect((await request(app).get('/api/v1/public/mapa/9/0/0.png')).headers['x-map-cache']).toBe('MISS');
      expect(fetcher).toHaveBeenCalledTimes(258);
    } finally { clock.mockRestore(); }
  });
});
