import type { Database } from '../../db/pool';
import { AppError } from '../../shared/errors/app-error';
import type { AuthContext } from '../auth/auth.types';
import type { EnderecoAutocompleteQuery, EnderecoReverseQuery } from './endereco.schemas';

type GeoapifyResult = {
  formatted?: string;
  address_line1?: string;
  address_line2?: string;
  street?: string;
  housenumber?: string;
  suburb?: string;
  city?: string;
  state_code?: string;
  state?: string;
  lat?: number;
  lon?: number;
  place_id?: string;
};

type GeoapifyResponse = { results?: GeoapifyResult[] };

export type EnderecoSugestao = {
  id: string;
  descricao: string;
  logradouro: string | null;
  numero: string | null;
  bairro: string | null;
  cidade: string | null;
  estado: string | null;
  latitude: number;
  longitude: number;
};

export class EnderecoService {
  constructor(private readonly database: Database, private readonly apiKey?: string) {}

  async autocomplete(auth: AuthContext, query: EnderecoAutocompleteQuery): Promise<EnderecoSugestao[]> {
    this.requireConfigured();
    const reference = query.latitude === undefined
      ? await this.companyReference(auth.empresaId)
      : { latitude: query.latitude, longitude: query.longitude, cidade: null, estado: null };
    const text = reference.cidade && reference.estado
      ? `${query.texto}, ${reference.cidade}, ${reference.estado}`
      : query.texto;
    const parameters = new URLSearchParams({
      text,
      format: 'json',
      lang: 'pt',
      limit: '8',
      filter: 'countrycode:br',
      apiKey: this.apiKey!,
    });
    if (reference.latitude !== null && reference.longitude !== null) {
      parameters.set('bias', `proximity:${reference.longitude},${reference.latitude}`);
    }
    return this.request(`/v1/geocode/autocomplete?${parameters.toString()}`);
  }

  async reverse(_auth: AuthContext, query: EnderecoReverseQuery): Promise<EnderecoSugestao | null> {
    this.requireConfigured();
    const parameters = new URLSearchParams({
      lat: String(query.latitude), lon: String(query.longitude), format: 'json', lang: 'pt',
      apiKey: this.apiKey!,
    });
    return (await this.request(`/v1/geocode/reverse?${parameters.toString()}`))[0] ?? null;
  }

  private async companyReference(empresaId: string): Promise<{
    latitude: number | null; longitude: number | null; cidade: string | null; estado: string | null;
  }> {
    const result = await this.database.query<{
      latitude_padrao: string | null; longitude_padrao: string | null; cidade_padrao: string | null; estado_padrao: string | null;
    }>(
      `SELECT latitude_padrao::text, longitude_padrao::text, cidade_padrao, estado_padrao
         FROM admtaxi.empresas WHERE id = $1 AND ativo = TRUE`,
      [empresaId],
    );
    const row = result.rows[0];
    return {
      latitude: row?.latitude_padrao === null || row?.latitude_padrao === undefined ? null : Number(row.latitude_padrao),
      longitude: row?.longitude_padrao === null || row?.longitude_padrao === undefined ? null : Number(row.longitude_padrao),
      cidade: row?.cidade_padrao ?? null,
      estado: row?.estado_padrao ?? null,
    };
  }

  private async request(path: string): Promise<EnderecoSugestao[]> {
    try {
      const response = await fetch(`https://api.geoapify.com${path}`, { signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error(`Geoapify respondeu ${response.status}`);
      const payload = await response.json() as GeoapifyResponse;
      return (payload.results ?? []).flatMap((item) => {
        if (typeof item.lat !== 'number' || typeof item.lon !== 'number' || !item.formatted) return [];
        return [{
          id: item.place_id ?? `${item.lat},${item.lon}`,
          descricao: item.formatted,
          logradouro: item.street ?? item.address_line1 ?? null,
          numero: item.housenumber ?? null,
          bairro: item.suburb ?? null,
          cidade: item.city ?? null,
          estado: item.state_code ?? item.state ?? null,
          latitude: item.lat,
          longitude: item.lon,
        }];
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, 'GEOCODIFICACAO_INDISPONIVEL', 'A busca de enderecos esta temporariamente indisponivel.');
    }
  }

  private requireConfigured(): void {
    if (!this.apiKey) {
      throw new AppError(503, 'GEOCODIFICACAO_NAO_CONFIGURADA', 'A busca de enderecos ainda nao foi configurada.');
    }
  }
}
