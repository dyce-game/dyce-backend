import { Room, ServerError, type Client } from '@colyseus/core';
import { z } from 'zod';
import { liveGame, type LiveGame } from '@dyce/games';
import { LIVE_CLOSE_REPLACED, type LiveError } from '@dyce/shared';
import type { TokenVerifier } from './auth.ts';
import { LiveMatch, type LiveMatchOptions, type MoveResult, type Scheduler } from './live-match.ts';
import { PartyMatch } from './party-match.ts';
import type { LiveMatchStore } from './store.ts';

export type RoomDeps = {
  store: LiveMatchStore;
  tokens: TokenVerifier;
  scheduler: Scheduler;
  options: LiveMatchOptions;
  /** How long a finished table stays open so everybody can look at the result. */
  lingerMs: number;
  log: (msg: string, extra?: unknown) => void;
  /** The live game registry (tests swap in games with short timers). */
  games?: (slug: string) => LiveGame | null;
};

const moveSchema = z.object({
  expectedVersion: z.number().int().min(0).max(1_000_000).optional(),
  action: z.unknown(),
});
const chatSchema = z.object({ text: z.string().max(400) });

type Auth = { userId: string };

/**
 * A Colyseus room is the network end of a match: it authenticates people against the seats, turns their
 * messages into moves, and sends each seat its own `LiveState` after every change. All rules, timers and
 * persistence live in the match class: `LiveMatch` for turn games (Whot!, Crazy Cards) and `PartyMatch` for
 * party games. The room id is the match id, and nothing is held that the database does not also hold, so a
 * lost room is rebuilt from the match row (`ensureRoom`).
 *
 * Messages in: `move`, `chat` (party), `sync`, `leave`. Messages out: `state`, `error`, `chat`,
 * `chat_history` (docs/PARTY_ROOM_PROTOCOL.md).
 */
export function makeLiveRoom(deps: RoomDeps) {
  const registry = deps.games ?? liveGame;
  return class LiveRoom extends Room<object, object, object, Auth> {
    // Room for a seat's old connection to still be around while its replacement joins.
    override maxClients = 24;
    override autoDispose = false;

    private turns: LiveMatch | null = null;
    private party: PartyMatch | null = null;
    private readonly byUser = new Map<string, Client>();
    private lingerTimer: unknown = null;

    private get matchId(): string {
      return (this.turns ?? this.party)!.matchId;
    }

    private hasSeat(userId: string): boolean {
      return (this.turns ?? this.party)!.hasSeat(userId);
    }

    override async onCreate(options: { matchId?: unknown }): Promise<void> {
      const matchId = z.uuid().safeParse(options.matchId);
      if (!matchId.success) throw new ServerError(4400, 'matchId required');
      const loaded = await deps.store.load(matchId.data);
      if (!loaded) throw new ServerError(4404, 'match not running');
      const game = registry(loaded.gameSlug);
      if (!game) throw new ServerError(4404, 'unknown game');

      this.roomId = loaded.matchId; // one room per match: the API and the app can always find it
      this.setPrivate(true);
      const onError = (err: unknown) => deps.log(`match ${loaded.matchId} error`, err);
      if (game.kind === 'turns') {
        this.turns = new LiveMatch(
          loaded,
          game,
          deps.store,
          deps.scheduler,
          (m) => this.broadcastState(m),
          deps.options,
          onError,
        );
      } else {
        this.party = new PartyMatch(
          loaded,
          game,
          deps.store,
          deps.scheduler,
          {
            state: (userId, s) => this.sendTo(userId, 'state', s),
            chat: (userId, c) => this.sendTo(userId, 'chat', c),
            stream: (userId, m) => this.sendTo(userId, 'canvas', m),
            finished: () => this.scheduleClose(),
          },
          deps.options,
          onError,
        );
      }
      this.onMessage('move', (client, raw: unknown) => void this.onMove(client, raw));
      this.onMessage('chat', (client, raw: unknown) => this.onChat(client, raw));
      this.onMessage('leave', (client) => {
        const userId = client.userData && (client.userData as Auth).userId;
        if (userId) void (this.turns ?? this.party)!.forfeit(userId);
      });
      this.onMessage('sync', (client) => this.sendState(client));
      (this.turns ?? this.party)!.start();
    }

    override async onAuth(_client: Client, options: { token?: unknown }): Promise<Auth> {
      const userId = await deps.tokens.userId(options?.token);
      if (!userId) throw new ServerError(4401, 'unauthorized');
      if (!this.hasSeat(userId)) throw new ServerError(4403, 'not seated');
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
      (this.turns ?? this.party)!.setConnected(auth.userId, true);
      this.sendState(client);
      if (this.party) {
        try {
          client.send('chat_history', this.party.chatHistoryFor(auth.userId));
        } catch {
          // closing
        }
      }
    }

    override onLeave(client: Client): void {
      const userId = (client.userData as Auth | undefined)?.userId;
      if (!userId || this.byUser.get(userId) !== client) return; // replaced by a newer connection
      this.byUser.delete(userId);
      (this.turns ?? this.party)!.setConnected(userId, false);
    }

    override onDispose(): void {
      if (this.lingerTimer !== null) deps.scheduler.clearTimeout(this.lingerTimer);
      this.turns?.dispose();
      this.party?.dispose();
    }

    private async onMove(client: Client, raw: unknown): Promise<void> {
      const userId = (client.userData as Auth | undefined)?.userId;
      const parsed = moveSchema.safeParse(raw);
      if (!userId || !parsed.success) {
        this.sendError(client, { code: 'invalid_action' });
        return;
      }
      const { expectedVersion, action } = parsed.data;
      try {
        let r: MoveResult;
        if (this.turns) {
          // A turn game needs the version the player was looking at (a stale move is refused).
          if (expectedVersion === undefined) {
            this.sendError(client, { code: 'invalid_action' });
            return;
          }
          r = await this.turns.submit(userId, expectedVersion, action);
        } else {
          r = await this.party!.submit(userId, expectedVersion, action);
        }
        if (!r.ok) {
          this.sendError(client, {
            code: r.reason ? `${r.code}:${r.reason}` : r.code,
            ...(expectedVersion === undefined ? {} : { expectedVersion }),
          });
          // A stale or refused move usually means the app is behind: bring it up to date.
          if (r.code !== 'rate_limited') this.sendState(client);
        }
      } catch (err) {
        deps.log(`match ${this.matchId} move failed`, err);
        this.sendError(client, {
          code: 'server_error',
          ...(expectedVersion === undefined ? {} : { expectedVersion }),
        });
        this.sendState(client);
      }
    }

    private onChat(client: Client, raw: unknown): void {
      const userId = (client.userData as Auth | undefined)?.userId;
      const parsed = chatSchema.safeParse(raw);
      if (!userId || !parsed.success || !this.party) {
        this.sendError(client, { code: this.party ? 'invalid_action' : 'chat_closed' });
        return;
      }
      const r = this.party.chat(userId, parsed.data.text);
      if (!r.ok) this.sendError(client, { code: r.code });
    }

    private sendError(client: Client, e: LiveError): void {
      try {
        client.send('error', e);
      } catch {
        // closing
      }
    }

    private sendTo(userId: string, type: string, body: unknown): void {
      const client = this.byUser.get(userId);
      if (!client) return;
      try {
        client.send(type, body);
      } catch {
        // closing
      }
    }

    private sendState(client: Client): void {
      const userId = (client.userData as Auth | undefined)?.userId;
      if (!userId) return;
      if (this.party) {
        this.party.sendState(userId);
        return;
      }
      try {
        client.send('state', this.turns!.stateFor(userId));
      } catch {
        // closing
      }
    }

    private broadcastState(m: LiveMatch): void {
      for (const [, client] of this.byUser) this.sendState(client);
      if (m.status === 'finished') this.scheduleClose();
    }

    /** Leave the table up a little so everyone sees the result, then close the room. */
    private scheduleClose(): void {
      if (this.lingerTimer !== null) return;
      this.lingerTimer = deps.scheduler.setTimeout(() => {
        void this.disconnect();
      }, deps.lingerMs);
    }
  };
}
