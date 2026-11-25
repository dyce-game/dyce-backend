import type pg from 'pg';
import {
  parseAvatar,
  type LeaderboardQuery,
  type LeaderboardResponse,
  type LeaderboardRow,
} from '@dyce/shared';
import type { Clock } from '../auth/tokens.ts';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const LAGOS_OFFSET_MS = 60 * 60 * 1000; // UTC+1, no daylight saving
/** 1970-01-01 was a Thursday; this is the first Monday (1970-01-05) in Lagos-shifted time. */
const FIRST_MONDAY_MS = 4 * DAY_MS;

/** The instant the current week began: Monday 00:00 in Lagos. */
export function lagosWeekStart(now: Date): Date {
  const shifted = now.getTime() + LAGOS_OFFSET_MS;
  const weeks = Math.floor((shifted - FIRST_MONDAY_MS) / WEEK_MS);
  return new Date(FIRST_MONDAY_MS + weeks * WEEK_MS - LAGOS_OFFSET_MS);
}

type Row = {
  user_id: string;
  username: string;
  display_name: string;
  avatar: unknown;
  value: string;
  rank: string;
  is_friend: boolean;
};

const TOP = 50;

/**
 * Weekly leaderboards (design: Leaderboard), computed from `xp_events` (XP) and finished Pool matches (net winnings).
 * The week runs Monday 00:00 to Monday 00:00 in Lagos. Friends = you and your accepted friends; global = everyone with
 * XP this week. Blocked people never appear and Pool winnings are only ranked among friends (they are money).
 */
export class LeaderboardService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly clock: Clock = () => new Date(),
  ) {}

  async get(userId: string, q: LeaderboardQuery): Promise<LeaderboardResponse> {
    const start = lagosWeekStart(this.clock());
    const end = new Date(start.getTime() + WEEK_MS);
    const friendsOnly = q.scope === 'friends';
    const game = q.game ?? null;

    // $1 viewer, $2 week start, $3 week end, $4 game (or null)
    const members = `
      SELECT $1::uuid AS user_id
      UNION
      SELECT CASE WHEN f.user_low = $1::uuid THEN f.user_high ELSE f.user_low END
        FROM friendships f WHERE f.status = 'accepted' AND $1::uuid IN (f.user_low, f.user_high)`;

    const scores =
      q.metric === 'pool'
        ? `SELECT mp.user_id, sum(coalesce(mp.payout_kobo, 0) - mp.staked_kobo)::bigint AS value
             FROM match_players mp
             JOIN matches m ON m.id = mp.match_id
            WHERE m.status = 'finished' AND mp.staked_kobo > 0
              AND m.finished_at >= $2 AND m.finished_at < $3
              AND ($4::text IS NULL OR m.game_slug = $4)
            GROUP BY mp.user_id`
        : `SELECT x.user_id, sum(x.amount)::bigint AS value
             FROM xp_events x
             LEFT JOIN matches m ON m.id = x.match_id
            WHERE x.created_at >= $2 AND x.created_at < $3 AND x.amount > 0
              AND ($4::text IS NULL OR m.game_slug = $4)
            GROUP BY x.user_id`;

    // Friends boards list everyone (a friend with no result yet shows 0); the global board only people who scored.
    const base = friendsOnly
      ? `SELECT mem.user_id, coalesce(s.value, 0) AS value
           FROM (${members}) mem LEFT JOIN (${scores}) s ON s.user_id = mem.user_id`
      : `SELECT s.user_id, s.value FROM (${scores}) s`;

    const r = await this.pool.query<Row>(
      `WITH base AS (${base}),
       visible AS (
         SELECT b.user_id, b.value FROM base b
           JOIN users u ON u.id = b.user_id AND u.disabled_at IS NULL
          WHERE b.user_id = $1::uuid OR NOT EXISTS (
                  SELECT 1 FROM blocks bl
                   WHERE (bl.blocker_id = b.user_id AND bl.blocked_id = $1::uuid)
                      OR (bl.blocker_id = $1::uuid AND bl.blocked_id = b.user_id))
       ),
       ranked AS (
         SELECT v.user_id, v.value, rank() OVER (ORDER BY v.value DESC) AS rank FROM visible v
       ),
       myrank AS (SELECT rank FROM ranked WHERE user_id = $1::uuid),
       pick AS (
         SELECT * FROM ranked
          WHERE rank <= ${TOP} OR user_id = $1::uuid
             OR rank = (SELECT max(r2.rank) FROM ranked r2 WHERE r2.rank < (SELECT rank FROM myrank))
          ORDER BY rank, user_id
          LIMIT 250
       )
       SELECT k.user_id, p.username, p.display_name, p.avatar, k.value::text AS value, k.rank::text AS rank,
              EXISTS (SELECT 1 FROM friendships f
                       WHERE f.status = 'accepted'
                         AND f.user_low = LEAST(k.user_id, $1::uuid) AND f.user_high = GREATEST(k.user_id, $1::uuid)) AS is_friend
         FROM pick k JOIN profiles p ON p.id = k.user_id
        ORDER BY k.rank, lower(p.username)`,
      [userId, start, end, game],
    );

    const all: LeaderboardRow[] = r.rows.map((x) => ({
      rank: Number(x.rank),
      userId: x.user_id,
      username: x.username,
      displayName: x.display_name,
      avatar: parseAvatar(x.avatar),
      value: Number(x.value),
      isMe: x.user_id === userId,
      isFriend: x.is_friend,
    }));
    const me = all.find((x) => x.isMe) ?? null;
    // On the global board someone with no XP this week simply is not ranked.
    const ranked = me && (friendsOnly || me.value > 0) ? me : null;
    const rows = all.filter((x) => x.rank <= TOP).slice(0, TOP);
    const above = ranked ? ([...all].reverse().find((x) => x.rank < ranked.rank) ?? null) : null;

    return {
      scope: q.scope,
      metric: q.metric,
      game,
      rows,
      me: ranked,
      above,
      weekStartsAt: start.toISOString(),
      resetsAt: end.toISOString(),
    };
  }
}
