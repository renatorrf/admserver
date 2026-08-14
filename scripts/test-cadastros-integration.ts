import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import argon2 from 'argon2';
import pino from 'pino';
import type { Pool } from 'pg';

import { createApp } from '../src/app';
import { getConfig } from '../src/config/env';
import { createPool } from '../src/db/pool';
import { createAdminRouter } from '../src/modules/admin/admin.routes';
import { PgAuthRepository } from '../src/modules/auth/auth.repository';
import { AuthService } from '../src/modules/auth/auth.service';
import { TokenService } from '../src/modules/auth/token-service';
import { DispositivoService } from '../src/modules/dispositivos/dispositivo.service';

type JsonRecord = Record<string, unknown>;

const config = { ...getConfig(), nodeEnv: 'test' as const, logLevel: 'silent' as const, trustProxy: 1 as const };
const pool = createPool(config);
const tokens = new TokenService(config);
const auth = new AuthService(
  new PgAuthRepository(pool), tokens, undefined, config.jwtAccessExpiresInSeconds,
);
const app = createApp({
  config,
  logger: pino({ level: 'silent' }),
  pool,
  auth,
  tokens,
  adminRouter: createAdminRouter(pool, tokens),
});

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const companyCode = `SMOKE-${suffix}`.toUpperCase();
const password = `Teste-${suffix}-A1!`;
let companyId: string | undefined;
let managerId: string | undefined;

type ApiResponse = { status: number; body: JsonRecord };

function body(response: ApiResponse): JsonRecord {
  return response.body;
}

function data(response: ApiResponse): JsonRecord {
  const value = body(response).data;
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Resposta sem objeto data.');
  return value as JsonRecord;
}

function expectStatus(label: string, response: ApiResponse, expected: number): void {
  assert.equal(
    response.status,
    expected,
    `${label}: esperado HTTP ${expected}, recebido ${response.status}: ${JSON.stringify(response.body)}`,
  );
}

async function prepareTenant(): Promise<{ companyId: string; gestorId: string; email: string }> {
  const passwordHash = await argon2.hash(password);
  const company = await pool.query<{ id: string }>(
    `INSERT INTO admtaxi.empresas (codigo_acesso, razao_social, nome_fantasia)
     VALUES ($1, $2, $3) RETURNING id`,
    [companyCode, `Empresa Teste ${suffix}`, `Smoke ${suffix}`],
  );
  const createdCompanyId = company.rows[0]?.id;
  assert(createdCompanyId, 'Nao foi possivel criar a empresa temporaria.');
  companyId = createdCompanyId;

  const email = `gestor.${suffix}@teste.local`;
  const gestor = await pool.query<{ id: string }>(
    `INSERT INTO admtaxi.usuarios (empresa_id, nome, email, senha_hash, perfil)
     VALUES ($1, $2, $3, $4, 'GESTOR') RETURNING id`,
    [companyId, 'Gestor Smoke', email, passwordHash],
  );
  const gestorId = gestor.rows[0]?.id;
  assert(gestorId, 'Nao foi possivel criar o gestor temporario.');
  return {
    companyId,
    gestorId,
    email,
  };
}

async function startLocalServer(): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

async function stopServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function send(
  baseUrl: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  path: string,
  payload?: JsonRecord,
  token?: string,
): Promise<ApiResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(payload ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-Forwarded-For': '203.0.113.30',
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const parsed = await response.json() as JsonRecord;
  return { status: response.status, body: parsed };
}

async function cleanupTenant(database: Pool): Promise<void> {
  if (!companyId) return;
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    for (const table of [
      'notificacoes_push', 'dispositivos_push', 'dispositivos_usuario', 'corrida_localizacoes', 'corrida_eventos', 'corridas',
      'auditoria', 'gerente_centros_custo', 'veiculos', 'prestadores', 'funcionarios', 'refresh_tokens',
      'usuarios', 'centros_custo',
    ]) {
      await client.query(`DELETE FROM admtaxi.${table} WHERE empresa_id = $1`, [companyId]);
    }
    await client.query('DELETE FROM admtaxi.empresas WHERE id = $1', [companyId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function run(): Promise<void> {
  const checks: string[] = [];
  let localServer: Server | undefined;
  try {
    const tenant = await prepareTenant();
    const configuredBaseUrl = process.env.CADASTROS_BASE_URL?.replace(/\/$/, '');
    const target = configuredBaseUrl ? { baseUrl: configuredBaseUrl, server: undefined } : await startLocalServer();
    localServer = target.server;

    const gestorLogin = await send(target.baseUrl, 'POST', '/api/v1/auth/login', {
      empresa: companyCode, email: tenant.email, senha: password,
    });
    expectStatus('login do gestor temporario', gestorLogin, 200);
    const accessToken = data(gestorLogin).accessToken;
    assert.equal(typeof accessToken, 'string', 'Login do gestor nao retornou accessToken.');
    const authorized = (
      method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, payload?: JsonRecord,
    ) => send(target.baseUrl, method, path, payload, accessToken);

    if (!configuredBaseUrl) {
      const deviceService = new DispositivoService(pool);
      const device = await deviceService.syncCurrent(
        { empresaId: tenant.companyId, usuarioId: tenant.gestorId, perfil: 'GESTOR' },
        {
          chaveDispositivo: randomUUID(), plataforma: 'WEB', nomeDispositivo: 'Navegador de teste',
          navegador: 'Smoke Test', modoAcesso: 'NAVEGADOR', notificacoesStatus: 'NAO_SOLICITADA',
          geolocalizacaoStatus: 'NAO_SOLICITADA',
        },
      );
      const managed = await deviceService.listManaged(
        { empresaId: tenant.companyId, usuarioId: tenant.gestorId, perfil: 'GESTOR' },
        { pagina: 1, limite: 20 },
      );
      assert.equal(managed.data[0]?.id, device.id, 'Dispositivo nao apareceu na visao do gestor.');
      await deviceService.deactivateCurrent(
        { empresaId: tenant.companyId, usuarioId: tenant.gestorId, perfil: 'GESTOR' }, device.chaveDispositivo,
      );
      checks.push('dispositivo, permissoes e visao do gestor');
    }

    const centerResponse = await authorized('POST', '/api/v1/centros-custo', {
      codigo: `CC-${suffix.slice(0, 6)}`, nome: 'Centro de custo teste', descricao: 'Criado pelo smoke test',
    });
    expectStatus('criar centro de custo', centerResponse, 201);
    const centerId = data(centerResponse).id;
    assert.equal(typeof centerId, 'string');
    checks.push('centro de custo');

    const gestorResponse = await authorized('POST', '/api/v1/usuarios', {
      nome: 'Gestor Secundario', email: `gestor2.${suffix}@teste.local`, senha: password, perfil: 'GESTOR',
    });
    expectStatus('criar gestor', gestorResponse, 201);

    const managerResponse = await authorized('POST', '/api/v1/usuarios', {
      nome: 'Gerente Teste', email: `gerente.${suffix}@teste.local`, telefone: '34999990001',
      senha: password, perfil: 'GERENTE',
    });
    expectStatus('criar gerente', managerResponse, 201);
    managerId = String(data(managerResponse).id);
    const managerCenters = await authorized('PUT', `/api/v1/usuarios/${managerId}/centros-custo`, {
      centroCustoIds: [centerId],
    });
    expectStatus('vincular gerente ao centro de custo', managerCenters, 200);

    for (const profile of ['GESTOR', 'GERENTE'] as const) {
      const listResponse = await authorized('GET', `/api/v1/usuarios?perfil=${profile}`);
      expectStatus(`filtrar usuarios ${profile}`, listResponse, 200);
      const rows = body(listResponse).data;
      assert(Array.isArray(rows) && rows.length > 0, `Filtro ${profile} retornou uma lista vazia.`);
      assert(rows.every((row) => (row as JsonRecord).perfil === profile), `Filtro ${profile} misturou perfis.`);
    }
    checks.push('usuarios GESTOR/GERENTE e filtros');

    const providerResponse = await authorized('POST', '/api/v1/cadastros-unificados/prestadores', {
      acesso: {
        nome: 'Prestador Teste', email: `prestador.${suffix}@teste.local`, telefone: '34999990002',
        ativo: true, formaAtivacao: 'SENHA_TEMPORARIA', senha: password,
      },
      prestador: {
        reutilizarDadosAcesso: true, cpf: '529.982.247-25', numeroCnh: `CNH${suffix}`,
        validadeCnh: '2030-12-31', disponivel: true, ativo: true,
      },
      veiculo: {
        modo: 'NOVO',
        dados: {
          placa: 'TST1A01', marca: 'Fiat', modelo: 'Cronos', cor: 'Prata', ano: 2026,
          capacidadePassageiros: 4, ativo: true,
        },
      },
    });
    expectStatus('criar prestador, acesso e veiculo', providerResponse, 201);
    const provider = data(providerResponse);
    assert.equal(typeof provider.usuarioId, 'string');
    assert(Array.isArray(provider.veiculos) && provider.veiculos.length === 1, 'Veiculo nao foi vinculado ao prestador.');
    checks.push('prestador com acesso e veiculo');

    const employeeEmail = `funcionario.${suffix}@teste.local`;
    const employeeResponse = await authorized('POST', '/api/v1/cadastros-unificados/funcionarios', {
      acesso: { senha: password, ativo: true },
      funcionario: {
        centroCustoId: centerId, nome: 'Funcionario Teste', matricula: `MAT-${suffix}`,
        telefone: '34999990003', email: employeeEmail, cpf: null,
        enderecoPadrao: 'Av. Joao Naves de Avila, 2121, Uberlandia - MG',
        latitudePadrao: -18.9186, longitudePadrao: -48.2772,
      },
    });
    expectStatus('criar funcionario e acesso', employeeResponse, 201);
    const employee = data(employeeResponse);
    assert.equal(typeof employee.usuarioId, 'string');

    const employeeLogin = await send(target.baseUrl, 'POST', '/api/v1/auth/login', {
      empresa: companyCode, email: employeeEmail, senha: password,
    });
    expectStatus('login do funcionario criado', employeeLogin, 200);
    assert.equal((data(employeeLogin).usuario as JsonRecord).perfil, 'FUNCIONARIO');
    checks.push('funcionario com acesso e login');

    const duplicateEmployee = await authorized('POST', '/api/v1/cadastros-unificados/funcionarios', {
      acesso: { senha: password, ativo: true },
      funcionario: {
        centroCustoId: centerId, nome: 'Funcionario Duplicado', matricula: `MAT2-${suffix}`,
        email: employeeEmail,
      },
    });
    expectStatus('recusar e-mail duplicado sem cadastro parcial', duplicateEmployee, 409);
    const partialCount = await pool.query<{ total: string }>(
      'SELECT COUNT(*)::text AS total FROM admtaxi.funcionarios WHERE empresa_id = $1 AND matricula = $2',
      [tenant.companyId, `MAT2-${suffix}`],
    );
    assert.equal(Number(partialCount.rows[0]?.total), 0, 'Cadastro duplicado deixou funcionario parcial.');
    checks.push('rollback em duplicidade');

    const auditResponse = await authorized('GET', '/api/v1/auditoria?pagina=1&limite=100');
    expectStatus('listar auditoria', auditResponse, 200);
    const auditRows = body(auditResponse).data;
    assert(Array.isArray(auditRows) && auditRows.length >= 6, 'Eventos de auditoria esperados nao foram gravados.');
    checks.push('auditoria');

    process.stdout.write(`${JSON.stringify({ ok: true, alvo: target.baseUrl, checks }, null, 2)}\n`);
  } finally {
    await stopServer(localServer);
    await cleanupTenant(pool);
    await pool.end();
  }
}

void run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
