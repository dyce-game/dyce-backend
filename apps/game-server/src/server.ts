import http from 'node:http';
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import type pg from 'pg';
import { TokenVerifier } from './auth.ts';
import { SIG_HEADER, TS_HEADER, verifyInternal } from './internal-sig.ts';
import {
  DEFAULT_OPTIONS,
  realScheduler,
  type LiveMatchOptions,
  type Scheduler,
} from './live-match.ts';
import { makeLiveRoom } from './room.ts';
import { PgLiveMatchStore, type LiveMatchStore } from './store.ts';

export type GameServerConfig = {
  pool: pg.Pool;
  /** Same secret as the API's JWT_SECRET: tokens it issued are what get people into rooms. */
  jwtSecret: string;
  /** Shared with the API: signs the room requests it sends here. */
  internalSecret: string;
  options?: Partial<LiveMatchOptions>;
  scheduler?: Scheduler;
  /** Tests pass a store of their own; production uses Postgres. */
  store?: LiveMatchStore;
  /** How long a finished table stays open. */
  lingerMs?: number;
  log?: (msg: string, extra?: unknown) => void;
};

export type GameServer = {
  /** Resolves with the port actually bound. */
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
  /** Makes sure the match has a room and returns its id (which is the match id). */
  ensureRoom(matchId: string): Promise<string>;
  http: http.Server;
};

const ROOM = 'live';
const MAX_BODY = 4096;

/**
 * The Colyseus game server (ARCHITECTURE section 5): one room per live match. Besides the Colyseus
 * matchmaking and WebSocket routes it serves `GET /health` and the API's signed `POST /internal/rooms`.
 */
export function createGameServer(config: GameServerConfig): GameServer {
  const log = config.log ?? ((msg, extra) => console.warn(msg, extra ?? ''));
  const store = config.store ?? new PgLiveMatchStore(config.pool);
  const scheduler = config.scheduler ?? realScheduler;
  const options = { ...DEFAULT_OPTIONS, ...config.options };
  const tokens = new TokenVerifier(config.jwtSecret);
  if (config.internalSecret.length < 32)
    throw new Error('INTERNAL_SECRET must be at least 32 characters');

  const inflight = new Map<string, Promise<string>>();

  async function ensureRoom(matchId: string): Promise<string> {
    if (matchMaker.getLocalRoomById(matchId)) return matchId;
    const pending = inflight.get(matchId);
    if (pending) return pending;
    const p = (async () => {
      // A second check inside the guard: another caller may have created it while we were waiting.
      if (matchMaker.getLocalRoomById(matchId)) return matchId;
      const room = await matchMaker.createRoom(ROOM, { matchId });
      return room.roomId;
    })().finally(() => inflight.delete(matchId));
    inflight.set(matchId, p);
    return p;
  }

  const httpServer = http.createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log('request failed', err);
      if (!res.headersSent) respond(res, 500, { error: 'internal' });
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && url === '/health') return respond(res, 200, { ok: true });
    if (req.method === 'POST' && url === '/internal/rooms') {
      const body = await readBody(req);
      if (
        body === null ||
        !verifyInternal(
          config.internalSecret,
          header(req, TS_HEADER),
          header(req, SIG_HEADER),
          body,
        )
      ) {
        return respond(res, 401, { error: 'unauthorized' });
      }
      let matchId: unknown;
      try {
        matchId = (JSON.parse(body) as { matchId?: unknown }).matchId;
      } catch {
        return respond(res, 400, { error: 'bad_request' });
      }
      if (typeof matchId !== 'string' || !/^[0-9a-f-]{36}$/i.test(matchId)) {
        return respond(res, 400, { error: 'bad_request' });
      }
      try {
        const roomId = await ensureRoom(matchId);
        return respond(res, 200, { roomId });
      } catch (err) {
        const code = (err as { code?: number }).code;
        if (code === 4404) return respond(res, 404, { error: 'match_not_running' });
        throw err;
      }
    }
    return respond(res, 404, { error: 'not_found' });
  }

  const colyseus = new Server({
    transport: new WebSocketTransport({ server: httpServer }),
    greet: false,
    gracefullyShutdown: false, // main.ts owns process signals
  });
  colyseus.define(
    ROOM,
    makeLiveRoom({
      store,
      tokens,
      scheduler,
      options,
      lingerMs: config.lingerMs ?? 45_000,
      log,
    }),
  );

  return {
    http: httpServer,
    ensureRoom,
    async listen(port, host) {
      await colyseus.listen(port, host);
      const addr = httpServer.address();
      return typeof addr === 'object' && addr ? addr.port : port;
    },
    async close() {
      await colyseus.gracefullyShutdown(false);
    },
  };
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function respond(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
}

/** The request body as text, or null if it is larger than a room request ever is. */
function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
