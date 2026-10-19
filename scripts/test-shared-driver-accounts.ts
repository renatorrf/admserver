import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { io as connectSocket } from 'socket.io-client';
import type { Pool } from 'pg';
import pino from 'pino';
import webpush from 'web-push';
import { AuditRepository } from '../src/modules/auditoria/audit.repository';
import { PrestadorUnificadoService } from '../src/modules/prestadores/prestador-unificado.service';
import { prestadorUnificadoCreateSchema } from '../src/modules/prestadores/prestador-unificado.schemas';
import { DriverLinkService } from '../src/modules/prestadores/driver-link.service';
import { DriverLoginService } from '../src/modules/auth/driver-login.service';
import { PgAuthRepository } from '../src/modules/auth/auth.repository';
import { AuthService } from '../src/modules/auth/auth.service';
import { PasswordService } from '../src/modules/auth/password.service';
import { TokenService } from '../src/modules/auth/token-service';
import type { AuthContext } from '../src/modules/auth/auth.types';
import { CorridaService } from '../src/modules/corridas/corrida.service';
import { LocalizacaoService } from '../src/modules/localizacoes/localizacao.service';
import { OperacaoRepository } from '../src/modules/operacao/operacao.repository';
import { PainelParticipanteRepository } from '../src/modules/paineis/painel.repository';
import { DispositivoService } from '../src/modules/dispositivos/dispositivo.service';
import { RealtimeBus } from '../src/realtime/realtime-bus';
import { attachSocketServer } from '../src/realtime/socket-server';
import { NotificacaoService } from '../src/modules/notificacoes/notificacao.service';

// Called only with the temporary loopback pool created by test-review-integration.
export async function testSharedDriverAccounts(pool: Pool, ok: (label: string) => void): Promise<void> {
  assert.equal(pool.options.host, '127.0.0.1');
  const tenants = [];
  for (let i = 0; i < 3; i++) {
    const company = randomUUID(), manager = randomUUID(), center = randomUUID(), sector = randomUUID(), employee = randomUUID();
    await pool.query('INSERT INTO admtaxi.empresas(id,codigo_acesso,razao_social,nome_fantasia) VALUES($1,$2,$3,$3)', [company, `SHARED${i}`, `Shared company ${i}`]);
    await pool.query(`INSERT INTO admtaxi.usuarios(id,empresa_id,nome,email,senha_hash,perfil) VALUES($1,$2,$3,$4,'synthetic','GESTOR')`, [manager, company, `Manager ${i}`, `sharedmanager${i}@example.test`]);
    await pool.query('INSERT INTO admtaxi.setores(id,empresa_id,codigo,nome) VALUES($1,$2,\'S\',\'Setor\')', [sector, company]);
    await pool.query('INSERT INTO admtaxi.centros_custo(id,empresa_id,setor_id,codigo,nome) VALUES($1,$2,$3,\'C\',\'Centro\')', [center, company, sector]);
    await pool.query('INSERT INTO admtaxi.funcionarios(id,empresa_id,centro_custo_id,nome,matricula) VALUES($1,$2,$3,\'Passageiro\',\'E\')', [employee, company, center]);
    tenants.push({ company, employee, center, auth: { usuarioId: manager, empresaId: company, perfil: 'GESTOR' } as AuthContext });
  }
  const a = tenants[0]!, b = tenants[1]!;
  const providers = new PrestadorUnificadoService(pool, new AuditRepository(pool));
  const created = await providers.create(a.auth, prestadorUnificadoCreateSchema.parse({
    acesso: { nome: 'Motorista compartilhado', email: 'shared.driver@example.test', telefone: '34977771234', senha: '123456', formaAtivacao: 'SENHA_TEMPORARIA' },
    prestador: { cpf: '11144477735', numeroCnh: 'SHARED123', validadeCnh: '2035-01-01', reutilizarDadosAcesso: true },
    veiculo: { modo: 'NOVO', dados: { placa: 'SHR1A23', marca: 'Teste', modelo: 'Teste', cor: 'Branco', ano: 2026, capacidadePassageiros: 4 } },
  }), {});
  const repo = new PgAuthRepository(pool);
  const tokens = new TokenService({ jwtAccessSecret: randomUUID() + randomUUID(), jwtRefreshSecret: randomUUID() + randomUUID(), jwtAccessExpiresInSeconds: 900, jwtRefreshExpiresInSeconds: 3600 }, auth => repo.accessAllowed(auth));
  const login = new DriverLoginService(pool, tokens, 900);
  assert.equal(await login.identify({ email: 'shared.driver@example.test', senha: 'wrong' }), null);
  const first = (await login.identify({ email: 'shared.driver@example.test', senha: '123456' }))!;
  assert.equal(first.usuario.deveAlterarSenha, true);
  await assert.rejects(tokens.authenticateAccess(first.accessToken), { code: 'TROCA_SENHA_OBRIGATORIA' });
  const passwords = new PasswordService(pool, pino({ level: 'silent' }));
  await passwords.change(tokens.verifyAccess(first.accessToken), { senhaAtual: '123456', novaSenha: '654321' });
  const session = (await login.identify({ email: 'shared.driver@example.test', senha: '654321' }))!;
  const driver = await tokens.authenticateAccess(session.accessToken);
  assert(driver.contaMotoristaId);
  const links = new DriverLinkService(pool);
  assert.deepEqual((await links.search(b.auth, 'shared.driver@example.test')).map(x => Object.keys(x).sort()), [['email','id','nome','vinculado']]);
  await assert.rejects(links.search({ ...b.auth, perfil: 'GERENTE' }, 'shared.driver@example.test'), { statusCode: 403 });
  const linked = await links.link(b.auth, driver.contaMotoristaId, true, {});
  await assert.rejects(links.link(b.auth, driver.contaMotoristaId, true, {}), { statusCode: 409 });
  assert.equal((await pool.query('SELECT count(*) FROM admtaxi.contas_motorista WHERE email=$1', ['shared.driver@example.test'])).rows[0].count, '1');
  assert.equal((await login.identify({ email: 'shared.driver@example.test', senha: '654321' }))!.usuario.contaMotoristaId, driver.contaMotoristaId);
  await assert.rejects(providers.update(b.auth, linked.id, { acesso: { senha: '999999' } }, {}), { code: 'P2001' });
  ok('SHARED-01 one credential owner, direct authorized link, no other-tenant data, same password, duplicate link and shared-password protection');

  const bus = new RealtimeBus(), rides = new CorridaService(pool, new AuditRepository(pool), undefined, bus);
  const locations = new LocalizacaoService(pool, rides, bus), operations = new OperacaoRepository(pool);
  const makeRide = async (t: typeof a) => (await pool.query<{ id: string }>(`INSERT INTO admtaxi.corridas(empresa_id,solicitante_usuario_id,funcionario_id,centro_custo_id,tipo,origem_descricao,destino_descricao)
    VALUES($1,$2,$3,$4,'IMEDIATA','Origem','Destino') RETURNING id`, [t.company, t.auth.usuarioId, t.employee, t.center])).rows[0]!.id;
  const rideIds = await Promise.all(tenants.map(makeRide));
  const listed = await rides.list(driver, { pagina: 1, limite: 100 });
  assert.deepEqual(new Set(listed.data.map(r => r.empresaId)), new Set([a.company, b.company]));
  assert(listed.data.every(r => r.empresaNome));
  await assert.rejects(rides.get(driver, rideIds[2]!), { statusCode: 404 });
  const vehicles = await operations.listMyVehicles(driver) as { id: string; empresaId: string }[];
  assert.equal(vehicles.length, 2);
  const results = await Promise.allSettled([a, b].map((t, i) => rides.accept(driver, rideIds[i]!, { veiculoId: vehicles.find(v => v.empresaId === t.company)!.id }, {})));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const winner = results.findIndex(r => r.status === 'fulfilled'), rideId = rideIds[winner]!, tenant = tenants[winner]!;
  assert.equal((results[1-winner] as PromiseRejectedResult).reason.statusCode, 409);
  const location = await locations.create(driver, rideId, { latitude: -18.9, longitude: -48.2, precisaoMetros: 4 });
  assert.equal(location.empresaId, tenant.company);
  assert.equal((await locations.snapshot(driver, rideId)).corrida.empresaId, tenant.company);
  await assert.rejects(locations.create(driver, rideIds[2]!, { latitude: 0, longitude: 0 }), { statusCode: 404 });
  assert.equal((await operations.getMyProvider(driver))!.disponivel, false);
  await assert.rejects(rides.setAvailability(driver, { disponivel: true }, {}), { statusCode: 409 });
  const panel = await new PainelParticipanteRepository(pool).get(driver, { pagina: 1, limite: 100 });
  assert.equal(panel.resumo.emAndamento, 1); assert.equal(panel.corridas.meta.total, 1);
  const oldPanel = await new PainelParticipanteRepository(pool).get(driver, { pagina: 1, limite: 100, inicio: '2020-01-01', fim: '2020-01-31' });
  assert.equal(oldPanel.resumo.emAndamento, 0); assert.equal(oldPanel.disponibilidade, false);
  ok('SHARED-02 combined list/pagination/panel, company labels, tenant-specific vehicles, cross-company acceptance race and GPS authorization');

  const devices = new DispositivoService(pool), deviceKey = randomUUID();
  await devices.syncCurrent(driver, { chaveDispositivo: deviceKey, plataforma: 'ANDROID', nomeDispositivo: 'Synthetic', modoAcesso: 'PWA', notificacoesStatus: 'ATIVA', geolocalizacaoStatus: 'ATIVA' });
  assert.equal((await pool.query('SELECT count(*) FROM admtaxi.dispositivos_usuario WHERE chave_dispositivo=$1 AND ativo', [deviceKey])).rows[0].count, '2');
  await devices.deactivateCurrent(driver, deviceKey);
  assert.equal((await pool.query('SELECT count(*) FROM admtaxi.dispositivos_usuario WHERE chave_dispositivo=$1 AND ativo', [deviceKey])).rows[0].count, '0');
  const push = new NotificacaoService(pool);
  const subscription = await push.register(driver, { endpoint: 'https://push.example.test/shared', keys: { auth: 'synthetic', p256dh: 'synthetic-key-not-a-real-key' } }, null);
  const sibling = (await pool.query<{ usuario_id: string }>('SELECT usuario_id FROM admtaxi.prestadores WHERE id=$1', [linked.id])).rows[0]!;
  assert.equal((await push.listDevices({ ...driver, empresaId: b.company, usuarioId: sibling.usuario_id }))[0]!.id, subscription.id);
  const pushKeys = webpush.generateVAPIDKeys();
  const sending = new NotificacaoService(pool, { ...pushKeys, subject: 'mailto:push@example.test', appUrl: 'https://app.example.test', defaultOpenUrl: '/app', rideOpenUrl: '/app/corridas' });
  const originalSend = webpush.sendNotification;
  let deliveries = 0;
  webpush.sendNotification = async () => { deliveries++; return { statusCode: 201, body: '', headers: {} }; };
  try {
    await sending.sendTest({ ...driver, empresaId: b.company, usuarioId: sibling.usuario_id });
    assert.equal(deliveries, 1);
    const attempt = (await pool.query('SELECT empresa_id,subscription_empresa_id,status FROM admtaxi.push_tentativas WHERE subscription_id=$1', [subscription.id])).rows[0];
    assert.deepEqual(attempt, { empresa_id: b.company, subscription_empresa_id: a.company, status: 'ENVIADA' });
    await sending.sendTest(tenants[2]!.auth);
    const foreign = (await pool.query('SELECT id FROM admtaxi.notificacoes_push WHERE empresa_id=$1 AND evento=\'TESTE\'', [tenants[2]!.company])).rows[0];
    await assert.rejects(pool.query(`INSERT INTO admtaxi.push_tentativas(empresa_id,notificacao_id,subscription_id,subscription_empresa_id)
      VALUES($1,$2,$3,$4)`, [tenants[2]!.company, foreign.id, subscription.id, a.company]), { code: '23514' });
  } finally { webpush.sendNotification = originalSend; }
  ok('SHARED-03 device permissions, cross-company push delivery/logging (transport mocked), foreign subscription denied by database');

  const http = createServer(), io = attachSocketServer(http, { appOrigins: [] }, tokens, locations, bus, pino({ level: 'silent' }), pool);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address(); assert(address && typeof address !== 'string');
  const socket = connectSocket(`http://127.0.0.1:${address.port}`, { auth: { token: session.accessToken }, transports: ['websocket'], reconnection: false });
  try {
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    const snap = await socket.timeout(5000).emitWithAck('corrida:acompanhar', { corridaId: rideId });
    assert.equal(snap.ok, true); assert.equal(snap.data.corrida.empresaId, tenant.company);
    const update = new Promise<{ empresaId: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('GPS socket timeout')), 5000);
      socket.once('localizacao:atualizada', payload => { clearTimeout(timer); resolve(payload); });
    });
    await locations.create(driver, rideId, { latitude: -18.90001, longitude: -48.2 });
    assert.equal((await update).empresaId, tenant.company);
    socket.disconnect(); socket.connect();
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    assert.equal((await socket.timeout(5000).emitWithAck('corrida:acompanhar', { corridaId: rideId })).ok, true);
    assert.equal((await socket.timeout(5000).emitWithAck('corrida:acompanhar', { corridaId: rideIds[2] })).ok, false);
  } finally { socket.disconnect(); await new Promise<void>(resolve => io.close(() => resolve())); }
  ok('SHARED-04 real Socket.IO room, GPS delivery, reconnect and foreign ride denial');

  await rides.cancel(tenant.auth, rideId, { motivo: 'Cancelamento sintetico' }, {});
  await rides.setAvailability(driver, { disponivel: false }, {});
  assert.equal((await rides.list(driver, { pagina: 1, limite: 100 })).data.filter(r => r.status === 'SOLICITADA').length, 0);
  await rides.setAvailability(driver, { disponivel: true }, {});
  await providers.update(a.auth, created.id, { acesso: { ativo: false } }, {});
  assert.equal(await repo.accessAllowed(driver), true);
  assert.deepEqual(new Set((await rides.list(driver, { pagina: 1, limite: 100 })).data.map(r => r.empresaId)), new Set([b.company]));
  const remaining = (await login.identify({ email: 'shared.driver@example.test', senha: '654321' }))!;
  assert.equal(remaining.usuario.empresaId, b.company);
  await passwords.change(tokens.verifyAccess(remaining.accessToken), { senhaAtual: '654321', novaSenha: '987654' });
  await assert.rejects(tokens.authenticateAccess(session.accessToken), { statusCode: 401 });
  await assert.rejects(new AuthService(repo, tokens).refresh({ refreshToken: remaining.refreshToken }), { statusCode: 401 });
  assert.equal(await login.identify({ email: 'shared.driver@example.test', senha: '654321' }), null);
  assert(await login.identify({ email: 'shared.driver@example.test', senha: '987654' }));
  const emails: string[] = [];
  const recovery = new PasswordService(pool, pino({ level: 'silent' }), {
    host: 'smtp.example.test', port: 587, secure: false, user: 'test', password: 'test', from: 'no-reply@example.test',
    resetUrl: 'https://app.example.test/redefinir-senha', resetTtlMinutes: 30,
  }, { send: async (_to, url) => { emails.push(url); } });
  await recovery.requestReset({ email: 'shared.driver@example.test' });
  await recovery.requestReset({ email: 'shared.driver@example.test' });
  assert.equal(emails.length, 1);
  const resetToken = new URLSearchParams(new URL(emails[0]!).hash.slice(1)).get('token')!;
  await recovery.reset({ token: resetToken, novaSenha: '765432' });
  await assert.rejects(recovery.reset({ token: resetToken, novaSenha: '123456' }), { code: 'LINK_SENHA_INVALIDO' });
  assert.equal(await login.identify({ email: 'shared.driver@example.test', senha: '987654' }), null);
  assert(await login.identify({ email: 'shared.driver@example.test', senha: '765432' }));
  await providers.update(b.auth, linked.id, { acesso: { ativo: false } }, {});
  assert.equal(await login.identify({ email: 'shared.driver@example.test', senha: '765432' }), null);
  ok('SHARED-05 global availability, membership-only deactivation, remaining company access, global password/session revocation and company-free email recovery');
}
