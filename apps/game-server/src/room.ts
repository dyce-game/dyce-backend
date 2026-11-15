import { Room, ServerError, type Client } from '@colyseus/core';
import { z } from 'zod';
import { liveGame } from '@dyce/games';
import { LIVE_CLOSE_REPLACED, type LiveError } from '@dyce/shared';
import type { TokenVerifier } from './auth.ts';
import { LiveMatch, type LiveMatchOptions, type Scheduler } from './live-match.ts';
import type { LiveMatchStore } from './store.ts';

export type RoomDeps = {
  store: LiveMatchStore;
  tokens: TokenVerifier;
  scheduler: Scheduler;
  options: LiveMatchOptions;
  /** How long a finished table stays open so everybody can look at the result. */
  lingerMs: number;
  log: (msg: string, extra?: unknown) => void;
};

const moveSchema = z.object({
  expectedVersion: z.number().int().min(0).max(1_000_000),
  action: z.unknown(),
});

type Auth = { userId: string };

/**
 * A Colyseus room is the network end of a `LiveMatch`: it authenticates people against the seats, turns
 * their messages into moves, and sends each seat its own `LiveState` after every change. All rules,
 * timers and persistence live in `LiveMatch`. The room id is the match id, and nothing is held that the
 * database does not also hold, so a lost room is rebuilt from the match row (`ensureRoom`).
 */
export function makeLiveRoom(deps: RoomDeps) {
  return class LiveRoom extends Room<object, object, object, Auth> {
    // Room for a seat's old connection to still be around while its replacement joins.
    override maxClients = 16;
    override autoDispose = false;

    private match!: LiveMatch;
    private readonly byUser = new Map<string, Client>();
    private lingerTimer: unknown = null;

    override async onCreate(options: { matchId?: unknown }): Promise<void> {
      const matchId = z.uuid().safeParse(options.matchId);
      if (!matchId.success) throw new ServerError(4400, 'matchId required');
      const loaded = await deps.store.load(matchId.data);
      if (!loaded) throw new ServerError(4404, 'match not running');
      const game = liveGame(loaded.gameSlug);
      if (!game) throw new ServerError(4404, 'unknown game');

      this.roomId = loaded.matchId; // one room per match: the API and the app can always find it
      this.setPrivate(true);
      this.match = new LiveMatch(
        loaded,
        game,
        deps.store,
        deps.scheduler,
        (m) => this.broadcastState(m),
        deps.options,
        (err) => deps.log(`match ${loaded.matchId} error`, err),
      );
      this.onMessage('move', (client, raw: unknown) => void this.onMove(client, raw));
      this.onMessage('leave', (client) => {
        const userId = client.userData && (client.userData as Auth).userId;
        if (userId) void this.match.forfeit(userId);
      });
      this.onMessage('sync', (client) => this.sendState(client));
      this.match.start();
    }

    override async onAuth(_client: Client, options: { token?: unknown }): Promise<Auth> {
      const userId = await deps.tokens.userId(options?.token);
      if (!userId) throw new ServerError(4401, 'unauthorized');
      if (!this.match.hasSeat(userId)) throw new ServerError(4403, 'not seated');
      return { userId };
    }

    override onJoin(client: Client, _options: unknown, auth: Auth): void {
      client.userData = auth;
      const old = this.byUser.get(auth.userId);
      this.byUser.set(auth.userId, client);
      if (old && old !== client) {
        try {
          old.leave(LIVE_CLOSE_REPLACED);
        } catch {
          // already gone
        }
      }
      this.match.setConnected(auth.userId, true);
      this.sendState(client);
    }

    override onLeave(client: Client): void {
      const userId = (client.userData as Auth | undefined)?.userId;
      if (!userId || this.byUser.get(userId) !== client) return; // replaced by a newer connection
      this.byUser.delete(userId);
      this.match.setConnected(userId, false);
    }

    override onDispose(): void {
      if (this.lingerTimer !== null) deps.scheduler.clearTimeout(this.lingerTimer);
      this.match?.dispose();
    }

    private async onMove(client: Client, raw: unknown): Promise<void> {
      const userId = (client.userData as Auth | undefined)?.userId;
      const parsed = moveSchema.safeParse(raw);
      if (!userId || !parsed.success) {
        this.sendError(client, { code: 'invalid_action' });
        return;
      }
      try {
        const r = await this.match.submit(userId, parsed.data.expectedVersion, parsed.data.action);
        if (!r.ok) {
          this.sendError(client, {
            code: r.reason ? `${r.code}:${r.reason}` : r.code,
            expectedVersion: parsed.data.expectedVersion,
          });
          // A stale or refused move usually means the app is behind: bring it up to date.
          this.sendState(client);
        }
      } catch (err) {
        deps.log(`match ${this.match.matchId} move failed`, err);
        this.sendError(client, {
          code: 'server_error',
          expectedVersion: parsed.data.expectedVersion,
        });
        this.sendState(client);
      }
    }

    private sendError(client: Client, e: LiveError): void {
      try {
        client.send('error', e);
      } catch {
        // closing
      }
    }

    private sendState(client: Client): void {
      const userId = (client.userData as Auth | undefined)?.userId;
      if (!userId) return;
      try {
        client.send('state', this.match.stateFor(userId));
      } catch {
        // closing
      }
    }

    private broadcastState(m: LiveMatch): void {
      for (const [, client] of this.byUser) this.sendState(client);
      if (m.status === 'finished' && this.lingerTimer === null) {
        // Leave the table up a little so everyone sees the result, then close the room.
        this.lingerTimer = deps.scheduler.setTimeout(() => {
          void this.disconnect();
        }, deps.lingerMs);
      }
    }
  };
}
