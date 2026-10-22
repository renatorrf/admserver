import express from 'express';
import request from 'supertest';
import { describe,it,expect,vi } from 'vitest';
import pino from 'pino';
import type { Database } from '../src/db/pool';
import { passengerControl,passengerControlRouter } from '../src/modules/usuarios/passenger-control';
import type { AuthContext } from '../src/modules/auth/auth.types';
import { createErrorHandler } from '../src/shared/http/error-handler';

describe('Passenger control',()=>{
  it('scopes rows to authenticated company, global aggregates only, rejects tenant override',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[{data:[],total:0,plano:{limite:200}}]});
    const database={query} as unknown as Database;
    await passengerControl(database,'company',{pagina:2,busca:"' OR TRUE --",situacao:'INATIVO'});
    const [sql,values]=query.mock.calls[0]!;
    expect(sql).toContain('WHERE f.empresa_id=$1');expect(sql).toContain('r.empresa_id=f.empresa_id');
    expect(values).toEqual(['company',"%' OR TRUE --%",'INATIVO',20]);
    await expect(passengerControl(database,'company',{empresaId:'other'})).rejects.toThrow();
  });
  for(const perfil of ['GERENTE','PORTARIA','PRESTADOR','FUNCIONARIO','GESTOR'] as const) it(`protects manager-only counters from ${perfil}`,async()=>{
    const query=vi.fn().mockResolvedValue({rows:[{data:[],total:0,plano:{limite:200}}]});
    const app=express();app.use((req,_res,next)=>{req.auth={empresaId:'company',usuarioId:'user',perfil} as AuthContext;next();});
    app.use('/passageiros/controle',passengerControlRouter({query} as unknown as Database));
    app.use(createErrorHandler(pino({level:'silent'})));
    const response=await request(app).get('/passageiros/controle');expect(response.status).toBe(perfil==='GESTOR'?200:403);
    expect(query).toHaveBeenCalledTimes(perfil==='GESTOR'?1:0);
  });
  it('returns a clear conflict for global capacity instead of a generic 500',async()=>{
    const app=express();app.get('/',(_req,_res,next)=>next({code:'P2601'}));app.use(createErrorHandler(pino({level:'silent'})));
    const response=await request(app).get('/');expect(response.status).toBe(409);expect(response.body.erro.codigo).toBe('LIMITE_PASSAGEIROS');
  });
});
