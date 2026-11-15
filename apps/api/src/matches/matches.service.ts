import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type pg from 'pg';
import {
  parseAvatar,
  type CounterMatchRequest,
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
  type PoolInfo,
  type RealtimeEvent,
  type SubmitMoveRequest,
} from '@dyce/shared';
import { AuthError } from '../auth/auth-error.ts';
import type { Clock } from '../auth/tokens.ts';
import { parseDbError, DyceError } from '../common/dyce-error.ts';
import { readConfigInt, secondsUntilLagosMidnight } from '../db/config.ts';
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
  allow_counter: boolean;
  counter_stake_kobo: string | null;
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
  staked_kobo: string;
  payout_kobo: string | null;
  username: string;
  display_name: string;
  avatar: unknown;
};

type Db = Pick<pg.Pool, 'query'>;

const MATCH_COLUMNS = `m.id, m.game_slug, g.name AS game_name, m.mode, m.stake_kobo, m.allow_counter, m.counter_stake_kobo, m.status, m.conversation_id,
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
 * `view()` for themselves. Free and Pool modes.
 *
 * Pool mode (ADR-017) adds real stakes on top of this lifecycle, and every cent moves through the SQL
 * functions `stake_pool`, `restake_pool`, `settle_match` and `refund_match`, never from here: the creator's
 * stake is escrowed when the invite is sent, the invitee's when they accept; the invitee may counter once
 * with a smaller stake (or Free), which the creator accepts or declines; a declined, cancelled or expired
 * invite refunds whatever was staked; a finished match pays out through `settle_match`.
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

  /** What the stake picker needs: the limits, today's usage and whether the age gate has been passed. */
  async poolInfo(userId: string): Promise<PoolInfo> {
    const [me, usage, minStake, maxStake, dailyStake, dailyGames] = await Promise.all([
      this.pool.query<{ is_adult: boolean; birth_year: number | null }>(
        `SELECT is_adult, birth_year FROM profiles WHERE id = $1`,
        [userId],
      ),
      this.pool.query<{ pool_games: number; pool_staked_kobo: string }>(
        `SELECT pool_games, pool_staked_kobo FROM daily_usage
          WHERE user_id = $1 AND day = (now() AT TIME ZONE 'Africa/Lagos')::date`,
        [userId],
      ),
      readConfigInt(this.pool, 'pool_min_stake_kobo', 10_000),
      readConfigInt(this.pool, 'pool_max_stake_kobo', 2_000_000),
      readConfigInt(this.pool, 'pool_staked_per_day_kobo', 10_000_000),
      readConfigInt(this.pool, 'pool_games_per_day', 20),
    ]);
    const profile = me.rows[0];
    if (!profile) throw new AuthError('profile_required');
    return {
      isAdult: profile.is_adult,
      ageAnswered: profile.birth_year !== null,
      minStakeKobo: minStake,
      maxStakeKobo: maxStake,
      dailyStakeLimitKobo: dailyStake,
      stakedTodayKobo: Number(usage.rows[0]?.pool_staked_kobo ?? 0),
      dailyGamesLimit: dailyGames,
      gamesToday: usage.rows[0]?.pool_games ?? 0,
      resetsInSeconds: secondsUntilLagosMidnight(this.clock()),
    };
  }

  /**
   * Expires every invite whose time is up, refunding Pool stakes. Players also trigger this lazily when
   * they open a match; this sweep is for invites nobody opens again, so locked cash is never stranded.
   */
  async expireStaleInvites(limit = 100): Promise<number> {
    const stale = await this.pool.query<{ id: string }>(
      `SELECT id FROM matches
        WHERE status IN ('invited', 'countered') AND invite_expires_at <= $1
        ORDER BY invite_expires_at LIMIT $2`,
      [this.clock(), limit],
    );
    let n = 0;
    for (const { id } of stale.rows) {
      const done = await withTx(this.pool, async (c) => {
        const { row } = await this.load(c, id, true);
        if (!this.isOpenInvite(row) || !this.isStale(row)) return false;
        await this.markExpired(c, id);
        return true;
      });
      if (done) {
        await this.afterChange(id);
        n += 1;
      }
    }
    return n;
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  /**
   * Sends a game to the other person in a chat. Idempotent on `input.id`: a retry returns the same match
   * (and makes sure its card is in the thread) instead of sending a second game.
   */
  async create(userId: string, input: CreateMatchRequest): Promise<MatchView> {
    const mode = input.mode ?? 'free';
    const stake = mode === 'pool' ? (input.stakeKobo ?? 0) : 0;
    const allowCounter = mode === 'pool' ? (input.allowCounter ?? true) : false;
    if (this.entry(input.gameSlug) === null) throw new AuthError('game_not_found');

    const { peerId, friends } = await this.chat.playablePeer(userId, input.conversationId);
    if (!friends) throw new AuthError('match_requires_friends');

    const now = this.clock();
    await withTx(this.pool, async (c) => {
      await lockPair(c, userId, peerId);
      const existing = await c.query<{
        created_by: string;
        conversation_id: string | null;
        mode: MatchMode;
        game_slug: string;
      }>(`SELECT created_by, conversation_id, mode, game_slug FROM matches WHERE id = $1`, [
        input.id,
      ]);
      const e = existing.rows[0];
      if (e) {
        if (
          e.created_by !== userId ||
          e.conversation_id !== input.conversationId ||
          e.mode !== mode ||
          e.game_slug !== input.gameSlug
        ) {
          throw new AuthError('message_id_taken');
        }
        return; // a retry
      }

      const game = await c.query<{ enabled: boolean; supports_pool: boolean }>(
        `SELECT enabled, supports_pool FROM games WHERE slug = $1`,
        [input.gameSlug],
      );
      if (!game.rows[0]?.enabled) throw new AuthError('game_not_found');
      if (mode === 'pool') {
        if (!game.rows[0].supports_pool) throw new AuthError('pool_not_supported');
        await this.assertStakeInRange(c, stake);
      }

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
        `INSERT INTO matches (id, game_slug, mode, stake_kobo, allow_counter, status, conversation_id, seed,
                              created_by, created_at, invite_expires_at)
         VALUES ($1, $2, $8, $9, $10, 'invited', $3, $4, $5, $6, $7)`,
        [
          input.id,
          input.gameSlug,
          input.conversationId,
          newSeed(),
          userId,
          now,
          expires,
          mode,
          stake,
          allowCounter,
        ],
      );
      await c.query(
        `INSERT INTO match_players (match_id, user_id, seat, accepted_at) VALUES
           ($1, $2, 1, $4), ($1, $3, 2, NULL)`,
        [input.id, userId, peerId, now],
      );
      // Pool: the creator's stake is locked in escrow before the invite is visible to anyone. If it fails
      // (not enough cash, 18+ gate, daily limits) the whole transaction rolls back and no match exists.
      if (mode === 'pool')
        await this.stake(c, input.id, userId, stake, `stake:${input.id}:${userId}`);
    });

    const { row, players } = await this.load(this.pool, input.id);
    // Idempotent on the match id, so a retry after a failure here still ends with exactly one card.
    await this.chat.postCard(input.conversationId, userId, {
      id: input.id,
      kind: 'game',
      body: `${row.game_name} · ${row.mode === 'pool' ? 'Pool' : 'Free'}`,
      payload: cardPayload(row, players),
    });
    this.publishMatch(row, players);
    return this.toView(row, players, userId);
  }

  /**
   * The game starts and it is the first player's turn. Idempotent. The invitee accepts an invite (in Pool,
   * matching the stake); the creator accepts the invitee's counter-offer (their stake is reduced to the
   * counter, or the match becomes Free).
   */
  async accept(userId: string, matchId: string): Promise<MatchView> {
    await this.assertCanInteract(userId, matchId);
    const changed = await withTx(this.pool, async (c) => {
      const { row, players } = await this.lock(c, matchId, userId);
      if (row.status === 'active' || row.status === 'finished') return false; // already accepted
      const mine = row.created_by === userId;
      if (row.status === 'invited' && mine) throw new AuthError('cannot_accept_own_invite');
      if (row.status === 'countered' && !mine) throw new AuthError('match_not_open');
      if ((row.status === 'invited' || row.status === 'countered') && this.isStale(row)) {
        await this.markExpired(c, matchId);
        return true;
      }
      if (row.status !== 'invited' && row.status !== 'countered') {
        throw new AuthError('match_not_open');
      }
      const invitee = players.find((p) => p.user_id !== row.created_by)!.user_id;

      if (row.mode === 'pool') {
        if (row.status === 'invited') {
          await this.stake(
            c,
            matchId,
            userId,
            Number(row.stake_kobo),
            `stake:${matchId}:${userId}`,
          );
        } else {
          const counter = Number(row.counter_stake_kobo ?? 0);
          await this.money(() =>
            c.query(`SELECT restake_pool($1, $2, $3, $4)`, [
              matchId,
              row.created_by,
              counter,
              `restake:${matchId}:${row.created_by}`,
            ]),
          );
          if (counter > 0) {
            try {
              await this.stake(c, matchId, invitee, counter, `stake:${matchId}:${invitee}`);
            } catch (err) {
              // The counter was theirs, but they may no longer be able to cover it. Nothing has moved
              // (the transaction rolls back); the creator can try again later or decline.
              if (err instanceof DyceError) {
                throw new AuthError('opponent_cannot_stake', { reason: err.code });
              }
              throw err;
            }
          }
        }
      }

      const entry = this.engineFor(row.game_slug);
      const state = entry.engine.init(
        players.map((p) => p.user_id),
        BigInt(row.seed),
        entry.cfg,
      );
      const turn = entry.engine.currentPlayers(state)[0] ?? null;
      await c.query(
        `UPDATE match_players SET accepted_at = $3 WHERE match_id = $1 AND user_id = $2`,
        [matchId, invitee, this.clock()],
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

  /**
   * The invitee proposes a smaller stake (0 = play it free), once. Nothing leaves their wallet yet; the
   * creator's stake stays locked while they decide. Idempotent for the same stake.
   */
  async counter(userId: string, matchId: string, input: CounterMatchRequest): Promise<MatchView> {
    await this.assertCanInteract(userId, matchId);
    const changed = await withTx(this.pool, async (c) => {
      const { row } = await this.lock(c, matchId, userId);
      if (row.created_by === userId) throw new AuthError('counter_not_allowed');
      if (row.status === 'countered' && Number(row.counter_stake_kobo) === input.stakeKobo) {
        return false;
      }
      if (row.status === 'invited' && this.isStale(row)) {
        await this.markExpired(c, matchId);
        return true;
      }
      if (row.status !== 'invited') throw new AuthError('match_not_open');
      if (row.mode !== 'pool' || !row.allow_counter) throw new AuthError('counter_not_allowed');
      const stake = Number(row.stake_kobo);
      if (input.stakeKobo >= stake) throw new AuthError('invalid_stake');
      if (input.stakeKobo > 0) await this.assertStakeInRange(c, input.stakeKobo);

      // They must be able to honour their own offer.
      const me = await c.query<{ is_adult: boolean; pool_frozen: boolean; balance: string }>(
        `SELECT p.is_adult, p.pool_frozen, w.balance_kobo AS balance
           FROM profiles p JOIN wallets w ON w.user_id = p.id WHERE p.id = $1`,
        [userId],
      );
      const you = me.rows[0];
      if (!you?.is_adult) throw new DyceError('adult_required');
      if (you.pool_frozen) throw new DyceError('pool_frozen');
      if (Number(you.balance) < input.stakeKobo) throw new DyceError('insufficient_funds');

      const ttlHours = await readConfigInt(c, 'match_invite_ttl_hours', 24);
      const expires = new Date(this.clock().getTime() + ttlHours * 3_600_000);
      await c.query(
        `UPDATE matches SET status = 'countered', counter_stake_kobo = $2, invite_expires_at = $3
          WHERE id = $1`,
        [matchId, input.stakeKobo, expires],
      );
      return true;
    });
    if (changed) await this.afterChange(matchId);
    return this.get(userId, matchId);
  }

  /** The invited player says no (or, on a counter-offer, the creator does). Stakes go back. Idempotent. */
  async decline(userId: string, matchId: string): Promise<MatchView> {
    return this.closeInvite(userId, matchId, 'decline');
  }

  /** The sender takes the invite back; any stake goes back. Idempotent. */
  async cancel(userId: string, matchId: string): Promise<MatchView> {
    return this.closeInvite(userId, matchId, 'cancel');
  }

  /** The match as you see it. An invite that ran out of time is marked expired first. */
  async get(userId: string, matchId: string): Promise<MatchView> {
    let { row, players } = await this.load(this.pool, matchId);
    if (!players.some((p) => p.user_id === userId)) throw new AuthError('match_not_found');
    if (this.isOpenInvite(row) && this.isStale(row)) {
      const expired = await withTx(this.pool, async (c) => {
        const locked = await this.lock(c, matchId, userId);
        if (!this.isOpenInvite(locked.row) || !this.isStale(locked.row)) return false;
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
      if (entry.screenAction) {
        const mine = await c.query<{ action: unknown; created_at: Date }>(
          `SELECT action, created_at FROM match_moves WHERE match_id = $1 AND user_id = $2 ORDER BY seq`,
          [matchId, userId],
        );
        action = entry.screenAction({
          state,
          by: userId,
          action,
          now: this.clock(),
          history: mine.rows.map((r) => ({ action: r.action, at: r.created_at })),
        });
      }
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
        // Free: marks the match finished. Pool: pays the escrow out by placement (a draw refunds both
        // stakes) in the same transaction, so a finished match and its payout can never disagree.
        await this.money(() => c.query(`SELECT settle_match($1)`, [matchId]));
      }
      return { changed: true };
    });

    if (result.changed) await this.afterChange(matchId);
    return this.get(userId, matchId);
  }

  /**
   * Turns an SMS invite into a normal Free match once the invitee has signed up (ADR-020). `id` is the invite's
   * id, so a retry is harmless. With `played` (the moves a guest made in the browser, already screened) the new
   * user's turn is replayed through the engine on the guest's own seed: they keep their score and the inviter
   * plays next. Without it the inviter simply sends the game as a fresh invite. Returns the match id.
   */
  async startFromInvite(input: {
    id: string;
    inviterId: string;
    userId: string;
    conversationId: string;
    gameSlug: string;
    seed: string;
    played: { action: unknown; at: Date }[] | null;
  }): Promise<string> {
    const entry = this.engineFor(input.gameSlug);
    if (!input.played || input.played.length === 0) {
      await this.create(input.inviterId, {
        id: input.id,
        conversationId: input.conversationId,
        gameSlug: input.gameSlug,
        mode: 'free',
      });
      return input.id;
    }
    const { engine } = entry;
    const now = this.clock();
    await withTx(this.pool, async (c) => {
      await lockPair(c, input.inviterId, input.userId);
      const exists = await c.query(`SELECT 1 FROM matches WHERE id = $1`, [input.id]);
      if (exists.rows[0]) return; // a retry
      let state = engine.init([input.inviterId, input.userId], BigInt(input.seed), entry.cfg);
      for (const m of input.played!) {
        const verdict = engine.validate(state, input.userId, m.action);
        if (!verdict.ok) throw new Error(`guest run no longer valid: ${verdict.code}`);
        state = engine.apply(state, input.userId, m.action);
      }
      if (engine.isTerminal(state)) throw new Error('a guest run must leave the inviter to play');
      const turn = engine.currentPlayers(state)[0] ?? null;
      await c.query(
        `INSERT INTO matches (id, game_slug, mode, stake_kobo, allow_counter, status, conversation_id, seed,
                              state, state_version, current_turn, created_by, created_at)
         VALUES ($1, $2, 'free', 0, false, 'active', $3, $4, $5::jsonb, $6, $7, $8, $9)`,
        [
          input.id,
          input.gameSlug,
          input.conversationId,
          input.seed,
          JSON.stringify(state),
          input.played!.length,
          turn,
          input.inviterId,
          now,
        ],
      );
      await c.query(
        `INSERT INTO match_players (match_id, user_id, seat, accepted_at) VALUES
           ($1, $2, 1, $4), ($1, $3, 2, $4)`,
        [input.id, input.inviterId, input.userId, now],
      );
      let seq = 0;
      for (const m of input.played!) {
        seq += 1;
        await c.query(
          `INSERT INTO match_moves (match_id, seq, user_id, action, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)`,
          [input.id, seq, input.userId, JSON.stringify(m.action), m.at],
        );
      }
    });
    const { row, players } = await this.load(this.pool, input.id);
    await this.chat.postCard(input.conversationId, input.inviterId, {
      id: input.id,
      kind: 'game',
      body: `${row.game_name} · Free`,
      payload: cardPayload(row, players),
    });
    this.publishMatch(row, players);
    return input.id;
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

  private isOpenInvite(row: MatchRow): boolean {
    return row.status === 'invited' || row.status === 'countered';
  }

  /** An invite that ran out of time. In Pool whatever was staked goes back (`refund_match`). */
  private async markExpired(c: pg.PoolClient, matchId: string): Promise<void> {
    const m = await c.query<{ mode: MatchMode }>(
      `SELECT mode FROM matches WHERE id = $1 AND status IN ('invited', 'countered')`,
      [matchId],
    );
    if (!m.rows[0]) return;
    if (m.rows[0].mode === 'pool') {
      await this.money(() => c.query(`SELECT refund_match($1, 'expired')`, [matchId]));
    } else {
      await c.query(`UPDATE matches SET status = 'expired' WHERE id = $1`, [matchId]);
    }
  }

  /** The stake limits from config (docs/SPEC.md section 9). */
  private async assertStakeInRange(c: Db, stake: number): Promise<void> {
    const min = await readConfigInt(c, 'pool_min_stake_kobo', 10_000);
    const max = await readConfigInt(c, 'pool_max_stake_kobo', 2_000_000);
    if (!Number.isInteger(stake) || stake < min || stake > max) {
      throw new AuthError('invalid_stake', { minStakeKobo: min, maxStakeKobo: max });
    }
  }

  /** Money moves only through the SQL functions; their `dyce:<code>` errors become typed errors. */
  private async money<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw parseDbError(err) ?? err;
    }
  }

  private async stake(
    c: pg.PoolClient,
    matchId: string,
    userId: string,
    amount: number,
    key: string,
  ): Promise<void> {
    await this.money(() =>
      c.query(`SELECT stake_pool($1, $2, $3, $4)`, [matchId, userId, amount, key]),
    );
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
      if (row.status === 'cancelled') return false; // already done
      // On a plain invite only the invitee declines and only the creator cancels; once there is a
      // counter-offer either of them can end it.
      if (row.status === 'invited') {
        if (how === 'decline' && mine) throw new AuthError('match_not_open');
        if (how === 'cancel' && !mine) throw new AuthError('match_not_open');
      } else if (row.status !== 'countered') {
        throw new AuthError('match_not_open');
      }
      if (row.mode === 'pool') {
        await this.money(() => c.query(`SELECT refund_match($1, 'cancelled')`, [matchId]));
      } else {
        await c.query(`UPDATE matches SET status = 'cancelled' WHERE id = $1`, [matchId]);
      }
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
      `SELECT mp.user_id, mp.seat, mp.accepted_at, mp.result, mp.placement, mp.staked_kobo, mp.payout_kobo,
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
      potKobo: potOf(row, players),
      counterStakeKobo: counterOf(row),
      allowCounter: row.allow_counter,
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
        stakedKobo: Number(p.staked_kobo),
        payoutKobo: p.payout_kobo === null ? null : Number(p.payout_kobo),
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
      inviteExpiresAt: this.isOpenInvite(row)
        ? (row.invite_expires_at?.toISOString() ?? null)
        : null,
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
    stakeKobo: Number(row.stake_kobo),
    potKobo: potOf(row, players),
    counterStakeKobo: counterOf(row),
    allowCounter: row.allow_counter,
    status: row.status,
    currentTurn: row.status === 'active' ? row.current_turn : null,
    winnerIds: finished ? players.filter((p) => p.result === 'win').map((p) => p.user_id) : null,
    draw: finished && players.every((p) => p.result === 'draw'),
    stateVersion: row.state_version,
  };
}

/** Both stakes: what the winner takes. Free matches have no pot. */
function potOf(row: MatchRow, players: PlayerRow[]): number {
  return row.mode === 'pool' ? Number(row.stake_kobo) * players.length : 0;
}

/** The invitee's counter-offer, visible only while it is waiting for the creator. */
function counterOf(row: MatchRow): number | null {
  return row.status === 'countered' && row.counter_stake_kobo !== null
    ? Number(row.counter_stake_kobo)
    : null;
}

/** A random 62-bit seed (fits a Postgres bigint), as a decimal string. */
function newSeed(): string {
  return (randomBytes(8).readBigUInt64BE() & ((1n << 62n) - 1n)).toString();
}
