import type { QueryExecutor } from '../../db/pool';
import { conflict } from '../../shared/errors/app-error';
import { completedGuestSchema, type RequisitionInput } from './requisicao.schemas';
import { completeGuestAccess } from './guest-access';

export async function resolveGuests(client: QueryExecutor, empresaId: string, requestId: string, participants: RequisitionInput['participantes'],
  audit: (id:string,before:Record<string,unknown>|null,after:Record<string,unknown>)=>Promise<void>) {
  const resolved = new Map<string,string>();
  // The same lock serializes admission across companies, including requests with several passengers.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('plano_passageiros'),0)");
  for (const person of participants) {
    if (!person.avulso) continue;
    const guest=completedGuestSchema.parse(person.avulso);
    const existing=await client.query<Record<string,unknown> & { id:string; avulso:boolean; ativo:boolean; mesmo_nome:boolean; mesmo_telefone:boolean; mesma_matricula:boolean; centro_custo_id:string }>(
      `SELECT *,admtaxi.normalizar_cadastro(nome,'nome')=admtaxi.normalizar_cadastro($2,'nome') AS mesmo_nome,
        admtaxi.normalizar_cadastro(telefone,'telefone')=$3 AS mesmo_telefone,UPPER(matricula)=$4 AS mesma_matricula
       FROM admtaxi.funcionarios WHERE empresa_id=$1 AND
       (admtaxi.normalizar_cadastro(nome,'nome')=admtaxi.normalizar_cadastro($2,'nome')
        OR admtaxi.normalizar_cadastro(telefone,'telefone')=$3 OR UPPER(matricula)=$4) FOR UPDATE`,
      [empresaId,guest.nome,guest.telefone,guest.matricula]);
    const found=existing.rows[0];
    if (found) {
      if (existing.rows.length!==1 || !found.mesmo_nome || !found.mesmo_telefone
        || (!found.avulso && (!found.mesma_matricula || found.centro_custo_id!==guest.centroCustoId)))
        throw conflict('Nome, telefone ou matricula ja cadastrado com outros dados. Revise o pre-cadastro com o gestor.');
      if (!found.ativo) throw conflict('Passageiro bloqueado no cadastro. Solicite a revisao ao gestor.');
      if (!found.avulso) {
        await completeGuestAccess(client,empresaId,requestId,found,guest);
        const updated=(await client.query<Record<string,unknown>>('SELECT * FROM admtaxi.funcionarios WHERE empresa_id=$1 AND id=$2',[empresaId,found.id])).rows[0]!;
        await audit(found.id,found,updated);
        resolved.set(guest.id,found.id); continue;
      }
    }
    // Promote legacy guests in place, preserving transport identity and trip history.
    const values=[empresaId,guest.centroCustoId,guest.nome,guest.telefone,guest.matricula,
      person.origem!.descricao,person.origem!.latitude,person.origem!.longitude];
    const result=found
      ? await client.query<Record<string,unknown> & {id:string}>(`UPDATE admtaxi.funcionarios SET centro_custo_id=$2,nome=$3,telefone=$4,
          matricula=$5,endereco_padrao=$6,latitude_padrao=$7,longitude_padrao=$8,avulso=FALSE
          WHERE empresa_id=$1 AND id=$9 RETURNING *`,[...values,found.id])
      : await client.query<Record<string,unknown> & {id:string}>(`INSERT INTO admtaxi.funcionarios
          (empresa_id,centro_custo_id,nome,telefone,matricula,endereco_padrao,latitude_padrao,longitude_padrao,avulso)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,FALSE) RETURNING *`,values);
    const employee=result.rows[0]!;
    await completeGuestAccess(client,empresaId,requestId,employee,guest);
    const updated=(await client.query<Record<string,unknown>>('SELECT * FROM admtaxi.funcionarios WHERE empresa_id=$1 AND id=$2',[empresaId,employee.id])).rows[0]!;
    await audit(employee.id,found??null,updated);
    resolved.set(guest.id,employee.id);
  }
  return resolved;
}
