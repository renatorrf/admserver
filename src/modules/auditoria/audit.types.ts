import type { Request } from 'express';

export type AuditMetadata = {
  ip?: string;
  userAgent?: string;
};

export type AuditEntry = AuditMetadata & {
  empresaId: string;
  usuarioId?: string;
  entidade: string;
  entidadeId: string;
  acao: string;
  dadosAnteriores?: Record<string, unknown> | null;
  dadosNovos?: Record<string, unknown> | null;
};

export function auditMetadataFromRequest(request: Request): AuditMetadata {
  return {
    ip: request.ip,
    userAgent: request.get('user-agent'),
  };
}
