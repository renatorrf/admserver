export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const unauthorized = (message = 'Nao autorizado.'): AppError =>
  new AppError(401, 'NAO_AUTORIZADO', message);

export const forbidden = (message = 'Voce nao tem permissao para realizar esta acao.'): AppError =>
  new AppError(403, 'ACESSO_NEGADO', message);

export const notFound = (entity = 'Registro'): AppError =>
  new AppError(404, 'REGISTRO_NAO_ENCONTRADO', `${entity} nao encontrado.`);

export const conflict = (message: string): AppError =>
  new AppError(409, 'CONFLITO', message);

export const invalidReference = (message: string): AppError =>
  new AppError(422, 'REFERENCIA_INVALIDA', message);
