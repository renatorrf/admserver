import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { CorridaRecord } from './corrida.types';
import { invalidReference, unavailable } from '../../shared/errors/app-error';

const routeResponse = z.object({ features: z.array(z.object({
  properties: z.object({ distance: z.number().nonnegative(), time: z.number().nonnegative() }),
  geometry: z.object({ type: z.literal('MultiLineString'), coordinates: z.array(z.array(z.tuple([
    z.number().min(-180).max(180), z.number().min(-90).max(90),
  ])).min(2)).min(1) }),
})).min(1) });
type RouteGeometry = { distanciaMetros: number; duracaoSegundos: number; linhas: [number, number][][] };

export class RideRouteService {
  private readonly cache = new Map<string, { expires: number; value: RouteGeometry }>();
  constructor(private readonly apiKey?: string, private readonly request: typeof fetch = fetch) {}

  async calculate(ride: CorridaRecord): Promise<RouteGeometry & { versao: number; calculadoEm: string }> {
    if (!this.apiKey) throw unavailable('Calculo de rota indisponivel. Os enderecos continuam acessiveis.');
    const points = ride.itinerario?.paradas ?? [
      { latitude: ride.origemLatitude, longitude: ride.origemLongitude }, ...(ride.paradas ?? []),
      { latitude: ride.destinoLatitude, longitude: ride.destinoLongitude },
    ];
    if (points.length < 2 || points.some(p => typeof p.latitude !== 'number' || !Number.isFinite(p.latitude)
      || Math.abs(p.latitude) > 90 || typeof p.longitude !== 'number' || !Number.isFinite(p.longitude) || Math.abs(p.longitude) > 180)) {
      throw invalidReference('Confirme as coordenadas de todas as paradas para calcular a rota.');
    }
    const waypoints = points.map(p => `${p.latitude},${p.longitude}`).join('|');
    const key = createHash('sha256').update(`${ride.empresaId}:${waypoints}`).digest('hex');
    const cached = this.cache.get(key);
    let geometry = cached && cached.expires > Date.now() ? cached.value : undefined;
    if (!geometry) {
      try {
        const params = new URLSearchParams({ waypoints, mode: 'drive', units: 'metric', lang: 'pt', apiKey: this.apiKey });
        const response = await this.request(`https://api.geoapify.com/v1/routing?${params}`, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error('Routing unavailable');
        const feature = routeResponse.parse(await response.json()).features[0]!;
        geometry = { distanciaMetros: feature.properties.distance, duracaoSegundos: feature.properties.time,
          linhas: feature.geometry.coordinates.map(line => line.map(([lon, lat]) => [lat, lon])) };
        if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { expires: Date.now() + 300_000, value: geometry });
      } catch { throw unavailable('Nao foi possivel calcular a rota. Tente novamente; os enderecos foram preservados.'); }
    }
    return { ...geometry, versao: ride.itinerarioVersao ?? 0, calculadoEm: new Date().toISOString() };
  }
}
