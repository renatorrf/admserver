import type { CorridaRecord, StatusCorrida } from '../corridas/corrida.types';

export const statusComRastreamento: readonly StatusCorrida[] = [
  'ACEITA',
  'EM_DESLOCAMENTO',
  'AGUARDANDO_PASSAGEIRO',
  'EM_CORRIDA',
];

export type LocalizacaoRecord = {
  id: string;
  empresaId: string;
  corridaId: string;
  prestadorId: string;
  latitude: number;
  longitude: number;
  precisaoMetros: number | null;
  velocidade: number | null;
  direcao: number | null;
  registradoEm: Date;
};

export type AcompanhamentoSnapshot = {
  corrida: CorridaRecord;
  localizacaoAtual: LocalizacaoRecord | null;
};
