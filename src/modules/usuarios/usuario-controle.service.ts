import type { QueryResultRow } from 'pg';
import type { Database } from '../../db/pool';
import { paginate } from '../../shared/pagination/pagination';
import type { AuthContext } from '../auth/auth.types';
import type { UsuarioControleQuery } from './usuario.schemas';

export class UsuarioControleService {
  constructor(private readonly database: Database) {}

  async list(auth: AuthContext, query: UsuarioControleQuery) {
    const values: unknown[] = [auth.empresaId];
    const conditions = ['TRUE'];
    const filter = (sql: string, value: unknown) => {
      values.push(value);
      conditions.push(sql.replace('?', `$${values.length}`));
    };
    if (query.ativo !== undefined) filter('ativo = ?', query.ativo);
    if (query.perfil) filter('perfil = ?', query.perfil);
    if (query.busca) {
      values.push(`%${query.busca}%`);
      conditions.push(`(nome ILIKE $${values.length} OR email ILIKE $${values.length})`);
    }
    if (query.atividade) filter('"atividadeRecente" = ?', query.atividade === 'RECENTE');
    values.push(query.limite, (query.pagina - 1) * query.limite);
    // One snapshot avoids mismatched counters and rows while device heartbeats arrive.
    const result = await this.database.query<QueryResultRow>(
      `WITH base AS (
         SELECT u.id,u.nome,u.email::text,u.perfil::text,u.ativo,u.ultimo_acesso_em AS "ultimoAcessoEm",
           COALESCE(rt.quantidade,0)::int AS "sessoesValidas",
           COALESCE(d.quantidade,0)::int AS dispositivos,
           d.ultimo_uso AS "ultimaAtividadeEm",
           (u.ativo AND COALESCE(rt.quantidade,0)>0 AND COALESCE(d.recente,FALSE)) AS "atividadeRecente"
         FROM admtaxi.usuarios u
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS quantidade FROM admtaxi.refresh_tokens r
           WHERE (r.empresa_id=u.empresa_id AND r.usuario_id=u.id OR r.usuario_id IN
             (SELECT sibling.id FROM admtaxi.usuarios sibling WHERE sibling.conta_motorista_id=u.conta_motorista_id))
             AND r.revogado_em IS NULL AND r.expira_em>CURRENT_TIMESTAMP
         ) rt ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS quantidade,MAX(ultimo_uso_em) AS ultimo_uso,
             BOOL_OR(ativo AND ultimo_uso_em>=CURRENT_TIMESTAMP-INTERVAL '5 minutes') AS recente
           FROM admtaxi.dispositivos_usuario WHERE empresa_id=u.empresa_id AND usuario_id=u.id
         ) d ON TRUE
         WHERE u.empresa_id=$1
       ), filtrados AS (SELECT * FROM base WHERE ${conditions.join(' AND ')}),
       pagina AS (SELECT * FROM filtrados ORDER BY "atividadeRecente" DESC,nome,id
         LIMIT $${values.length - 1} OFFSET $${values.length})
       SELECT COALESCE((SELECT json_agg(pagina) FROM pagina),'[]'::json) AS data,
         (SELECT COUNT(*)::int FROM filtrados) AS total,
         json_build_object('total',COUNT(*)::int,'habilitados',COUNT(*) FILTER (WHERE ativo)::int,
           'bloqueados',COUNT(*) FILTER (WHERE NOT ativo)::int,
           'atividadeRecente',COUNT(*) FILTER (WHERE "atividadeRecente")::int,
           'comSessao',COUNT(*) FILTER (WHERE ativo AND "sessoesValidas">0)::int) AS resumo,
         CURRENT_TIMESTAMP AS "consultadoEm" FROM base`,
      values,
    );
    const row = result.rows[0]!;
    return { ...paginate(row.data as Record<string, unknown>[], Number(row.total), query),
      resumo: row.resumo, consultadoEm: row.consultadoEm, janelaAtividadeMinutos: 5 };
  }
}
