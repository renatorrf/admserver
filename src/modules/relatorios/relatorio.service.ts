import { forbidden } from '../../shared/errors/app-error';
import type { AuthContext } from '../auth/auth.types';
import type { RelatorioExportQuery, RelatorioListQuery } from './relatorio.schemas';
import type { RelatorioRepository } from './relatorio.repository';
import type { RelatorioCorrida } from './relatorio.types';

export class RelatorioService {
  constructor(private readonly repository: RelatorioRepository) {}

  list(auth: AuthContext, query: RelatorioListQuery) {
    this.authorize(auth);
    return this.repository.list(auth, query);
  }

  async csv(auth: AuthContext, query: RelatorioExportQuery): Promise<string> {
    this.authorize(auth);
    return rowsToCsv(await this.repository.export(auth, query));
  }

  private authorize(auth: AuthContext): void {
    if (auth.perfil === 'PRESTADOR') throw forbidden();
  }
}

const csvCell = (value: unknown): string => {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

const date = (value: Date | null): string => value ? value.toISOString() : '';

export function rowsToCsv(rows: RelatorioCorrida[]): string {
  const headers = [
    'ID', 'Solicitada em', 'Agendada para', 'Finalizada em', 'Status', 'Tipo', 'Funcionario',
    'Centro de custo', 'Prestador', 'Solicitante', 'Origem', 'Destino', 'Valor estimado', 'Valor final',
  ];
  const lines = rows.map((row) => [
    row.id, date(row.solicitadaEm), date(row.agendadaPara), date(row.finalizadaEm), row.status, row.tipo,
    row.funcionarioNome, `${row.centroCustoCodigo} - ${row.centroCustoNome}`, row.prestadorNome,
    row.solicitanteNome, row.origemDescricao, row.destinoDescricao, row.valorEstimado, row.valorFinal,
  ].map(csvCell).join(';'));
  return `\uFEFF${headers.map(csvCell).join(';')}\r\n${lines.join('\r\n')}${lines.length ? '\r\n' : ''}`;
}
