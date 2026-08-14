import type { QueryResultRow } from 'pg';

import type { Database } from '../../db/pool';
import { paginate, type PaginatedResult } from '../../shared/pagination/pagination';
import type { AuthContext, PerfilUsuario } from '../auth/auth.types';
import type { DispositivoAtualInput, DispositivoGestaoListQuery } from './dispositivo.schemas';

type DeviceRow = QueryResultRow & {
  id: string; empresa_id: string; usuario_id: string; chave_dispositivo: string; plataforma: string;
  nome_dispositivo: string; navegador: string | null; modo_acesso: string; notificacoes_status: string;
  geolocalizacao_status: string; ativo: boolean; ultimo_uso_em: Date; criado_em: Date; atualizado_em: Date;
  usuario_nome?: string; usuario_email?: string; usuario_perfil?: PerfilUsuario;
};

export type ManagedDevice = ReturnType<DispositivoService['mapManagedDevice']>;

export class DispositivoService {
  constructor(private readonly database: Database) {}

  async syncCurrent(auth: AuthContext, input: DispositivoAtualInput) {
    const result = await this.database.query<DeviceRow>(
      `INSERT INTO admtaxi.dispositivos_usuario
         (empresa_id, usuario_id, chave_dispositivo, plataforma, nome_dispositivo, navegador, modo_acesso,
          notificacoes_status, geolocalizacao_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (empresa_id, usuario_id, chave_dispositivo) DO UPDATE SET
         plataforma = EXCLUDED.plataforma, nome_dispositivo = EXCLUDED.nome_dispositivo,
         navegador = EXCLUDED.navegador, modo_acesso = EXCLUDED.modo_acesso,
         notificacoes_status = EXCLUDED.notificacoes_status,
         geolocalizacao_status = EXCLUDED.geolocalizacao_status,
         ativo = TRUE, ultimo_uso_em = CURRENT_TIMESTAMP
       RETURNING *`,
      [auth.empresaId, auth.usuarioId, input.chaveDispositivo, input.plataforma, input.nomeDispositivo,
        input.navegador ?? null, input.modoAcesso, input.notificacoesStatus, input.geolocalizacaoStatus],
    );
    return this.mapDevice(result.rows[0]!);
  }

  async deactivateCurrent(auth: AuthContext, deviceKey: string): Promise<void> {
    await this.database.query(
      `UPDATE admtaxi.dispositivos_usuario SET ativo = FALSE, ultimo_uso_em = CURRENT_TIMESTAMP
        WHERE empresa_id = $1 AND usuario_id = $2 AND chave_dispositivo = $3`,
      [auth.empresaId, auth.usuarioId, deviceKey],
    );
  }

  async listManaged(auth: AuthContext, query: DispositivoGestaoListQuery): Promise<PaginatedResult<ManagedDevice>> {
    const values: unknown[] = [auth.empresaId];
    const conditions = ['d.empresa_id = $1'];
    if (query.ativo !== undefined) {
      values.push(query.ativo);
      conditions.push(`d.ativo = $${values.length}`);
    }
    if (query.busca) {
      values.push(`%${query.busca}%`);
      conditions.push(`(u.nome ILIKE $${values.length} OR u.email::text ILIKE $${values.length}
        OR d.nome_dispositivo ILIKE $${values.length} OR COALESCE(d.navegador, '') ILIKE $${values.length})`);
    }
    const where = conditions.join(' AND ');
    const count = await this.database.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM admtaxi.dispositivos_usuario d
        JOIN admtaxi.usuarios u ON u.empresa_id = d.empresa_id AND u.id = d.usuario_id
       WHERE ${where}`,
      [...values],
    );
    const total = Number(count.rows[0]?.total ?? 0);
    values.push(query.limite, (query.pagina - 1) * query.limite);
    const result = await this.database.query<DeviceRow>(
      `SELECT d.*, u.nome AS usuario_nome, u.email::text AS usuario_email, u.perfil::text AS usuario_perfil
         FROM admtaxi.dispositivos_usuario d
         JOIN admtaxi.usuarios u ON u.empresa_id = d.empresa_id AND u.id = d.usuario_id
        WHERE ${where}
        ORDER BY d.ativo DESC, d.ultimo_uso_em DESC, u.nome ASC
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return paginate(result.rows.map((row) => this.mapManagedDevice(row)), total, query);
  }

  private mapDevice(row: DeviceRow) {
    return {
      id: row.id, empresaId: row.empresa_id, usuarioId: row.usuario_id,
      chaveDispositivo: row.chave_dispositivo, plataforma: row.plataforma,
      nomeDispositivo: row.nome_dispositivo, navegador: row.navegador, modoAcesso: row.modo_acesso,
      notificacoesStatus: row.notificacoes_status, geolocalizacaoStatus: row.geolocalizacao_status,
      ativo: row.ativo, ultimoUsoEm: row.ultimo_uso_em, criadoEm: row.criado_em, atualizadoEm: row.atualizado_em,
    };
  }

  private mapManagedDevice(row: DeviceRow) {
    return {
      ...this.mapDevice(row),
      usuario: { nome: row.usuario_nome!, email: row.usuario_email!, perfil: row.usuario_perfil! },
    };
  }
}
