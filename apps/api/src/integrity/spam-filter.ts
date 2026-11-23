import type pg from 'pg';
import { readConfigInt } from '../db/config.ts';

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

/**
 * The spam filter for Requests (SPEC section 13, ADR-039). A message to someone who is not a friend lands in their
 * Requests; if the sender looks like a spammer it lands in the "filtered" bucket instead (still there, never
 * deleted, shown behind "N filtered as spam · view" and not counted in the Requests badge). It never blocks the
 * sender and never tells them.
 */
export type SpamReason = 'new_account' | 'mass_sending' | 'repeated_declines' | 'reported';

export type SpamFacts = {
  /** The recipient has the sender in their contacts, or they share a friend: never filtered. */
  known: boolean;
  accountAgeHours: number;
  /** People outside the sender's friends they started a chat with in the last hour. */
  strangersLastHour: number;
  /** Different people who declined the sender's request in the last 30 days. */
  declinedBy30d: number;
  /** Different people who reported the sender for spam, abuse or scams in the last 30 days. */
  reporters30d: number;
};

export type SpamConfig = {
  threshold: number;
  newAccountHours: number;
  massPerHour: number;
  declines30d: number;
  reports30d: number;
};

export type SpamVerdict = { score: number; reasons: SpamReason[]; filtered: boolean };

/** Pure: facts and config in, verdict out. The weights are written here and the limits come from `app_config`. */
export function scoreRequest(f: SpamFacts, c: SpamConfig): SpamVerdict {
  if (f.known) return { score: 0, reasons: [], filtered: false };
  const reasons: SpamReason[] = [];
  let score = 0;
  if (f.accountAgeHours < c.newAccountHours) {
    reasons.push('new_account');
    score += 30;
  }
  if (f.strangersLastHour >= c.massPerHour) {
    reasons.push('mass_sending');
    score += 40;
  }
  if (f.declinedBy30d >= c.declines30d) {
    reasons.push('repeated_declines');
    score += 40;
  }
  if (f.reporters30d >= 3) {
    reasons.push('reported');
    score += 60;
  } else if (f.reporters30d >= c.reports30d) {
    reasons.push('reported');
    score += 30;
  }
  score = Math.min(100, score);
  return { score, reasons, filtered: score >= c.threshold };
}

export async function readSpamConfig(db: Queryable): Promise<SpamConfig> {
  return {
    threshold: await readConfigInt(db, 'spam_filter_threshold', 50),
    newAccountHours: await readConfigInt(db, 'spam_new_account_hours', 24),
    massPerHour: await readConfigInt(db, 'spam_mass_per_hour', 8),
    declines30d: await readConfigInt(db, 'spam_declines_30d', 3),
    reports30d: await readConfigInt(db, 'spam_reports_30d', 1),
  };
}

export async function gatherSpamFacts(
  db: Queryable,
  sender: string,
  recipient: string,
  now: Date,
): Promise<SpamFacts> {
  const r = await db.query<{
    known: boolean;
    age_hours: string;
    strangers_hour: string;
    declined: string;
    reporters: string;
  }>(
    `SELECT
       (
         EXISTS (SELECT 1 FROM contact_links WHERE owner_id = $2 AND contact_user_id = $1)
         OR EXISTS (
           SELECT 1
             FROM friendships a JOIN friendships b
               ON CASE WHEN a.user_low = $1 THEN a.user_high ELSE a.user_low END
                = CASE WHEN b.user_low = $2 THEN b.user_high ELSE b.user_low END
            WHERE a.status = 'accepted' AND b.status = 'accepted'
              AND $1 IN (a.user_low, a.user_high) AND $2 IN (b.user_low, b.user_high))
       ) AS known,
       extract(epoch FROM ($3::timestamptz - u.created_at)) / 3600 AS age_hours,
       (SELECT count(*) FROM conversations cv
          JOIN conversation_members o ON o.conversation_id = cv.id AND o.user_id <> $1
         WHERE cv.created_by = $1 AND cv.kind = 'direct' AND cv.created_at >= $3::timestamptz - interval '1 hour'
           AND o.state IN ('request', 'declined')) AS strangers_hour,
       (SELECT count(DISTINCT o.user_id) FROM conversations cv
          JOIN conversation_members o ON o.conversation_id = cv.id AND o.user_id <> $1
         WHERE cv.created_by = $1 AND cv.kind = 'direct' AND o.state = 'declined'
           AND cv.created_at >= $3::timestamptz - interval '30 days') AS declined,
       (SELECT count(DISTINCT rp.reporter_id) FROM reports rp
         WHERE rp.target_user_id = $1 AND rp.reason IN ('spam', 'abuse', 'scam')
           AND rp.created_at >= $3::timestamptz - interval '30 days') AS reporters
     FROM users u WHERE u.id = $1`,
    [sender, recipient, now],
  );
  const row = r.rows[0];
  if (!row) {
    return {
      known: false,
      accountAgeHours: 0,
      strangersLastHour: 0,
      declinedBy30d: 0,
      reporters30d: 0,
    };
  }
  return {
    known: row.known,
    accountAgeHours: Number(row.age_hours),
    strangersLastHour: Number(row.strangers_hour),
    declinedBy30d: Number(row.declined),
    reporters30d: Number(row.reporters),
  };
}

/**
 * Judges a request while the sender writes it and puts it in the filtered bucket when it looks like spam. Sticky:
 * once filtered it stays filtered until the recipient answers it (accepting or declining clears the mark).
 * Returns whether the request is filtered.
 */
export async function applySpamFilter(
  db: Queryable,
  input: { conversationId: string; sender: string; recipient: string; now: Date },
): Promise<boolean> {
  const cur = await db.query<{ filtered_at: Date | null }>(
    `SELECT filtered_at FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
    [input.conversationId, input.recipient],
  );
  if (cur.rows[0]?.filtered_at) return true;

  const facts = await gatherSpamFacts(db, input.sender, input.recipient, input.now);
  const cfg = await readSpamConfig(db);
  const verdict = scoreRequest(facts, cfg);
  if (!verdict.filtered) return false;
  await db.query(
    `UPDATE conversation_members SET filtered_at = $3, filter_reason = $4
      WHERE conversation_id = $1 AND user_id = $2`,
    [input.conversationId, input.recipient, input.now, verdict.reasons.join(',')],
  );
  return true;
}
