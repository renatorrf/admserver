import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from 'pino';
import type { Pool } from 'pg';
import { ZodError } from 'zod';

import { AppError } from '../errors/app-error';

export const notFoundHandler: RequestHandler = (request, _response, next) => {
  next(new AppError(404, 'ROTA_NAO_ENCONTRADA', `Rota nao encontrada: ${request.method} ${request.path}`));
};

export function createErrorHandler(logger: Logger, auditDatabase?: Pick<Pool, 'query'>): ErrorRequestHandler {
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
      const fields = error.issues.map((issue) => {
        const collection = issue.path.findIndex(part => part === 'paradas' || part === 'participantes');
        let record: unknown = request.body;
        if (collection >= 0 && typeof issue.path[collection + 1] === 'number') {
          for (const part of issue.path.slice(0, collection + 2)) {
            record = record && typeof record === 'object' ? (record as Record<string, unknown>)[String(part)] : undefined;
          }
        } else record = undefined;
        const stableId = record && typeof record === 'object'
          ? (record as Record<string, unknown>)[issue.path[collection] === 'paradas' ? 'id' : 'funcionarioId'] : undefined;
        return { campo: issue.path.join('.') || 'formulario', mensagem: issue.message,
          ...(typeof stableId === 'string' && /^[0-9a-f-]{36}$/i.test(stableId) ? { objetoId: stableId } : {}) };
      });
      logger.warn({ requestId: request.id, validationFields: fields }, 'Requisicao rejeitada por dados invalidos');
      response.status(422).json({
        erro: {
          codigo: 'DADOS_INVALIDOS',
          mensagem: 'Revise os dados informados.',
          detalhes: { campos: fields },
        },
        requisicaoId: request.id,
      });
      return;
    }

    if (error instanceof AppError) {
      if (error.statusCode === 403 && request.auth && auditDatabase) {
        void Promise.resolve(auditDatabase.query(
          `INSERT INTO admtaxi.auditoria
             (empresa_id,usuario_id,entidade,entidade_id,acao,dados_novos,ip,user_agent)
           VALUES ($1,$2,'controle_acesso',$3,'ACESSO_NEGADO',$4,$5,$6)`,
          [
            request.auth.empresaId, request.auth.usuarioId, request.path,
            { metodo: request.method, caminho: request.path, codigo: error.code },
            request.ip, request.get('user-agent') ?? null,
          ],
        )).catch((auditError: unknown) => {
          logger.warn({ err: auditError, requestId: request.id }, 'Falha ao registrar acesso negado');
        });
      }
      response.status(error.statusCode).json({
        erro: { codigo: error.code, mensagem: error.message, ...(error.details ? { detalhes: error.details } : {}) },
        requisicaoId: request.id,
      });
      return;
    }

    if (typeof error === 'object' && error !== null && 'code' in error) {
      if (error.code === 'P1601') {
        response.status(409).json({ erro: { codigo: 'CONTA_GESTOR', mensagem: 'message' in error ? String(error.message) : 'Revise o vinculo da conta de gestor.' }, requisicaoId: request.id });
        return;
      }
      if (error.code === '23505') {
        const constraint = 'constraint' in error && typeof error.constraint === 'string' ? error.constraint : '';
        const duplicateFields: Record<string, { campo: string; mensagem: string }> = {
          usuarios_empresa_email_unico: { campo: 'email', mensagem: 'Este e-mail ja esta cadastrado.' },
          prestadores_empresa_cpf_unico: { campo: 'cpf', mensagem: 'Este CPF ja esta cadastrado.' },
          prestadores_empresa_cnh_unico: { campo: 'numeroCnh', mensagem: 'Esta CNH ja esta cadastrada.' },
          veiculos_empresa_placa_unico: { campo: 'placa', mensagem: 'Esta placa ja esta cadastrada.' },
          funcionarios_empresa_matricula_unico: { campo: 'matricula', mensagem: 'Esta matricula ja esta cadastrada.' },
          funcionarios_empresa_cpf_unico: { campo: 'cpf', mensagem: 'Este CPF ja esta cadastrado.' },
          centros_custo_empresa_codigo_unico: { campo: 'codigo', mensagem: 'Este codigo ja esta cadastrado.' },
          setores_empresa_codigo_unico: { campo: 'codigo', mensagem: 'Este codigo de setor ja esta cadastrado.' },
          empresas_codigo_acesso_key: { campo: 'codigoAcesso', mensagem: 'Este codigo de acesso ja esta cadastrado.' },
        };
        const entities = { usuarios: 'usuario', prestadores: 'prestador', funcionarios: 'funcionario', veiculos: 'veiculo' };
        const fieldLabels = { nome: 'nome', telefone: 'telefone', email: 'e-mail', placa: 'placa' };
        for (const [table, label] of Object.entries(entities)) {
          for (const [field, fieldLabel] of Object.entries(fieldLabels)) {
            duplicateFields[`${table}_empresa_${field}_normalizado_unico`] = { campo: field,
              mensagem: `Ja existe outro ${label} com ${field === 'placa' ? 'esta' : 'este'} ${fieldLabel} nesta empresa. Verifique tambem os cadastros inativos.` };
          }
        }
        duplicateFields.usuarios_empresa_email_unico = { campo: 'email', mensagem: 'Este e-mail ja possui um acesso nesta empresa. Edite o cadastro existente ou utilize outro e-mail. Verifique tambem os inativos.' };
        duplicateFields.veiculos_empresa_placa_unico = { campo: 'placa', mensagem: 'Esta placa ja esta cadastrada nesta empresa. Selecione o veiculo existente ou revise a placa. Verifique tambem os inativos.' };
        const detail = duplicateFields[constraint];
        response.status(409).json({
          erro: {
            codigo: 'REGISTRO_DUPLICADO', mensagem: detail?.mensagem ?? 'Ja existe um registro com os dados informados.',
            ...(detail ? { detalhes: { campos: [detail] } } : {}),
          },
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
