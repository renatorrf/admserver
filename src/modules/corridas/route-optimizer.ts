import { z } from 'zod';
import { conflict, unavailable } from '../../shared/errors/app-error';
import { itinerarySchema, peakOccupancy, type ItineraryInput, type ItinerarySnapshot } from './itinerary';
import type { CorridaRecord } from './corrida.types';

export const optimizeRouteSchema = z.object({
  versao: z.number().int().min(1),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
}).strict();
export type OptimizeRouteInput = z.infer<typeof optimizeRouteSchema>;

export function assertRouteNotStarted(ride: CorridaRecord, snapshot: ItinerarySnapshot, version: number): void {
  if (ride.itinerarioVersao !== version || snapshot.versao !== version) throw conflict('Itinerario desatualizado. Recarregue a corrida.');
  if (ride.status !== 'ACEITA' || !snapshot.paradas.length || !snapshot.participantes.length
    || snapshot.paradas.some(p => p.estado !== 'PENDENTE')
    || snapshot.participantes.some(p => p.estado !== 'AGUARDANDO')) {
    throw conflict('Calcule o trajeto apos aceitar e antes de iniciar o deslocamento.');
  }
}

const planSchema = z.object({ features: z.array(z.object({ properties: z.object({
  agent_index: z.literal(0),
  actions: z.array(z.object({
    type: z.string(), shipment_index: z.number().int().nonnegative().optional(),
    job_index: z.number().int().nonnegative().optional(),
  })).min(1),
}) })).length(1) });

export class RideRouteOptimizer {
  constructor(private readonly apiKey?: string, private readonly request: typeof fetch = fetch) {}

  async optimize(snapshot: ItinerarySnapshot, position: OptimizeRouteInput, capacity: number): Promise<ItineraryInput> {
    if (!this.apiKey) throw unavailable('Calculo de trajeto indisponivel. Os enderecos foram preservados.');
    const stops = snapshot.paradas;
    const participants = snapshot.participantes;
    const manualStops = stops.filter(s => !participants.some(p => p.embarqueId === s.id || p.desembarqueId === s.id));
    try {
      const response = await this.request(`https://api.geoapify.com/v1/routeplanner?${new URLSearchParams({ apiKey: this.apiKey })}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ mode: 'drive',
          agents: [{ start_location: [position.longitude, position.latitude], delivery_capacity: capacity }],
          locations: stops.map((s, index) => ({ id: String(index), location: [s.longitude, s.latitude] })),
          shipments: participants.map((p, index) => ({ id: String(index), amount: 1,
            pickup: { location_index: stops.findIndex(s => s.id === p.embarqueId), duration: 0 },
            delivery: { location_index: stops.findIndex(s => s.id === p.desembarqueId), duration: 0 },
          })),
          ...(manualStops.length ? { jobs: manualStops.map((s, index) => ({ id: String(index),
            location_index: stops.findIndex(point => point.id === s.id), duration: 0 })) } : {}),
        }),
      });
      if (!response.ok) throw new Error('Planner unavailable');
      const actions = planSchema.parse(await response.json()).features[0]!.properties.actions;
      const order: string[] = [];
      const seen = new Set<string>();
      for (const action of actions) {
        if (['start', 'end'].includes(action.type)) continue;
        let id: string | undefined;
        let key: string;
        if (action.shipment_index !== undefined && ['pickup', 'delivery'].includes(action.type)) {
          const passenger = participants[action.shipment_index];
          id = action.type === 'pickup' ? passenger?.embarqueId : passenger?.desembarqueId;
          key = `${action.type}:${action.shipment_index}`;
        } else if (action.job_index !== undefined && action.shipment_index === undefined) {
          id = manualStops[action.job_index]?.id;
          key = `job:${action.job_index}`;
        } else throw new Error('Unknown action');
        if (!id || seen.has(key)) throw new Error('Invalid action');
        seen.add(key);
        if (order[order.length - 1] !== id) order.push(id);
      }
      // Accept only a complete permutation, never a partial plan or repeated visits to a shared stop.
      if (seen.size !== participants.length * 2 + manualStops.length || order.length !== stops.length
        || new Set(order).size !== stops.length || stops.some(s => !order.includes(s.id))) throw new Error('Incomplete plan');
      const candidate = itinerarySchema.parse({
        paradas: order.map(id => {
          const stop = stops.find(s => s.id === id)!;
          return { id, descricao: stop.descricao, latitude: stop.latitude, longitude: stop.longitude };
        }),
        participantes: participants.map(({ funcionarioId, embarqueId, desembarqueId, centroCustoId, valor }) =>
          ({ funcionarioId, embarqueId, desembarqueId, centroCustoId, valor })),
      });
      if (peakOccupancy(candidate) > capacity) throw new Error('Capacity exceeded');
      return candidate;
    } catch {
      throw unavailable('Nao foi possivel obter um trajeto completo e seguro. Os enderecos foram preservados; tente novamente.');
    }
  }
}
