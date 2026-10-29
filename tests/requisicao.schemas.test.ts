import { describe,it,expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { requisicaoSchema,conferenceData,decisionSchema,toRideInput } from '../src/modules/requisicoes/requisicao.schemas';
const employee=randomUUID(),center=randomUUID();
const address={descricao:'Endereco completo',latitude:0,longitude:-48.2};
const input=()=>requisicaoSchema.parse({chave:randomUUID(),tipo:'IMEDIATA',participantes:[{funcionarioId:employee}]});
describe('requisicao e conferencia',()=>{
  it('exige telefone na requisicao e matricula e setor na conferencia',()=>{
    const guest={id:randomUUID(),nome:'Ana Nova',centroCustoId:center};
    expect(()=>requisicaoSchema.parse({...input(),participantes:[{avulso:guest}]})).toThrow();
    const data=requisicaoSchema.parse({...input(),participantes:[{avulso:{...guest,telefone:'34999991234'}}]});
    const p={...data.participantes[0]!,origem:address,destino:address};
    expect(()=>conferenceData(data,[p])).toThrow('matricula');
    const complete={...p,avulso:{...p.avulso!,matricula:' m01 ',setorId:randomUUID(),telefone:'34999991234',email:'ANA@example.test'}};
    const result=conferenceData(data,[complete]);
    expect(result.participantes[0]!.avulso).toMatchObject({matricula:'M01',telefone:'34999991234',email:'ana@example.test'});
    expect(()=>conferenceData(data,[{...complete,avulso:{...complete.avulso,centroCustoId:randomUUID()}}])).toThrow('centros');
    expect(()=>conferenceData(data,[{...complete,avulso:{...complete.avulso,email:'nao-email'}}])).toThrow();
  });
  it('permite enderecos pendentes mas nao coordenadas parciais ou fora do intervalo',()=>{
    expect(input().participantes[0]!.origem).toBeUndefined();
    expect(()=>requisicaoSchema.parse({...input(),participantes:[{funcionarioId:employee,origem:{descricao:'Rua',latitude:1}}]})).toThrow();
    expect(()=>requisicaoSchema.parse({...input(),participantes:[{funcionarioId:employee,origem:{...address,latitude:91}}]})).toThrow();
  });
  it('rejeita duplicacao, tenant injetado e recusas sem motivo',()=>{
    const data=input();expect(()=>requisicaoSchema.parse({...data,participantes:[data.participantes[0],data.participantes[0]]})).toThrow();
    expect(()=>requisicaoSchema.parse({...data,empresaId:randomUUID()})).toThrow();
    expect(()=>decisionSchema.parse({autorizar:false})).toThrow();
  });
  it('portaria completa pendentes mas nao troca passageiros ou enderecos autorizados',()=>{
    const data=input();const passenger={funcionarioId:employee,origem:address,destino:address};
    const complete=conferenceData(data,[passenger]);expect(complete.participantes[0]!.origem).toEqual(address);
    expect(()=>conferenceData(data,[{...passenger,funcionarioId:randomUUID()}])).toThrow();
    expect(()=>conferenceData(complete,[{...passenger,origem:{...address,descricao:'Novo endereco'}}])).toThrow();
    expect(()=>conferenceData(data,[{funcionarioId:employee}])).toThrow();
  });
  it('preserva valores autorizados e deriva centros no servidor',()=>{
    const data={...input(),participantes:[{funcionarioId:employee,origem:address,destino:address,valor:'25.10'}]};
    expect(()=>conferenceData(data,[{...data.participantes[0]!,valor:'1.00'}])).toThrow();
    const ride=toRideInput(data,new Map([[employee,center]]),false);
    expect(ride.itinerario!.participantes[0]).toMatchObject({centroCustoId:center,valor:'25.10'});
    expect(ride.itinerario!.paradas[0]!.latitude).toBe(0);
    expect(toRideInput(data,new Map([[employee,center]]),true).itinerario!.participantes[0]!.valor).toBeUndefined();
  });
});
