import { withTransaction, type Database, type QueryExecutor } from '../../db/pool';
import { conflict, forbidden, invalidReference, notFound } from '../../shared/errors/app-error';
import type { AuthContext } from '../auth/auth.types';
import type { AuditMetadata } from '../auditoria/audit.types';
import type { CorridaAuditWriter, CorridaService } from '../corridas/corrida.service';
import { commandHash } from '../corridas/itinerary.repository';
import { centerAllowed, OperationalScopeService } from '../escopo/operational-scope.service';
import { conferenceData, requisicaoSchema, toRideInput, type RequisitionInput, type RequisitionRow } from './requisicao.schemas';
import type { TravelEmails } from './travel-emails';
import { resolveGuests } from './guest-passengers';

export class RequisitionService {
  constructor(private readonly database: Database, private readonly audit: CorridaAuditWriter,
    private readonly rides: CorridaService, private readonly emails: TravelEmails) {}
  async list(auth: AuthContext, offset = 0): Promise<RequisitionRow[]> {
    this.authorize(auth);
    const result = await this.database.query<RequisitionRow>(`SELECT r.*,u.nome AS solicitante,
      (SELECT json_agg(json_build_object('id',f.id,'nome',f.nome)) FROM admtaxi.funcionarios f WHERE f.empresa_id=r.empresa_id
        AND f.id::text IN (SELECT p->>'funcionarioId' FROM jsonb_array_elements(r.dados->'participantes') p)) AS funcionarios
      FROM admtaxi.requisicoes_viagem r
      JOIN admtaxi.usuarios u ON u.empresa_id=r.empresa_id AND u.id=r.solicitante_id
      WHERE r.empresa_id=$1 AND ($2::uuid IS NULL OR r.solicitante_id=$2)
      ORDER BY r.criada_em DESC,r.id LIMIT 50 OFFSET $3`, [auth.empresaId,auth.perfil==='GERENTE' ? auth.usuarioId : null,offset]);
    return result.rows;
  }
  async get(auth: AuthContext, id: string, client: QueryExecutor = this.database, lock = false): Promise<RequisitionRow> {
    this.authorize(auth);
    const result = await client.query<RequisitionRow>(`SELECT r.*,
      (SELECT json_agg(json_build_object('id',f.id,'nome',f.nome)) FROM admtaxi.funcionarios f WHERE f.empresa_id=r.empresa_id
        AND f.id::text IN (SELECT p->>'funcionarioId' FROM jsonb_array_elements(r.dados->'participantes') p)) AS funcionarios
      FROM admtaxi.requisicoes_viagem r
      WHERE empresa_id=$1 AND id=$2 AND ($3::uuid IS NULL OR solicitante_id=$3) ${lock ? 'FOR UPDATE' : ''}`,
    [auth.empresaId,id,auth.perfil==='GERENTE' ? auth.usuarioId : null]);
    if (!result.rows[0]) throw notFound('Requisicao');
    return result.rows[0];
  }
  async create(auth: AuthContext, input: RequisitionInput, metadata: AuditMetadata): Promise<RequisitionRow> {
    if (!['GESTOR','GERENTE'].includes(auth.perfil)) throw forbidden('Somente gestor ou supervisor cria requisicoes.');
    const result = await withTransaction(this.database,async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',[auth.empresaId,`${auth.usuarioId}:${input.chave}`]);
      const previous = await client.query<RequisitionRow>('SELECT * FROM admtaxi.requisicoes_viagem WHERE empresa_id=$1 AND solicitante_id=$2 AND chave=$3', [auth.empresaId,auth.usuarioId,input.chave]);
      if (previous.rows[0]) {
        if (previous.rows[0].conteudo_hash!==commandHash(input)) throw conflict('Esta requisicao ja foi enviada com outros dados.');
        return previous.rows[0];
      }
      await this.validate(client,auth,input);
      const result = await client.query<RequisitionRow>(`INSERT INTO admtaxi.requisicoes_viagem
        (empresa_id,solicitante_id,chave,conteudo_hash,dados,status,decisor_id,decidida_em)
        VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $7::uuid IS NOT NULL THEN CURRENT_TIMESTAMP ELSE NULL END) RETURNING *`,
      [auth.empresaId,auth.usuarioId,input.chave,commandHash(input),JSON.stringify(input),auth.perfil==='GESTOR' ? 'AUTORIZADA' : 'PENDENTE',auth.perfil==='GESTOR' ? auth.usuarioId : null]);
      const row = result.rows[0]!;
      await this.record(client,auth,row,'CRIAR',metadata);
      await this.emails.enqueue(client,row,row.status); return row;
    });
    this.emails.kick(); return result;
  }
  async decide(auth: AuthContext,id: string,decision: { autorizar: boolean; motivo?: string },metadata: AuditMetadata): Promise<RequisitionRow> {
    if (auth.perfil!=='GESTOR') throw forbidden('Somente o gestor autoriza viagens.');
    const result = await withTransaction(this.database,async client => {
      const row = await this.get(auth,id,client,true);
      const status = decision.autorizar ? 'AUTORIZADA' : 'REJEITADA';
      if (row.status===status) return row;
      if (row.status!=='PENDENTE') throw conflict('Esta requisicao ja foi decidida.');
      const updated = await client.query<RequisitionRow>(`UPDATE admtaxi.requisicoes_viagem SET status=$3,decisor_id=$4,motivo=$5,
        decidida_em=CURRENT_TIMESTAMP,atualizada_em=CURRENT_TIMESTAMP WHERE empresa_id=$1 AND id=$2 RETURNING *`,
      [auth.empresaId,id,status,auth.usuarioId,decision.motivo || null]);
      await this.record(client,auth,updated.rows[0]!,status,metadata);
      await this.emails.enqueue(client,updated.rows[0]!,status); return updated.rows[0]!;
    });
    this.emails.kick(); return result;
  }
  async dispatch(auth: AuthContext,id: string,participants: RequisitionInput['participantes'],metadata: AuditMetadata) {
    if (auth.perfil!=='PORTARIA') throw forbidden('Somente a portaria pode solicitar a corrida apos conferencia.');
    // The hook runs inside the ride transaction and locks the request through creation and linking.
    return this.rides.createConferred(auth,metadata,async client => {
      const row = await this.get(auth,id,client,true);
      if (row.corrida_id) return { existingId: row.corrida_id };
      if (row.status!=='AUTORIZADA') throw conflict('A viagem precisa estar autorizada pelo gestor.');
      const data = conferenceData(requisicaoSchema.parse(row.dados),participants);
      const { centers, monthly } = await this.validate(client,auth,data,true);
      const resolved = await resolveGuests(client,auth.empresaId,data.participantes);
      return { input: toRideInput(data,centers,monthly,resolved), complete: async (corridaId: string) => {
        const updated = await client.query<RequisitionRow>(`UPDATE admtaxi.requisicoes_viagem SET status='SOLICITADA',dados=$3,
          corrida_id=$4,conferente_id=$5,atualizada_em=CURRENT_TIMESTAMP WHERE empresa_id=$1 AND id=$2 RETURNING *`,
        [auth.empresaId,id,JSON.stringify(data),corridaId,auth.usuarioId]);
        await this.record(client,auth,updated.rows[0]!,'SOLICITAR',metadata);
        await this.emails.enqueue(client,updated.rows[0]!,'SOLICITADA');
      } };
    });
  }
  private async validate(client: QueryExecutor,auth: AuthContext,input: RequisitionInput,complete = false) {
    if (input.tipo==='AGENDADA' && new Date(input.agendadaPara!).getTime()<=Date.now()) throw invalidReference('Informe um horario futuro para a viagem agendada.');
    const scope = await new OperationalScopeService(this.database).resolve(auth,client);
    const company = await client.query<{ modo_cobranca: string }>('SELECT modo_cobranca FROM admtaxi.empresas WHERE id=$1 AND ativo FOR SHARE',[auth.empresaId]);
    if (!company.rows[0]) throw forbidden('Empresa inativa.');
    const monthly = company.rows[0].modo_cobranca==='MENSAL_FIXO';
    const employees = await client.query<{ id: string; centro_custo_id: string }>(`SELECT f.id,f.centro_custo_id FROM admtaxi.funcionarios f
      JOIN admtaxi.centros_custo c ON c.empresa_id=f.empresa_id AND c.id=f.centro_custo_id AND c.ativo
      JOIN admtaxi.setores s ON s.empresa_id=c.empresa_id AND s.id=c.setor_id AND s.ativo
      WHERE f.empresa_id=$1 AND f.id=ANY($2::uuid[]) AND f.ativo AND NOT f.avulso FOR SHARE OF f,c,s`, [auth.empresaId,input.participantes.flatMap(p => p.funcionarioId ? [p.funcionarioId] : [])]);
    if (employees.rows.length!==input.participantes.filter(p=>p.funcionarioId).length || employees.rows.some(p => !centerAllowed(scope,p.centro_custo_id)))
      throw invalidReference('Revise os funcionarios e centros de custo ativos dentro do seu escopo.');
    const centers = new Map(employees.rows.map(p => [p.id,p.centro_custo_id]));
    for (const person of input.participantes) {
      if (!person.avulso) continue;
      const id=person.avulso.centroCustoId;
      if (!centerAllowed(scope,id)) throw forbidden('Centro de custo do avulso fora do seu escopo.');
      const found=await client.query(`SELECT c.id FROM admtaxi.centros_custo c JOIN admtaxi.setores s ON s.empresa_id=c.empresa_id AND s.id=c.setor_id
        WHERE c.empresa_id=$1 AND c.id=$2 AND c.ativo AND s.ativo FOR SHARE OF c,s`,[auth.empresaId,id]);
      if (!found.rowCount) throw invalidReference('Selecione um centro de custo com setor ativo para o avulso.');
      centers.set(person.avulso.id,id);
    }
    if (monthly && input.participantes.some(p => p.valor!==undefined)) throw invalidReference('Empresa com mensalidade fixa: nao informe valores individuais.');
    if (complete && !monthly && input.participantes.some(p => p.valor===undefined)) throw invalidReference('Informe o valor de cada funcionario antes de solicitar.');
    return { monthly,centers };
  }
  private authorize(auth: AuthContext): void { if (!['GESTOR','GERENTE','PORTARIA'].includes(auth.perfil)) throw forbidden(); }
  private record(client: QueryExecutor,auth: AuthContext,row: RequisitionRow,action: string,metadata: AuditMetadata) {
    return this.audit.record(client,{ ...metadata,empresaId: auth.empresaId,usuarioId: auth.usuarioId,
      entidade: 'requisicoes_viagem',entidadeId: row.id,acao: action,dadosAnteriores: null,dadosNovos: row });
  }
}
