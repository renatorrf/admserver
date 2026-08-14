import argon2 from 'argon2';
import type { QueryResultRow } from 'pg';

import { queryOne, type Database, type QueryExecutor, withTransaction } from '../../db/pool';
import { conflict, invalidReference, notFound } from '../../shared/errors/app-error';
import { paginate, type PaginatedResult } from '../../shared/pagination/pagination';
import type { AuthContext } from '../auth/auth.types';
import type { AuditMetadata } from '../auditoria/audit.types';
import type { AuditRepository } from '../auditoria/audit.repository';
import type {
  PrestadorUnificadoCreateInput, PrestadorUnificadoUpdateInput, VeiculoVinculoListQuery,
} from './prestador-unificado.schemas';

type EntityRow = QueryResultRow & { id: string };
type ProviderContext = QueryResultRow & {
  id: string; empresa_id: string; usuario_id: string; nome: string; cpf: string; telefone: string;
  email: string | null; numero_cnh: string; validade_cnh: string; disponivel: boolean; ativo: boolean;
  usuario_nome: string; usuario_email: string; usuario_telefone: string | null; usuario_ativo: boolean;
};

export type VeiculoVinculoRecord = {
  id: string; placa: string; marca: string; modelo: string; cor: string; ano: number;
  capacidadePassageiros: number; prestadorId: string | null; prestadorNome: string | null;
  ativo: boolean; disponivelParaVinculo: boolean;
};

export class PrestadorUnificadoService {
  constructor(private readonly database: Database, private readonly audit: AuditRepository) {}

  async create(auth: AuthContext, input: PrestadorUnificadoCreateInput, metadata: AuditMetadata) {
    const passwordHash = await argon2.hash(input.acesso.senha);
    return withTransaction(this.database, async (client) => {
      const user = await this.createUser(client, auth, input, passwordHash);
      const providerData = this.providerData(input);
      const effectiveActive = input.acesso.ativo && input.prestador.ativo;
      const providerResult = await client.query<EntityRow>(
        `INSERT INTO admtaxi.prestadores
           (empresa_id, usuario_id, nome, cpf, telefone, email, numero_cnh, validade_cnh, disponivel, ativo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [auth.empresaId, user.id, providerData.nome, input.prestador.cpf, providerData.telefone,
          providerData.email, input.prestador.numeroCnh, input.prestador.validadeCnh,
          input.prestador.disponivel && effectiveActive, effectiveActive],
      );
      const providerId = providerResult.rows[0]?.id;
      if (!providerId) throw new Error('Falha ao criar prestador.');
      const vehicleId = await this.applyCreateVehicle(client, auth.empresaId, providerId, input.veiculo);
      await this.audit.record(client, {
        ...metadata, empresaId: auth.empresaId, usuarioId: auth.usuarioId, entidade: 'cadastro_unificado',
        entidadeId: providerId, acao: 'CRIAR_PRESTADOR_ACESSO_VEICULO',
        dadosNovos: { usuarioId: user.id, prestadorId: providerId, veiculoId: vehicleId, perfil: 'PRESTADOR' },
      });
      return this.getFrom(client, auth.empresaId, providerId);
    });
  }

  async get(auth: AuthContext, id: string) {
    return this.getFrom(this.database, auth.empresaId, id);
  }

  async update(auth: AuthContext, id: string, input: PrestadorUnificadoUpdateInput, metadata: AuditMetadata) {
    const passwordHash = input.acesso?.senha ? await argon2.hash(input.acesso.senha) : undefined;
    return withTransaction(this.database, async (client) => {
      const current = await this.getFrom(client, auth.empresaId, id, true);
      if (input.acesso) await this.updateAccess(client, auth.empresaId, current.usuarioId, input.acesso, passwordHash);
      if (input.prestador) await this.updateProvider(client, auth.empresaId, id, input.prestador);
      if (input.prestador?.ativo === false || input.acesso?.ativo === false) {
        await client.query(
          'UPDATE admtaxi.usuarios SET ativo = FALSE WHERE empresa_id = $1 AND id = $2',
          [auth.empresaId, current.usuarioId],
        );
        await client.query(
          'UPDATE admtaxi.prestadores SET ativo = FALSE, disponivel = FALSE WHERE empresa_id = $1 AND id = $2',
          [auth.empresaId, id],
        );
        await client.query(
          `UPDATE admtaxi.refresh_tokens SET revogado_em = COALESCE(revogado_em, CURRENT_TIMESTAMP)
            WHERE empresa_id = $1 AND usuario_id = $2`, [auth.empresaId, current.usuarioId],
        );
      } else if (input.prestador?.ativo === true || input.acesso?.ativo === true) {
        await client.query('UPDATE admtaxi.usuarios SET ativo = TRUE WHERE empresa_id = $1 AND id = $2', [auth.empresaId, current.usuarioId]);
        await client.query('UPDATE admtaxi.prestadores SET ativo = TRUE WHERE empresa_id = $1 AND id = $2', [auth.empresaId, id]);
      }
      if (passwordHash) {
        await client.query(
          `UPDATE admtaxi.refresh_tokens SET revogado_em = COALESCE(revogado_em, CURRENT_TIMESTAMP)
            WHERE empresa_id = $1 AND usuario_id = $2`, [auth.empresaId, current.usuarioId],
        );
      }
      if (input.veiculo && input.veiculo.acao !== 'MANTER') {
        await this.applyVehicleUpdate(client, auth.empresaId, id, input.veiculo);
      }
      const updated = await this.getFrom(client, auth.empresaId, id);
      await this.audit.record(client, {
        ...metadata, empresaId: auth.empresaId, usuarioId: auth.usuarioId, entidade: 'cadastro_unificado',
        entidadeId: id, acao: 'ATUALIZAR_PRESTADOR_ACESSO_VEICULO', dadosAnteriores: current, dadosNovos: updated,
      });
      return updated;
    });
  }

  async listVehicles(auth: AuthContext, query: VeiculoVinculoListQuery): Promise<PaginatedResult<VeiculoVinculoRecord>> {
    const values: unknown[] = [auth.empresaId];
    const conditions = ['v.empresa_id = $1', 'v.ativo = TRUE'];
    if (query.busca) {
      values.push(`%${query.busca}%`);
      conditions.push(`(v.placa ILIKE $${values.length} OR v.marca ILIKE $${values.length} OR v.modelo ILIKE $${values.length} OR v.cor ILIKE $${values.length})`);
    }
    const where = conditions.join(' AND ');
    const count = await this.database.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM admtaxi.veiculos v WHERE ${where}`, values,
    );
    const total = Number(count.rows[0]?.total ?? 0);
    values.push(query.limite, (query.pagina - 1) * query.limite);
    const result = await this.database.query<QueryResultRow>(
      `SELECT v.*, p.nome AS prestador_nome FROM admtaxi.veiculos v
         LEFT JOIN admtaxi.prestadores p ON p.empresa_id = v.empresa_id AND p.id = v.prestador_id
        WHERE ${where} ORDER BY v.placa LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return paginate(result.rows.map((row) => ({
      id: row.id as string, placa: row.placa as string, marca: row.marca as string,
      modelo: row.modelo as string, cor: row.cor as string, ano: row.ano as number,
      capacidadePassageiros: row.capacidade_passageiros as number,
      prestadorId: row.prestador_id as string | null, prestadorNome: row.prestador_nome as string | null,
      ativo: row.ativo as boolean,
      disponivelParaVinculo: row.prestador_id === null || row.prestador_id === query.prestadorId,
    })), total, query);
  }

  private async createUser(
    client: QueryExecutor, auth: AuthContext, input: PrestadorUnificadoCreateInput, passwordHash: string,
  ): Promise<EntityRow> {
    const result = await client.query<EntityRow>(
      `INSERT INTO admtaxi.usuarios (empresa_id, nome, email, telefone, senha_hash, perfil, ativo)
       VALUES ($1, $2, $3, $4, $5, 'PRESTADOR', $6) RETURNING id`,
      [auth.empresaId, input.acesso.nome, input.acesso.email, input.acesso.telefone ?? null, passwordHash,
        input.acesso.ativo && input.prestador.ativo],
    );
    const user = result.rows[0];
    if (!user) throw new Error('Falha ao criar usuario.');
    return user;
  }

  private providerData(input: PrestadorUnificadoCreateInput) {
    return input.prestador.reutilizarDadosAcesso
      ? { nome: input.acesso.nome, telefone: input.acesso.telefone ?? '', email: input.acesso.email }
      : { nome: input.prestador.nome!, telefone: input.prestador.telefone!, email: input.prestador.email ?? null };
  }

  private async applyCreateVehicle(
    client: QueryExecutor, empresaId: string, providerId: string, vehicle: PrestadorUnificadoCreateInput['veiculo'],
  ): Promise<string | null> {
    if (vehicle.modo === 'DEPOIS') return null;
    if (vehicle.modo === 'EXISTENTE') {
      await this.linkExistingVehicle(client, empresaId, providerId, vehicle.veiculoId);
      return vehicle.veiculoId;
    }
    const data = vehicle.dados;
    const result = await client.query<EntityRow>(
      `INSERT INTO admtaxi.veiculos
         (empresa_id, prestador_id, placa, marca, modelo, cor, ano, capacidade_passageiros, ativo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [empresaId, providerId, data.placa, data.marca, data.modelo, data.cor, data.ano, data.capacidadePassageiros, data.ativo],
    );
    return result.rows[0]?.id ?? null;
  }

  private async linkExistingVehicle(client: QueryExecutor, empresaId: string, providerId: string, vehicleId: string): Promise<void> {
    const vehicle = await queryOne<QueryResultRow>(client,
      'SELECT id, prestador_id FROM admtaxi.veiculos WHERE empresa_id = $1 AND id = $2 AND ativo = TRUE FOR UPDATE',
      [empresaId, vehicleId]);
    if (!vehicle) throw invalidReference('Selecione um veiculo ativo da mesma empresa.');
    if (vehicle.prestador_id && vehicle.prestador_id !== providerId) {
      throw conflict('Este veiculo ja esta vinculado a outro prestador. Realize uma transferencia explicita.');
    }
    await client.query('UPDATE admtaxi.veiculos SET prestador_id = $3 WHERE empresa_id = $1 AND id = $2',
      [empresaId, vehicleId, providerId]);
  }

  private async applyVehicleUpdate(
    client: QueryExecutor, empresaId: string, providerId: string,
    vehicle: NonNullable<PrestadorUnificadoUpdateInput['veiculo']>,
  ): Promise<void> {
    await client.query('UPDATE admtaxi.veiculos SET prestador_id = NULL WHERE empresa_id = $1 AND prestador_id = $2', [empresaId, providerId]);
    if (vehicle.acao === 'DESVINCULAR') return;
    if (vehicle.acao === 'EXISTENTE') {
      await this.linkExistingVehicle(client, empresaId, providerId, vehicle.veiculoId);
      return;
    }
    if (vehicle.acao === 'NOVO') await this.applyCreateVehicle(client, empresaId, providerId, { modo: 'NOVO', dados: vehicle.dados });
  }

  private async updateAccess(
    client: QueryExecutor, empresaId: string, userId: string,
    input: NonNullable<PrestadorUnificadoUpdateInput['acesso']>, passwordHash?: string,
  ): Promise<void> {
    const columns: Record<string, string> = { nome: 'nome', email: 'email', telefone: 'telefone', ativo: 'ativo' };
    const values: unknown[] = [empresaId, userId];
    const assignments = Object.entries(input).filter(([key, value]) => key !== 'senha' && value !== undefined).map(([key, value]) => {
      values.push(value); return `${columns[key]} = $${values.length}`;
    });
    if (passwordHash) { values.push(passwordHash); assignments.push(`senha_hash = $${values.length}`); }
    if (assignments.length) await client.query(`UPDATE admtaxi.usuarios SET ${assignments.join(', ')} WHERE empresa_id = $1 AND id = $2`, values);
  }

  private async updateProvider(
    client: QueryExecutor, empresaId: string, providerId: string,
    input: NonNullable<PrestadorUnificadoUpdateInput['prestador']>,
  ): Promise<void> {
    const columns: Record<string, string> = {
      nome: 'nome', cpf: 'cpf', telefone: 'telefone', email: 'email', numeroCnh: 'numero_cnh',
      validadeCnh: 'validade_cnh', disponivel: 'disponivel', ativo: 'ativo',
    };
    const values: unknown[] = [empresaId, providerId];
    const assignments = Object.entries(input).filter(([, value]) => value !== undefined).map(([key, value]) => {
      values.push(value); return `${columns[key]} = $${values.length}`;
    });
    if (assignments.length) await client.query(`UPDATE admtaxi.prestadores SET ${assignments.join(', ')} WHERE empresa_id = $1 AND id = $2`, values);
  }

  private async getFrom(executor: QueryExecutor, empresaId: string, id: string, lock = false) {
    const provider = await queryOne<ProviderContext>(executor,
      `SELECT p.*, u.nome AS usuario_nome, u.email::text AS usuario_email, u.telefone AS usuario_telefone,
              u.ativo AS usuario_ativo
         FROM admtaxi.prestadores p JOIN admtaxi.usuarios u
           ON u.empresa_id = p.empresa_id AND u.id = p.usuario_id
        WHERE p.empresa_id = $1 AND p.id = $2${lock ? ' FOR UPDATE OF p, u' : ''}`,
      [empresaId, id]);
    if (!provider) throw notFound('Prestador com acesso');
    const vehicles = await executor.query<QueryResultRow>(
      `SELECT id, placa, marca, modelo, cor, ano, capacidade_passageiros, ativo
         FROM admtaxi.veiculos WHERE empresa_id = $1 AND prestador_id = $2 ORDER BY ativo DESC, placa`, [empresaId, id]);
    const devices = await executor.query<QueryResultRow>(
      `SELECT id, plataforma, nome_dispositivo, ativo, ultimo_uso_em
         FROM admtaxi.dispositivos_push WHERE empresa_id = $1 AND usuario_id = $2 ORDER BY ativo DESC, ultimo_uso_em DESC`,
      [empresaId, provider.usuario_id]);
    return {
      id: provider.id,
      usuarioId: provider.usuario_id,
      acesso: { nome: provider.usuario_nome, email: provider.usuario_email, telefone: provider.usuario_telefone, perfil: 'PRESTADOR', ativo: provider.usuario_ativo },
      prestador: { nome: provider.nome, cpf: provider.cpf, telefone: provider.telefone, email: provider.email,
        numeroCnh: provider.numero_cnh, validadeCnh: provider.validade_cnh, disponivel: provider.disponivel, ativo: provider.ativo },
      veiculos: vehicles.rows.map((row) => ({ id: row.id, placa: row.placa, marca: row.marca, modelo: row.modelo,
        cor: row.cor, ano: row.ano, capacidadePassageiros: row.capacidade_passageiros, ativo: row.ativo })),
      dispositivos: devices.rows.map((row) => ({ id: row.id, plataforma: row.plataforma, nomeDispositivo: row.nome_dispositivo,
        ativo: row.ativo, ultimoUsoEm: row.ultimo_uso_em })),
    };
  }
}
