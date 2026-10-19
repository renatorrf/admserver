import type { Pool } from 'pg';
import { withTransaction } from '../../db/pool';
import { conflict, forbidden, notFound } from '../../shared/errors/app-error';
import type { AuthContext } from '../auth/auth.types';
import type { AuditMetadata } from '../auditoria/audit.types';
import { AuditRepository } from '../auditoria/audit.repository';

export class DriverLinkService {
  constructor(private readonly db: Pool) {}

  async search(auth: AuthContext, email: string) {
    if (auth.perfil !== 'GESTOR') throw forbidden();
    return (await this.db.query<{ id: string; nome: string; email: string; vinculado: boolean }>(
      `SELECT c.id,c.nome,c.email::text,EXISTS(SELECT 1 FROM admtaxi.usuarios u WHERE u.conta_motorista_id=c.id AND u.empresa_id=$2) AS vinculado
       FROM admtaxi.contas_motorista c WHERE c.email=$1
       AND EXISTS(SELECT 1 FROM admtaxi.motorista_vinculos_ativos m WHERE m.conta_id=c.id) ORDER BY c.id LIMIT 20`,
      [email, auth.empresaId])).rows;
  }

  async link(auth: AuthContext, accountId: string, copyVehicle: boolean, metadata: AuditMetadata) {
    if (auth.perfil !== 'GESTOR') throw forbidden();
    return withTransaction(this.db, async client => {
      const account = (await client.query<{ id: string; nome: string; email: string; telefone: string; senha_hash: string }>(
        'SELECT * FROM admtaxi.contas_motorista WHERE id=$1 FOR UPDATE', [accountId])).rows[0];
      if (!account) throw notFound('Motorista');
      if ((await client.query('SELECT id FROM admtaxi.usuarios WHERE conta_motorista_id=$1 AND empresa_id=$2', [accountId, auth.empresaId])).rowCount) {
        throw conflict('Este motorista ja possui cadastro nesta empresa. Localize-o nos ativos ou inativos para editar.');
      }
      const source = (await client.query<{ id: string; empresa_id: string; nome: string; cpf: string; telefone: string; email: string; numero_cnh: string; validade_cnh: string; disponivel: boolean }>(
        `SELECT p.* FROM admtaxi.motorista_vinculos_ativos m JOIN admtaxi.prestadores p ON p.id=m.prestador_id AND p.empresa_id=m.empresa_id
         WHERE m.conta_id=$1 ORDER BY p.criado_em,p.id LIMIT 1`, [accountId])).rows[0];
      if (!source) throw notFound('Motorista ativo');
      const user = (await client.query<{ id: string }>(
        `INSERT INTO admtaxi.usuarios(empresa_id,nome,email,telefone,senha_hash,perfil,ativo,conta_motorista_id)
         VALUES($1,$2,$3,$4,$5,'PRESTADOR',TRUE,$6) RETURNING id`,
        [auth.empresaId, account.nome, account.email, account.telefone, account.senha_hash, accountId])).rows[0]!;
      const provider = (await client.query<{ id: string }>(
        `INSERT INTO admtaxi.prestadores(empresa_id,usuario_id,nome,cpf,telefone,email,numero_cnh,validade_cnh,disponivel,ativo)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE) RETURNING id`,
        [auth.empresaId, user.id, source.nome, source.cpf, source.telefone, source.email, source.numero_cnh, source.validade_cnh, source.disponivel])).rows[0]!;
      if (copyVehicle) await client.query(
        `INSERT INTO admtaxi.veiculos(empresa_id,prestador_id,placa,marca,modelo,cor,ano,capacidade_passageiros,ativo)
         SELECT $1,$2,placa,marca,modelo,cor,ano,capacidade_passageiros,TRUE FROM admtaxi.veiculos
         WHERE empresa_id=$3 AND prestador_id=$4 AND ativo`, [auth.empresaId, provider.id, source.empresa_id, source.id]);
      await new AuditRepository(this.db).record(client, { ...metadata, empresaId: auth.empresaId, usuarioId: auth.usuarioId,
        entidade: 'prestador', entidadeId: provider.id, acao: 'VINCULAR_CONTA_MOTORISTA', dadosNovos: { contaId: accountId, copiarVeiculo: copyVehicle } });
      return { id: provider.id };
    });
  }
}
