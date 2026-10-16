import express from 'express';
import request from 'supertest';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { itineraryEditSchema } from '../src/modules/corridas/itinerary';
import { createErrorHandler } from '../src/shared/http/error-handler';

describe('stable itinerary errors', () => {
  it('identifies a reordered stop without returning its address', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const app = express();
    app.use(express.json());
    app.post('/', (req, res) => { itineraryEditSchema.parse(req.body); res.sendStatus(200); });
    app.use(createErrorHandler(pino({ level: 'silent' })));
    const response = await request(app).post('/').send({ versao: 1, itinerario: {
      paradas: [{ id, descricao: 'Endereco privado', latitude: null, longitude: 0 }], participantes: [],
    } });
    expect(response.status).toBe(422);
    expect(response.body.erro.detalhes.campos).toContainEqual(expect.objectContaining({ campo: 'itinerario.paradas.0.latitude', objetoId: id }));
    expect(JSON.stringify(response.body)).not.toContain('Endereco privado');
  });
});
