export const statusCorrida = [
  'SOLICITADA',
  'OFERTADA',
  'ACEITA',
  'EM_DESLOCAMENTO',
  'AGUARDANDO_PASSAGEIRO',
  'EM_CORRIDA',
  'FINALIZADA',
  'CANCELADA',
  'RECUSADA',
] as const;

export type StatusCorrida = (typeof statusCorrida)[number];

export const tiposCorrida = ['IMEDIATA', 'AGENDADA'] as const;
export type TipoCorrida = (typeof tiposCorrida)[number];

export type CorridaRecord = Record<string, unknown> & {
  id: string;
  empresaId: string;
  solicitanteUsuarioId: string;
  funcionarioId: string;
  centroCustoId: string;
  prestadorId: string | null;
  veiculoId: string | null;
  status: StatusCorrida;
  tipo: TipoCorrida;
  desembarqueEm?: Date | null;
  funcionarioNome?: string;
  funcionarioTelefone?: string | null;
  funcionarioMatricula?: string;
  centroCustoCodigo?: string;
  centroCustoNome?: string;
  prestadorNome?: string | null;
  prestadorTelefone?: string | null;
  veiculoPlaca?: string | null;
  veiculoDescricao?: string | null;
};

export type CorridaEventoRecord = {
  id: string;
  corridaId: string;
  usuarioId: string | null;
  tipoEvento: string;
  statusAnterior: StatusCorrida | null;
  statusNovo: StatusCorrida | null;
  descricao: string | null;
  metadata: Record<string, unknown>;
  criadoEm: Date;
};

export type PrestadorContext = {
  id: string;
  usuarioId: string;
  disponivel: boolean;
  ativo: boolean;
};
