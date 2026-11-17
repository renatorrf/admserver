import { Router } from 'express';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function createMapTileRouter(apiKey?: string, request: typeof fetch = fetch): Router {
  const router = Router();
  // Share in-flight downloads only; the provider's tiles must not be cached.
  const inFlight = new Map<string, Promise<Buffer>>();
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
    if (!inFlight.has(key)) {
      if (inFlight.size >= 32) {
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
        if (!response.ok || !response.headers.get('content-type')?.startsWith('image/png')) {
          throw new Error('MAP_TILE_UNAVAILABLE');
        }
        const image = Buffer.from(await response.arrayBuffer());
        if (image.length > 512 * 1024 || image.length < 8 || !image.subarray(0, 8).equals(pngSignature)) {
          throw new Error('INVALID_MAP_TILE');
        }
        return image;
      })();
      inFlight.set(key, download);
    }
    const pending = inFlight.get(key)!;
    try {
      const image = await pending;
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.type('png').send(image);
    } catch {
      res.status(503).json({ erro: { codigo: 'MAPA_INDISPONIVEL', mensagem: 'Nao foi possivel carregar o mapa. Tente novamente.' } });
    } finally {
      if (inFlight.get(key) === pending) inFlight.delete(key);
    }
  });
  return router;
}
