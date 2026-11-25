import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  parseAvatar,
  type MatchMode,
  type QuickMatchGame,
  type QuickMatchState,
  type QuickMatchStatus,
  type QuickMatchTicket,
  type StartQuickMatchRequest,
} from '@dyce/shared';
import { liveGame, type LiveGame } from '@dyce/games';
import { AuthError } from '../auth/auth-error.ts';
import type { Clock } from '../auth/tokens.ts';
import type { Publisher } from '../chat/messages.service.ts';
import { DyceError, parseDbError } from '../common/dyce-error.ts';
import { readConfigInt } from '../db/config.ts';
import { withTx } from '../db/tx.ts';
import type { SpacesService } from '../spaces/spaces.service.ts';

type TicketRow = {
  id: string;
  user_id: string;
  game_slug: string;
  mode: MatchMode;
  stake_kobo: string;
  level: number;
  status: QuickMatchStatus;
  space_id: string | null;
  opponent_ticket_id: string | null;
  found_at: Date | null;
  accept_by: Date | null;
  accepted_at: Date | null;
  error_code: string | null;
  search_ends_at: Date;
  created_at: Date;
  updated_at: Date;
};

/** How long an ended ticket (declined, expired, failed...) is still shown to the person who had it. */
const SHOW_ENDED_MS = 2 * 60_000;
const MAX_CANDIDATE_TRIES = 3;
const SWEEP_BATCH = 100;

/** A seat's own problem while pairing (cannot afford the stake, too many spaces...): that ticket is dropped, the other goes on. */
class SeatFailure extends Error {
  constructor(
    readonly userId: string,
    readonly code: string,
  ) {
    super(code);
  }
}

/**
 * Quick match (SPEC section 7): join a queue for a game and a mode, get paired with a stranger of a
 * similar level, both accept within 10 seconds, and play in a live room.
 *
 * - **The queue is a table** (`quick_match_tickets`). Pairing runs in one transaction that locks both
 *   tickets (`FOR UPDATE SKIP LOCKED`, so parallel sweeps and sign-ups never pair a ticket twice), opens
 *   a waiting two-seat space through `SpacesService` and, in Pool, escrows **both seat fees at that moment**
 *   with `stake_pool`. A stake that is refused (cash, 18+, daily limits) drops only that person's ticket;
 *   the other keeps searching.
 * - **Accept window.** Both must accept in time. A decline or a missed window closes the space and
 *   `refund_match` returns both stakes; the person who did not fail goes back to searching with their
 *   place in the queue. Money moves only inside SQL functions.
 * - **Who is matched.** Same game, mode and stake; a level within `quick_match_level_gap` until either
 *   has waited `quick_match_widen_seconds`, then anyone; never a blocked pair (either direction), never
 *   the same two people twice within `quick_match_rematch_minutes`; never yourself; in Pool never two accounts that share a device or IP fingerprint (ADR-039).
 * - **Strangers get no chat.** Nothing here creates a conversation or a friendship; the opponent's
 *   public fields (name, avatar, level, win rate) are all that is shown. If one of them writes to the
 *   other later, the existing messaging rules put it in Requests (ADR-010).
 */
export class QuickMatchService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly publisher: Publisher,
    private readonly spaces: SpacesService,
    private readonly clock: Clock = () => new Date(),
    private readonly games: (slug: string) => LiveGame | null = liveGame,
  ) {}

  // ---- reading --------------------------------------------------------------------------------

  /** Your open search (or the one that just ended) and the games you can quick match. */
  async state(userId: string): Promise<QuickMatchState> {
    const since = new Date(this.clock().getTime() - SHOW_ENDED_MS);
    const r = await this.pool.query<TicketRow>(
      `SELECT * FROM quick_match_tickets
        WHERE user_id = $1 AND (status IN ('searching', 'found') OR updated_at >= $2)
        ORDER BY (status IN ('searching', 'found')) DESC, created_at DESC LIMIT 1`,
      [userId, since],
    );
    return {
      ticket: r.rows[0] ? await this.view(this.pool, r.rows[0], userId) : null,
      games: await this.availableGames(),
    };
  }

  private async availableGames(): Promise<QuickMatchGame[]> {
    const r = await this.pool.query<{ slug: string; name: string; supports_pool: boolean }>(
      `SELECT slug, name, supports_pool FROM games WHERE enabled AND sync = 'live' ORDER BY name`,
    );
    return r.rows
      .filter((g) => this.games(g.slug)?.quickMatch === true)
      .map((g) => ({ slug: g.slug, name: g.name, supportsPool: g.supports_pool }));
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  /** Joins the queue. Safe to repeat: the same search returns your open ticket. */
  async join(userId: string, input: StartQuickMatchRequest): Promise<QuickMatchTicket> {
    const mode: MatchMode = input.mode ?? 'free';
    const stake = mode === 'pool' ? (input.stakeKobo ?? 0) : 0;
    const live = this.games(input.gameSlug);
    const g = await this.pool.query<{ enabled: boolean; sync: string; supports_pool: boolean }>(
      `SELECT enabled, sync, supports_pool FROM games WHERE slug = $1`,
      [input.gameSlug],
    );
    const game = g.rows[0];
    if (!live || !game?.enabled || game.sync !== 'live') throw new AuthError('game_not_found');
    if (!live.quickMatch) throw new AuthError('quick_match_unavailable');
    if (mode === 'pool') {
      if (!game.supports_pool) throw new AuthError('pool_not_supported');
      await this.assertStakeOk(userId, stake);
    }

    const now = this.clock();
    const created = await withTx(this.pool, async (c) => {
      // Serialise one person's joins so a double tap can neither open two searches nor skip the limits.
      await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`qm:${userId}`]);
      const open = await c.query<TicketRow>(
        `SELECT * FROM quick_match_tickets WHERE user_id = $1 AND status IN ('searching', 'found')`,
        [userId],
      );
      const existing = open.rows[0];
      if (existing) {
        if (
          existing.game_slug === input.gameSlug &&
          existing.mode === mode &&
          Number(existing.stake_kobo) === stake
        ) {
          return { id: existing.id, fresh: false };
        }
        throw new AuthError('quick_match_active');
      }

      const perHour = await readConfigInt(c, 'quick_match_per_hour', 30);
      const hourAgo = new Date(now.getTime() - 3_600_000);
      const made = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM quick_match_tickets WHERE user_id = $1 AND created_at >= $2`,
        [userId, hourAgo],
      );
      if (Number(made.rows[0]?.n ?? 0) >= perHour) throw new AuthError('quick_match_rate_limited');

      // Walking away from found matches wastes the other person's time: a short cooldown.
      const missLimit = await readConfigInt(c, 'quick_match_miss_limit', 3);
      const tenAgo = new Date(now.getTime() - 10 * 60_000);
      const misses = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM quick_match_tickets
          WHERE user_id = $1 AND status IN ('declined', 'missed') AND updated_at >= $2`,
        [userId, tenAgo],
      );
      if (Number(misses.rows[0]?.n ?? 0) >= missLimit) throw new AuthError('quick_match_cooldown');

      const profile = await c.query<{ level: number }>(`SELECT level FROM profiles WHERE id = $1`, [
        userId,
      ]);
      if (!profile.rows[0]) throw new AuthError('profile_required');
      const searchSeconds = await readConfigInt(c, 'quick_match_search_seconds', 60);
      const id = randomUUID();
      await c.query(
        `INSERT INTO quick_match_tickets
           (id, user_id, game_slug, mode, stake_kobo, level, status, search_ends_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'searching', $7, $8, $8)`,
        [
          id,
          userId,
          input.gameSlug,
          mode,
          stake,
          profile.rows[0].level,
          new Date(now.getTime() + searchSeconds * 1000),
          now,
        ],
      );
      return { id, fresh: true };
    });

    if (created.fresh) await this.tryPair(created.id);
    const row = await this.load(this.pool, created.id);
    const ticket = await this.view(this.pool, row, userId);
    if (created.fresh) await this.publishTicket(row.id);
    return ticket;
  }

  /** Leaves the queue (searching) or turns a found match down (found). Idempotent. */
  async cancel(userId: string, ticketId: string): Promise<QuickMatchTicket> {
    return this.walkAway(userId, ticketId, 'cancelled');
  }

  /** Turns a found match down: the stakes go back and the other person searches on. Idempotent. */
  async decline(userId: string, ticketId: string): Promise<QuickMatchTicket> {
    return this.walkAway(userId, ticketId, 'declined');
  }

  /** Says yes to a found match. When both have, the space starts. Idempotent. */
  async accept(userId: string, ticketId: string): Promise<QuickMatchTicket> {
    const now = this.clock();
    const grace = await readConfigInt(this.pool, 'quick_match_accept_grace_seconds', 3);
    const outcome = await withTx(this.pool, async (c) => {
      const mine = await this.ownTicket(c, userId, ticketId);
      if (mine.status === 'playing') return { startSpace: null, both: false };
      if (mine.status !== 'found' || !mine.opponent_ticket_id || !mine.space_id) {
        throw new AuthError('quick_match_expired');
      }
      const pair = await this.lockPair(c, mine.id, mine.opponent_ticket_id);
      const me = pair.find((t) => t.id === mine.id)!;
      const opp = pair.find((t) => t.id !== mine.id);
      if (me.status !== 'found' || !opp || opp.status !== 'found') {
        throw new AuthError('quick_match_expired');
      }
      if (me.accepted_at) return { startSpace: null, both: false };
      const deadline = me.accept_by!.getTime() + grace * 1000;
      if (now.getTime() > deadline) throw new AuthError('quick_match_expired');
      await c.query(
        `UPDATE quick_match_tickets SET accepted_at = $2, updated_at = $2 WHERE id = $1`,
        [me.id, now],
      );
      return { startSpace: opp.accepted_at ? me.space_id : null, both: !!opp.accepted_at };
    });

    if (outcome.startSpace) await this.startPaired(outcome.startSpace);
    await this.publishPairOf(ticketId);
    return this.view(this.pool, await this.ownTicket(this.pool, userId, ticketId), userId);
  }

  // ---- the periodic work ----------------------------------------------------------------------

  /**
   * Run every couple of seconds (and by tests with a fake clock): gives up on old searches, settles matches
   * nobody accepted in time (refunding stakes), restarts accepted pairs a crash left unstarted, then
   * tries to pair whoever is still waiting (the level gap widens as people wait).
   */
  async sweep(): Promise<{ expired: number; missed: number; paired: number; restarted: number }> {
    const now = this.clock();
    const expiredIds = await this.pool.query<{ id: string }>(
      `UPDATE quick_match_tickets SET status = 'expired', updated_at = $1
        WHERE status = 'searching' AND search_ends_at <= $1 RETURNING id`,
      [now],
    );
    for (const { id } of expiredIds.rows) await this.publishTicket(id);

    const missed = await this.settleOverdue(now);
    const restarted = await this.restartAccepted(now);

    let paired = 0;
    const waiting = await this.pool.query<{ id: string }>(
      `SELECT id FROM quick_match_tickets WHERE status = 'searching'
        ORDER BY created_at LIMIT ${SWEEP_BATCH}`,
    );
    for (const { id } of waiting.rows) if (await this.tryPair(id)) paired += 1;
    return { expired: expiredIds.rowCount ?? 0, missed, paired, restarted };
  }

  // ---- pairing --------------------------------------------------------------------------------

  /** Tries to pair one searching ticket with the best waiting one. Returns whether it did. */
  async tryPair(ticketId: string): Promise<boolean> {
    const now = this.clock();
    const gap = await readConfigInt(this.pool, 'quick_match_level_gap', 3);
    const widenS = await readConfigInt(this.pool, 'quick_match_widen_seconds', 15);
    const acceptS = await readConfigInt(this.pool, 'quick_match_accept_seconds', 10);
    const rematchMin = await readConfigInt(this.pool, 'quick_match_rematch_minutes', 10);
    const widenCutoff = new Date(now.getTime() - widenS * 1000);
    const rematchSince = new Date(now.getTime() - rematchMin * 60_000);

    const result = await withTx(this.pool, async (c) => {
      const mine = (
        await c.query<TicketRow>(
          `SELECT * FROM quick_match_tickets WHERE id = $1 AND status = 'searching' FOR UPDATE SKIP LOCKED`,
          [ticketId],
        )
      ).rows[0];
      if (!mine) return { paired: null as null | [string, string], dropped: [] as string[] };
      const dropped: string[] = [];

      for (let attempt = 0; attempt < MAX_CANDIDATE_TRIES; attempt++) {
        const cand = (
          await c.query<TicketRow>(
            `SELECT t.* FROM quick_match_tickets t
              WHERE t.status = 'searching' AND t.game_slug = $1 AND t.mode = $2 AND t.stake_kobo = $3
                AND t.user_id <> $4 AND t.search_ends_at > $5
                AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = t.user_id AND u.disabled_at IS NOT NULL)
                AND NOT EXISTS (
                  SELECT 1 FROM blocks b
                   WHERE (b.blocker_id = $4 AND b.blocked_id = t.user_id)
                      OR (b.blocker_id = t.user_id AND b.blocked_id = $4))
                -- Pool: never two accounts that share a phone or a connection (ADR-039, collusion)
                AND ($2::match_mode <> 'pool' OR NOT users_share_fingerprint($4, t.user_id))
                AND NOT EXISTS (
                  SELECT 1 FROM spaces s
                    JOIN space_members a ON a.space_id = s.id AND a.user_id = $4
                    JOIN space_members b ON b.space_id = s.id AND b.user_id = t.user_id
                   WHERE s.quick_match AND s.started_at > $9)
                AND (abs(t.level - $6) <= $7 OR LEAST(t.created_at, $8::timestamptz) <= $10)
              ORDER BY abs(t.level - $6), t.created_at
              LIMIT 1 FOR UPDATE OF t SKIP LOCKED`,
            [
              mine.game_slug,
              mine.mode,
              mine.stake_kobo,
              mine.user_id,
              now,
              mine.level,
              gap,
              mine.created_at,
              rematchSince,
              widenCutoff,
            ],
          )
        ).rows[0];
        if (!cand) return { paired: null, dropped };

        await c.query('SAVEPOINT pairing');
        try {
          const fee = Number(mine.stake_kobo);
          const seat = async <T>(userId: string, fn: () => Promise<T>): Promise<T> => {
            try {
              return await fn();
            } catch (err) {
              const typed =
                err instanceof AuthError || err instanceof DyceError ? err : parseDbError(err);
              if (typed) throw new SeatFailure(userId, typed.code);
              throw err;
            }
          };
          await seat(mine.user_id, () => this.spaces.assertCanSeat(c, mine.user_id));
          await seat(cand.user_id, () => this.spaces.assertCanSeat(c, cand.user_id));
          const { spaceId, matchId } = await this.spaces.openQuickSpace(c, {
            gameSlug: mine.game_slug,
            mode: mine.mode,
            seatFeeKobo: fee,
            players: [mine.user_id, cand.user_id],
          });
          if (mine.mode === 'pool') {
            await seat(mine.user_id, () => this.spaces.stake(c, matchId, mine.user_id, fee, 1));
            await seat(cand.user_id, () => this.spaces.stake(c, matchId, cand.user_id, fee, 1));
          }
          const acceptBy = new Date(now.getTime() + acceptS * 1000);
          for (const [t, other] of [
            [mine, cand],
            [cand, mine],
          ] as const) {
            await c.query(
              `UPDATE quick_match_tickets
                  SET status = 'found', space_id = $2, opponent_ticket_id = $3, found_at = $4,
                      accept_by = $5, accepted_at = NULL, error_code = NULL, updated_at = $4
                WHERE id = $1`,
              [t.id, spaceId, other.id, now, acceptBy],
            );
          }
          await c.query('RELEASE SAVEPOINT pairing');
          return { paired: [mine.id, cand.id] as [string, string], dropped };
        } catch (err) {
          await c.query('ROLLBACK TO SAVEPOINT pairing');
          if (!(err instanceof SeatFailure)) throw err;
          // Only the person whose seat failed leaves the queue; the other goes on to the next candidate.
          const failedTicket = err.userId === mine.user_id ? mine : cand;
          await c.query(
            `UPDATE quick_match_tickets SET status = 'failed', error_code = $2, updated_at = $3 WHERE id = $1`,
            [failedTicket.id, err.code, now],
          );
          dropped.push(failedTicket.id);
          if (failedTicket.id === mine.id) return { paired: null, dropped };
        }
      }
      return { paired: null, dropped };
    });

    for (const id of result.dropped) await this.publishTicket(id);
    if (result.paired) {
      for (const id of result.paired) await this.publishTicket(id);
      return true;
    }
    return false;
  }

  // ---- internals ------------------------------------------------------------------------------

  /** Cancel or decline: `searching` just leaves the queue; `found` also closes the space and refunds. */
  private async walkAway(
    userId: string,
    ticketId: string,
    endStatus: 'cancelled' | 'declined',
  ): Promise<QuickMatchTicket> {
    const now = this.clock();
    const requeue: string[] = [];
    await withTx(this.pool, async (c) => {
      let mine = await this.ownTicket(c, userId, ticketId);
      if (mine.status === 'searching') {
        // Atomic: if a pairing commits first this matches nothing and we fall through to the found case.
        const left = await c.query(
          `UPDATE quick_match_tickets SET status = 'cancelled', updated_at = $2
            WHERE id = $1 AND status = 'searching'`,
          [mine.id, now],
        );
        if (left.rowCount === 1) return;
        mine = await this.ownTicket(c, userId, ticketId);
      }
      if (mine.status !== 'found' || !mine.opponent_ticket_id || !mine.space_id) return;
      const pair = await this.lockPair(c, mine.id, mine.opponent_ticket_id);
      const me = pair.find((t) => t.id === mine.id)!;
      const opp = pair.find((t) => t.id !== mine.id);
      if (me.status !== 'found') return;
      await this.spaces.closeQuickSpace(c, me.space_id!, 'cancelled');
      await c.query(`UPDATE quick_match_tickets SET status = $2, updated_at = $3 WHERE id = $1`, [
        me.id,
        endStatus,
        now,
      ]);
      if (opp && opp.status === 'found') {
        await this.requeue(c, opp, now);
        requeue.push(opp.id);
      }
    });
    await this.publishTicket(ticketId);
    for (const id of requeue) {
      await this.publishTicket(id);
      await this.tryPair(id);
    }
    return this.view(this.pool, await this.ownTicket(this.pool, userId, ticketId), userId);
  }

  /** The other side fell through: back into the queue with the same place, and a fresh search window. */
  private async requeue(c: pg.PoolClient, t: TicketRow, now: Date): Promise<void> {
    const searchS = await readConfigInt(c, 'quick_match_search_seconds', 60);
    await c.query(
      `UPDATE quick_match_tickets
          SET status = 'searching', space_id = NULL, opponent_ticket_id = NULL, found_at = NULL,
              accept_by = NULL, accepted_at = NULL, search_ends_at = $2, updated_at = $3
        WHERE id = $1`,
      [t.id, new Date(now.getTime() + searchS * 1000), now],
    );
  }

  /** Found matches whose window ran out: whoever did not accept missed it; the stakes go back. */
  private async settleOverdue(now: Date): Promise<number> {
    const grace = await readConfigInt(this.pool, 'quick_match_accept_grace_seconds', 3);
    const cutoff = new Date(now.getTime() - grace * 1000);
    const overdue = await this.pool.query<TicketRow>(
      `SELECT * FROM quick_match_tickets t
        WHERE status = 'found' AND accept_by <= $1
          AND NOT (accepted_at IS NOT NULL AND EXISTS (
                SELECT 1 FROM quick_match_tickets o WHERE o.id = t.opponent_ticket_id AND o.accepted_at IS NOT NULL))
        ORDER BY accept_by LIMIT 50`,
      [cutoff],
    );
    let n = 0;
    const touched: string[] = [];
    const again: string[] = [];
    for (const first of overdue.rows) {
      if (!first.opponent_ticket_id || !first.space_id) continue;
      const done = await withTx(this.pool, async (c) => {
        const pair = await this.lockPair(c, first.id, first.opponent_ticket_id!);
        if (pair.length !== 2 || pair.some((t) => t.status !== 'found')) return false;
        await this.spaces.closeQuickSpace(c, first.space_id!, 'expired');
        for (const t of pair) {
          if (t.accepted_at) {
            await this.requeue(c, t, now);
            again.push(t.id);
          } else {
            await c.query(
              `UPDATE quick_match_tickets SET status = 'missed', updated_at = $2 WHERE id = $1`,
              [t.id, now],
            );
          }
          touched.push(t.id);
        }
        return true;
      });
      if (done) n += 1;
    }
    for (const id of touched) await this.publishTicket(id);
    for (const id of again) await this.tryPair(id);
    return n;
  }

  /** Both accepted but the start did not finish (a crash): start it now. */
  private async restartAccepted(now: Date): Promise<number> {
    const grace = await readConfigInt(this.pool, 'quick_match_accept_grace_seconds', 3);
    const cutoff = new Date(now.getTime() - grace * 1000);
    const stuck = await this.pool.query<{ space_id: string }>(
      `SELECT DISTINCT t.space_id FROM quick_match_tickets t
         JOIN quick_match_tickets o ON o.id = t.opponent_ticket_id
        WHERE t.status = 'found' AND o.status = 'found' AND t.accepted_at IS NOT NULL
          AND o.accepted_at IS NOT NULL AND t.accept_by <= $1 AND t.space_id IS NOT NULL LIMIT 20`,
      [cutoff],
    );
    for (const { space_id } of stuck.rows) await this.startPaired(space_id);
    return stuck.rowCount ?? 0;
  }

  /** Starts the space of two people who both accepted, then marks both tickets `playing`. */
  private async startPaired(spaceId: string): Promise<void> {
    const now = this.clock();
    try {
      await this.spaces.startQuickSpace(spaceId);
    } catch (err) {
      // The game could not start (engine refused, space already gone): give both their money back.
      const code = err instanceof AuthError ? err.code : 'start_failed';
      const ids: string[] = [];
      await withTx(this.pool, async (c) => {
        await this.spaces.closeQuickSpace(c, spaceId, 'cancelled');
        const r = await c.query<{ id: string }>(
          `UPDATE quick_match_tickets SET status = 'failed', error_code = $2, updated_at = $3
            WHERE space_id = $1 AND status = 'found' RETURNING id`,
          [spaceId, code, now],
        );
        ids.push(...r.rows.map((x) => x.id));
      });
      for (const id of ids) await this.publishTicket(id);
      return;
    }
    const r = await this.pool.query<{ id: string }>(
      `UPDATE quick_match_tickets SET status = 'playing', updated_at = $2
        WHERE space_id = $1 AND status = 'found' RETURNING id`,
      [spaceId, now],
    );
    for (const { id } of r.rows) await this.publishTicket(id);
  }

  private async assertStakeOk(userId: string, stake: number): Promise<void> {
    const min = await readConfigInt(this.pool, 'pool_min_stake_kobo', 10_000);
    const max = await readConfigInt(this.pool, 'pool_max_stake_kobo', 2_000_000);
    if (!Number.isInteger(stake) || stake < min || stake > max) {
      throw new AuthError('invalid_stake', { minStakeKobo: min, maxStakeKobo: max });
    }
    // A cheap early look so a search that could never be paired fails now, not after a wait.
    const r = await this.pool.query<{ is_adult: boolean; pool_frozen: boolean; balance: string }>(
      `SELECT p.is_adult, p.pool_frozen, coalesce(w.balance_kobo, 0) AS balance
         FROM profiles p LEFT JOIN wallets w ON w.user_id = p.id WHERE p.id = $1`,
      [userId],
    );
    const me = r.rows[0];
    if (!me) throw new AuthError('profile_required');
    if (!me.is_adult) throw new DyceError('adult_required');
    if (me.pool_frozen) throw new DyceError('pool_frozen');
    if (Number(me.balance) < stake) throw new DyceError('insufficient_funds');
  }

  private async load(db: Pick<pg.Pool, 'query'>, id: string): Promise<TicketRow> {
    const r = await db.query<TicketRow>(`SELECT * FROM quick_match_tickets WHERE id = $1`, [id]);
    if (!r.rows[0]) throw new AuthError('quick_match_not_found');
    return r.rows[0];
  }

  private async ownTicket(
    db: Pick<pg.Pool, 'query'> | pg.PoolClient,
    userId: string,
    ticketId: string,
  ): Promise<TicketRow> {
    const r = await db.query<TicketRow>(
      `SELECT * FROM quick_match_tickets WHERE id = $1 AND user_id = $2`,
      [ticketId, userId],
    );
    if (!r.rows[0]) throw new AuthError('quick_match_not_found');
    return r.rows[0];
  }

  /** Locks both tickets in id order so two people acting at once can never deadlock. */
  private async lockPair(c: pg.PoolClient, a: string, b: string): Promise<TicketRow[]> {
    const r = await c.query<TicketRow>(
      `SELECT * FROM quick_match_tickets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [[a, b]],
    );
    return r.rows;
  }

  private async publishPairOf(ticketId: string): Promise<void> {
    try {
      const t = await this.load(this.pool, ticketId);
      await this.publishTicket(t.id);
      if (t.opponent_ticket_id) await this.publishTicket(t.opponent_ticket_id);
    } catch {
      // best effort
    }
  }

  private async publishTicket(ticketId: string): Promise<void> {
    try {
      const row = await this.load(this.pool, ticketId);
      const ticket = await this.view(this.pool, row, row.user_id);
      this.publisher.publish([row.user_id], { type: 'quick_match', ticket });
    } catch {
      // best effort: the app polls while it searches
    }
  }

  /** The ticket as its owner sees it. The opponent is only shown once matched. */
  private async view(
    db: Pick<pg.Pool, 'query'>,
    t: TicketRow,
    viewerId: string,
  ): Promise<QuickMatchTicket> {
    const live = this.games(t.game_slug);
    const name = await db.query<{ name: string }>(`SELECT name FROM games WHERE slug = $1`, [
      t.game_slug,
    ]);
    const looking = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM quick_match_tickets WHERE status = 'searching' AND game_slug = $1`,
      [t.game_slug],
    );
    let opponent: QuickMatchTicket['opponent'] = null;
    if ((t.status === 'found' || t.status === 'playing') && t.opponent_ticket_id) {
      const o = await db.query<{
        user_id: string;
        username: string;
        display_name: string;
        avatar: unknown;
        level: number;
        games: string;
        wins: string;
      }>(
        `SELECT p.id AS user_id, p.username, p.display_name, p.avatar, p.level,
                (SELECT count(*) FROM match_players mp WHERE mp.user_id = p.id AND mp.result IS NOT NULL) AS games,
                (SELECT count(*) FROM match_players mp WHERE mp.user_id = p.id AND mp.result = 'win') AS wins
           FROM quick_match_tickets ot JOIN profiles p ON p.id = ot.user_id
          WHERE ot.id = $1 AND ot.user_id <> $2`,
        [t.opponent_ticket_id, viewerId],
      );
      const row = o.rows[0];
      if (row) {
        const games = Number(row.games);
        opponent = {
          userId: row.user_id,
          username: row.username,
          displayName: row.display_name,
          avatar: parseAvatar(row.avatar),
          level: row.level,
          winRatePct: games > 0 ? Math.round((100 * Number(row.wins)) / games) : null,
          games,
        };
      }
    }
    return {
      id: t.id,
      status: t.status,
      gameSlug: t.game_slug,
      gameName: name.rows[0]?.name ?? live?.slug ?? t.game_slug,
      mode: t.mode,
      stakeKobo: Number(t.stake_kobo),
      createdAt: t.created_at.toISOString(),
      searchEndsAt: t.search_ends_at.toISOString(),
      acceptBy: t.status === 'found' ? (t.accept_by?.toISOString() ?? null) : null,
      accepted: t.accepted_at !== null,
      opponent,
      spaceId: t.status === 'playing' ? t.space_id : null,
      lookingCount: Number(looking.rows[0]?.n ?? 0),
      errorCode: t.error_code,
    };
  }
}
