import { createServer, type Server as HttpServer } from 'node:http';

import pino from 'pino';
import type { Server as SocketServer } from 'socket.io';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../src/config/env';
import { TokenService } from '../src/modules/auth/token-service';
import type { LocalizacaoService } from '../src/modules/localizacoes/localizacao.service';
import { RealtimeBus } from '../src/realtime/realtime-bus';
import { attachSocketServer } from '../src/realtime/socket-server';

const config: AppConfig = {
  nodeEnv: 'test', port: 0, databaseUrl: 'postgres://unused', appOrigins: ['http://localhost:8100'],
  jwtAccessSecret: 'access-secret-used-only-for-socket-tests-123456',
  jwtRefreshSecret: 'refresh-secret-used-only-for-socket-tests-12345',
  jwtAccessExpiresInSeconds: 900, jwtRefreshExpiresInSeconds: 3600,
  logLevel: 'silent', trustProxy: false,
};
const auth = {
  usuarioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  empresaId: '11111111-1111-4111-8111-111111111111',
  perfil: 'GESTOR' as const,
};
const corridaId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('Socket.IO', () => {
  let httpServer: HttpServer | undefined;
  let ioServer: SocketServer | undefined;
  let client: ClientSocket | undefined;

  afterEach(async () => {
    client?.disconnect();
    if (ioServer) await new Promise<void>((resolve) => ioServer!.close(() => resolve()));
    else if (httpServer?.listening) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  });

  it('autentica o handshake e autoriza o acompanhamento antes de entrar na sala', async () => {
    const tokens = new TokenService(config);
    const snapshot = vi.fn().mockResolvedValue({
      corrida: { id: corridaId, empresaId: auth.empresaId, status: 'ACEITA' },
      localizacaoAtual: null,
    });
    const locations = { snapshot, create: vi.fn() } as unknown as LocalizacaoService;
    httpServer = createServer();
    ioServer = attachSocketServer(
      httpServer, config, tokens, locations, new RealtimeBus(), pino({ level: 'silent' }),
    );
    const url = await listen(httpServer);
    client = createClient(url, { auth: { token: tokens.issueTokens(auth).accessToken } });
    await connected(client);

    const response = await emitWithAck(client, 'corrida:acompanhar', { corridaId });

    expect(response).toMatchObject({ ok: true, data: { corrida: { id: corridaId } } });
    expect(snapshot).toHaveBeenCalledWith(auth, corridaId);

    client.emit('corrida:acompanhar', { corridaId });
    const responseAfterMissingAck = await emitWithAck(client, 'corrida:acompanhar', { corridaId });
    expect(responseAfterMissingAck).toMatchObject({ ok: true });
    expect(snapshot).toHaveBeenCalledTimes(3);
  });

  it('recusa conexao sem access token', async () => {
    const tokens = new TokenService(config);
    const locations = { snapshot: vi.fn(), create: vi.fn() } as unknown as LocalizacaoService;
    httpServer = createServer();
    ioServer = attachSocketServer(
      httpServer, config, tokens, locations, new RealtimeBus(), pino({ level: 'silent' }),
    );
    const url = await listen(httpServer);
    client = createClient(url, { reconnection: false });

    const error = await new Promise<Error>((resolve) => client!.once('connect_error', resolve));

    expect(error.message).toBe('NAO_AUTORIZADO');
  });
});

async function listen(server: HttpServer): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Porta de teste indisponivel.');
  return `http://127.0.0.1:${address.port}`;
}

function connected(socket: ClientSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
}

function emitWithAck(socket: ClientSocket, event: string, payload: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout Socket.IO')), 3_000);
    socket.emit(event, payload, (response: Record<string, unknown>) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}
