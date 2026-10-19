import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { TokenService } from '../src/modules/auth/token-service';
import { masterCompanySchema, provisionamentoSchema } from '../src/modules/provisionamento/provisionamento.schemas';

const config = { jwtAccessSecret:'test-only-access-secret-0000000000000000',jwtRefreshSecret:'test-only-refresh-secret-000000000000000',jwtAccessExpiresInSeconds:900,jwtRefreshExpiresInSeconds:3600 };
const tokens = new TokenService(config);
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const empresa = {codigoAcesso:'EMPRESA',razaoSocial:'Empresa Teste',nomeFantasia:'Teste',cidadePadrao:'Uberlandia',estadoPadrao:'MG',latitudePadrao:-18.9,longitudePadrao:-48.2};

describe('conta unica de gestor',()=>{
  it('selecao tem finalidade separada, cinco minutos e versao da credencial',()=>{
    const token=tokens.issueCompanySelection(id,3);
    expect(tokens.verifyCompanySelection(token)).toMatchObject({sub:id,versao:3});
    const decoded=jwt.decode(token) as jwt.JwtPayload;
    expect(decoded.exp!-decoded.iat!).toBe(300);
    expect(()=>tokens.verifyAccess(token)).toThrow();
    expect(()=>tokens.verifyRefresh(token)).toThrow();
  });
  it('rejeita selecao expirada, adulterada e token de acesso usado como selecao',()=>{
    const expired=jwt.sign({sub:id,versao:0,tipo:'company-selection'},config.jwtAccessSecret,{expiresIn:-1,issuer:'adm-taxi',audience:'adm-taxi-company-selection'});
    expect(()=>tokens.verifyCompanySelection(expired)).toThrow();
    expect(()=>tokens.verifyCompanySelection(tokens.issueCompanySelection(id,0)+'bad')).toThrow();
    expect(()=>tokens.verifyCompanySelection(tokens.issueTokens({usuarioId:id,empresaId:id,perfil:'GESTOR'}).accessToken)).toThrow();
  });
  it('master aceita vinculo sem senha e rejeita misturar conta existente com credenciais',()=>{
    expect(masterCompanySchema.parse({empresa,gestor:{contaId:id}}).gestor).toEqual({contaId:id});
    expect(masterCompanySchema.safeParse({empresa,gestor:{contaId:id,senha:'123456'}}).success).toBe(false);
    expect(provisionamentoSchema.safeParse({empresa,gestor:{contaId:id}}).success).toBe(false);
  });
  it('preserva contrato de novo gestor e exige seis caracteres',()=>{
    const gestor={nome:'Gestor Teste',email:'gestor@example.test',senha:'123456'};
    expect(masterCompanySchema.safeParse({empresa,gestor}).success).toBe(true);
    expect(masterCompanySchema.safeParse({empresa,gestor:{...gestor,senha:'12345'}}).success).toBe(false);
  });
});
