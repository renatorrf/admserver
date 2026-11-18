import { Router } from 'express';
import { createHash } from 'node:crypto';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
type MapTile = { image: Buffer; expiresAt: number; etag: string };

function cacheLifetime(headers: Headers): number {
  const directives = new Map((headers.get('cache-control') ?? '').toLowerCase().split(',').map(part => {
    const [name, value] = part.trim().split('=');
    return [name, value?.replaceAll('"', '')] as const;
  }));
  if (!directives.has('public') || ['private', 'no-store', 'no-cache'].some(name => directives.has(name))) return 0;
  const ages = ['max-age', 's-maxage'].filter(name => directives.has(name)).map(name => {
    const value = directives.get(name) ?? '';
    return /^\d+$/.test(value) ? Number(value) : 0;
  });
  const age = Number(headers.get('age') ?? 0);
  if (!ages.length || !Number.isFinite(age) || age < 0) return 0;
  return Math.max(0, Math.min(600, Math.min(...ages) - age));
}

export function createMapTileRouter(apiKey?: string, request: typeof fetch = fetch): Router {
  const router = Router();
  const inFlight = new Map<string, Promise<MapTile>>();
  // Cache public map images only when explicitly allowed by the provider.
  const cache = new Map<string, MapTile>();
  let cacheBytes = 0;
  let nextDownloadAt = 0;
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/:z/:x/:y.png', async (req, res) => {
    const parts = [req.params.z, req.params.x, req.params.y];
    if (parts.some(value => typeof value !== 'string' || !/^\d{1,7}$/.test(value))) {
      res.sendStatus(400);
      return;
    }
    const [z, x, y] = parts.map(Number) as [number, number, number];
    if (z > 20 || x >= 2 ** z || y >= 2 ** z) {
      res.sendStatus(400);
      return;
    }
    if (!apiKey) {
      res.status(503).json({ erro: { codigo: 'MAPA_INDISPONIVEL', mensagem: 'Mapa nao configurado.' } });
      return;
    }

    const key = `${z}/${x}/${y}`;
    let cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      if (cached.expiresAt <= Date.now()) { cacheBytes -= cached.image.length; cached = undefined; }
      else cache.set(key, cached);
    }
    const shared = inFlight.has(key);
    if (!cached && !shared) {
      if (inFlight.size >= 32) {
        res.setHeader('Retry-After', '1');
        res.sendStatus(503);
        return;
      }
      // Smooth tile bursts per instance rather than exhausting the provider's RPS.
      const delay = Math.max(0, nextDownloadAt - Date.now());
      nextDownloadAt = Math.max(nextDownloadAt, Date.now()) + 100;
      const download = (async () => {
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        const response = await request(`https://maps.geoapify.com/v1/tile/osm-carto/${key}.png?apiKey=${encodeURIComponent(apiKey)}`, {
          signal: AbortSignal.timeout(6000),
          redirect: 'error',
          headers: { 'User-Agent': 'ADM-Taxi/1.0 (+https://admbrasil-taxi.web.app/)' },
        });
        if (!response.ok) throw new Error(`MAP_TILE_HTTP_${response.status}`);
        if (!response.headers.get('content-type')?.startsWith('image/png')) throw new Error('INVALID_MAP_TILE');
        const expiresAt = Date.now() + cacheLifetime(response.headers) * 1000;
        const image = Buffer.from(await response.arrayBuffer());
        if (image.length > 512 * 1024 || image.length < 8 || !image.subarray(0, 8).equals(pngSignature)) {
          throw new Error('INVALID_MAP_TILE');
        }
        const tile = { image, expiresAt, etag: '"' + createHash('sha256').update(image).digest('hex') + '"' };
        if (expiresAt > Date.now()) {
          cache.set(key, tile);
          cacheBytes += image.length;
          while (cache.size > 256 || cacheBytes > 16 * 1024 * 1024) {
            const oldest = cache.keys().next().value!;
            cacheBytes -= cache.get(oldest)!.image.length;
            cache.delete(oldest);
          }
        }
        return tile;
      })();
      inFlight.set(key, download);
    }
    const pending = inFlight.get(key);
    try {
      const tile = cached ?? await pending!;
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('X-Map-Cache', cached ? 'HIT' : shared ? 'SHARED' : 'MISS');
      const seconds = Math.floor((tile.expiresAt - Date.now()) / 1000);
      if (seconds > 0) {
        res.setHeader('Cache-Control', `public, max-age=${seconds}`);
        res.setHeader('ETag', tile.etag);
      }
      res.type('png').send(tile.image);
    } catch (error) {
      const upstreamStatus = error instanceof Error && /^MAP_TILE_HTTP_\d{3}$/.test(error.message)
        ? Number(error.message.slice(-3)) : undefined;
      const reason = upstreamStatus === 429 ? 'LIMITE_PROVEDOR'
        : error instanceof Error && error.name === 'TimeoutError' ? 'TEMPO_ESGOTADO' : 'FALHA_PROVEDOR';
      req.log?.warn({ motivo: reason, statusProvedor: upstreamStatus }, 'Falha ao carregar imagem do mapa');
      res.setHeader('Retry-After', '2');
      res.status(503).json({ erro: { codigo: 'MAPA_INDISPONIVEL', mensagem: 'Nao foi possivel carregar o mapa. Tente novamente.' } });
    } finally {
      if (inFlight.get(key) === pending) inFlight.delete(key);
    }
  });
  return router;
}
