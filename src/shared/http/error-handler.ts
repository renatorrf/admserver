import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from 'pino';
import { ZodError } from 'zod';

import { AppError } from '../errors/app-error';

export const notFoundHandler: RequestHandler = (request, _response, next) => {
  next(new AppError(404, 'ROTA_NAO_ENCONTRADA', `Rota nao encontrada: ${request.method} ${request.path}`));
};

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, request, response, _next) => {
    if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.parse.failed') {
      response.status(400).json({
        erro: { codigo: 'JSON_INVALIDO', mensagem: 'O corpo da requisicao contem JSON invalido.' },
        requisicaoId: request.id,
      });
      return;
    }

    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 413) {
      response.status(413).json({
        erro: { codigo: 'CONTEUDO_MUITO_GRANDE', mensagem: 'O conteudo enviado excede o limite permitido.' },
        requisicaoId: request.id,
      });
      return;
    }

    if (error instanceof ZodError) {
      response.status(422).json({
        erro: {
          codigo: 'DADOS_INVALIDOS',
          mensagem: 'Revise os dados informados.',
          detalhes: error.flatten().fieldErrors,
        },
        requisicaoId: request.id,
      });
      return;
    }

    if (error instanceof AppError) {
      response.status(error.statusCode).json({
        erro: { codigo: error.code, mensagem: error.message, ...(error.details ? { detalhes: error.details } : {}) },
        requisicaoId: request.id,
      });
      return;
    }

    if (typeof error === 'object' && error !== null && 'code' in error) {
      if (error.code === '23505') {
        response.status(409).json({
          erro: { codigo: 'REGISTRO_DUPLICADO', mensagem: 'Ja existe um registro com os dados informados.' },
          requisicaoId: request.id,
        });
        return;
      }
      if (error.code === '23503' || error.code === '23514' || error.code === '22P02') {
        response.status(422).json({
          erro: { codigo: 'DADOS_INVALIDOS', mensagem: 'Os dados informados violam uma regra do cadastro.' },
          requisicaoId: request.id,
        });
        return;
      }
    }

    logger.error({ err: error, requestId: request.id }, 'Erro nao tratado');
    response.status(500).json({
      erro: { codigo: 'ERRO_INTERNO', mensagem: 'Nao foi possivel concluir a solicitacao.' },
      requisicaoId: request.id,
    });
  };
}
