import { randomBytes } from 'node:crypto';
import type { MailConfig } from '../../config/env';
import { withTransaction, type Database, type QueryExecutor } from '../../db/pool';
import { AppError, conflict, forbidden, notFound, unavailable } from '../../shared/errors/app-error';
import type { AuthContext } from '../auth/auth.types';
import { lockCredentials } from '../auth/account-credentials';
import { hashResetToken } from '../auth/password.service';
import type { AuditMetadata } from '../auditoria/audit.types';
import type { CorridaAuditWriter } from '../corridas/corrida.service';
import { installationInstructions } from './access-instructions';

type AccessRow = {
  funcionarioId: string; nome: string; telefone: string | null; email: string | null;
  usuarioId: string | null; ativo: boolean; primeiroAcesso: boolean; criadoNaConferencia: boolean;
};

export function whatsappPhone(phone: string | null): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (/^[1-9]\d{9,10}$/.test(digits)) return `55${digits}`;
  return /^55[1-9]\d{9,10}$/.test(digits) ? digits : null;
}

function unavailableReason(row: AccessRow): string | null {
  if (!row.ativo) return 'Cadastro ou acesso inativo. Solicite a revisao ao gestor.';
  if (!row.usuarioId || !row.email) return 'Cadastro sem acesso. O gestor precisa cadastrar o e-mail de login.';
  if (!whatsappPhone(row.telefone)) return 'Telefone com DDD ausente ou invalido. Solicite a correcao ao gestor.';
  if (row.primeiroAcesso && !row.criadoNaConferencia) return 'Use o acesso inicial ja fornecido ou a recuperacao por e-mail.';
  return null;
}

export class RequisitionAccessService {
  constructor(private readonly database: Database, private readonly audit: CorridaAuditWriter,
    private readonly config?: Pick<MailConfig, 'resetUrl' | 'resetTtlMinutes'>) {}

  private async contacts(auth: AuthContext, id: string, db: QueryExecutor): Promise<AccessRow[]> {
    if (auth.perfil !== 'PORTARIA') throw forbidden('Somente a portaria pode preparar o acesso pelo WhatsApp.');
    const request = (await db.query<{ status: string; corrida_id: string | null }>(
      'SELECT status,corrida_id FROM admtaxi.requisicoes_viagem WHERE empresa_id=$1 AND id=$2', [auth.empresaId, id])).rows[0];
    if (!request) throw notFound('Requisicao');
    if (request.status !== 'SOLICITADA' || !request.corrida_id) throw conflict('Conclua a conferencia e solicite a corrida antes de enviar o acesso.');
    return (await db.query<AccessRow>(`SELECT DISTINCT f.id AS "funcionarioId",f.nome,f.telefone,u.email::text,
        u.id AS "usuarioId",(f.ativo AND e.ativo AND COALESCE(u.ativo,TRUE)) AS ativo,
        COALESCE(u.deve_alterar_senha,FALSE) AS "primeiroAcesso",
        EXISTS(SELECT 1 FROM admtaxi.emails_viagem m WHERE m.empresa_id=f.empresa_id
          AND m.requisicao_id=$3 AND m.evento='PRIMEIRO_ACESSO:' || u.id::text
          AND m.destinatario=u.email) AS "criadoNaConferencia"
      FROM admtaxi.corrida_participacoes cp
      JOIN admtaxi.funcionarios f ON f.empresa_id=cp.empresa_id AND f.id=cp.funcionario_id
      JOIN admtaxi.empresas e ON e.id=f.empresa_id
      LEFT JOIN admtaxi.usuarios_autenticacao u ON u.empresa_id=f.empresa_id AND u.id=f.usuario_id AND u.perfil='FUNCIONARIO'
      WHERE cp.empresa_id=$1 AND cp.corrida_id=$2 ORDER BY f.nome,f.id`, [auth.empresaId, request.corrida_id, id])).rows;
  }

  async list(auth: AuthContext, id: string) {
    return (await this.contacts(auth, id, this.database)).map(row => ({
      funcionarioId: row.funcionarioId, nome: row.nome, telefone: row.telefone,
      email: row.email, primeiroAcesso: row.primeiroAcesso,
      indisponivel: unavailableReason(row),
    }));
  }

  async prepare(auth: AuthContext, id: string, employeeId: string, metadata: AuditMetadata) {
    // Only server-side membership and the stored contact determine the recipient.
    return withTransaction(this.database, async client => {
      let row = (await this.contacts(auth, id, client)).find(p => p.funcionarioId === employeeId);
      if (!row) throw notFound('Passageiro desta requisicao');
      const reason = unavailableReason(row);
      if (reason) throw conflict(reason);
      if (!this.config) throw unavailable('O endereco de primeiro acesso ainda nao foi configurado.');
      const userId = row.usuarioId;
      const account = await lockCredentials(client, row.usuarioId!, auth.empresaId);
      row = (await this.contacts(auth, id, client)).find(p => p.funcionarioId === employeeId);
      if (!row) throw notFound('Passageiro desta requisicao');
      if (row.usuarioId !== userId) throw conflict('O acesso foi alterado. Atualize os dados antes de continuar.');
      const updatedReason = unavailableReason(row);
      if (updatedReason) throw conflict(updatedReason);
      let activation = 'Utilize seu e-mail e sua senha atual. Sua senha nao foi alterada.';
      let expiresAt: string | null = null;
      if (row.primeiroAcesso) {
        const attempts = (await client.query<{ total: string }>(`SELECT COUNT(*)::text AS total
          FROM admtaxi.recuperacoes_senha WHERE criado_em > CURRENT_TIMESTAMP - INTERVAL '1 hour'
          AND usuario_id IN (SELECT id FROM admtaxi.usuarios WHERE id=$1
            OR ($2::uuid IS NOT NULL AND conta_funcionario_id=$2))`, [row.usuarioId, account])).rows[0];
        if (Number(attempts?.total) >= 5) throw new AppError(429, 'LIMITE_ACESSO_WHATSAPP', 'Limite de links atingido. Aguarde uma hora antes de gerar outro.');
        const token = randomBytes(32).toString('hex');
        const issued = await client.query<{ expira_em: Date }>(`INSERT INTO admtaxi.recuperacoes_senha
          (token_hash,empresa_id,usuario_id,expira_em) VALUES($1,$2,$3,CURRENT_TIMESTAMP+$4::int*INTERVAL '1 minute') RETURNING expira_em`,
        [hashResetToken(token), auth.empresaId, row.usuarioId, this.config.resetTtlMinutes]);
        expiresAt = new Date(issued.rows[0]!.expira_em).toISOString();
        const url = new URL(this.config.resetUrl); url.hash = `token=${token}`;
        activation = `Para ativar sua conta e definir sua senha: ${url.toString()}\n`
          + `Link pessoal de uso unico, valido por ${this.config.resetTtlMinutes} minutos. Nao compartilhe.\n`
          + 'Se expirar, use Esqueci minha senha na tela de login.';
      }
      const message = `Ola, ${row.nome}!\n\nSeu acesso a plataforma ADM Taxi foi disponibilizado.\nLogin: ${row.email}\n\n`
        + activation + '\n\n' + installationInstructions(this.config.resetUrl);
      await this.audit.record(client, { ...metadata, empresaId: auth.empresaId, usuarioId: auth.usuarioId,
        entidade: 'requisicoes_viagem', entidadeId: id, acao: 'PREPARAR_ACESSO_WHATSAPP',
        dadosAnteriores: null, dadosNovos: { funcionarioId: employeeId, primeiroAcesso: row.primeiroAcesso } });
      return { nome: row.nome, telefone: whatsappPhone(row.telefone)!, mensagem: message, expiraEm: expiresAt };
    });
  }
}
