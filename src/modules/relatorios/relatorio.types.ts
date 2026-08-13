import type { StatusCorrida, TipoCorrida } from '../corridas/corrida.types';

export type RelatorioCorrida = {
  id: string;
  solicitadaEm: Date;
  agendadaPara: Date | null;
  finalizadaEm: Date | null;
  status: StatusCorrida;
  tipo: TipoCorrida;
  funcionarioId: string;
  funcionarioNome: string;
  centroCustoId: string;
  centroCustoCodigo: string;
  centroCustoNome: string;
  prestadorId: string | null;
  prestadorNome: string | null;
  solicitanteUsuarioId: string;
  solicitanteNome: string;
  origemDescricao: string;
  destinoDescricao: string;
  valorEstimado: string | null;
  valorFinal: string | null;
};

export type CustoAgrupado = { id: string | null; codigo?: string; nome: string; corridas: number; valor: string };
export type RelatorioResumo = {
  corridas: number;
  finalizadas: number;
  canceladas: number;
  valorEstimado: string;
  valorFinal: string;
};
