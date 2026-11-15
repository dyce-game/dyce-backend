import type pg from 'pg';
import type { BlocksResponse, ReportRequest, ReportResult } from '@dyce/shared';
import { AuthError } from '../auth/auth-error.ts';
import type { Clock } from '../auth/tokens.ts';
import { lagosDayStart, readConfigInt } from '../db/config.ts';
import { withTx } from '../db/tx.ts';
import { lockPair } from '../social/relationship.ts';

/** How many of the latest messages are copied into a report as evidence. */
const EVIDENCE_MESSAGES = 20;
/** The same reporter reporting the same person for the same reason within this long is one report. */
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Block and report.
 *
 * Blocking is silent and one-way in effect, two-way in reach: the person you block can't message you, send
 * you money, ask to be friends or find you, and you stop seeing them; nobody is told. (Every list, send and
 * lookup in the API already treats a blocked pair as strangers who don't exist.) Blocking also ends a
 * friendship, because that's what people mean by it; unblocking doesn't bring it back.
 *
 * A report goes to the moderation queue with a snapshot of the conversation, so a moderator sees what the
 * reporter saw even if messages are deleted later. The person reported is never told who reported them.
 */
export class SafetyService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly clock: Clock = () => new Date(),
  ) {}

  /** Block someone. Idempotent. */
  async block(userId: string, targetId: string): Promise<void> {
    if (userId === targetId) throw new AuthError('cannot_add_self');
    await withTx(this.pool, async (c) => {
      await lockPair(c, userId, targetId);
      const exists = await c.query(`SELECT 1 FROM users WHERE id = $1`, [targetId]);
      if (exists.rows.length === 0) throw new AuthError('user_not_found');
      await c.query(
        `INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [userId, targetId],
      );
      await c.query(
        `DELETE FROM friendships
          WHERE user_low = LEAST($1::uuid, $2::uuid) AND user_high = GREATEST($1::uuid, $2::uuid)`,
        [userId, targetId],
      );
    });
  }

  /** Unblock someone. Idempotent. You are not friends again: add them if you want to. */
  async unblock(userId: string, targetId: string): Promise<void> {
    await this.pool.query(`DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`, [
      userId,
      targetId,
    ]);
  }

  /** The people you've blocked, most recent first. */
  async list(userId: string): Promise<BlocksResponse> {
    const r = await this.pool.query<{
      id: string;
      username: string | null;
      display_name: string | null;
      created_at: Date;
    }>(
      `SELECT b.blocked_id AS id, p.username, p.display_name, b.created_at
         FROM blocks b LEFT JOIN profiles p ON p.id = b.blocked_id
        WHERE b.blocker_id = $1
        ORDER BY b.created_at DESC, b.blocked_id
        LIMIT 500`,
      [userId],
    );
    return {
      blocked: r.rows.map((row) => ({
        user: {
          id: row.id,
          username: row.username ?? 'deleted',
          displayName: row.display_name ?? '',
        },
        blockedAt: row.created_at.toISOString(),
      })),
    };
  }

  /** File a report, optionally with the conversation attached and the person blocked. */
  async report(userId: string, input: ReportRequest): Promise<ReportResult> {
    if (input.userId === userId) throw new AuthError('cannot_add_self');
    const now = this.clock();

    const reportId = await withTx(this.pool, async (c) => {
      const target = await c.query(`SELECT 1 FROM users WHERE id = $1`, [input.userId]);
      if (target.rows.length === 0) throw new AuthError('user_not_found');

      // The same report twice (a double tap, a retry) is one report.
      const dup = await c.query<{ id: string }>(
        `SELECT id FROM reports
          WHERE reporter_id = $1 AND target_user_id = $2 AND reason = $3 AND created_at >= $4
          ORDER BY created_at DESC LIMIT 1`,
        [userId, input.userId, input.reason, new Date(now.getTime() - DUPLICATE_WINDOW_MS)],
      );
      if (dup.rows[0]) return dup.rows[0].id;

      const perDay = await readConfigInt(c, 'reports_per_day', 20);
      const today = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM reports WHERE reporter_id = $1 AND created_at >= $2`,
        [userId, lagosDayStart(now)],
      );
      if (Number(today.rows[0]?.n ?? 0) >= perDay) throw new AuthError('reports_rate_limited');

      let evidence: unknown = null;
      if (input.conversationId) {
        // It must be your own chat with the person you're reporting, not any conversation id.
        const own = await c.query(
          `SELECT 1
             FROM conversations cv
             JOIN conversation_members me ON me.conversation_id = cv.id AND me.user_id = $1
             JOIN conversation_members them ON them.conversation_id = cv.id AND them.user_id = $2
            WHERE cv.id = $3 AND cv.kind = 'direct'`,
          [userId, input.userId, input.conversationId],
        );
        if (own.rows.length === 0) throw new AuthError('conversation_not_found');
        if (input.messageId) {
          const inChat = await c.query(
            `SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2`,
            [input.messageId, input.conversationId],
          );
          if (inChat.rows.length === 0) throw new AuthError('conversation_not_found');
        }
        const msgs = await c.query(
          `SELECT id, sender_id AS "senderId", kind, body, created_at AS "createdAt"
             FROM messages
            WHERE conversation_id = $1 AND deleted_at IS NULL
            ORDER BY created_at DESC, id DESC
            LIMIT ${EVIDENCE_MESSAGES}`,
          [input.conversationId],
        );
        evidence = { capturedAt: now.toISOString(), messages: msgs.rows.reverse() };
      } else if (input.messageId) {
        throw new AuthError('validation_failed', {
          issues: [{ path: 'messageId', message: 'needs conversationId' }],
        });
      }

      const inserted = await c.query<{ id: string }>(
        `INSERT INTO reports (reporter_id, target_user_id, conversation_id, message_id, reason, note, evidence, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING id`,
        [
          userId,
          input.userId,
          input.conversationId ?? null,
          input.messageId ?? null,
          input.reason,
          input.note || null,
          evidence === null ? null : JSON.stringify(evidence),
          now,
        ],
      );
      return inserted.rows[0]!.id;
    });

    if (input.alsoBlock) await this.block(userId, input.userId);
    const blocked = await this.pool.query(
      `SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`,
      [userId, input.userId],
    );
    return { reportId, blocked: blocked.rows.length > 0 };
  }
}
