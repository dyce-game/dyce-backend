import type pg from 'pg';
import { normalizeSpaceCode } from '@dyce/shared';

/** How a route says it takes a Pool stake: `body` (`mode: 'pool'`), `match` (`:id` is a Pool match), `space` (`code`). */
export type PoolEntryKind = 'body' | 'match' | 'space';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this request really a Pool entry? Looked at before the body is validated, so it only reads `mode`, the route
 * id and the space code, and trusts them for nothing but this question.
 */
export async function isPoolEntry(
  pool: Pick<pg.Pool, 'query'>,
  kind: PoolEntryKind,
  req: { body?: unknown; params?: Record<string, unknown> },
): Promise<boolean> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (kind === 'body') return body.mode === 'pool';
  if (kind === 'match') {
    const id = req.params?.id;
    if (typeof id !== 'string' || !UUID.test(id)) return false;
    const r = await pool.query(`SELECT 1 FROM matches WHERE id = $1 AND mode = 'pool'`, [id]);
    return r.rows.length > 0;
  }
  const code = typeof body.code === 'string' ? normalizeSpaceCode(body.code) : null;
  if (!code) return false;
  const r = await pool.query(
    `SELECT 1 FROM spaces WHERE code = $1 AND mode = 'pool' AND seat_fee_kobo > 0`,
    [code],
  );
  return r.rows.length > 0;
}
