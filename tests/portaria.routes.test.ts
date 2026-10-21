import type { Pool } from 'pg';
import pino from 'pino';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import type { AppConfig } from '../src/config/env';
import { createAdminRouter } from '../src/modules/admin/admin.routes';
import { createOperationalRouter } from '../src/modules/corridas/operational.routes';
import type { AuthApplication } from '../src/modules/auth/auth.service';
import { TokenService } from '../src/modules/auth/token-service';
import { usuarioCreateSchema } from '../src/modules/usuarios/usuario.schemas';
import { isNonTransactionalMigration } from '../src/db/migration-mode';

const company = '11111111-1111-4111-8111-111111111111';
const user = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const config = { nodeEnv:'test',port:3000,databaseUrl:'postgres://unused',appOrigins:[],
  jwtAccessSecret:'test-access-secret-portaria-only-123456789',jwtRefreshSecret:'test-refresh-secret-portaria-only-123456789',
  jwtAccessExpiresInSeconds:900,jwtRefreshExpiresInSeconds:3600,logLevel:'silent',trustProxy:false } satisfies AppConfig;
const tokens = new TokenService(config);
const pool = { query:vi.fn().mockResolvedValue({ rows:[],rowCount:0 }), connect:vi.fn() } as unknown as Pool;
const auth = {} as AuthApplication;
const app = createApp({ config,pool,auth,tokens,logger:pino({level:'silent'}),
  adminRouter:createAdminRouter(pool,tokens),operationalRouter:createOperationalRouter(pool,tokens) });
const token = tokens.issueTokens({ usuarioId:user,empresaId:company,perfil:'PORTARIA' }).accessToken;
const id = '22222222-2222-4222-8222-222222222222';

describe('Portaria permission boundary', () => {
  beforeEach(()=>vi.clearAllMocks());
  it.each(['/usuarios','/usuarios/controle','/empresas','/cadastros-unificados/funcionarios','/setores','/centros-custo','/funcionarios',
    '/prestadores','/veiculos','/auditoria','/dashboard','/paineis/meu','/faturamentos','/relatorios/corridas',
    '/corridas',`/corridas/${id}`,`/corridas/${id}/eventos`,`/corridas/${id}/rota`,`/corridas/${id}/localizacoes`,
    '/operacao/escopo','/operacao/setores','/operacao/prestadores','/operacao/prestadores/pesquisa','/operacao/solicitantes',
    '/push/diagnostics','/dispositivos'])('denies GET %s', async path=> {
    const result = await request(app).get(`/api/v1${path}`).set('Authorization',`Bearer ${token}`);
    expect(result.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalledWith(expect.stringMatching(/^SELECT/),expect.anything());
  });
  it.each(['atribuir','reabrir','aceitar','recusar','iniciar-deslocamento','cheguei-embarque','confirmar-embarque','finalizar','cancelar','otimizar-trajeto'])('denies ride operation %s',async action=> {
    const result = await request(app).post(`/api/v1/corridas/${id}/${action}`).send({}).set('Authorization',`Bearer ${token}`);
    expect(result.status).toBe(403);
    expect(pool.connect).not.toHaveBeenCalled();
  });
  it('allows only valid creation payloads and refuses injected tenant',async ()=> {
    const result = await request(app).post('/api/v1/corridas').send({empresaId:company}).set('Authorization',`Bearer ${token}`);
    expect(result.status).toBe(422);
    expect(pool.connect).not.toHaveBeenCalled();
  });
  it('lists only own company notifications',async ()=> {
    const result=await request(app).get('/api/v1/push/notificacoes').set('Authorization',`Bearer ${token}`);
    expect(result.status).toBe(200);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE empresa_id=$1 AND usuario_id=$2'),[company,user]);
  });
  it.each(['/operacao/centros-custo','/operacao/funcionarios','/operacao/funcionarios/pesquisa'])('allows request lookup %s with tenant scope',async path=> {
    const result=await request(app).get(`/api/v1${path}`).set('Authorization',`Bearer ${token}`);
    expect(result.status).toBe(200);
    expect(vi.mocked(pool.query).mock.calls.some(([,values])=>Array.isArray(values)&&values[0]===company)).toBe(true);
  });
  it('accepts Portaria in user registration without renaming legacy enum',()=> {
    expect(usuarioCreateSchema.parse({nome:'Portaria principal',email:'portaria@example.com',senha:'test123',perfil:'PORTARIA'}).perfil).toBe('PORTARIA');
    expect(tokens.verifyAccess(token).perfil).toBe('PORTARIA');
  });
});

describe('nontransactional migrations',()=> {
  it('permits only a single idempotent enum addition including CRLF',()=> {
    expect(isNonTransactionalMigration("-- transaction: none\r\n-- comment\r\nALTER TYPE admtaxi.perfil_usuario ADD VALUE IF NOT EXISTS 'PORTARIA';\r\n")).toBe(true);
    expect(isNonTransactionalMigration('CREATE TABLE example(id integer);')).toBe(false);
    expect(()=>isNonTransactionalMigration('-- transaction: none\nDELETE FROM admtaxi.usuarios;')).toThrow();
    expect(()=>isNonTransactionalMigration("-- transaction: none\nALTER TYPE admtaxi.perfil_usuario ADD VALUE IF NOT EXISTS 'PORTARIA'; SELECT 1;")).toThrow();
  });
});
