import type pg from 'pg';
import {
  parseAvatar,
  SEARCH_MAX_RESULTS,
  SEARCH_MIN_CHARS,
  type PeopleSearchResponse,
  type PersonResult,
  type Relationship,
  type SearchSource,
} from '@dyce/shared';
import { AuthError } from '../auth/auth-error.ts';
import type { Clock } from '../auth/tokens.ts';
import { readConfigInt, secondsUntilLagosMidnight } from '../db/config.ts';
import { FRIENDSHIP_JOIN, NOT_BLOCKED, RELATIONSHIP_EXPR } from '../social/relationship.ts';

/** `%`, `_` and `\` are wildcards in LIKE: a username may contain `_`, so they are escaped. */
export function likePrefix(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

type Row = {
  id: string;
  username: string;
  display_name: string;
  avatar: unknown;
  level: number;
  relationship: Relationship;
  is_friend: boolean;
  is_contact: boolean;
  is_known: boolean;
  mutual: number;
};

/**
 * People search (ADR-023).
 *
 *  - **Friends, contacts and people you have chatted or played with** match on the start of their @username or
 *    of any word of their name, from 2 characters.
 *  - **Strangers** match only on the start of their @username and only from 3 characters, so the search cannot
 *    be used to browse everyone by name. At most 15 results come back.
 *  - Blocked people (either way) and disabled accounts never appear. Only public fields are returned.
 *  - Each person may run a limited number of searches a day (`people_searches_per_day`).
 */
export class SearchService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly clock: Clock = () => new Date(),
  ) {}

  async people(userId: string, q: string): Promise<PeopleSearchResponse> {
    const now = this.clock();
    const limit = await readConfigInt(this.pool, 'people_searches_per_day', 600);
    const used = await this.pool.query<{ n: number }>(
      `INSERT INTO search_usage (user_id, day, n)
       VALUES ($1, ($2::timestamptz AT TIME ZONE 'Africa/Lagos')::date, 1)
       ON CONFLICT (user_id, day) DO UPDATE SET n = search_usage.n + 1
       RETURNING n`,
      [userId, now],
    );
    if ((used.rows[0]?.n ?? 0) > limit) {
      throw new AuthError('search_rate_limited', {
        retryAfterSeconds: secondsUntilLagosMidnight(now),
      });
    }

    const pattern = likePrefix(q);
    const r = await this.pool.query<Row>(
      `WITH cand AS (
         SELECT u.id, p.username, p.display_name, p.avatar, p.level,
                ${RELATIONSHIP_EXPR} AS relationship,
                (f.status = 'accepted') AS is_friend,
                EXISTS (SELECT 1 FROM contact_links cl
                         WHERE (cl.owner_id = $1::uuid AND cl.contact_user_id = u.id)
                            OR (cl.owner_id = u.id AND cl.contact_user_id = $1::uuid)) AS is_contact,
                (EXISTS (SELECT 1 FROM conversation_members a
                           JOIN conversation_members b ON b.conversation_id = a.conversation_id
                          WHERE a.user_id = $1::uuid AND b.user_id = u.id
                            AND a.state = 'active' AND b.state = 'active')
                 OR EXISTS (SELECT 1 FROM match_players a
                              JOIN match_players b ON b.match_id = a.match_id
                             WHERE a.user_id = $1::uuid AND b.user_id = u.id)) AS is_known
           FROM profiles p
           JOIN users u ON u.id = p.id
           ${FRIENDSHIP_JOIN}
          WHERE u.id <> $1::uuid AND u.disabled_at IS NULL AND ${NOT_BLOCKED}
            AND (lower(p.username) LIKE $2 || '%' OR lower(p.display_name) LIKE $2 || '%'
                 OR lower(p.display_name) LIKE '% ' || $2 || '%')
       ), shown AS (
         SELECT c.*,
                (c.is_friend OR c.is_contact OR c.is_known) AS knows,
                CASE WHEN lower(c.username) = $3 THEN 0 WHEN lower(c.username) LIKE $2 || '%' THEN 1 ELSE 2 END AS rel
           FROM cand c
       )
       SELECT s.id, s.username, s.display_name, s.avatar, s.level, s.relationship,
              s.is_friend, s.is_contact, s.is_known,
              (SELECT count(*)::int FROM (
                 SELECT CASE WHEN a.user_low = $1::uuid THEN a.user_high ELSE a.user_low END
                   FROM friendships a WHERE a.status = 'accepted' AND $1::uuid IN (a.user_low, a.user_high)
                 INTERSECT
                 SELECT CASE WHEN b.user_low = s.id THEN b.user_high ELSE b.user_low END
                   FROM friendships b WHERE b.status = 'accepted' AND s.id IN (b.user_low, b.user_high)
               ) m) AS mutual
         FROM shown s
        WHERE s.knows OR (lower(s.username) LIKE $2 || '%' AND $4::boolean)
        ORDER BY (NOT s.is_friend), (NOT s.is_contact), (NOT s.is_known), s.rel, lower(s.username)
        LIMIT $5`,
      [userId, pattern, q, q.length >= SEARCH_MIN_CHARS, SEARCH_MAX_RESULTS],
    );
    return {
      people: r.rows.map((row): PersonResult => ({
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        avatar: parseAvatar(row.avatar),
        level: row.level,
        relationship: row.relationship,
        source: sourceOf(row),
        mutualFriends: row.is_friend ? 0 : row.mutual,
      })),
    };
  }
}

function sourceOf(row: Row): SearchSource {
  if (row.is_friend) return 'friend';
  if (row.is_contact) return 'contact';
  if (row.is_known) return 'known';
  return 'stranger';
}
