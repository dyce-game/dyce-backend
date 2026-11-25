import type pg from 'pg';
import { parseAvatar, type StreakStatus } from '@dyce/shared';

type Row = {
  current: number;
  best: number;
  won_today: boolean;
  lost_length: number | null;
  lost_on: string | null;
  lost_seen_at: Date | null;
  saver_expires_at: Date | null;
  saver_live: boolean | null;
  to_id: string | null;
  to_username: string | null;
  to_name: string | null;
  to_avatar: unknown;
  recent: boolean | null;
};

/**
 * The streak and its saver, as the person sees them (ADR-042). The rules live in SQL (`_streak_roll`, `_streak_win`,
 * migration 0030); this reads them, notices a loss nobody has noticed yet, and records that the screen was seen.
 */
export class StreakService {
  constructor(private readonly pool: pg.Pool) {}

  async get(userId: string): Promise<StreakStatus> {
    // A streak that went a whole day without a win is only marked lost when something looks. Look now.
    await this.pool.query(`SELECT streak_check($1)`, [userId]);
    const r = await this.pool.query<Row>(
      `SELECT s.current, s.best,
              s.last_win_date = (now() AT TIME ZONE 'Africa/Lagos')::date AS won_today,
              s.lost_length, s.lost_on::text AS lost_on, s.lost_seen_at, s.saver_expires_at,
              (s.saver_expires_at IS NOT NULL AND s.saver_expires_at > now()) AS saver_live,
              p.id AS to_id, p.username AS to_username, p.display_name AS to_name, p.avatar AS to_avatar,
              -- the loss still matters: a saver is on offer, or it ended in the last three days
              (s.lost_on >= (now() AT TIME ZONE 'Africa/Lagos')::date - 3) AS recent
         FROM streaks s LEFT JOIN profiles p ON p.id = s.lost_to
        WHERE s.user_id = $1`,
      [userId],
    );
    const s = r.rows[0];
    const friend = await this.pool.query<{
      username: string;
      display_name: string;
      current: number;
    }>(
      `SELECT p.username, p.display_name, s.current
         FROM friendships f
         JOIN streaks s ON s.user_id = CASE WHEN f.user_low = $1 THEN f.user_high ELSE f.user_low END
         JOIN profiles p ON p.id = s.user_id
        WHERE f.status = 'accepted' AND $1 IN (f.user_low, f.user_high)
          AND s.current > 0 AND s.last_win_date >= (now() AT TIME ZONE 'Africa/Lagos')::date - 1
        ORDER BY s.current DESC, p.username LIMIT 1`,
      [userId],
    );
    const best = friend.rows[0];
    const friendsBest = best
      ? { username: best.username, displayName: best.display_name, length: best.current }
      : null;
    if (!s) return { current: 0, best: 0, wonToday: false, lost: null, friendsBest };

    const live = s.saver_live === true;
    const showLost = s.lost_length !== null && s.lost_on !== null && (live || s.recent === true);
    return {
      current: s.current,
      best: s.best,
      wonToday: s.won_today === true && s.current > 0,
      lost: showLost
        ? {
            length: s.lost_length!,
            endedOn: s.lost_on!,
            brokenBy: s.to_id
              ? {
                  id: s.to_id,
                  username: s.to_username!,
                  displayName: s.to_name!,
                  avatar: parseAvatar(s.to_avatar),
                }
              : null,
            saverAvailable: live,
            saverExpiresAt: live ? s.saver_expires_at!.toISOString() : null,
            seen: s.lost_seen_at !== null,
          }
        : null,
      friendsBest,
    };
  }

  /** "Not now": the screen is not pushed at them again for this loss. Idempotent. */
  async markSeen(userId: string): Promise<void> {
    await this.pool.query(`SELECT streak_mark_seen($1)`, [userId]);
  }

  /** Hourly: notice every streak that went a whole day without a win (and tell its owner). */
  async sweep(): Promise<number> {
    const r = await this.pool.query<{ n: number }>(`SELECT streak_sweep() AS n`);
    return r.rows[0]?.n ?? 0;
  }
}
