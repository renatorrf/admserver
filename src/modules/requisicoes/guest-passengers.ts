import type { QueryExecutor } from '../../db/pool';
import { conflict } from '../../shared/errors/app-error';
import type { RequisitionInput } from './requisicao.schemas';

export async function resolveGuests(client: QueryExecutor, empresaId: string, participants: RequisitionInput['participantes']) {
  const resolved = new Map<string,string>();
  // The same lock serializes admission across companies, including requests with several passengers.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('plano_passageiros'),0)");
  for (const person of participants) {
    if (!person.avulso) continue;
    const guest=person.avulso;
    const existing=await client.query<{ id:string; avulso:boolean; ativo:boolean; mesmo_nome:boolean; mesmo_telefone:boolean }>(
      `SELECT id,avulso,ativo,admtaxi.normalizar_cadastro(nome,'nome')=admtaxi.normalizar_cadastro($2,'nome') AS mesmo_nome,
        admtaxi.normalizar_cadastro(telefone,'telefone')=$3 AS mesmo_telefone
       FROM admtaxi.funcionarios WHERE empresa_id=$1 AND
       (admtaxi.normalizar_cadastro(nome,'nome')=admtaxi.normalizar_cadastro($2,'nome') OR admtaxi.normalizar_cadastro(telefone,'telefone')=$3) FOR UPDATE`,
      [empresaId,guest.nome,guest.telefone]);
    const found=existing.rows[0];
    if (found) {
      if (existing.rows.length!==1 || !found.avulso || !found.mesmo_nome || !found.mesmo_telefone)
        throw conflict('Nome ou telefone ja cadastrado. Selecione o funcionario existente ou revise os dados do avulso.');
      if (!found.ativo) throw conflict('Passageiro bloqueado no cadastro. Solicite a revisao ao gestor.');
      resolved.set(guest.id,found.id);
    } else {
      const result=await client.query<{id:string}>(`INSERT INTO admtaxi.funcionarios(empresa_id,centro_custo_id,nome,telefone,avulso)
        VALUES($1,$2,$3,$4,TRUE) RETURNING id`,[empresaId,guest.centroCustoId,guest.nome,guest.telefone]);
      resolved.set(guest.id,result.rows[0]!.id);
    }
  }
  return resolved;
}
