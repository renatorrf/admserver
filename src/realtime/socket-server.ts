import type { Server as HttpServer } from 'node:http';

import type { Logger } from 'pino';
import { Server, type Socket } from 'socket.io';
import { ZodError } from 'zod';

import type { AppConfig } from '../config/env';
import type { Database } from '../db/pool';
import type { AuthContext } from '../modules/auth/auth.types';
import { driverMemberships } from '../modules/auth/driver-scope';
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
import type { CorridaRealtimeEvent, FaturamentoRealtimeEvent, FaturamentoRealtimePayload } from './realtime-bus';

type SocketData = {
  auth: AuthContext;
  accessToken: string;
  accessTokenExpiresAt: number;
  locationTimestamps: number[];
};

type RealtimeAck<T = unknown> = (response: {
  ok: boolean;
  data?: T;
  erro?: { codigo: string; mensagem: string };
}) => void;

type ClientToServerEvents = {
  'corrida:acompanhar': (payload: unknown, ack?: RealtimeAck) => void;
  'corrida:parar-acompanhamento': (payload: unknown, ack?: RealtimeAck) => void;
  'localizacao:enviar': (payload: unknown, ack?: RealtimeAck) => void;
};

type RideInvalidation = Pick<CorridaRecord, 'id' | 'empresaId' | 'status' | 'itinerarioVersao' | 'atualizadoEm'>;
type ServerToClientEvents = {
  'corrida:atualizada': (ride: RideInvalidation) => void;
  'corrida:criada': (ride: RideInvalidation) => void;
  'corrida:ofertada': (ride: RideInvalidation) => void;
  'corrida:aceita': (ride: RideInvalidation) => void;
  'corrida:status-alterado': (ride: RideInvalidation) => void;
  'corrida:finalizada': (ride: RideInvalidation) => void;
  'corrida:cancelada': (ride: RideInvalidation) => void;
  'corrida:valor-alterado': (ride: RideInvalidation) => void;
  'corrida:lista-invalidada': (payload: { corridaId: string }) => void;
  'faturamento:criado': (payload: FaturamentoRealtimePayload) => void;
  'faturamento:cancelado': (payload: FaturamentoRealtimePayload) => void;
  'localizacao:atualizada': (location: LocalizacaoRecord) => void;
  'sessao:expirando': () => void;
};

type AdmTaxiSocket = Socket<ClientToServerEvents, ServerToClientEvents, never, SocketData>;

function rideRoom(empresaId: string, corridaId: string): string {
  return `empresa:${empresaId}:corrida:${corridaId}`;
}

const userRoom = (empresaId: string, usuarioId: string): string => `empresa:${empresaId}:usuario:${usuarioId}`;
const profileRoom = (empresaId: string, profile: string): string => `empresa:${empresaId}:perfil:${profile}`;
const centerRoom = (empresaId: string, centerId: string): string => `empresa:${empresaId}:centro:${centerId}`;
const providerRoom = (empresaId: string, providerId: string): string => `empresa:${empresaId}:prestador:${providerId}`;

function tokenFromSocket(socket: Socket): string | null {
  const authToken = socket.handshake.auth?.token;
  if (typeof authToken === 'string' && authToken) return authToken;
  const authorization = socket.handshake.headers.authorization;
  const [scheme, token] = authorization?.split(' ') ?? [];
  return scheme === 'Bearer' && token ? token : null;
}

function respond<T>(ack: RealtimeAck<T> | undefined, payload: Parameters<RealtimeAck<T>>[0]): void {
  if (typeof ack === 'function') ack(payload);
}

function ackError(ack: RealtimeAck | undefined, error: unknown): void {
  if (error instanceof AppError) {
    respond(ack, { ok: false, erro: { codigo: error.code, mensagem: error.message } });
    return;
  }
  if (error instanceof ZodError) {
    respond(ack, { ok: false, erro: { codigo: 'DADOS_INVALIDOS', mensagem: 'Revise os dados informados.' } });
    return;
  }
  respond(ack, { ok: false, erro: { codigo: 'ERRO_INTERNO', mensagem: 'Nao foi possivel concluir a operacao.' } });
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
  database?: Database,
): Server {
  const io = new Server<ClientToServerEvents, ServerToClientEvents, never, SocketData>(server, {
    serveClient: false,
    cors: { origin: config.appOrigins, credentials: true },
  });

  io.use(async (socket, next) => {
    const token = tokenFromSocket(socket);
    if (!token) {
      next(new Error('NAO_AUTORIZADO'));
      return;
    }
    try {
      const session = tokens.verifyAccessSession(token);
      await tokens.authenticateAccess(token);
      socket.data.auth = session.auth;
      socket.data.accessToken = token;
      socket.data.accessTokenExpiresAt = session.expiresAt.getTime();
      socket.data.locationTimestamps = [];
      next();
    } catch {
      next(new Error('NAO_AUTORIZADO'));
    }
  });

  io.on('connection', (socket) => {
    const expiresIn = Math.max(0, socket.data.accessTokenExpiresAt - Date.now());
    const refreshLeadTime = Math.min(30_000, Math.max(1_000, Math.floor(expiresIn * 0.2)));
    const warningTimer = setTimeout(() => {
      if (socket.connected) socket.emit('sessao:expirando');
    }, Math.max(0, expiresIn - refreshLeadTime));
    const expirationTimer = setTimeout(() => socket.disconnect(true), expiresIn + 250);
    let validatingAccess = false;
    const syncDriverRooms = async () => {
      if (!database || !socket.data.auth.contaMotoristaId) return;
      const members = await driverMemberships(database, socket.data.auth);
      const desired = new Set(members.flatMap(m => [userRoom(m.empresa_id, m.usuario_id), providerRoom(m.empresa_id, m.prestador_id), profileRoom(m.empresa_id, 'PRESTADOR')]));
      for (const room of socket.rooms) {
        if (room.startsWith('empresa:') && !room.includes(':corrida:') && !desired.has(room)) await socket.leave(room);
        if (room.includes(':corrida:') && !members.some(m => room.startsWith(`empresa:${m.empresa_id}:`))) await socket.leave(room);
      }
      await socket.join([...desired]);
    };
    const accessTimer = setInterval(() => {
      if (validatingAccess || !socket.connected) return;
      validatingAccess = true;
      void tokens.authenticateAccess(socket.data.accessToken)
        .then(syncDriverRooms)
        .catch(() => socket.disconnect(true))
        .finally(() => { validatingAccess = false; });
    }, 15_000);
    accessTimer.unref();
    warningTimer.unref();
    expirationTimer.unref();
    socket.once('disconnect', () => {
      clearTimeout(warningTimer);
      clearTimeout(expirationTimer);
      clearInterval(accessTimer);
    });

    void socket.join(userRoom(socket.data.auth.empresaId, socket.data.auth.usuarioId));
    if (socket.data.auth.perfil === 'GESTOR') {
      void socket.join(profileRoom(socket.data.auth.empresaId, 'GESTOR'));
    }
    if (database && socket.data.auth.perfil === 'GERENTE') {
      void database.query<{ centro_custo_id: string }>(
        `SELECT gcc.centro_custo_id FROM admtaxi.gerente_centros_custo gcc
         JOIN admtaxi.centros_custo cc ON cc.empresa_id=gcc.empresa_id AND cc.id=gcc.centro_custo_id AND cc.ativo=TRUE
         JOIN admtaxi.setores s ON s.empresa_id=cc.empresa_id AND s.id=cc.setor_id AND s.ativo=TRUE
         JOIN admtaxi.gerente_setores gs ON gs.empresa_id=gcc.empresa_id
           AND gs.gerente_usuario_id=gcc.gerente_usuario_id AND gs.setor_id=cc.setor_id
         WHERE gcc.empresa_id=$1 AND gcc.gerente_usuario_id=$2`,
        [socket.data.auth.empresaId, socket.data.auth.usuarioId],
      ).then((result) => socket.join(result.rows.map((row) => centerRoom(socket.data.auth.empresaId, row.centro_custo_id))))
        .catch(() => socket.disconnect(true));
    }
    if (database && socket.data.auth.contaMotoristaId) {
      void syncDriverRooms().catch(() => socket.disconnect(true));
    } else if (database && socket.data.auth.perfil === 'PRESTADOR') {
      void database.query<{ id: string }>(
        'SELECT id FROM admtaxi.prestadores WHERE empresa_id=$1 AND usuario_id=$2 AND ativo=TRUE',
        [socket.data.auth.empresaId, socket.data.auth.usuarioId],
      ).then((result) => result.rows[0]?.id
        ? socket.join([
          providerRoom(socket.data.auth.empresaId, result.rows[0].id),
          profileRoom(socket.data.auth.empresaId, 'PRESTADOR'),
        ]) : undefined)
        .catch(() => socket.disconnect(true));
    }
    socket.on('corrida:acompanhar', (raw: unknown, ack?: RealtimeAck) => {
      void (async () => {
        const startedAt = Date.now();
        try {
          await tokens.authenticateAccess(socket.data.accessToken);
          const { corridaId } = acompanharCorridaSchema.parse(raw);
          const snapshot = await locations.snapshot(socket.data.auth, corridaId);
          await socket.join(rideRoom(snapshot.corrida.empresaId, corridaId));
          respond(ack, { ok: true, data: snapshot });
        } catch (error) {
          ackError(ack, error);
        } finally {
          const durationMs = Date.now() - startedAt;
          if (durationMs >= 5_000) {
            logger.warn({ corridaId: acompanharCorridaSchema.safeParse(raw).data?.corridaId, durationMs }, 'Snapshot de corrida lento');
          }
        }
      })();
    });

    socket.on('corrida:parar-acompanhamento', (raw: unknown, ack?: RealtimeAck) => {
      try {
        const { corridaId } = acompanharCorridaSchema.parse(raw);
        for (const room of socket.rooms) if (room.endsWith(`:corrida:${corridaId}`)) void socket.leave(room);
        respond(ack, { ok: true, data: null });
      } catch (error) {
        ackError(ack, error);
      }
    });

    socket.on('localizacao:enviar', (raw: unknown, ack?: RealtimeAck) => {
      void (async () => {
        try {
          await tokens.authenticateAccess(socket.data.accessToken);
          assertSocketRate(socket);
          const input = enviarLocalizacaoSocketSchema.parse(raw);
          const { corridaId, ...location } = input;
          const created = await locations.create(socket.data.auth, corridaId, location);
          respond(ack, { ok: true, data: created });
        } catch (error) {
          ackError(ack, error);
        }
      })();
    });
  });

  realtime.onLocation((location) => {
    const room = rideRoom(location.empresaId, location.corridaId);
    // Assignment and sector membership can change while a socket remains open.
    void (async () => {
      const watchers = await io.in(room).fetchSockets();
      await Promise.all(watchers.map(async watcher => {
        try {
          await tokens.authenticateAccess(watcher.data.accessToken);
          const snapshot = await locations.snapshot(watcher.data.auth, location.corridaId);
          if (watcher.data.auth.perfil === 'FUNCIONARIO' && snapshot.corrida.acompanhamentoLiberado === false) return;
          if (watcher.rooms.has(room)) watcher.emit('localizacao:atualizada', location);
        } catch { await watcher.leave(room); }
      }));
    })().catch(() => logger.warn({ corridaId: location.corridaId }, 'Falha ao distribuir localizacao autorizada'));
  });
  realtime.onRide((ride, event) => {
    void (async () => {
      const rooms = new Set<string>([
        rideRoom(ride.empresaId, ride.id), profileRoom(ride.empresaId, 'GESTOR'),
        centerRoom(ride.empresaId, ride.centroCustoId), userRoom(ride.empresaId, ride.solicitanteUsuarioId),
      ]);
      if (ride.prestadorId) rooms.add(providerRoom(ride.empresaId, ride.prestadorId));
      if (database) {
        const users = await database.query<{ funcionario_usuario_id: string | null; prestador_usuario_id: string | null }>(
          `SELECT f.usuario_id AS funcionario_usuario_id,p.usuario_id AS prestador_usuario_id
           FROM admtaxi.corridas c
           JOIN admtaxi.funcionarios f ON f.empresa_id=c.empresa_id AND (
             f.id=c.funcionario_id OR EXISTS (SELECT 1 FROM admtaxi.corrida_participacoes cp
               WHERE cp.empresa_id=c.empresa_id AND cp.corrida_id=c.id AND cp.funcionario_id=f.id) OR EXISTS (
               SELECT 1 FROM admtaxi.corrida_paradas cp
                WHERE cp.empresa_id=c.empresa_id AND cp.corrida_id=c.id AND cp.funcionario_id=f.id
             )
           )
           LEFT JOIN admtaxi.prestadores p ON p.empresa_id=c.empresa_id AND p.id=c.prestador_id
           WHERE c.empresa_id=$1 AND c.id=$2`, [ride.empresaId, ride.id],
        );
        for (const audience of users.rows) {
          if (audience.funcionario_usuario_id) rooms.add(userRoom(ride.empresaId, audience.funcionario_usuario_id));
          if (audience.prestador_usuario_id) rooms.add(userRoom(ride.empresaId, audience.prestador_usuario_id));
        }
      }
      const targets = [...rooms];
      // Rooms carry invalidation only; HTTP/snapshot access resolves personal data per recipient.
      const update = { id: ride.id, empresaId: ride.empresaId, status: ride.status,
        itinerarioVersao: ride.itinerarioVersao, atualizadoEm: ride.atualizadoEm };
      io.to(targets).emit('corrida:atualizada', update);
      io.to(targets).emit(event as CorridaRealtimeEvent, update);
      if (event === 'corrida:criada' || event === 'corrida:aceita' || event === 'corrida:cancelada') {
        io.to(profileRoom(ride.empresaId, 'PRESTADOR')).emit('corrida:lista-invalidada', { corridaId: ride.id });
      }
      if (ride.status === 'FINALIZADA' || ride.status === 'CANCELADA') {
        io.in(rideRoom(ride.empresaId, ride.id)).socketsLeave(rideRoom(ride.empresaId, ride.id));
      }
    })().catch(() => logger.warn({ corridaId: ride.id }, 'Falha ao distribuir atualizacao de corrida'));
  });
  realtime.onBilling((event, payload) => {
    const rooms = [profileRoom(payload.empresaId, 'GESTOR')];
    if (payload.prestadorId) rooms.push(providerRoom(payload.empresaId, payload.prestadorId));
    io.to(rooms).emit(event as FaturamentoRealtimeEvent, payload);
  });

  io.engine.on('connection_error', (error) => {
    logger.warn({ code: error.code }, 'Conexao Socket.IO recusada');
  });

  return io;
}
