import type { Database } from '../../db/pool';
import type { AuthContext } from '../auth/auth.types';
import type { FuncionarioLookupQuery } from './operacao.schemas';

export type CentroCustoLookup = { id: string; codigo: string; nome: string };
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
export type SolicitanteLookup = { id: string; nome: string; perfil: 'GERENTE' | 'GESTOR' };

export class OperacaoRepository {
  constructor(private readonly database: Database) {}

  async listCenters(auth: AuthContext): Promise<CentroCustoLookup[]> {
    const managerFilter = auth.perfil === 'GERENTE'
      ? `AND EXISTS (
           SELECT 1 FROM admtaxi.gerente_centros_custo gcc
            WHERE gcc.empresa_id = c.empresa_id AND gcc.centro_custo_id = c.id
              AND gcc.gerente_usuario_id = $2
         )`
      : '';
    const values = auth.perfil === 'GERENTE' ? [auth.empresaId, auth.usuarioId] : [auth.empresaId];
    const result = await this.database.query<{
      id: string; codigo: string; nome: string;
    }>(
      `SELECT c.id, c.codigo, c.nome
         FROM admtaxi.centros_custo c
        WHERE c.empresa_id = $1 AND c.ativo = TRUE ${managerFilter}
        ORDER BY c.codigo, c.nome`,
      values,
    );
    return result.rows;
  }

  async listEmployees(auth: AuthContext, query: FuncionarioLookupQuery): Promise<FuncionarioLookup[]> {
    const values: unknown[] = [auth.empresaId];
    const conditions = ['f.empresa_id = $1', 'f.ativo = TRUE', 'c.ativo = TRUE'];
    if (auth.perfil === 'GERENTE') {
      values.push(auth.usuarioId);
      conditions.push(`EXISTS (
        SELECT 1 FROM admtaxi.gerente_centros_custo gcc
         WHERE gcc.empresa_id = f.empresa_id AND gcc.centro_custo_id = f.centro_custo_id
           AND gcc.gerente_usuario_id = $${values.length}
      )`);
    }
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
    const result = await this.database.query<PrestadorLookup>(
      `SELECT id, nome FROM admtaxi.prestadores
        WHERE empresa_id = $1 AND ativo = TRUE ORDER BY nome, id`,
      [auth.empresaId],
    );
    return result.rows;
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
}
