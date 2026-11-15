import { signInternal, SIG_HEADER, TS_HEADER } from './internal-sig.ts';
import type { GameRooms } from './spaces.service.ts';

export type GameRoomsConfig = {
  /** Where the game server listens for our signed calls (http://host:2567). */
  baseUrl: string;
  /** What apps connect to (ws://host:2567). Defaults to the base URL with the scheme swapped. */
  publicUrl?: string;
  secret: string;
  fetch?: typeof fetch;
};

/** Asks the Colyseus game server for the room of a started match. Idempotent: the same match, the same room. */
export class HttpGameRooms implements GameRooms {
  readonly publicUrl: string;
  private readonly base: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly config: GameRoomsConfig) {
    this.base = config.baseUrl.replace(/\/$/, '');
    this.publicUrl = (config.publicUrl ?? this.base.replace(/^http/, 'ws')).replace(/\/$/, '');
    this.doFetch = config.fetch ?? fetch;
  }

  async ensureRoom(matchId: string): Promise<{ roomId: string }> {
    const body = JSON.stringify({ matchId });
    const ts = Date.now();
    const res = await this.doFetch(`${this.base}/internal/rooms`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [TS_HEADER]: String(ts),
        [SIG_HEADER]: signInternal(this.config.secret, ts, body),
      },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`game server answered ${res.status}`);
    const json = (await res.json()) as { roomId?: unknown };
    if (typeof json.roomId !== 'string') throw new Error('game server sent no roomId');
    return { roomId: json.roomId };
  }
}

/** Used when no game server is configured: rooms can't start, everything else about Spaces still works. */
export class NoGameRooms implements GameRooms {
  readonly publicUrl = '';
  ensureRoom(): Promise<{ roomId: string }> {
    return Promise.reject(new Error('no game server configured'));
  }
}
