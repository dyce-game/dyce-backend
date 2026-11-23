import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  SPACE_CODE_ALPHABET,
  SPACE_CODE_LENGTH,
  normalizeSpaceCode,
  parseAvatar,
  type CreateSpaceRequest,
  type MatchMode,
  type MatchPlayerResult,
  type SpaceConnection,
  type SpaceOptions,
  type SpacePayoutScheme,
  type SpaceStartRule,
  type SpaceStatus,
  type SpaceExit,
  type SpaceView,
  type SpaceVisibility,
  type SpacesResponse,
} from '@dyce/shared';
import { liveGame, type LiveGame } from '@dyce/games';
import { AuthError } from '../auth/auth-error.ts';
import type { Clock } from '../auth/tokens.ts';
import type { Publisher } from '../chat/messages.service.ts';
import { parseDbError } from '../common/dyce-error.ts';
import { readConfigInt } from '../db/config.ts';
import { withTx } from '../db/tx.ts';

/** Starts (or finds) the live room for a match. The real one calls the Colyseus game server. */
export interface GameRooms {
  ensureRoom(matchId: string): Promise<{ roomId: string }>;
  /** Public WebSocket URL of the game server, handed to the app. */
  readonly publicUrl: string;
}

type Db = Pick<pg.Pool, 'query'>;

type SpaceRow = {
  id: string;
  code: string;
  name: string;
  host_id: string;
  game_slug: string;
  game_name: string;
  min_players: number;
  mode: MatchMode;
  seat_fee_kobo: string;
  payout_scheme: SpacePayoutScheme;
  max_seats: number;
  visibility: SpaceVisibility;
  start_rule: SpaceStartRule;
  options: SpaceOptions;
  quick_match: boolean;
  status: SpaceStatus;
  created_at: Date;
};

type MemberRow = {
  user_id: string;
  seat: number;
  joined_at: Date;
  username: string;
  display_name: string;
  avatar: unknown;
  staked_kobo: string | null;
  placement: number | null;
  result: MatchPlayerResult | null;
  payout_kobo: string | null;
};

const SPACE_COLUMNS = `s.id, s.code, s.name, s.host_id, s.game_slug, g.name AS game_name, g.min_players, s.mode,
  s.seat_fee_kobo, s.payout_scheme, s.max_seats, s.visibility, s.start_rule, s.options, s.quick_match, s.status,
  s.created_at`;

/** How long a finished space stays in "Your spaces" so people can open the result. */
const ENDED_VISIBLE_HOURS = 24;

/**
 * Spaces: private rooms (friends or a code) that play one live match (ADR-018).
 *
 * A space owns a `matches` row from the moment it is created. While the space is waiting that match is
 * `invited`; every person who sits down is a `match_players` row and, in Pool, their seat fee is escrowed
 * with `stake_pool` in the same transaction, so the escrow always equals the money of the people seated
 * (leaving or being removed gives it back with `unstake_pool`, closing the space with `refund_match`).
 * Starting initialises the engine and flips the match to `active`; from then on the Colyseus game server
 * runs it, persists every move and settles through `settle_match`. Money only ever moves in SQL functions.
 *
 * Every change to a space happens under a row lock on the `spaces` row, so two people taking the last seat
 * or the host starting while someone leaves can't interleave.
 */
export class SpacesService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly publisher: Publisher,
    private readonly rooms: GameRooms,
    private readonly clock: Clock = () => new Date(),
    /** The live game registry. Tests swap in games with short timers. */
    private readonly games: (slug: string) => LiveGame | null = liveGame,
  ) {}

  // ---- reading --------------------------------------------------------------------------------

  /** Your spaces: the ones you sit in that are waiting or live, plus recently finished ones. */
  async list(userId: string): Promise<SpacesResponse> {
    const since = new Date(this.clock().getTime() - ENDED_VISIBLE_HOURS * 3_600_000);
    const r = await this.pool.query<{ id: string }>(
      `SELECT s.id FROM spaces s JOIN space_members sm ON sm.space_id = s.id
        WHERE sm.user_id = $1 AND sm.left_at IS NULL
          AND (s.status = 'live' OR (s.status = 'waiting' AND NOT s.quick_match)
               OR (s.status = 'ended' AND s.ended_at >= $2))
        ORDER BY s.created_at DESC LIMIT 30`,
      [userId, since],
    );
    const spaces: SpaceView[] = [];
    for (const { id } of r.rows) spaces.push(await this.view(this.pool, id, userId));
    return { spaces };
  }

  /** A space you sit in (or sat in until it ended). */
  async get(userId: string, spaceId: string): Promise<SpaceView> {
    const member = await this.pool.query(
      `SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [spaceId, userId],
    );
    if (member.rowCount === 0) {
      const gone = await this.exitView(spaceId, userId);
      if (gone) return gone;
      throw new AuthError('space_not_found');
    }
    return this.view(this.pool, spaceId, userId);
  }

  /**
   * A space you used to sit in, told as why you are out (the Space edge-state screens, ADR-037): the host closed it
   * or it timed out, you were removed, or you left. Nobody else can read it (`space_not_found` stays the answer for
   * a stranger), and what the people still inside are doing is not part of it (no members, no match).
   */
  private async exitView(spaceId: string, userId: string): Promise<SpaceView | null> {
    const r = await this.pool.query<{
      removed: boolean;
      space_status: string;
      mode: MatchMode;
      seat_fee_kobo: string;
      match_status: string | null;
      host_name: string | null;
    }>(
      `SELECT sm.removed, s.status AS space_status, s.mode, s.seat_fee_kobo,
              (SELECT m.status FROM matches m WHERE m.space_id = s.id ORDER BY m.created_at DESC LIMIT 1) AS match_status,
              coalesce(nullif(h.display_name, ''), h.username) AS host_name
         FROM space_members sm
         JOIN spaces s ON s.id = sm.space_id
         LEFT JOIN profiles h ON h.id = s.host_id
        WHERE sm.space_id = $1 AND sm.user_id = $2`,
      [spaceId, userId],
    );
    const x = r.rows[0];
    if (!x) return null;
    const reason: SpaceExit['reason'] = x.removed
      ? 'removed'
      : x.space_status === 'closed'
        ? x.match_status === 'expired'
          ? 'expired'
          : 'host_closed'
        : 'left';
    const fee = Number(x.seat_fee_kobo);
    const gaveBack = x.removed || x.space_status === 'closed' || x.space_status === 'waiting';
    const base = await this.view(this.pool, spaceId, userId);
    return {
      ...base,
      members: [],
      matchId: null,
      potKobo: 0,
      exit: {
        reason,
        hostName: x.host_name,
        refundedKobo: x.mode === 'pool' && gaveBack ? fee : 0,
      },
    };
  }

  /** "Space found": what a code leads to, before sitting down. Applies the same entry rules as `join`. */
  async lookup(userId: string, code: string): Promise<SpaceView> {
    const row = await this.byCode(this.pool, code);
    if (!row) throw new AuthError('space_not_found');
    const seated = await this.isMember(this.pool, row.id, userId);
    if (!seated) await this.assertMayEnter(this.pool, row, userId);
    return this.view(this.pool, row.id, userId);
  }

  /** Where to open the live connection: makes sure the room exists (it may have been lost in a restart). */
  async connect(userId: string, spaceId: string): Promise<SpaceConnection> {
    const space = await this.get(userId, spaceId);
    if (space.status !== 'live' || !space.matchId) throw new AuthError('space_not_open');
    try {
      const { roomId } = await this.rooms.ensureRoom(space.matchId);
      return { url: this.rooms.publicUrl, roomId, matchId: space.matchId };
    } catch {
      throw new AuthError('room_unavailable');
    }
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  /** Opens a space and seats its host. Idempotent on `input.id`. */
  async create(userId: string, input: CreateSpaceRequest): Promise<SpaceView> {
    const mode = input.mode ?? 'free';
    const live = this.games(input.gameSlug);
    const game = await this.pool.query<{
      enabled: boolean;
      sync: string;
      supports_pool: boolean;
      min_players: number;
      max_players: number;
    }>(`SELECT enabled, sync, supports_pool, min_players, max_players FROM games WHERE slug = $1`, [
      input.gameSlug,
    ]);
    const g = game.rows[0];
    if (!live || !g?.enabled || g.sync !== 'live') throw new AuthError('game_not_found');
    const minSeats = Math.max(g.min_players, live.minPlayers);
    const maxSeats = Math.min(g.max_players, live.maxPlayers);
    if (input.maxSeats < minSeats || input.maxSeats > maxSeats) {
      throw new AuthError('invalid_seats', { minSeats, maxSeats });
    }
    const options: SpaceOptions = input.options ?? {};
    if (!live.optionsValid(options)) throw new AuthError('invalid_options');
    let fee = 0;
    let scheme: SpacePayoutScheme = 'winner_all';
    if (mode === 'pool') {
      if (!g.supports_pool) throw new AuthError('pool_not_supported');
      fee = input.seatFeeKobo ?? 0;
      await this.assertFeeInRange(this.pool, fee);
      scheme = input.payoutScheme ?? 'winner_all';
      if (scheme === 'p50_30_20' && input.maxSeats < 3) throw new AuthError('invalid_payout');
      // Side games (Imposter, Werewolf) pay the winning side equally: no 2nd or 3rd place money.
      if (!live.payoutSchemes.includes(scheme)) throw new AuthError('invalid_payout');
    }

    const created = await withTx(this.pool, async (c) => {
      const existing = await c.query<{ host_id: string; game_slug: string }>(
        `SELECT host_id, game_slug FROM spaces WHERE id = $1`,
        [input.id],
      );
      const e = existing.rows[0];
      if (e) {
        if (e.host_id !== userId || e.game_slug !== input.gameSlug) {
          throw new AuthError('space_id_taken');
        }
        return false; // a retry
      }
      const cap = await readConfigInt(c, 'spaces_open_per_user', 5);
      const open = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM space_members sm JOIN spaces s ON s.id = sm.space_id
          WHERE sm.user_id = $1 AND sm.left_at IS NULL AND s.status IN ('waiting', 'live')`,
        [userId],
      );
      if (Number(open.rows[0]?.n ?? 0) >= cap) throw new AuthError('spaces_limit');

      const now = this.clock();
      let code = '';
      for (let attempt = 0; attempt < 12 && !code; attempt++) {
        const candidate = newCode();
        const ins = await c.query(
          `INSERT INTO spaces (id, code, name, host_id, game_slug, mode, seat_fee_kobo, payout_scheme,
                               max_seats, visibility, start_rule, options, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $13::jsonb, 'waiting', $12)
           ON CONFLICT (code) DO NOTHING`,
          [
            input.id,
            candidate,
            input.name.trim(),
            userId,
            input.gameSlug,
            mode,
            fee,
            scheme,
            input.maxSeats,
            input.visibility ?? 'friends',
            input.startRule ?? 'host',
            now,
            JSON.stringify(options),
          ],
        );
        if (ins.rowCount === 1) code = candidate;
      }
      if (!code) throw new Error('could not allocate a space code');

      const matchId = randomUUID();
      await c.query(
        `INSERT INTO matches (id, game_slug, mode, stake_kobo, payout_scheme, status, space_id, seed,
                              created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, 'invited', $6, $7, $8, $9)`,
        [matchId, input.gameSlug, mode, fee, scheme, input.id, newSeed(), userId, now],
      );
      await c.query(
        `INSERT INTO match_players (match_id, user_id, seat, accepted_at) VALUES ($1, $2, 1, $3)`,
        [matchId, userId, now],
      );
      await c.query(
        `INSERT INTO space_members (space_id, user_id, seat, joined_at) VALUES ($1, $2, 1, $3)`,
        [input.id, userId, now],
      );
      // Pool: the host's seat fee is locked before anyone can see the space. If it fails (cash, 18+,
      // daily limits) the transaction rolls back and no space exists.
      if (mode === 'pool') await this.stake(c, matchId, userId, fee, 1);
      return true;
    });

    if (created) await this.publish(input.id);
    return this.view(this.pool, input.id, userId);
  }

  /** Sits down at a space by its code. Idempotent for someone already seated. */
  async join(userId: string, code: string): Promise<SpaceView> {
    const found = await this.byCode(this.pool, code);
    if (!found) throw new AuthError('space_not_found');

    const outcome = await withTx(this.pool, async (c) => {
      const { row, matchId } = await this.lockSpace(c, found.id);
      const membership = await c.query<{ left_at: Date | null; removed: boolean; join_n: number }>(
        `SELECT left_at, removed, join_n FROM space_members WHERE space_id = $1 AND user_id = $2`,
        [row.id, userId],
      );
      const mine = membership.rows[0];
      if (mine && mine.left_at === null) return { changed: false, full: false, id: row.id };
      if (mine?.removed) throw new AuthError('space_removed');

      await this.assertMayEnter(c, row, userId);
      const members = await c.query<{ seat: number }>(
        `SELECT seat FROM space_members WHERE space_id = $1 AND left_at IS NULL ORDER BY seat`,
        [row.id],
      );
      if (members.rowCount !== null && members.rowCount >= row.max_seats) {
        throw new AuthError('space_full', {
          name: row.name,
          gameName: row.game_name,
          gameSlug: row.game_slug,
          seats: row.max_seats,
        });
      }
      const taken = new Set(members.rows.map((m) => m.seat));
      let seat = 1;
      while (taken.has(seat)) seat += 1;

      const cap = await readConfigInt(c, 'spaces_open_per_user', 5);
      const open = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM space_members sm JOIN spaces s ON s.id = sm.space_id
          WHERE sm.user_id = $1 AND sm.left_at IS NULL AND s.status IN ('waiting', 'live')`,
        [userId],
      );
      if (Number(open.rows[0]?.n ?? 0) >= cap) throw new AuthError('spaces_limit');

      const joinN = (mine?.join_n ?? 0) + 1;
      const now = this.clock();
      await c.query(
        `INSERT INTO match_players (match_id, user_id, seat, accepted_at) VALUES ($1, $2, $3, $4)`,
        [matchId, userId, seat, now],
      );
      if (mine) {
        await c.query(
          `UPDATE space_members SET seat = $3, join_n = $4, left_at = NULL, joined_at = $5, ready = false
            WHERE space_id = $1 AND user_id = $2`,
          [row.id, userId, seat, joinN, now],
        );
      } else {
        await c.query(
          `INSERT INTO space_members (space_id, user_id, seat, join_n, joined_at) VALUES ($1, $2, $3, $4, $5)`,
          [row.id, userId, seat, joinN, now],
        );
      }
      if (row.mode === 'pool') {
        await this.stake(c, matchId, userId, Number(row.seat_fee_kobo), joinN);
      }
      const full = members.rows.length + 1 >= row.max_seats;
      return { changed: true, full, id: row.id };
    });

    if (outcome.changed) {
      await this.publish(outcome.id);
      if (outcome.full && found.start_rule === 'when_full') await this.startNow(outcome.id);
    }
    return this.view(this.pool, outcome.id, userId);
  }

  /**
   * Stands up from a waiting space; the seat fee goes back. If the host leaves, the person who has been
   * seated longest becomes host; if nobody is left the space closes. Idempotent.
   */
  async leave(userId: string, spaceId: string): Promise<SpaceView> {
    const changed = await this.vacate(userId, spaceId, userId, false);
    if (changed) await this.publish(spaceId, [userId]);
    return this.view(this.pool, spaceId, userId);
  }

  /** The host sends someone away from a waiting space. Their seat fee goes back and they can't return. */
  async remove(hostId: string, spaceId: string, targetId: string): Promise<SpaceView> {
    if (hostId === targetId) throw new AuthError('validation_failed');
    const changed = await this.vacate(hostId, spaceId, targetId, true);
    if (changed) await this.publish(spaceId, [targetId]);
    return this.view(this.pool, spaceId, hostId);
  }

  /** The host closes a waiting space: every seat fee goes back. Idempotent. */
  async close(hostId: string, spaceId: string): Promise<SpaceView> {
    const closed = await withTx(this.pool, async (c) => {
      const { row, matchId } = await this.lockSpace(c, spaceId);
      if (row.host_id !== hostId) throw new AuthError('not_space_host');
      if (row.status === 'closed') return false;
      if (row.status !== 'waiting') throw new AuthError('space_live');
      await this.closeLocked(c, row, matchId, 'cancelled');
      return true;
    });
    if (closed) await this.publish(spaceId, [hostId]);
    return this.view(this.pool, spaceId, hostId);
  }

  /** The host starts the game with whoever is seated (at least the game's minimum). Idempotent. */
  async start(hostId: string, spaceId: string): Promise<SpaceView> {
    const row = await this.pool.query<{ host_id: string }>(
      `SELECT host_id FROM spaces WHERE id = $1`,
      [spaceId],
    );
    if (!row.rows[0]) throw new AuthError('space_not_found');
    if (row.rows[0].host_id !== hostId) throw new AuthError('not_space_host');
    await this.startNow(spaceId);
    return this.view(this.pool, spaceId, hostId);
  }

  /** Closes waiting spaces nobody started, giving every seat fee back. Run by a scheduled job. */
  async expireStaleSpaces(limit = 50): Promise<number> {
    const hours = await readConfigInt(this.pool, 'space_waiting_ttl_hours', 6);
    const cutoff = new Date(this.clock().getTime() - hours * 3_600_000);
    const stale = await this.pool.query<{ id: string }>(
      `SELECT id FROM spaces WHERE status = 'waiting' AND created_at <= $1 ORDER BY created_at LIMIT $2`,
      [cutoff, limit],
    );
    let n = 0;
    for (const { id } of stale.rows) {
      const done = await withTx(this.pool, async (c) => {
        const { row, matchId } = await this.lockSpace(c, id);
        if (row.status !== 'waiting' || row.created_at.getTime() > cutoff.getTime()) return false;
        await this.closeLocked(c, row, matchId, 'expired');
        return true;
      });
      if (done) {
        await this.publish(id);
        n += 1;
      }
    }
    return n;
  }

  // ---- quick match hooks (QuickMatchService) -------------------------------------------------------

  /** Throws `spaces_limit` when the person already sits in as many open spaces as one person may. */
  async assertCanSeat(c: pg.PoolClient, userId: string): Promise<void> {
    const cap = await readConfigInt(c, 'spaces_open_per_user', 5);
    const open = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM space_members sm JOIN spaces s ON s.id = sm.space_id
        WHERE sm.user_id = $1 AND sm.left_at IS NULL AND s.status IN ('waiting', 'live')`,
      [userId],
    );
    if (Number(open.rows[0]?.n ?? 0) >= cap) throw new AuthError('spaces_limit');
  }

  /**
   * Opens the two-seat space of a quick match inside the caller's transaction: a waiting space nobody can
   * find by code, its match, and both seats (host first). It stakes nothing: the caller escrows Pool seat
   * fees with `stake`, person by person, so it knows whose stake failed.
   */
  async openQuickSpace(
    c: pg.PoolClient,
    input: { gameSlug: string; mode: MatchMode; seatFeeKobo: number; players: [string, string] },
  ): Promise<{ spaceId: string; matchId: string }> {
    const now = this.clock();
    const spaceId = randomUUID();
    const matchId = randomUUID();
    let code = '';
    for (let attempt = 0; attempt < 12 && !code; attempt++) {
      const candidate = newCode();
      const ins = await c.query(
        `INSERT INTO spaces (id, code, name, host_id, game_slug, mode, seat_fee_kobo, payout_scheme,
                             max_seats, visibility, start_rule, quick_match, status, created_at)
         VALUES ($1, $2, 'Quick match', $3, $4, $5, $6, 'winner_all', 2, 'invite', 'host', true, 'waiting', $7)
         ON CONFLICT (code) DO NOTHING`,
        [spaceId, candidate, input.players[0], input.gameSlug, input.mode, input.seatFeeKobo, now],
      );
      if (ins.rowCount === 1) code = candidate;
    }
    if (!code) throw new Error('could not allocate a space code');
    await c.query(
      `INSERT INTO matches (id, game_slug, mode, stake_kobo, payout_scheme, status, space_id, seed,
                            created_by, created_at)
       VALUES ($1, $2, $3, $4, 'winner_all', 'invited', $5, $6, $7, $8)`,
      [
        matchId,
        input.gameSlug,
        input.mode,
        input.seatFeeKobo,
        spaceId,
        newSeed(),
        input.players[0],
        now,
      ],
    );
    for (const [i, userId] of input.players.entries()) {
      await c.query(
        `INSERT INTO match_players (match_id, user_id, seat, accepted_at) VALUES ($1, $2, $3, $4)`,
        [matchId, userId, i + 1, now],
      );
      await c.query(
        `INSERT INTO space_members (space_id, user_id, seat, joined_at) VALUES ($1, $2, $3, $4)`,
        [spaceId, userId, i + 1, now],
      );
    }
    return { spaceId, matchId };
  }

  /** Both accepted: start the game. Idempotent (a second call finds it already live). */
  async startQuickSpace(spaceId: string): Promise<void> {
    await this.startNow(spaceId);
  }

  /** The match fell through (declined, not accepted in time): close the waiting space and refund every stake. */
  async closeQuickSpace(
    c: pg.PoolClient,
    spaceId: string,
    reason: 'cancelled' | 'expired',
  ): Promise<void> {
    const { row, matchId } = await this.lockSpace(c, spaceId);
    if (row.status !== 'waiting') return;
    await this.closeLocked(c, row, matchId, reason);
  }

  // ---- internals ------------------------------------------------------------------------------

  /** Locks the space and returns it with its current match. */
  private async lockSpace(c: pg.PoolClient, spaceId: string) {
    const r = await c.query<SpaceRow>(
      `SELECT ${SPACE_COLUMNS} FROM spaces s JOIN games g ON g.slug = s.game_slug
        WHERE s.id = $1 FOR UPDATE OF s`,
      [spaceId],
    );
    const row = r.rows[0];
    if (!row) throw new AuthError('space_not_found');
    const m = await c.query<{ id: string }>(
      `SELECT id FROM matches WHERE space_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [spaceId],
    );
    const matchId = m.rows[0]?.id;
    if (!matchId) throw new AuthError('space_not_found');
    return { row, matchId };
  }

  private async byCode(db: Db, code: string): Promise<SpaceRow | null> {
    const r = await db.query<SpaceRow>(
      `SELECT ${SPACE_COLUMNS} FROM spaces s JOIN games g ON g.slug = s.game_slug WHERE s.code = $1`,
      [normalizeSpaceCode(code) ?? ''],
    );
    const row = r.rows[0];
    // A quick match is two people who were paired: nobody can look it up or sit down by its code.
    return row && !row.quick_match ? row : null;
  }

  private async isMember(db: Db, spaceId: string, userId: string): Promise<boolean> {
    const r = await db.query(
      `SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [spaceId, userId],
    );
    return r.rowCount !== null && r.rowCount > 0;
  }

  /** Who may sit down: the space is waiting, you are not blocked by anyone seated, friends-only means friends of the host. */
  private async assertMayEnter(db: Db, row: SpaceRow, userId: string): Promise<void> {
    if (row.status !== 'waiting') throw new AuthError('space_not_open');
    const blocked = await db.query(
      `SELECT 1 FROM blocks b JOIN space_members sm ON sm.space_id = $1 AND sm.left_at IS NULL
        WHERE (b.blocker_id = sm.user_id AND b.blocked_id = $2)
           OR (b.blocker_id = $2 AND b.blocked_id = sm.user_id) LIMIT 1`,
      [row.id, userId],
    );
    if (blocked.rowCount) throw new AuthError('blocked');
    if (row.visibility === 'friends' && row.host_id !== userId) {
      const f = await db.query(
        `SELECT 1 FROM friendships WHERE user_low = LEAST($1::uuid, $2::uuid)
            AND user_high = GREATEST($1::uuid, $2::uuid) AND status = 'accepted'`,
        [row.host_id, userId],
      );
      if (!f.rowCount) throw new AuthError('space_friends_only');
    }
  }

  private async assertFeeInRange(db: Db, fee: number): Promise<void> {
    const min = await readConfigInt(db, 'pool_min_stake_kobo', 10_000);
    const max = await readConfigInt(db, 'pool_max_stake_kobo', 2_000_000);
    if (!Number.isInteger(fee) || fee < min || fee > max) {
      throw new AuthError('invalid_stake', { minStakeKobo: min, maxStakeKobo: max });
    }
  }

  /** Money moves only through SQL functions; their `dyce:<code>` errors become typed errors. */
  private async money<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw parseDbError(err) ?? err;
    }
  }

  async stake(c: pg.PoolClient, matchId: string, userId: string, fee: number, joinN: number) {
    await this.money(() =>
      c.query(`SELECT stake_pool($1, $2, $3, $4)`, [
        matchId,
        userId,
        fee,
        `stake:${matchId}:${userId}:${joinN}`,
      ]),
    );
  }

  /** A person leaves (or is removed from) a waiting space. Returns whether anything changed. */
  private async vacate(
    actorId: string,
    spaceId: string,
    targetId: string,
    removal: boolean,
  ): Promise<boolean> {
    return withTx(this.pool, async (c) => {
      const { row, matchId } = await this.lockSpace(c, spaceId);
      if (removal && row.host_id !== actorId) throw new AuthError('not_space_host');
      const m = await c.query<{ left_at: Date | null; join_n: number }>(
        `SELECT left_at, join_n FROM space_members WHERE space_id = $1 AND user_id = $2`,
        [spaceId, targetId],
      );
      const member = m.rows[0];
      if (!member) throw new AuthError('space_not_found');
      if (member.left_at !== null) return false; // already out
      if (row.status === 'live') throw new AuthError('space_live');
      if (row.status !== 'waiting') return false;

      if (row.mode === 'pool') {
        await this.money(() =>
          c.query(`SELECT unstake_pool($1, $2, $3)`, [
            matchId,
            targetId,
            `unstake:${matchId}:${targetId}:${member.join_n}`,
          ]),
        );
      }
      await c.query(`DELETE FROM match_players WHERE match_id = $1 AND user_id = $2`, [
        matchId,
        targetId,
      ]);
      await c.query(
        `UPDATE space_members SET left_at = $3, removed = $4 WHERE space_id = $1 AND user_id = $2`,
        [spaceId, targetId, this.clock(), removal],
      );

      if (row.host_id === targetId) {
        const next = await c.query<{ user_id: string }>(
          `SELECT user_id FROM space_members WHERE space_id = $1 AND left_at IS NULL
            ORDER BY joined_at, seat LIMIT 1`,
          [spaceId],
        );
        const heir = next.rows[0]?.user_id;
        if (heir) {
          await c.query(`UPDATE spaces SET host_id = $2 WHERE id = $1`, [spaceId, heir]);
          await c.query(`UPDATE matches SET created_by = $2 WHERE id = $1`, [matchId, heir]);
        } else {
          await this.closeLocked(c, row, matchId, 'cancelled');
        }
      }
      return true;
    });
  }

  /** Closes a waiting space under its lock: refunds anything still staked and empties it. */
  private async closeLocked(
    c: pg.PoolClient,
    row: SpaceRow,
    matchId: string,
    reason: 'cancelled' | 'expired',
  ): Promise<void> {
    if (row.mode === 'pool') {
      await this.money(() => c.query(`SELECT refund_match($1, $2)`, [matchId, reason]));
    } else {
      await c.query(
        `UPDATE matches SET status = $2::match_status, finished_at = $3 WHERE id = $1`,
        [matchId, reason, this.clock()],
      );
    }
    await c.query(`UPDATE space_members SET left_at = coalesce(left_at, $2) WHERE space_id = $1`, [
      row.id,
      this.clock(),
    ]);
    await c.query(`UPDATE spaces SET status = 'closed', ended_at = $2 WHERE id = $1`, [
      row.id,
      this.clock(),
    ]);
  }

  /** Initialises the engine for whoever is seated, flips the match to active and asks the game server for the room. */
  private async startNow(spaceId: string): Promise<void> {
    const started = await withTx(this.pool, async (c) => {
      const { row, matchId } = await this.lockSpace(c, spaceId);
      if (row.status === 'live' || row.status === 'ended') return null; // already started
      if (row.status !== 'waiting') throw new AuthError('space_not_open');
      const live = this.games(row.game_slug);
      if (!live) throw new AuthError('game_not_found');

      const seated = await c.query<{ user_id: string }>(
        `SELECT user_id FROM space_members WHERE space_id = $1 AND left_at IS NULL ORDER BY seat`,
        [spaceId],
      );
      const players = seated.rows.map((r) => r.user_id);
      const min = Math.max(row.min_players, live.minPlayers);
      if (players.length < min) throw new AuthError('not_enough_players', { minSeats: min });

      const seed = await c.query<{ seed: string }>(`SELECT seed FROM matches WHERE id = $1`, [
        matchId,
      ]);
      const state = live.engine.init(
        players,
        BigInt(seed.rows[0]!.seed),
        live.buildCfg(row.options ?? {}, players.length),
      );
      // Party rooms have no "whose turn": it would give roles away (Werewolf night), and several act at once.
      const turn = live.kind === 'turns' ? (live.engine.currentPlayers(state)[0] ?? null) : null;
      const deadline =
        live.kind === 'turns' ? new Date(this.clock().getTime() + live.turnMs) : null;
      const now = this.clock();
      // Two people playing for a pot split 50/30/20 would get 62.5/37.5: use the 60/40 split instead.
      const scheme: SpacePayoutScheme =
        players.length === 2 && row.payout_scheme === 'p50_30_20' ? 'p60_40' : row.payout_scheme;
      await c.query(
        `UPDATE matches SET status = 'active', state = $2::jsonb, state_version = 0, current_turn = $3,
                turn_deadline = $4, payout_scheme = $5, live_meta = '{}'::jsonb
          WHERE id = $1`,
        [matchId, JSON.stringify(state), turn, deadline, scheme],
      );
      await c.query(`UPDATE spaces SET status = 'live', started_at = $2 WHERE id = $1`, [
        spaceId,
        now,
      ]);
      return matchId;
    });
    if (!started) return;
    await this.publish(spaceId);
    // The room is created now so the first connection finds it; if the game server is down the app
    // asks again through `connect`, which retries.
    try {
      await this.rooms.ensureRoom(started);
    } catch {
      // surfaced as room_unavailable when someone connects
    }
  }

  /** Tells every seated person (and anyone who just left) their own view of the space. */
  private async publish(spaceId: string, alsoUsers: readonly string[] = []): Promise<void> {
    try {
      const members = await this.pool.query<{ user_id: string }>(
        `SELECT user_id FROM space_members WHERE space_id = $1 AND left_at IS NULL`,
        [spaceId],
      );
      const audience = new Set([...members.rows.map((m) => m.user_id), ...alsoUsers]);
      for (const userId of audience) {
        try {
          const space = await this.view(this.pool, spaceId, userId);
          this.publisher.publish([userId], { type: 'space', space });
        } catch {
          // best effort: the app refetches on reconnect
        }
      }
    } catch {
      // ignore
    }
  }

  /** The space as `viewerId` sees it (only the `seated` and `hosting` flags depend on the viewer). */
  private async view(db: Db, spaceId: string, viewerId: string): Promise<SpaceView> {
    const s = await db.query<SpaceRow>(
      `SELECT ${SPACE_COLUMNS} FROM spaces s JOIN games g ON g.slug = s.game_slug WHERE s.id = $1`,
      [spaceId],
    );
    const row = s.rows[0];
    if (!row) throw new AuthError('space_not_found');
    const match = await db.query<{ id: string }>(
      `SELECT id FROM matches WHERE space_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [spaceId],
    );
    const matchId = match.rows[0]?.id ?? null;
    const members = await db.query<MemberRow>(
      `SELECT sm.user_id, sm.seat, sm.joined_at, pr.username, pr.display_name, pr.avatar,
              mp.staked_kobo, mp.placement, mp.result, mp.payout_kobo
         FROM space_members sm
         JOIN profiles pr ON pr.id = sm.user_id
         LEFT JOIN match_players mp ON mp.match_id = $2 AND mp.user_id = sm.user_id
        WHERE sm.space_id = $1 AND sm.left_at IS NULL
        ORDER BY sm.seat`,
      [spaceId, matchId],
    );
    const fee = Number(row.seat_fee_kobo);
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      hostId: row.host_id,
      gameSlug: row.game_slug,
      gameName: row.game_name,
      mode: row.mode,
      seatFeeKobo: fee,
      potKobo: row.mode === 'pool' ? fee * members.rows.length : 0,
      payoutScheme: row.payout_scheme,
      maxSeats: row.max_seats,
      minSeats: Math.max(row.min_players, this.games(row.game_slug)?.minPlayers ?? 2),
      visibility: row.visibility,
      startRule: row.start_rule,
      options: row.options ?? {},
      quickMatch: row.quick_match,
      status: row.status,
      members: members.rows.map((m) => ({
        userId: m.user_id,
        username: m.username,
        displayName: m.display_name,
        avatar: parseAvatar(m.avatar),
        seat: m.seat,
        isHost: m.user_id === row.host_id,
        stakedKobo: Number(m.staked_kobo ?? 0),
        placement: m.placement,
        result: m.result,
        payoutKobo: m.payout_kobo === null ? null : Number(m.payout_kobo),
      })),
      matchId,
      seated: members.rows.some((m) => m.user_id === viewerId),
      hosting: row.host_id === viewerId,
      createdAt: row.created_at.toISOString(),
    };
  }
}

/** `DY-` + 4 characters that are easy to read aloud. */
function newCode(): string {
  const bytes = randomBytes(SPACE_CODE_LENGTH);
  let out = 'DY-';
  for (const b of bytes) out += SPACE_CODE_ALPHABET[b % SPACE_CODE_ALPHABET.length];
  return out;
}

/** A random 62-bit seed (fits a Postgres bigint), as a decimal string. */
function newSeed(): string {
  return (randomBytes(8).readBigUInt64BE() & ((1n << 62n) - 1n)).toString();
}
