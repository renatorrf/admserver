import { describe, expect, it, vi } from 'vitest';
import { RideRouteService } from '../src/modules/corridas/route.service';
import type { CorridaRecord } from '../src/modules/corridas/corrida.types';
const ride = { id: 'test', empresaId: 'test', itinerarioVersao: 1,
  origemLatitude: 1, origemLongitude: 2, destinoLatitude: 5, destinoLongitude: 6,
  paradas: [{ latitude: 3, longitude: 4 }],
} as unknown as CorridaRecord;
describe('Rota Geoapify', () => {
  it('envia todos os pontos na ordem, converte lon/lat e reaproveita calculo sem GPS', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ features: [{
      properties: { distance: 1234, time: 120 }, geometry: { type: 'MultiLineString', coordinates: [[[2, 1], [4, 3], [6, 5]]] },
    }] }) });
    const service = new RideRouteService('synthetic-key', request);
    const result = await service.calculate(ride);
    expect(new URL(request.mock.calls[0]![0]).searchParams.get('waypoints')).toBe('1,2|3,4|5,6');
    expect(result.linhas).toEqual([[[1, 2], [3, 4], [5, 6]]]);
    await service.calculate({ ...ride, itinerarioVersao: 2 });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('nao mistura cache entre empresas ou itinerarios e nao retorna zero em falha', async () => {
    const request = vi.fn().mockResolvedValue({ ok: false });
    await expect(new RideRouteService('test', request).calculate(ride)).rejects.toMatchObject({ statusCode: 503 });
    await expect(new RideRouteService().calculate(ride)).rejects.toMatchObject({ statusCode: 503 });
  });
});
