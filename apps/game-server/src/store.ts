import type pg from 'pg';
import type { LiveResultRow } from '@dyce/shared';

/** A started match as the room needs it. */
export type LoadedMatch = {
  matchId: string;
  spaceId: string;
  gameSlug: string;
  mode: 'free' | 'pool';
  /** Engine state exactly as persisted. */
  state: unknown;
  version: number;
  /** In seat order. */
  players: { userId: string; seat: number }[];
  /** Users who forfeited, in the order they did. */
  forfeited: string[];
};

/** How a finished match ranks, before the money moves. Index 0 of `placements` wins. */
export type FinalOutcome = {
  placements: string[][];
  /** Everyone left in the game tied for first (no winner). */
  draw: boolean;
  forfeited: string[];
};

/** Everything the room persists. The Postgres implementation is below; tests can pass a memory one. */
export interface LiveMatchStore {
  /** Null when the match is not running (unknown, finished, cancelled). */
  load(matchId: string): Promise<LoadedMatch | null>;
  /**
   * Appends move `seq` and stores the new state, in one transaction. Throws `version_conflict` if the
   * match is no longer at `seq - 1` (another process moved it).
   */
  saveMove(m: {
    matchId: string;
    seq: number;
    userId: string;
    action: unknown;
    state: unknown;
    currentTurn: string | null;
    turnDeadline: Date | null;
  }): Promise<void>;
  /**
   * Party rooms: appends moves `moves[0].seq` .. `moves[n-1].seq` (contiguous; a tick the room applied has
   * no player) and stores the state after the last one, in one transaction. Throws `version_conflict` if
   * the match is not at `moves[0].seq - 1`.
   */
  saveMoves(m: {
    matchId: string;
    moves: { seq: number; userId: string | null; action: unknown }[];
    state: unknown;
  }): Promise<void>;
  saveForfeits(matchId: string, forfeited: string[]): Promise<void>;
  /** Writes placements and results, settles the pot (Pool) and closes the space. Idempotent. */
  finish(matchId: string, outcome: FinalOutcome, finalState: unknown): Promise<LiveResultRow[]>;
}

/**
 * Postgres store. It connects as the same restricted role as the API: it can read and write matches and
 * move rows, but money only ever moves inside `settle_match`, which this calls once per match.
 */
export class PgLiveMatchStore implements LiveMatchStore {
  constructor(private readonly pool: pg.Pool) {}

  async load(matchId: string): Promise<LoadedMatch | null> {
    const m = await this.pool.query<{
      id: string;
      space_id: string | null;
      game_slug: string;
      mode: 'free' | 'pool';
      status: string;
      state: unknown;
      state_version: number;
      live_meta: { forfeited?: unknown } | null;
    }>(
      `SELECT id, space_id, game_slug, mode, status, state, state_version, live_meta
         FROM matches WHERE id = $1`,
      [matchId],
    );
    const row = m.rows[0];
    if (!row || row.status !== 'active' || !row.space_id) return null;
    const p = await this.pool.query<{ user_id: string; seat: number }>(
      `SELECT user_id, seat FROM match_players WHERE match_id = $1 ORDER BY seat`,
      [matchId],
    );
    const forfeited = Array.isArray(row.live_meta?.forfeited)
      ? (row.live_meta.forfeited as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    return {
      matchId: row.id,
      spaceId: row.space_id,
      gameSlug: row.game_slug,
      mode: row.mode,
      state: row.state,
      version: row.state_version,
      players: p.rows.map((r) => ({ userId: r.user_id, seat: r.seat })),
      forfeited,
    };
  }

  async saveMove(m: Parameters<LiveMatchStore['saveMove']>[0]): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const upd = await c.query(
        `UPDATE matches SET state = $2::jsonb, state_version = $3, current_turn = $4, turn_deadline = $5
          WHERE id = $1 AND status = 'active' AND state_version = $3 - 1`,
        [m.matchId, JSON.stringify(m.state), m.seq, m.currentTurn, m.turnDeadline],
      );
      if (upd.rowCount !== 1) throw new Error('version_conflict');
      await c.query(
        `INSERT INTO match_moves (match_id, seq, user_id, action) VALUES ($1, $2, $3, $4::jsonb)`,
        [m.matchId, m.seq, m.userId, JSON.stringify(m.action)],
      );
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  async saveMoves(m: Parameters<LiveMatchStore['saveMoves']>[0]): Promise<void> {
    const first = m.moves[0];
    const last = m.moves[m.moves.length - 1];
    if (!first || !last) return;
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const upd = await c.query(
        `UPDATE matches SET state = $2::jsonb, state_version = $3, current_turn = NULL, turn_deadline = NULL
          WHERE id = $1 AND status = 'active' AND state_version = $4`,
        [m.matchId, JSON.stringify(m.state), last.seq, first.seq - 1],
      );
      if (upd.rowCount !== 1) throw new Error('version_conflict');
      await c.query(
        `INSERT INTO match_moves (match_id, seq, user_id, action)
         SELECT $1, s.seq, s.user_id, s.action::jsonb
           FROM unnest($2::int[], $3::uuid[], $4::text[]) AS s(seq, user_id, action)`,
        [
          m.matchId,
          m.moves.map((x) => x.seq),
          m.moves.map((x) => x.userId),
          m.moves.map((x) => JSON.stringify(x.action)),
        ],
      );
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  async saveForfeits(matchId: string, forfeited: string[]): Promise<void> {
    await this.pool.query(
      `UPDATE matches SET live_meta = jsonb_set(live_meta, '{forfeited}', $2::jsonb) WHERE id = $1`,
      [matchId, JSON.stringify(forfeited)],
    );
  }

  async finish(
    matchId: string,
    outcome: FinalOutcome,
    finalState: unknown,
  ): Promise<LiveResultRow[]> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const m = await c.query<{ status: string; space_id: string | null }>(
        `SELECT status, space_id FROM matches WHERE id = $1 FOR UPDATE`,
        [matchId],
      );
      const row = m.rows[0];
      if (!row) throw new Error('match_not_found');
      if (row.status === 'active') {
        const placementOf = new Map<string, number>();
        outcome.placements.forEach((group, i) => group.forEach((id) => placementOf.set(id, i + 1)));
        const players = await c.query<{ user_id: string }>(
          `SELECT user_id FROM match_players WHERE match_id = $1`,
          [matchId],
        );
        const last = outcome.placements.length + 1;
        for (const { user_id } of players.rows) {
          const placement = placementOf.get(user_id) ?? last;
          const forfeited = outcome.forfeited.includes(user_id);
          const result = forfeited
            ? 'forfeit'
            : outcome.draw
              ? 'draw'
              : placement === 1
                ? 'win'
                : 'loss';
          await c.query(
            `UPDATE match_players SET placement = $3, result = $4::match_result
              WHERE match_id = $1 AND user_id = $2`,
            [matchId, user_id, placement, result],
          );
        }
        // Free: marks the match finished. Pool: pays the escrow out by placement in this same
        // transaction, so a finished match and its payouts can never disagree.
        await c.query(`SELECT settle_or_hold($1)`, [matchId]);
        // settle_match rewrites staked players' results to win/loss/draw: put the forfeits back.
        if (outcome.forfeited.length > 0) {
          await c.query(
            `UPDATE match_players SET result = 'forfeit'
              WHERE match_id = $1 AND user_id = ANY($2::uuid[])`,
            [matchId, outcome.forfeited],
          );
        }
        await c.query(
          `UPDATE matches SET state = $2::jsonb, current_turn = NULL, turn_deadline = NULL WHERE id = $1`,
          [matchId, JSON.stringify(finalState)],
        );
        if (row.space_id) {
          await c.query(
            `UPDATE spaces SET status = 'ended', ended_at = coalesce(ended_at, now()) WHERE id = $1`,
            [row.space_id],
          );
        }
      }
      const out = await c.query<{
        user_id: string;
        placement: number;
        result: LiveResultRow['result'];
        payout_kobo: string | null;
      }>(
        `SELECT user_id, placement, result, payout_kobo FROM match_players
          WHERE match_id = $1 ORDER BY placement, seat`,
        [matchId],
      );
      await c.query('COMMIT');
      return out.rows.map((r) => ({
        userId: r.user_id,
        placement: r.placement,
        result: r.result,
        payoutKobo: r.payout_kobo === null ? null : Number(r.payout_kobo),
      }));
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }
}
