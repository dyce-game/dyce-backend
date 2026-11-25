import type pg from 'pg';
import type {
  CreateDisputeRequest,
  DisputeReason,
  DisputeStatus,
  DisputeView,
  MatchDisputeInfo,
} from '@dyce/shared';
import { AuthError } from '../auth/auth-error.ts';
import type { Clock } from '../auth/tokens.ts';
import { readConfigInt } from '../db/config.ts';
import { withTx } from '../db/tx.ts';

type DisputeRow = {
  id: string;
  reference: string;
  match_id: string;
  status: DisputeStatus;
  reason: DisputeReason;
  note: string | null;
  created_at: Date;
  reviewing_at: Date | null;
  resolved_at: Date | null;
  decision_note: string | null;
};

const COLUMNS = `d.id, d.reference, d.match_id, d.status, d.reason, d.note, d.created_at, d.reviewing_at,
  d.resolved_at, d.decision_note`;

/**
 * Disputing a Pool result (SPEC section 9, ADR-037). The player says what went wrong, a person decides, and the
 * status is readable meanwhile. Opening a dispute never moves or freezes money: the payout already happened when the
 * match settled, and a correction is a reversing transaction an admin posts (see `resolve_dispute`). One dispute per
 * player per match; asking again returns the same one, so a retry after a dropped connection is harmless.
 */
export class DisputesService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly clock: Clock = () => new Date(),
  ) {}

  /** Where this result stands for the caller: their dispute, and whether they still can. */
  async info(userId: string, matchId: string): Promise<MatchDisputeInfo> {
    const m = await this.pool.query<{ mode: string; status: string; finished_at: Date | null }>(
      `SELECT m.mode, m.status, m.finished_at FROM matches m
        WHERE m.id = $1 AND EXISTS (SELECT 1 FROM match_players mp WHERE mp.match_id = m.id AND mp.user_id = $2)`,
      [matchId, userId],
    );
    const match = m.rows[0];
    if (!match) throw new AuthError('match_not_found');
    const mine = await this.pool.query<DisputeRow>(
      `SELECT ${COLUMNS} FROM disputes d WHERE d.match_id = $1 AND d.user_id = $2`,
      [matchId, userId],
    );
    const dispute = mine.rows[0] ? toView(mine.rows[0]) : null;
    const hours = await readConfigInt(this.pool, 'dispute_window_hours', 24);
    const windowEnd =
      match.finished_at !== null ? new Date(match.finished_at.getTime() + hours * 3_600_000) : null;

    let blockedBy: MatchDisputeInfo['blockedBy'] = null;
    if (match.mode !== 'pool') blockedBy = 'not_pool';
    else if (match.status !== 'finished') blockedBy = 'not_finished';
    else if (windowEnd && this.clock().getTime() > windowEnd.getTime()) blockedBy = 'window_closed';
    return {
      dispute,
      canDispute: !dispute && blockedBy === null,
      blockedBy: dispute ? null : blockedBy,
      windowEndsAt: windowEnd ? windowEnd.toISOString() : null,
    };
  }

  /** Opens the caller's dispute for a finished Pool match they played. */
  async open(userId: string, matchId: string, input: CreateDisputeRequest): Promise<DisputeView> {
    const info = await this.info(userId, matchId);
    if (info.dispute) return info.dispute;
    if (info.blockedBy === 'window_closed') throw new AuthError('dispute_window_closed');
    if (info.blockedBy) throw new AuthError('dispute_not_allowed');

    const perDay = await readConfigInt(this.pool, 'disputes_per_day', 5);
    const row = await withTx(this.pool, async (c) => {
      // serialise one person's disputes so the daily limit and the one-per-match rule cannot race
      await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`dispute:${userId}`]);
      const since = new Date(this.clock().getTime() - 86_400_000);
      const recent = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM disputes WHERE user_id = $1 AND created_at >= $2`,
        [userId, since],
      );
      if (Number(recent.rows[0]?.n ?? 0) >= perDay) throw new AuthError('disputes_rate_limited');
      const ins = await c.query<DisputeRow>(
        `INSERT INTO disputes AS d (match_id, user_id, reason, note, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (match_id, user_id) DO NOTHING
         RETURNING ${COLUMNS}`,
        [matchId, userId, input.reason, input.note?.length ? input.note : null, this.clock()],
      );
      if (ins.rows[0]) return ins.rows[0];
      const again = await c.query<DisputeRow>(
        `SELECT ${COLUMNS} FROM disputes d WHERE d.match_id = $1 AND d.user_id = $2`,
        [matchId, userId],
      );
      return again.rows[0]!;
    });
    return toView(row);
  }
}

function toView(r: DisputeRow): DisputeView {
  return {
    id: r.id,
    reference: r.reference,
    matchId: r.match_id,
    status: r.status,
    reason: r.reason,
    note: r.note,
    createdAt: r.created_at.toISOString(),
    reviewingAt: r.reviewing_at ? r.reviewing_at.toISOString() : null,
    resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
    decisionNote: r.decision_note,
  };
}
