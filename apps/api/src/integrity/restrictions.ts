import type pg from 'pg';
import { AuthError } from '../auth/auth-error.ts';

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

/**
 * A moderator can mute a person (no messages, friend requests or money requests for a while; they can still
 * play and report) or suspend them (no sign-in, no Pool). Both are columns on `users`, so this is one
 * primary-key read. Call it after the retry check, so a message that already went through is not refused twice.
 */
export async function assertNotRestricted(db: Queryable, userId: string): Promise<void> {
  const r = await db.query<{ suspended: boolean; muted: boolean; muted_until: Date | null }>(
    `SELECT coalesce(suspended_until > now(), false) AS suspended,
            coalesce(muted_until > now(), false) AS muted, muted_until
       FROM users WHERE id = $1`,
    [userId],
  );
  const row = r.rows[0];
  if (!row) return;
  if (row.suspended) throw new AuthError('account_suspended');
  if (row.muted) {
    throw new AuthError('account_muted', {
      until: row.muted_until instanceof Date ? row.muted_until.toISOString() : null,
    });
  }
}
