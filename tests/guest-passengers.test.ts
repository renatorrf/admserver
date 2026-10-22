import { describe,it,expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { conferenceData,requisicaoSchema,toRideInput } from '../src/modules/requisicoes/requisicao.schemas';

const input=()=>({chave:randomUUID(),tipo:'IMEDIATA',participantes:[{avulso:{id:randomUUID(),nome:'Pessoa avulsa',telefone:'+55 (34) 98888-1234',centroCustoId:randomUUID()}}]});
describe('Guest requisitions',()=>{
  it('requires manual phone and cost center, and normalizes the phone',()=>{
    const data=input();expect(requisicaoSchema.parse(data).participantes[0]!.avulso!.telefone).toBe('34988881234');
    for(const field of ['telefone','centroCustoId','nome'] as const) {
      const bad=input();bad.participantes[0]!.avulso[field]='';expect(requisicaoSchema.safeParse(bad).success).toBe(false);
    }
    expect(requisicaoSchema.safeParse({...data,participantes:[{...data.participantes[0],funcionarioId:randomUUID()}]}).success).toBe(false);
    expect(requisicaoSchema.safeParse({...data,participantes:[{}]}).success).toBe(false);
  });
  it('rejects duplicate guest phones and cannot change an authorized passenger or cost center',()=>{
    const data=requisicaoSchema.parse(input());
    const repeated={...data,participantes:[data.participantes[0],{avulso:{...data.participantes[0]!.avulso!,id:randomUUID()}}]};
    expect(requisicaoSchema.safeParse(repeated).success).toBe(false);
    for(const field of ['nome','telefone','centroCustoId'] as const) {
      const changed=structuredClone(data.participantes);changed[0]!.avulso![field]='alterado';
      expect(()=>conferenceData(data,changed)).toThrow('Mantenha os passageiros');
    }
  });
  it('translates avulso to the existing itinerary and individual cost center after resolution',()=>{
    const data=requisicaoSchema.parse(input());const p=data.participantes[0]!;
    p.origem=p.destino={descricao:'Endereco teste',latitude:0,longitude:0};p.valor='10.00';
    const id=randomUUID();const ride=toRideInput(data,new Map([[p.avulso!.id,p.avulso!.centroCustoId]]),false,new Map([[p.avulso!.id,id]]));
    expect(ride.funcionarioId).toBe(id);expect(ride.itinerario?.participantes[0]?.centroCustoId).toBe(p.avulso!.centroCustoId);
  });
});
