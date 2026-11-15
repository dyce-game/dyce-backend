import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type pg from 'pg';
import {
  parseAvatar,
  type CreateMatchRequest,
  type GameCardPayload,
  type GameInfo,
  type GamesResponse,
  type MatchMode,
  type MatchPlayer,
  type MatchPlayerResult,
  type MatchStatus,
  type MatchView,
  type Message,
  type RealtimeEvent,
  type SubmitMoveRequest,
} from '@dyce/shared';
import { AuthError } from '../auth/auth-error.ts';
import type { Clock } from '../auth/tokens.ts';
import { readConfigInt } from '../db/config.ts';
import { withTx } from '../db/tx.ts';
import { lockPair } from '../social/relationship.ts';
import { ENGINES, type EngineEntry } from './engines.ts';

/** Where live events go (the WebSocket hub; tests pass a recorder). */
export interface MatchPublisher {
  publish(userIds: readonly string[], event: RealtimeEvent): void;
}

/** The slice of the chat service a match needs: who you can play with, and the card in the thread. */
export interface MatchChat {
  playablePeer(
    userId: string,
    conversationId: string,
  ): Promise<{ peerId: string; friends: boolean }>;
  postCard(
    conversationId: string,
    senderId: string,
    input: { id: string; kind: 'game'; body: string; payload: GameCardPayload },
  ): Promise<Message>;
  updateGameCard(matchId: string, payload: GameCardPayload): Promise<void>;
}

export type MatchesOptions = {
  /** Offer and run engines marked `devOnly` (the reference game). False in production. */
  allowDevGames: boolean;
  engines?: Record<string, EngineEntry>;
};

type MatchRow = {
  id: string;
  game_slug: string;
  game_name: string;
  mode: MatchMode;
  stake_kobo: string;
  status: MatchStatus;
  conversation_id: string | null;
  seed: string;
  state: unknown;
  state_version: number;
  current_turn: string | null;
  created_by: string;
  created_at: Date;
  finished_at: Date | null;
  invite_expires_at: Date | null;
};

type PlayerRow = {
  user_id: string;
  seat: number;
  accepted_at: Date | null;
  result: MatchPlayerResult | null;
  placement: number | null;
  username: string;
  display_name: string;
  avatar: unknown;
};

type Db = Pick<pg.Pool, 'query'>;

const MATCH_COLUMNS = `m.id, m.game_slug, g.name AS game_name, m.mode, m.stake_kobo, m.status, m.conversation_id,
  m.seed, m.state, m.state_version, m.current_turn, m.created_by, m.created_at, m.finished_at,
  m.invite_expires_at`;

/**
 * Async 1v1 matches played from a chat card.
 *
 * Lifecycle: the creator sends an invite (a card in the chat) -> the other player accepts (the engine is
 * initialised and the match is active) or declines / lets it expire -> players alternate moves until the
 * engine says it is over -> results are written and the card shows the outcome.
 *
 * The server decides everything: every move is validated and applied with the game's engine under a row
 * lock, `state_version` is the optimistic-concurrency check, and clients only ever receive the engine's
 * `view()` for themselves. Only Free mode exists in this slice; Pool (stakes, escrow, counter-offers) is
 * rejected with `pool_not_available`.
 */
export class MatchesService {
  private readonly engines: Record<string, EngineEntry>;

  constructor(
    private readonly pool: pg.Pool,
    private readonly publisher: MatchPublisher,
    private readonly chat: MatchChat,
    private readonly clock: Clock = () => new Date(),
    private readonly opts: MatchesOptions = { allowDevGames: false },
  ) {
    this.engines = opts.engines ?? ENGINES;
  }

  // ---- catalogue ------------------------------------------------------------------------------

  /** The games you can send from a chat. */
  async listGames(): Promise<GamesResponse> {
    const r = await this.pool.query<{
      slug: string;
      name: string;
      dimension: '2d' | '3d';
      sync: 'async' | 'live';
      min_players: number;
      max_players: number;
      categories: string[];
      supports_pool: boolean;
    }>(
      `SELECT slug, name, dimension, sync, min_players, max_players, categories, supports_pool
         FROM games WHERE enabled ORDER BY name`,
    );
    const games: GameInfo[] = r.rows
      .filter((g) => this.entry(g.slug) !== null)
      .map((g) => ({
        slug: g.slug,
        name: g.name,
        dimension: g.dimension,
        sync: g.sync,
        minPlayers: g.min_players,
        maxPlayers: g.max_players,
        categories: g.categories,
        supportsPool: g.supports_pool,
      }));
    return { games };
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  /**
   * Sends a game to the other person in a chat. Idempotent on `input.id`: a retry returns the same match
   * (and makes sure its card is in the thread) instead of sending a second game.
   */
  async create(userId: string, input: CreateMatchRequest): Promise<MatchView> {
    const mode = input.mode ?? 'free';
    if (mode !== 'free') throw new AuthError('pool_not_available');
    if (this.entry(input.gameSlug) === null) throw new AuthError('game_not_found');

    const { peerId, friends } = await this.chat.playablePeer(userId, input.conversationId);
    if (!friends) throw new AuthError('match_requires_friends');

    const now = this.clock();
    await withTx(this.pool, async (c) => {
      await lockPair(c, userId, peerId);
      const existing = await c.query<{ created_by: string; conversation_id: string | null }>(
        `SELECT created_by, conversation_id FROM matches WHERE id = $1`,
        [input.id],
      );
      const e = existing.rows[0];
      if (e) {
        if (e.created_by !== userId || e.conversation_id !== input.conversationId) {
          throw new AuthError('message_id_taken');
        }
        return; // a retry
      }

      const game = await c.query<{ enabled: boolean }>(
        `SELECT enabled FROM games WHERE slug = $1`,
        [input.gameSlug],
      );
      if (!game.rows[0]?.enabled) throw new AuthError('game_not_found');

      const limit = await readConfigInt(c, 'open_match_invites_per_chat', 5);
      const open = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM matches
          WHERE conversation_id = $1 AND created_by = $2 AND status = 'invited'
            AND invite_expires_at > $3`,
        [input.conversationId, userId, now],
      );
      if (Number(open.rows[0]?.n ?? 0) >= limit) throw new AuthError('open_invites_limit');

      const ttlHours = await readConfigInt(c, 'match_invite_ttl_hours', 24);
      const expires = new Date(now.getTime() + ttlHours * 3_600_000);
      await c.query(
        `INSERT INTO matches (id, game_slug, mode, status, conversation_id, seed, created_by, created_at,
                              invite_expires_at)
         VALUES ($1, $2, 'free', 'invited', $3, $4, $5, $6, $7)`,
        [input.id, input.gameSlug, input.conversationId, newSeed(), userId, now, expires],
      );
      await c.query(
        `INSERT INTO match_players (match_id, user_id, seat, accepted_at) VALUES
           ($1, $2, 1, $4), ($1, $3, 2, NULL)`,
        [input.id, userId, peerId, now],
      );
    });

    const { row, players } = await this.load(this.pool, input.id);
    // Idempotent on the match id, so a retry after a failure here still ends with exactly one card.
    await this.chat.postCard(input.conversationId, userId, {
      id: input.id,
      kind: 'game',
      body: `${row.game_name} · Free`,
      payload: cardPayload(row, players),
    });
    this.publishMatch(row, players);
    return this.toView(row, players, userId);
  }

  /** The other player accepts: the game starts and it is the first player's turn. Idempotent. */
  async accept(userId: string, matchId: string): Promise<MatchView> {
    await this.assertCanInteract(userId, matchId);
    const changed = await withTx(this.pool, async (c) => {
      const { row, players } = await this.lock(c, matchId, userId);
      if (row.status === 'active' || row.status === 'finished') return false; // already accepted
      if (row.created_by === userId) throw new AuthError('cannot_accept_own_invite');
      if (row.status === 'invited' && this.isStale(row)) {
        await this.markExpired(c, matchId);
        return true;
      }
      if (row.status !== 'invited') throw new AuthError('match_not_open');

      const entry = this.engineFor(row.game_slug);
      const state = entry.engine.init(
        players.map((p) => p.user_id),
        BigInt(row.seed),
        entry.cfg,
      );
      const turn = entry.engine.currentPlayers(state)[0] ?? null;
      await c.query(
        `UPDATE match_players SET accepted_at = $3 WHERE match_id = $1 AND user_id = $2`,
        [matchId, userId, this.clock()],
      );
      await c.query(
        `UPDATE matches SET status = 'active', state = $2::jsonb, state_version = 0, current_turn = $3
          WHERE id = $1`,
        [matchId, JSON.stringify(state), turn],
      );
      return true;
    });
    if (changed) await this.afterChange(matchId);
    return this.get(userId, matchId);
  }

  /** The invited player says no. The sender can see it was declined. Idempotent. */
  async decline(userId: string, matchId: string): Promise<MatchView> {
    return this.closeInvite(userId, matchId, 'decline');
  }

  /** The sender takes the invite back. Idempotent. */
  async cancel(userId: string, matchId: string): Promise<MatchView> {
    return this.closeInvite(userId, matchId, 'cancel');
  }

  /** The match as you see it. An invite that ran out of time is marked expired first. */
  async get(userId: string, matchId: string): Promise<MatchView> {
    let { row, players } = await this.load(this.pool, matchId);
    if (!players.some((p) => p.user_id === userId)) throw new AuthError('match_not_found');
    if (row.status === 'invited' && this.isStale(row)) {
      const expired = await withTx(this.pool, async (c) => {
        const locked = await this.lock(c, matchId, userId);
        if (locked.row.status !== 'invited' || !this.isStale(locked.row)) return false;
        await this.markExpired(c, matchId);
        return true;
      });
      if (expired) {
        await this.afterChange(matchId);
        ({ row, players } = await this.load(this.pool, matchId));
      }
    }
    return this.toView(row, players, userId);
  }

  /**
   * One move. `expectedVersion` is the version the player saw: if the match has moved on the move is
   * rejected (`stale_version`, with the current version), except that a repeat of the move that produced
   * the current state is acknowledged as a success so a retry after a lost response is harmless.
   */
  async submitMove(userId: string, matchId: string, input: SubmitMoveRequest): Promise<MatchView> {
    const result = await withTx(this.pool, async (c) => {
      const { row, players } = await this.lock(c, matchId, userId);
      const entry = this.engineFor(row.game_slug);
      const { engine } = entry;

      let action: unknown = input.action;
      if (engine.actionSchema) {
        const parsed = engine.actionSchema.safeParse(input.action);
        if (!parsed.success) throw new AuthError('invalid_action');
        action = parsed.data;
      }

      if (input.expectedVersion !== row.state_version) {
        if (input.expectedVersion < row.state_version) {
          const prior = await c.query<{ user_id: string; action: unknown }>(
            `SELECT user_id, action FROM match_moves WHERE match_id = $1 AND seq = $2`,
            [matchId, input.expectedVersion + 1],
          );
          const p = prior.rows[0];
          if (p && p.user_id === userId && isDeepStrictEqual(p.action, action)) {
            return { changed: false };
          }
        }
        throw new AuthError('stale_version', { currentVersion: row.state_version });
      }

      // A block placed mid-match ends the interaction.
      if (row.conversation_id) await this.chat.playablePeer(userId, row.conversation_id);
      if (row.status !== 'active') throw new AuthError('match_not_open');

      const state = row.state;
      if (!engine.currentPlayers(state).includes(userId)) throw new AuthError('not_your_turn');
      const verdict = engine.validate(state, userId, action);
      if (!verdict.ok) throw new AuthError('illegal_move', { reason: verdict.code });

      const next = engine.apply(state, userId, action);
      const seq = row.state_version + 1;
      await c.query(
        `INSERT INTO match_moves (match_id, seq, user_id, action, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [matchId, seq, userId, JSON.stringify(action), this.clock()],
      );

      const over = engine.isTerminal(next);
      const turn = over ? null : (engine.currentPlayers(next)[0] ?? null);
      await c.query(
        `UPDATE matches SET state = $2::jsonb, state_version = $3, current_turn = $4 WHERE id = $1`,
        [matchId, JSON.stringify(next), seq, turn],
      );

      if (over) {
        const { placements, draw } = engine.result(next);
        const placementOf = new Map<string, number>();
        placements.forEach((group, i) => group.forEach((id) => placementOf.set(id, i + 1)));
        for (const p of players) {
          const placement = placementOf.get(p.user_id) ?? players.length;
          const outcome: MatchPlayerResult = draw ? 'draw' : placement === 1 ? 'win' : 'loss';
          await c.query(
            `UPDATE match_players SET placement = $3, result = $4::match_result
              WHERE match_id = $1 AND user_id = $2`,
            [matchId, p.user_id, placement, outcome],
          );
        }
        // Free: marks the match finished. (Pool will pay out the escrow here.)
        await c.query(`SELECT settle_match($1)`, [matchId]);
      }
      return { changed: true };
    });

    if (result.changed) await this.afterChange(matchId);
    return this.get(userId, matchId);
  }

  // ---- internals ------------------------------------------------------------------------------

  private entry(slug: string): EngineEntry | null {
    const e = this.engines[slug];
    if (!e) return null;
    if (e.devOnly && !this.opts.allowDevGames) return null;
    return e;
  }

  private engineFor(slug: string): EngineEntry {
    const e = this.entry(slug);
    if (!e) throw new AuthError('game_not_found');
    return e;
  }

  private isStale(row: MatchRow): boolean {
    return (
      row.invite_expires_at !== null && row.invite_expires_at.getTime() <= this.clock().getTime()
    );
  }

  private async markExpired(c: pg.PoolClient, matchId: string): Promise<void> {
    await c.query(`UPDATE matches SET status = 'expired' WHERE id = $1 AND status = 'invited'`, [
      matchId,
    ]);
  }

  /** You can only act on a match you're in, and not with someone who blocked you (or you blocked). */
  private async assertCanInteract(userId: string, matchId: string): Promise<void> {
    const { row, players } = await this.load(this.pool, matchId);
    if (!players.some((p) => p.user_id === userId)) throw new AuthError('match_not_found');
    if (row.conversation_id) await this.chat.playablePeer(userId, row.conversation_id);
  }

  private async closeInvite(
    userId: string,
    matchId: string,
    how: 'decline' | 'cancel',
  ): Promise<MatchView> {
    await this.assertCanInteract(userId, matchId);
    const changed = await withTx(this.pool, async (c) => {
      const { row } = await this.lock(c, matchId, userId);
      const mine = row.created_by === userId;
      if (how === 'decline' && mine) throw new AuthError('match_not_open');
      if (how === 'cancel' && !mine) throw new AuthError('match_not_open');
      if (row.status === 'cancelled') return false; // already done
      if (row.status !== 'invited') throw new AuthError('match_not_open');
      await c.query(`UPDATE matches SET status = 'cancelled' WHERE id = $1`, [matchId]);
      return true;
    });
    if (changed) await this.afterChange(matchId);
    return this.get(userId, matchId);
  }

  /** After a change commits: update the chat card and tell both players (each gets their own view). */
  private async afterChange(matchId: string): Promise<void> {
    const { row, players } = await this.load(this.pool, matchId);
    try {
      await this.chat.updateGameCard(matchId, cardPayload(row, players));
    } catch {
      // The card catches up on the next change; the match itself is already stored.
    }
    this.publishMatch(row, players);
  }

  private publishMatch(row: MatchRow, players: PlayerRow[]): void {
    for (const p of players) {
      try {
        this.publisher.publish([p.user_id], {
          type: 'match',
          match: this.toView(row, players, p.user_id),
        });
      } catch {
        // best effort: the app refetches on reconnect
      }
    }
  }

  private async load(db: Db, matchId: string, forUpdate = false) {
    const m = await db.query<MatchRow>(
      `SELECT ${MATCH_COLUMNS} FROM matches m JOIN games g ON g.slug = m.game_slug
        WHERE m.id = $1 ${forUpdate ? 'FOR UPDATE OF m' : ''}`,
      [matchId],
    );
    const row = m.rows[0];
    if (!row) throw new AuthError('match_not_found');
    const p = await db.query<PlayerRow>(
      `SELECT mp.user_id, mp.seat, mp.accepted_at, mp.result, mp.placement,
              pr.username, pr.display_name, pr.avatar
         FROM match_players mp JOIN profiles pr ON pr.id = mp.user_id
        WHERE mp.match_id = $1 ORDER BY mp.seat`,
      [matchId],
    );
    return { row, players: p.rows };
  }

  /** Loads the match under a row lock and checks `userId` is one of its players. */
  private async lock(c: pg.PoolClient, matchId: string, userId: string) {
    const loaded = await this.load(c, matchId, true);
    if (!loaded.players.some((p) => p.user_id === userId)) throw new AuthError('match_not_found');
    return loaded;
  }

  /** What `viewer` may see: the engine's `view()` for them, never the raw state. */
  private toView(row: MatchRow, players: PlayerRow[], viewer: string): MatchView {
    const hasState = row.status === 'active' || row.status === 'finished';
    const entry = hasState ? this.entry(row.game_slug) : null;
    const finished = row.status === 'finished';
    return {
      id: row.id,
      gameSlug: row.game_slug,
      gameName: row.game_name,
      mode: row.mode,
      stakeKobo: Number(row.stake_kobo),
      status: row.status,
      conversationId: row.conversation_id,
      createdBy: row.created_by,
      players: players.map((p): MatchPlayer => ({
        userId: p.user_id,
        username: p.username,
        displayName: p.display_name,
        avatar: parseAvatar(p.avatar),
        seat: p.seat,
        accepted: p.accepted_at !== null,
        result: p.result,
        placement: p.placement,
      })),
      stateVersion: row.state_version,
      currentTurn: row.status === 'active' ? row.current_turn : null,
      view: entry ? entry.engine.view(row.state, viewer) : null,
      outcome: finished
        ? {
            winnerIds: players.filter((p) => p.result === 'win').map((p) => p.user_id),
            draw: players.every((p) => p.result === 'draw'),
          }
        : null,
      inviteExpiresAt:
        row.status === 'invited' ? (row.invite_expires_at?.toISOString() ?? null) : null,
      createdAt: row.created_at.toISOString(),
      finishedAt: row.finished_at?.toISOString() ?? null,
    };
  }
}

function cardPayload(row: MatchRow, players: PlayerRow[]): GameCardPayload {
  const finished = row.status === 'finished';
  return {
    matchId: row.id,
    gameSlug: row.game_slug,
    gameName: row.game_name,
    mode: row.mode,
    status: row.status,
    currentTurn: row.status === 'active' ? row.current_turn : null,
    winnerIds: finished ? players.filter((p) => p.result === 'win').map((p) => p.user_id) : null,
    draw: finished && players.every((p) => p.result === 'draw'),
    stateVersion: row.state_version,
  };
}

/** A random 62-bit seed (fits a Postgres bigint), as a decimal string. */
function newSeed(): string {
  return (randomBytes(8).readBigUInt64BE() & ((1n << 62n) - 1n)).toString();
}
