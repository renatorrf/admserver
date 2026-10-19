import type { Database } from '../../db/pool';
import type { AuthContext } from '../auth/auth.types';
import type { EnderecoSugestao } from '../enderecos/endereco.service';
import { paginate, type PaginatedResult } from '../../shared/pagination/pagination';
import type { FuncionarioLookupQuery, FuncionarioSearchQuery, PrestadorSearchQuery } from './operacao.schemas';
import {
  addCenterScope, OperationalScopeService, type OperationalScope, type OperationalScopeResolver,
} from '../escopo/operational-scope.service';

export type SetorLookup = { id: string; codigo: string; nome: string };
export type CentroCustoLookup = { id: string; setorId: string; codigo: string; nome: string };
export type FuncionarioLookup = {
  id: string;
  centroCustoId: string;
  nome: string;
  matricula: string;
  telefone: string | null;
  enderecoPadrao: string | null;
  latitudePadrao: number | null;
  longitudePadrao: number | null;
};
export type MeuPrestador = { id: string; nome: string; disponivel: boolean; ativo: boolean };
export type VeiculoLookup = {
  id: string;
  placa: string;
  marca: string;
  modelo: string;
  cor: string;
  capacidadePassageiros: number;
};
export type PrestadorLookup = { id: string; nome: string };
export type PrestadorSearchResult = PrestadorLookup & {
  cpf: string; telefone: string; numeroCnh: string; disponivel: boolean; ativo: boolean;
};
export type SolicitanteLookup = { id: string; nome: string; perfil: 'GERENTE' | 'GESTOR' };
export type OperationalScopeSummary = {
  perfil: 'GERENTE' | 'GESTOR'; setores: SetorLookup[]; centrosCusto: CentroCustoLookup[];
  funcionariosVisiveis: number;
};

export class OperacaoRepository {
  private readonly scopeResolver: OperationalScopeResolver;

  constructor(private readonly database: Database, scopeResolver?: OperationalScopeResolver) {
    this.scopeResolver = scopeResolver ?? new OperationalScopeService(database);
  }

  async getMapLocation(auth: AuthContext) {
    const result = await this.database.query<{
      latitude_padrao: string | null; longitude_padrao: string | null;
      endereco: string | null; endereco_latitude: string | null; endereco_longitude: string | null;
    }>(
      `SELECT latitude_padrao, longitude_padrao, endereco, endereco_latitude, endereco_longitude
         FROM admtaxi.empresas WHERE id = $1 AND ativo = TRUE`,
      [auth.empresaId],
    );
    const row = result.rows[0];
    const addressLatitude = row?.endereco_latitude == null ? NaN : Number(row.endereco_latitude);
    const addressLongitude = row?.endereco_longitude == null ? NaN : Number(row.endereco_longitude);
    const hasAddress = Boolean(row?.endereco?.trim())
      && Number.isFinite(addressLatitude) && Math.abs(addressLatitude) <= 90
      && Number.isFinite(addressLongitude) && Math.abs(addressLongitude) <= 180;
    return {
      latitudePadrao: hasAddress ? addressLatitude : row?.latitude_padrao == null ? null : Number(row.latitude_padrao),
      longitudePadrao: hasAddress ? addressLongitude : row?.longitude_padrao == null ? null : Number(row.longitude_padrao),
    };
  }

  async getCompanyAddress(auth: AuthContext): Promise<EnderecoSugestao | null> {
    const result = await this.database.query<{ id: string; endereco: string | null; endereco_latitude: string | null; endereco_longitude: string | null }>(
      'SELECT id, endereco, endereco_latitude, endereco_longitude FROM admtaxi.empresas WHERE id=$1 AND ativo=TRUE', [auth.empresaId]);
    const row = result.rows[0];
    if (!row?.endereco || row.endereco_latitude == null || row.endereco_longitude == null) return null;
    return { id: `empresa:${row.id}`, descricao: row.endereco, latitude: Number(row.endereco_latitude), longitude: Number(row.endereco_longitude),
      logradouro: null, numero: null, bairro: null, cidade: null, estado: null };
  }

  async recentEmployeeDestinations(auth: AuthContext, employeeId: string): Promise<EnderecoSugestao[]> {
    const scope = await this.scopeResolver.resolve(auth);
    const values: unknown[] = [auth.empresaId, employeeId];
    const conditions = ['f.empresa_id = $1', 'f.id = $2', 'f.ativo = TRUE', 'cc.ativo = TRUE', 's.ativo = TRUE'];
    addCenterScope(conditions, values, scope, 'f.centro_custo_id');
    const historyScope = scope.kind === 'GERENTE' ? `AND cp.centro_custo_id = ANY($3::uuid[])` : '';
    const legacyScope = scope.kind === 'GERENTE' ? `AND c.centro_custo_id = ANY($3::uuid[])` : '';
    // The individual drop-off is authoritative; legacy trips have only a shared destination.
    const result = await this.database.query<{ descricao: string; latitude: string; longitude: string }>(`
      WITH funcionario AS (
        SELECT f.id FROM admtaxi.funcionarios f
        JOIN admtaxi.centros_custo cc ON cc.empresa_id=f.empresa_id AND cc.id=f.centro_custo_id
        JOIN admtaxi.setores s ON s.empresa_id=cc.empresa_id AND s.id=cc.setor_id
        WHERE ${conditions.join(' AND ')}
      ), destinos AS (
        SELECT p.descricao, p.latitude, p.longitude, c.criado_em
        FROM admtaxi.corrida_participacoes cp
        JOIN funcionario f ON f.id=cp.funcionario_id
        JOIN admtaxi.corridas c ON c.empresa_id=cp.empresa_id AND c.id=cp.corrida_id
        JOIN admtaxi.corrida_paradas p ON p.empresa_id=cp.empresa_id AND p.corrida_id=cp.corrida_id AND p.id=cp.desembarque_id
        WHERE cp.empresa_id=$1 AND cp.estado NOT IN ('AUSENTE','CANCELADO')
          AND c.status NOT IN ('CANCELADA','RECUSADA') ${historyScope}
        UNION ALL
        SELECT c.destino_descricao, c.destino_latitude, c.destino_longitude, c.criado_em
        FROM admtaxi.corridas c
        JOIN funcionario f ON (c.funcionario_id=f.id OR EXISTS (
          SELECT 1 FROM admtaxi.corrida_paradas p WHERE p.empresa_id=c.empresa_id AND p.corrida_id=c.id AND p.funcionario_id=f.id))
        WHERE c.empresa_id=$1 AND c.status NOT IN ('CANCELADA','RECUSADA') ${legacyScope}
          AND NOT EXISTS (SELECT 1 FROM admtaxi.corrida_participacoes cp WHERE cp.empresa_id=c.empresa_id AND cp.corrida_id=c.id)
      ), unicos AS (
        SELECT DISTINCT ON (lower(btrim(descricao)), latitude, longitude) descricao, latitude, longitude, criado_em
        FROM destinos WHERE char_length(btrim(descricao)) >= 3 AND latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180
        ORDER BY lower(btrim(descricao)), latitude, longitude, criado_em DESC
      ) SELECT descricao, latitude::text, longitude::text FROM unicos ORDER BY criado_em DESC, descricao, latitude, longitude LIMIT 5
    `, values);
    return result.rows.map(row => ({
      id: `recente:${row.latitude}:${row.longitude}:${row.descricao}`, descricao: row.descricao,
      latitude: Number(row.latitude), longitude: Number(row.longitude), logradouro: null, numero: null, bairro: null, cidade: null, estado: null,
    }));
  }

  async listSectors(auth: AuthContext): Promise<SetorLookup[]> {
    const scope = await this.scopeResolver.resolve(auth);
    const values: unknown[] = [auth.empresaId];
    const conditions = ['s.empresa_id = $1', 's.ativo = TRUE'];
    if (scope.kind === 'GERENTE') {
      values.push(scope.setorIds);
      conditions.push(`s.id = ANY($${values.length}::uuid[])`);
    }
    const result = await this.database.query<SetorLookup>(
      `SELECT s.id, s.codigo, s.nome FROM admtaxi.setores s
        WHERE ${conditions.join(' AND ')} ORDER BY s.codigo, s.nome`, values,
    );
    return result.rows;
  }

  async listCenters(auth: AuthContext): Promise<CentroCustoLookup[]> {
    const scope = await this.scopeResolver.resolve(auth);
    const values: unknown[] = [auth.empresaId];
    const conditions = ['c.empresa_id = $1', 'c.ativo = TRUE', 's.ativo = TRUE'];
    addCenterScope(conditions, values, scope, 'c.id');
    const result = await this.database.query<{
      id: string; setorId: string; codigo: string; nome: string;
    }>(
      `SELECT c.id, c.setor_id AS "setorId", c.codigo, c.nome
         FROM admtaxi.centros_custo c
         JOIN admtaxi.setores s ON s.empresa_id = c.empresa_id AND s.id = c.setor_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY c.codigo, c.nome`,
      values,
    );
    return result.rows;
  }

  async listEmployees(auth: AuthContext, query: FuncionarioLookupQuery): Promise<FuncionarioLookup[]> {
    const scope = await this.scopeResolver.resolve(auth);
    const values: unknown[] = [auth.empresaId];
    const conditions = ['f.empresa_id = $1', 'f.ativo = TRUE', 'c.ativo = TRUE', 's.ativo = TRUE'];
    addCenterScope(conditions, values, scope, 'f.centro_custo_id');
    if (query.centroCustoId) {
      values.push(query.centroCustoId);
      conditions.push(`f.centro_custo_id = $${values.length}`);
    }
    const result = await this.database.query<{
      id: string;
      centro_custo_id: string;
      nome: string;
      matricula: string;
      telefone: string | null;
      endereco_padrao: string | null;
      latitude_padrao: string | null;
      longitude_padrao: string | null;
    }>(
      `SELECT f.id, f.centro_custo_id, f.nome, f.matricula, f.telefone, f.endereco_padrao,
              f.latitude_padrao::text, f.longitude_padrao::text
         FROM admtaxi.funcionarios f
         JOIN admtaxi.centros_custo c
           ON c.empresa_id = f.empresa_id AND c.id = f.centro_custo_id
         JOIN admtaxi.setores s ON s.empresa_id = c.empresa_id AND s.id = c.setor_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY f.nome, f.id`,
      values,
    );
    return result.rows.map((row) => ({
      id: row.id,
      centroCustoId: row.centro_custo_id,
      nome: row.nome,
      matricula: row.matricula,
      telefone: row.telefone,
      enderecoPadrao: row.endereco_padrao,
      latitudePadrao: row.latitude_padrao === null ? null : Number(row.latitude_padrao),
      longitudePadrao: row.longitude_padrao === null ? null : Number(row.longitude_padrao),
    }));
  }

  async getMyProvider(auth: AuthContext): Promise<MeuPrestador | null> {
    const result = await this.database.query<MeuPrestador>(
      `SELECT id, nome, disponivel, ativo
         FROM admtaxi.prestadores
        WHERE empresa_id = $1 AND usuario_id = $2`,
      [auth.empresaId, auth.usuarioId],
    );
    return result.rows[0] ?? null;
  }

  async searchEmployees(auth: AuthContext, query: FuncionarioSearchQuery): Promise<PaginatedResult<FuncionarioLookup & { cpf: string | null; ativo: boolean }>> {
    const scope = await this.scopeResolver.resolve(auth);
    const values: unknown[] = [auth.empresaId];
    const conditions = ['f.empresa_id = $1', 'c.ativo = TRUE', 's.ativo = TRUE'];
    if (query.ativo !== undefined) {
      values.push(query.ativo);
      conditions.push(`f.ativo = $${values.length}`);
    }
    addCenterScope(conditions, values, scope, 'f.centro_custo_id');
    if (query.centroCustoId) {
      values.push(query.centroCustoId);
      conditions.push(`f.centro_custo_id = $${values.length}`);
    }
    if (query.busca) {
      values.push(`%${query.busca}%`);
      conditions.push(`(f.nome ILIKE $${values.length} OR f.matricula ILIKE $${values.length}
        OR COALESCE(f.cpf, '') ILIKE $${values.length} OR COALESCE(f.telefone, '') ILIKE $${values.length})`);
    }
    const where = conditions.join(' AND ');
    const count = await this.database.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM admtaxi.funcionarios f
       JOIN admtaxi.centros_custo c ON c.empresa_id=f.empresa_id AND c.id=f.centro_custo_id
       JOIN admtaxi.setores s ON s.empresa_id=c.empresa_id AND s.id=c.setor_id
       WHERE ${where}`, values,
    );
    const total = Number(count.rows[0]?.total ?? 0);
    values.push(query.limite, (query.pagina - 1) * query.limite);
    const result = await this.database.query<{
      id: string; centro_custo_id: string; nome: string; matricula: string; cpf: string | null;
      telefone: string | null; endereco_padrao: string | null; latitude_padrao: string | null;
      longitude_padrao: string | null; ativo: boolean;
    }>(
      `SELECT f.id, f.centro_custo_id, f.nome, f.matricula, f.cpf, f.telefone, f.endereco_padrao,
              f.latitude_padrao::text, f.longitude_padrao::text, f.ativo
         FROM admtaxi.funcionarios f
         JOIN admtaxi.centros_custo c ON c.empresa_id=f.empresa_id AND c.id=f.centro_custo_id
         JOIN admtaxi.setores s ON s.empresa_id=c.empresa_id AND s.id=c.setor_id
        WHERE ${where}
        ORDER BY f.ativo DESC, f.nome, f.id LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return paginate(result.rows.map((row) => ({
      id: row.id, centroCustoId: row.centro_custo_id, nome: row.nome, matricula: row.matricula,
      cpf: row.cpf, telefone: row.telefone, enderecoPadrao: row.endereco_padrao, ativo: row.ativo,
      latitudePadrao: row.latitude_padrao === null ? null : Number(row.latitude_padrao),
      longitudePadrao: row.longitude_padrao === null ? null : Number(row.longitude_padrao),
    })), total, query);
  }

  async listMyVehicles(auth: AuthContext): Promise<VeiculoLookup[]> {
    const result = await this.database.query<VeiculoLookup>(
      `SELECT v.id, v.placa, v.marca, v.modelo, v.cor,
              v.capacidade_passageiros AS "capacidadePassageiros"
         FROM admtaxi.veiculos v
         JOIN admtaxi.prestadores p
           ON p.empresa_id = v.empresa_id AND p.id = v.prestador_id
        WHERE v.empresa_id = $1 AND p.usuario_id = $2
          AND v.ativo = TRUE AND p.ativo = TRUE
        ORDER BY v.placa`,
      [auth.empresaId, auth.usuarioId],
    );
    return result.rows;
  }

  async listProviders(auth: AuthContext): Promise<PrestadorLookup[]> {
    const scope = await this.scopeResolver.resolve(auth);
    const values: unknown[] = [auth.empresaId];
    const conditions = ['p.empresa_id = $1', 'p.ativo = TRUE'];
    if (scope.kind === 'GERENTE') {
      values.push(scope.centroCustoIds);
      conditions.push(`EXISTS (SELECT 1 FROM admtaxi.corridas c
        WHERE c.empresa_id=p.empresa_id AND c.prestador_id=p.id
          AND c.centro_custo_id=ANY($${values.length}::uuid[]))`);
    }
    const result = await this.database.query<PrestadorLookup>(
      `SELECT p.id, p.nome FROM admtaxi.prestadores p
        WHERE ${conditions.join(' AND ')} ORDER BY p.nome, p.id`,
      values,
    );
    return result.rows;
  }

  async searchProviders(_auth: AuthContext, query: PrestadorSearchQuery): Promise<PaginatedResult<PrestadorSearchResult>> {
    const values: unknown[] = [_auth.empresaId];
    const conditions = ['p.empresa_id = $1'];
    if (query.ativo !== undefined) {
      values.push(query.ativo);
      conditions.push(`p.ativo = $${values.length}`);
    }
    if (query.disponivel !== undefined) {
      values.push(query.disponivel);
      conditions.push(`p.disponivel = $${values.length}`);
    }
    if (query.busca) {
      values.push(`%${query.busca}%`);
      conditions.push(`(p.nome ILIKE $${values.length} OR p.cpf ILIKE $${values.length}
        OR p.telefone ILIKE $${values.length} OR p.numero_cnh ILIKE $${values.length}
        OR EXISTS (SELECT 1 FROM admtaxi.veiculos v WHERE v.empresa_id = p.empresa_id
          AND v.prestador_id = p.id AND v.placa ILIKE $${values.length}))`);
    }
    const where = conditions.join(' AND ');
    const count = await this.database.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM admtaxi.prestadores p WHERE ${where}`, values,
    );
    const total = Number(count.rows[0]?.total ?? 0);
    values.push(query.limite, (query.pagina - 1) * query.limite);
    const result = await this.database.query<{
      id: string; nome: string; cpf: string; telefone: string; numero_cnh: string; disponivel: boolean; ativo: boolean;
    }>(
      `SELECT p.id, p.nome, p.cpf, p.telefone, p.numero_cnh, p.disponivel, p.ativo
         FROM admtaxi.prestadores p WHERE ${where}
        ORDER BY p.ativo DESC, p.disponivel DESC, p.nome, p.id
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return paginate(result.rows.map((row) => ({
      id: row.id, nome: row.nome, cpf: row.cpf, telefone: row.telefone,
      numeroCnh: row.numero_cnh, disponivel: row.disponivel, ativo: row.ativo,
    })), total, query);
  }

  async listRequesters(auth: AuthContext): Promise<SolicitanteLookup[]> {
    const values = auth.perfil === 'GERENTE' ? [auth.empresaId, auth.usuarioId] : [auth.empresaId];
    const userFilter = auth.perfil === 'GERENTE' ? 'AND id = $2' : '';
    const result = await this.database.query<SolicitanteLookup>(
      `SELECT id, nome, perfil::text FROM admtaxi.usuarios
        WHERE empresa_id = $1 AND ativo = TRUE AND perfil IN ('GERENTE','GESTOR') ${userFilter}
        ORDER BY nome, id`,
      values,
    );
    return result.rows;
  }

  async getScopeSummary(auth: AuthContext): Promise<OperationalScopeSummary> {
    const scope = await this.scopeResolver.resolve(auth);
    const [setores, centrosCusto] = await Promise.all([this.listSectorsFromScope(scope), this.listCentersFromScope(scope)]);
    const values: unknown[] = [auth.empresaId];
    const conditions = ['f.empresa_id = $1', 'f.ativo = TRUE', 'c.ativo = TRUE', 's.ativo = TRUE'];
    addCenterScope(conditions, values, scope, 'f.centro_custo_id');
    const count = await this.database.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM admtaxi.funcionarios f
       JOIN admtaxi.centros_custo c ON c.empresa_id=f.empresa_id AND c.id=f.centro_custo_id
       JOIN admtaxi.setores s ON s.empresa_id=c.empresa_id AND s.id=c.setor_id
       WHERE ${conditions.join(' AND ')}`, values,
    );
    return {
      perfil: scope.kind, setores, centrosCusto,
      funcionariosVisiveis: Number(count.rows[0]?.total ?? 0),
    };
  }

  private async listSectorsFromScope(scope: OperationalScope): Promise<SetorLookup[]> {
    const values: unknown[] = [scope.empresaId];
    const conditions = ['empresa_id = $1', 'ativo = TRUE'];
    if (scope.kind === 'GERENTE') {
      values.push(scope.setorIds);
      conditions.push(`id = ANY($${values.length}::uuid[])`);
    }
    const result = await this.database.query<SetorLookup>(
      `SELECT id,codigo,nome FROM admtaxi.setores WHERE ${conditions.join(' AND ')} ORDER BY codigo,nome`, values,
    );
    return result.rows;
  }

  private async listCentersFromScope(scope: OperationalScope): Promise<CentroCustoLookup[]> {
    const values: unknown[] = [scope.empresaId];
    const conditions = ['c.empresa_id=$1', 'c.ativo=TRUE', 's.ativo=TRUE'];
    addCenterScope(conditions, values, scope, 'c.id');
    const result = await this.database.query<CentroCustoLookup>(
      `SELECT c.id,c.setor_id AS "setorId",c.codigo,c.nome FROM admtaxi.centros_custo c
       JOIN admtaxi.setores s ON s.empresa_id=c.empresa_id AND s.id=c.setor_id
       WHERE ${conditions.join(' AND ')} ORDER BY c.codigo,c.nome`, values,
    );
    return result.rows;
  }
}
