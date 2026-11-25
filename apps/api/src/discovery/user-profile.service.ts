import type pg from 'pg';
import {
  parseAvatar,
  type BadgesResponse,
  type HeadToHead,
  type MutualFriend,
  type PlaysMost,
  type ProfileBadge,
  type ProfileRelationship,
  type RecentGame,
  type RequestPolicy,
  type UserProfile,
} from '@dyce/shared';
import { AuthError } from '../auth/auth-error.ts';
import { FRIENDSHIP_JOIN, NOT_BLOCKED, RELATIONSHIP_EXPR } from '../social/relationship.ts';

type TargetRow = {
  id: string;
  username: string;
  display_name: string;
  avatar: unknown;
  level: number;
  xp: number;
  request_policy: RequestPolicy;
  relationship: Exclude<ProfileRelationship, 'self'>;
  in_contacts: boolean;
};

type BadgeRow = {
  slug: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  earned_at: Date | null;
};

const toBadge = (b: BadgeRow): ProfileBadge => ({
  slug: b.slug,
  name: b.name,
  description: b.description,
  mark: b.icon,
  color: b.color,
  earnedAt: b.earned_at?.toISOString() ?? null,
});

/**
 * Someone's profile (design: UserProfile) built from real match data.
 *
 * Privacy contract: blocked people (either way) and disabled accounts look like they don't exist; no phone
 * number or hash is ever selected; a stranger shows level, badges, win record and mutual friends but not their
 * recent games; money figures (Pool net, best pot, what a game paid) are only ever your own.
 */
export class UserProfileService {
  constructor(private readonly pool: pg.Pool) {}

  async get(viewerId: string, username: string): Promise<UserProfile> {
    const t = await this.pool.query<TargetRow>(
      `SELECT u.id, p.username, p.display_name, p.avatar, p.level, p.xp, p.request_policy,
              ${RELATIONSHIP_EXPR} AS relationship,
              (coalesce(f.status = 'accepted', false) OR EXISTS (
                 SELECT 1 FROM contact_links cl WHERE cl.owner_id = $1::uuid AND cl.contact_user_id = u.id)) AS in_contacts
         FROM profiles p
         JOIN users u ON u.id = p.id
         ${FRIENDSHIP_JOIN}
        WHERE lower(p.username) = $2 AND u.disabled_at IS NULL AND (u.id = $1::uuid OR ${NOT_BLOCKED})`,
      [viewerId, username.toLowerCase()],
    );
    const row = t.rows[0];
    if (!row) throw new AuthError('user_not_found');
    const self = row.id === viewerId;
    const isFriend = row.relationship === 'friends';

    const [mutual, stats, playsMost, badges, h2h, recent, money] = await Promise.all([
      self
        ? Promise.resolve({ count: 0, sample: [] as MutualFriend[] })
        : this.mutualFriends(viewerId, row.id),
      this.stats(row.id),
      this.playsMost(row.id),
      this.earnedBadges(row.id),
      self ? Promise.resolve(null) : this.headToHead(viewerId, row.id),
      self || isFriend ? this.recentGames(row.id, self) : Promise.resolve(null),
      self ? this.money(row.id) : Promise.resolve(null),
    ]);

    const canRequest =
      !self &&
      row.relationship === 'none' &&
      (row.request_policy === 'everyone' ||
        (row.request_policy === 'fof' && (mutual.count > 0 || row.in_contacts)));

    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      avatar: parseAvatar(row.avatar),
      level: row.level,
      xp: row.xp,
      xpForLevel: 75 * Math.max(1, row.level),
      relationship: self ? 'self' : row.relationship,
      inContacts: self || row.in_contacts,
      mutualFriends: mutual,
      stats,
      playsMost,
      badges,
      headToHead: h2h,
      recentGames: recent,
      money,
      canRequest,
    };
  }

  /** Every badge with the date you earned it (null = still locked). */
  async myBadges(userId: string): Promise<BadgesResponse> {
    const r = await this.pool.query<BadgeRow>(
      `SELECT b.slug, b.name, b.description, b.icon, b.color, ub.earned_at
         FROM badges b LEFT JOIN user_badges ub ON ub.badge_slug = b.slug AND ub.user_id = $1
        ORDER BY b.sort, b.slug`,
      [userId],
    );
    return { badges: r.rows.map(toBadge) };
  }

  private async mutualFriends(
    viewerId: string,
    targetId: string,
  ): Promise<UserProfile['mutualFriends']> {
    const r = await this.pool.query<{
      id: string;
      username: string;
      display_name: string;
      avatar: unknown;
    }>(
      `SELECT p.id, p.username, p.display_name, p.avatar
         FROM (
           SELECT CASE WHEN a.user_low = $1::uuid THEN a.user_high ELSE a.user_low END AS id
             FROM friendships a WHERE a.status = 'accepted' AND $1::uuid IN (a.user_low, a.user_high)
           INTERSECT
           SELECT CASE WHEN b.user_low = $2::uuid THEN b.user_high ELSE b.user_low END
             FROM friendships b WHERE b.status = 'accepted' AND $2::uuid IN (b.user_low, b.user_high)
         ) m
         JOIN profiles p ON p.id = m.id
         JOIN users u ON u.id = p.id AND u.disabled_at IS NULL
        WHERE NOT EXISTS (SELECT 1 FROM blocks bl
                           WHERE (bl.blocker_id = m.id AND bl.blocked_id = $1::uuid)
                              OR (bl.blocker_id = $1::uuid AND bl.blocked_id = m.id))
        ORDER BY lower(p.username)`,
      [viewerId, targetId],
    );
    return {
      count: r.rows.length,
      sample: r.rows.slice(0, 3).map((x): MutualFriend => ({
        id: x.id,
        username: x.username,
        displayName: x.display_name,
        avatar: parseAvatar(x.avatar),
      })),
    };
  }

  private async stats(userId: string): Promise<UserProfile['stats']> {
    const r = await this.pool.query<{ games: number; wins: number; streak: number; best: number }>(
      `SELECT (SELECT count(*)::int FROM match_players mp JOIN matches m ON m.id = mp.match_id
                WHERE mp.user_id = $1 AND m.status = 'finished' AND mp.result IS NOT NULL) AS games,
              (SELECT count(*)::int FROM match_players mp JOIN matches m ON m.id = mp.match_id
                WHERE mp.user_id = $1 AND m.status = 'finished' AND mp.result = 'win') AS wins,
              coalesce((SELECT CASE WHEN last_win_date >= (now() AT TIME ZONE 'Africa/Lagos')::date - 1 THEN current ELSE 0 END
                          FROM streaks WHERE user_id = $1), 0) AS streak,
              coalesce((SELECT best FROM streaks WHERE user_id = $1), 0) AS best`,
      [userId],
    );
    const s = r.rows[0]!;
    return {
      games: s.games,
      wins: s.wins,
      winRate: s.games > 0 ? s.wins / s.games : null,
      streak: s.streak,
      bestStreak: s.best,
    };
  }

  private async playsMost(userId: string): Promise<PlaysMost[]> {
    const r = await this.pool.query<{ slug: string; name: string; played: number; wins: number }>(
      `SELECT g.slug, g.name, count(*)::int AS played, count(*) FILTER (WHERE mp.result = 'win')::int AS wins
         FROM match_players mp
         JOIN matches m ON m.id = mp.match_id AND m.status = 'finished'
         JOIN games g ON g.slug = m.game_slug
        WHERE mp.user_id = $1 AND mp.result IS NOT NULL
        GROUP BY g.slug, g.name
        ORDER BY played DESC, wins DESC, g.name
        LIMIT 3`,
      [userId],
    );
    return r.rows.map((x) => ({
      gameSlug: x.slug,
      gameName: x.name,
      wins: x.wins,
      played: x.played,
    }));
  }

  private async earnedBadges(userId: string): Promise<ProfileBadge[]> {
    const r = await this.pool.query<BadgeRow>(
      `SELECT b.slug, b.name, b.description, b.icon, b.color, ub.earned_at
         FROM user_badges ub JOIN badges b ON b.slug = ub.badge_slug
        WHERE ub.user_id = $1 ORDER BY ub.earned_at DESC, b.sort`,
      [userId],
    );
    return r.rows.map(toBadge);
  }

  /** You against them, in finished 1v1 games only (Spaces are not a duel). */
  private async headToHead(viewerId: string, targetId: string): Promise<HeadToHead> {
    const r = await this.pool.query<{
      slug: string;
      name: string;
      mode: 'free' | 'pool';
      result: 'win' | 'loss' | 'draw' | 'forfeit';
      staked: string;
      payout: string | null;
      at: Date;
    }>(
      `SELECT g.slug, g.name, m.mode, mine.result, mine.staked_kobo AS staked, mine.payout_kobo AS payout,
              coalesce(m.finished_at, m.created_at) AS at
         FROM matches m
         JOIN match_players mine ON mine.match_id = m.id AND mine.user_id = $1
         JOIN match_players them ON them.match_id = m.id AND them.user_id = $2
         JOIN games g ON g.slug = m.game_slug
        WHERE m.status = 'finished' AND mine.result IS NOT NULL
          AND (SELECT count(*) FROM match_players x WHERE x.match_id = m.id) = 2
        ORDER BY coalesce(m.finished_at, m.created_at) DESC
        LIMIT 200`,
      [viewerId, targetId],
    );
    const out: HeadToHead = { wins: 0, losses: 0, draws: 0, last: null };
    for (const x of r.rows) {
      if (x.result === 'win') out.wins++;
      else if (x.result === 'draw') out.draws++;
      else out.losses++;
    }
    const last = r.rows[0];
    if (last) {
      const pool = Number(last.staked) > 0;
      out.last = {
        gameSlug: last.slug,
        gameName: last.name,
        mode: last.mode,
        result: last.result === 'win' ? 'win' : last.result === 'draw' ? 'draw' : 'loss',
        netKobo: pool ? Number(last.payout ?? 0) - Number(last.staked) : null,
        at: last.at.toISOString(),
      };
    }
    return out;
  }

  private async recentGames(userId: string, self: boolean): Promise<RecentGame[]> {
    const r = await this.pool.query<{
      match_id: string;
      slug: string;
      name: string;
      mode: 'free' | 'pool';
      result: RecentGame['result'];
      staked: string;
      payout: string | null;
      space_id: string | null;
      against: string | null;
      at: Date;
    }>(
      `SELECT m.id AS match_id, g.slug, g.name, m.mode, mp.result, mp.staked_kobo AS staked, mp.payout_kobo AS payout,
              m.space_id,
              (SELECT p.username FROM match_players o JOIN profiles p ON p.id = o.user_id
                WHERE o.match_id = m.id AND o.user_id <> $1
                  AND (SELECT count(*) FROM match_players x WHERE x.match_id = m.id) = 2
                LIMIT 1) AS against,
              coalesce(m.finished_at, m.created_at) AS at
         FROM match_players mp
         JOIN matches m ON m.id = mp.match_id AND m.status = 'finished'
         JOIN games g ON g.slug = m.game_slug
        WHERE mp.user_id = $1 AND mp.result IS NOT NULL
        ORDER BY coalesce(m.finished_at, m.created_at) DESC
        LIMIT 5`,
      [userId],
    );
    return r.rows.map((x): RecentGame => ({
      matchId: x.match_id,
      gameSlug: x.slug,
      gameName: x.name,
      mode: x.mode,
      result: x.result,
      against: x.against,
      isSpace: x.space_id !== null,
      netKobo: self && Number(x.staked) > 0 ? Number(x.payout ?? 0) - Number(x.staked) : null,
      at: x.at.toISOString(),
    }));
  }

  private async money(userId: string): Promise<{ poolNetKobo: number; bestPotKobo: number }> {
    const r = await this.pool.query<{ net: string; best: string }>(
      `SELECT coalesce(sum(coalesce(mp.payout_kobo, 0) - mp.staked_kobo), 0)::text AS net,
              coalesce(max(mp.payout_kobo) FILTER (WHERE mp.result = 'win'), 0)::text AS best
         FROM match_players mp JOIN matches m ON m.id = mp.match_id AND m.status = 'finished'
        WHERE mp.user_id = $1 AND mp.staked_kobo > 0`,
      [userId],
    );
    return { poolNetKobo: Number(r.rows[0]!.net), bestPotKobo: Number(r.rows[0]!.best) };
  }
}
