import type { Server as HttpServer } from 'node:http';

import type { Logger } from 'pino';
import { Server, type Socket } from 'socket.io';
import { ZodError } from 'zod';

import type { AppConfig } from '../config/env';
import type { AuthContext } from '../modules/auth/auth.types';
import type { TokenService } from '../modules/auth/token-service';
import type { CorridaRecord } from '../modules/corridas/corrida.types';
import {
  acompanharCorridaSchema,
  enviarLocalizacaoSocketSchema,
} from '../modules/localizacoes/localizacao.schemas';
import type { LocalizacaoService } from '../modules/localizacoes/localizacao.service';
import type { LocalizacaoRecord } from '../modules/localizacoes/localizacao.types';
import { AppError } from '../shared/errors/app-error';
import type { RealtimeBus } from './realtime-bus';

type SocketData = {
  auth: AuthContext;
  accessToken: string;
  locationTimestamps: number[];
};

type RealtimeAck<T = unknown> = (response: {
  ok: boolean;
  data?: T;
  erro?: { codigo: string; mensagem: string };
}) => void;

type ClientToServerEvents = {
  'corrida:acompanhar': (payload: unknown, ack: RealtimeAck) => void;
  'corrida:parar-acompanhamento': (payload: unknown, ack: RealtimeAck) => void;
  'localizacao:enviar': (payload: unknown, ack: RealtimeAck) => void;
};

type ServerToClientEvents = {
  'corrida:atualizada': (ride: CorridaRecord) => void;
  'localizacao:atualizada': (location: LocalizacaoRecord) => void;
};

type AdmTaxiSocket = Socket<ClientToServerEvents, ServerToClientEvents, never, SocketData>;

function rideRoom(empresaId: string, corridaId: string): string {
  return `empresa:${empresaId}:corrida:${corridaId}`;
}

function tokenFromSocket(socket: Socket): string | null {
  const authToken = socket.handshake.auth?.token;
  if (typeof authToken === 'string' && authToken) return authToken;
  const authorization = socket.handshake.headers.authorization;
  const [scheme, token] = authorization?.split(' ') ?? [];
  return scheme === 'Bearer' && token ? token : null;
}

function ackError(ack: RealtimeAck, error: unknown): void {
  if (error instanceof AppError) {
    ack({ ok: false, erro: { codigo: error.code, mensagem: error.message } });
    return;
  }
  if (error instanceof ZodError) {
    ack({ ok: false, erro: { codigo: 'DADOS_INVALIDOS', mensagem: 'Revise os dados informados.' } });
    return;
  }
  ack({ ok: false, erro: { codigo: 'ERRO_INTERNO', mensagem: 'Nao foi possivel concluir a operacao.' } });
}

function assertSocketRate(socket: AdmTaxiSocket): void {
  const now = Date.now();
  socket.data.locationTimestamps = socket.data.locationTimestamps.filter((timestamp) => now - timestamp < 60_000);
  if (socket.data.locationTimestamps.length >= 30) {
    throw new AppError(429, 'LIMITE_EXCEDIDO', 'Aguarde antes de enviar uma nova localizacao.');
  }
  socket.data.locationTimestamps.push(now);
}

export function attachSocketServer(
  server: HttpServer,
  config: Pick<AppConfig, 'appOrigins'>,
  tokens: TokenService,
  locations: LocalizacaoService,
  realtime: RealtimeBus,
  logger: Logger,
): Server {
  const io = new Server<ClientToServerEvents, ServerToClientEvents, never, SocketData>(server, {
    serveClient: false,
    cors: { origin: config.appOrigins, credentials: true },
  });

  io.use((socket, next) => {
    const token = tokenFromSocket(socket);
    if (!token) {
      next(new Error('NAO_AUTORIZADO'));
      return;
    }
    try {
      const session = tokens.verifyAccessSession(token);
      socket.data.auth = session.auth;
      socket.data.accessToken = token;
      socket.data.locationTimestamps = [];
      const expiresIn = Math.max(0, session.expiresAt.getTime() - Date.now());
      setTimeout(() => socket.disconnect(true), expiresIn + 250).unref();
      next();
    } catch {
      next(new Error('NAO_AUTORIZADO'));
    }
  });

  io.on('connection', (socket) => {
    socket.on('corrida:acompanhar', (raw: unknown, ack: RealtimeAck) => {
      void (async () => {
        try {
          tokens.verifyAccess(socket.data.accessToken);
          const { corridaId } = acompanharCorridaSchema.parse(raw);
          const snapshot = await locations.snapshot(socket.data.auth, corridaId);
          await socket.join(rideRoom(socket.data.auth.empresaId, corridaId));
          ack({ ok: true, data: snapshot });
        } catch (error) {
          ackError(ack, error);
        }
      })();
    });

    socket.on('corrida:parar-acompanhamento', (raw: unknown, ack: RealtimeAck) => {
      try {
        const { corridaId } = acompanharCorridaSchema.parse(raw);
        void socket.leave(rideRoom(socket.data.auth.empresaId, corridaId));
        ack({ ok: true, data: null });
      } catch (error) {
        ackError(ack, error);
      }
    });

    socket.on('localizacao:enviar', (raw: unknown, ack: RealtimeAck) => {
      void (async () => {
        try {
          tokens.verifyAccess(socket.data.accessToken);
          assertSocketRate(socket);
          const input = enviarLocalizacaoSocketSchema.parse(raw);
          const { corridaId, ...location } = input;
          const created = await locations.create(socket.data.auth, corridaId, location);
          ack({ ok: true, data: created });
        } catch (error) {
          ackError(ack, error);
        }
      })();
    });
  });

  realtime.onLocation((location) => {
    io.to(rideRoom(location.empresaId, location.corridaId)).emit('localizacao:atualizada', location);
  });
  realtime.onRide((ride) => {
    const room = rideRoom(ride.empresaId, ride.id);
    io.to(room).emit('corrida:atualizada', ride);
    if (ride.status === 'FINALIZADA' || ride.status === 'CANCELADA') {
      io.in(room).socketsLeave(room);
    }
  });

  io.engine.on('connection_error', (error) => {
    logger.warn({ code: error.code }, 'Conexao Socket.IO recusada');
  });

  return io;
}
