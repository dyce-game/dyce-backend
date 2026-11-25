import type pg from 'pg';
import type { DataExport, DeletionPreview, DeletionStatus } from '@dyce/shared';
import { AuthError } from '../auth/auth-error.ts';
import type { Clock } from '../auth/tokens.ts';
import { readConfigInt } from '../db/config.ts';

/** What the account service needs from Spaces: leaving a waiting space (host hand-over and refunds live there). */
export interface SpaceLeaver {
  leave(userId: string, spaceId: string): Promise<unknown>;
}

const EXPORT_MESSAGE_LIMIT = 10_000;

/**
 * Deleting your account and downloading your data (SPEC section 12, ADR-037).
 *
 * Deleting is two steps with a grace period: asking (this service, from the Delete account screen) and doing it
 * (`processDue`, run nightly). Signing back in during the grace period cancels it. Doing it is the SQL function
 * `anonymise_account`: open games cancelled and Pool stakes returned, the balance cleared by one balanced ledger
 * transaction, the person's name, number and ties erased, their games kept under "Deleted player". It is idempotent,
 * so a crashed or repeated run finishes the job and never does it twice.
 */
export class AccountService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly spaces: SpaceLeaver | null = null,
    private readonly clock: Clock = () => new Date(),
  ) {}

  // ---- deleting -------------------------------------------------------------------------------

  async deletionStatus(userId: string): Promise<DeletionStatus> {
    const r = await this.pool.query<{ requested_at: Date; execute_after: Date }>(
      `SELECT requested_at, execute_after FROM account_deletions
        WHERE user_id = $1 AND completed_at IS NULL AND cancelled_at IS NULL`,
      [userId],
    );
    const row = r.rows[0];
    return {
      pending: !!row,
      requestedAt: row ? row.requested_at.toISOString() : null,
      executeAfter: row ? row.execute_after.toISOString() : null,
    };
  }

  /** What deleting would do, for the confirm screen. */
  async deletionPreview(userId: string): Promise<DeletionPreview> {
    const p = await this.pool.query<{ username: string; balance: string | null; open: string }>(
      `SELECT pr.username, w.balance_kobo AS balance,
              (SELECT count(*) FROM matches m JOIN match_players mp ON mp.match_id = m.id
                WHERE mp.user_id = pr.id AND m.status IN ('invited', 'countered', 'active')) AS open
         FROM profiles pr LEFT JOIN wallets w ON w.user_id = pr.id
        WHERE pr.id = $1`,
      [userId],
    );
    const row = p.rows[0];
    if (!row) throw new AuthError('profile_required');
    return {
      username: row.username,
      balanceKobo: Number(row.balance ?? 0),
      openGames: Number(row.open),
      graceDays: await readConfigInt(this.pool, 'account_deletion_grace_days', 30),
    };
  }

  /** Asks to delete. You type your username as the confirmation. Asking again keeps the original date. */
  async requestDeletion(userId: string, typedUsername: string): Promise<DeletionStatus> {
    const preview = await this.deletionPreview(userId);
    if (typedUsername.trim().replace(/^@/, '').toLowerCase() !== preview.username.toLowerCase()) {
      throw new AuthError('username_mismatch');
    }
    await this.pool.query('SELECT request_account_deletion($1)', [userId]);
    return this.deletionStatus(userId);
  }

  async cancelDeletion(userId: string): Promise<DeletionStatus> {
    await this.pool.query('SELECT cancel_account_deletion($1)', [userId]);
    return this.deletionStatus(userId);
  }

  /**
   * Erases everyone whose grace period is over. One person failing (or still sitting in a live space) never stops
   * the rest; they are retried on the next run. Returns how many were completed and how many were deferred.
   */
  async processDue(limit = 50): Promise<{ done: number; deferred: number }> {
    const due = await this.pool.query<{ id: string }>(
      `SELECT due_account_deletions AS id FROM due_account_deletions($1)`,
      [limit],
    );
    let done = 0;
    let deferred = 0;
    for (const { id } of due.rows) {
      try {
        if (await this.eraseOne(id)) done += 1;
        else deferred += 1;
      } catch {
        deferred += 1;
        await this.pool
          .query(
            `UPDATE account_deletions SET attempts = attempts + 1, last_note = 'error, will retry'
              WHERE user_id = $1`,
            [id],
          )
          .catch(() => undefined);
      }
    }
    return { done, deferred };
  }

  /** Erases one person now (the grace period is the caller's business). False while they still sit in a live space. */
  async eraseOne(userId: string): Promise<boolean> {
    if (this.spaces) {
      const waiting = await this.pool.query<{ id: string }>(
        `SELECT s.id FROM space_members sm JOIN spaces s ON s.id = sm.space_id
          WHERE sm.user_id = $1 AND sm.left_at IS NULL AND s.status = 'waiting'`,
        [userId],
      );
      for (const { id } of waiting.rows) await this.spaces.leave(userId, id);
    }
    const r = await this.pool.query<{ done: boolean }>(`SELECT anonymise_account($1) AS done`, [
      userId,
    ]);
    return r.rows[0]?.done === true;
  }

  // ---- exporting ------------------------------------------------------------------------------

  /** Everything Dyce holds about the caller, as one JSON document. Never anyone's phone number or its hash. */
  async exportData(userId: string): Promise<DataExport> {
    const q = <T extends pg.QueryResultRow>(text: string, values: unknown[] = [userId]) =>
      this.pool.query<T>(text, values).then((r) => r.rows);

    const [profile] = await q<{
      username: string;
      display_name: string;
      level: number;
      xp: number;
      city: string | null;
      birth_year: number | null;
      created_at: Date;
      request_policy: string;
      show_online: boolean;
    }>(
      `SELECT username, display_name, level, xp, city, birth_year, created_at, request_policy, show_online
         FROM profiles WHERE id = $1`,
    );
    if (!profile) throw new AuthError('profile_required');

    const [balance] = await q<{ balance_kobo: string }>(
      `SELECT balance_kobo FROM wallets WHERE user_id = $1`,
    );
    const txns = await q<{ id: string; kind: string; amount_kobo: string; created_at: Date }>(
      `SELECT t.id, t.kind, e.amount_kobo, t.created_at
         FROM ledger_entries e
         JOIN ledger_txns t ON t.id = e.txn_id
         JOIN wallets w ON w.account_id = e.account_id
        WHERE w.user_id = $1
        ORDER BY t.created_at DESC, t.id`,
    );
    const matches = await q<{
      id: string;
      game_slug: string;
      mode: string;
      status: string;
      staked_kobo: string;
      result: string | null;
      payout_kobo: string | null;
      created_at: Date;
      finished_at: Date | null;
      opponents: string[] | null;
    }>(
      `SELECT m.id, m.game_slug, m.mode, m.status, mp.staked_kobo, mp.result, mp.payout_kobo,
              m.created_at, m.finished_at,
              (SELECT array_agg(pr.username ORDER BY o.seat) FROM match_players o
                 JOIN profiles pr ON pr.id = o.user_id
                WHERE o.match_id = m.id AND o.user_id <> mp.user_id) AS opponents
         FROM match_players mp JOIN matches m ON m.id = mp.match_id
        WHERE mp.user_id = $1
        ORDER BY m.created_at DESC`,
    );
    const friends = await q<{ username: string }>(
      `SELECT pr.username FROM friendships f
         JOIN profiles pr ON pr.id = CASE WHEN f.user_low = $1 THEN f.user_high ELSE f.user_low END
        WHERE (f.user_low = $1 OR f.user_high = $1) AND f.status = 'accepted' ORDER BY pr.username`,
    );
    const blocked = await q<{ username: string }>(
      `SELECT pr.username FROM blocks b JOIN profiles pr ON pr.id = b.blocked_id
        WHERE b.blocker_id = $1 ORDER BY pr.username`,
    );
    const reports = await q<{ reason: string; status: string; created_at: Date }>(
      `SELECT reason, status, created_at FROM reports WHERE reporter_id = $1 ORDER BY created_at DESC`,
    );
    const disputes = await q<{
      reference: string;
      reason: string;
      status: string;
      created_at: Date;
    }>(
      `SELECT reference, reason, status, created_at FROM disputes WHERE user_id = $1 ORDER BY created_at DESC`,
    );
    const badges = await q<{ badge_slug: string; earned_at: Date }>(
      `SELECT badge_slug, earned_at FROM user_badges WHERE user_id = $1 ORDER BY earned_at`,
    );
    const [streak] = await q<{ current: number; best: number }>(
      `SELECT current, best FROM streaks WHERE user_id = $1`,
    );
    const messages = await q<{
      conversation_id: string;
      kind: string;
      body: string | null;
      created_at: Date;
    }>(
      `SELECT conversation_id, kind, body, created_at FROM messages
        WHERE sender_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ${EXPORT_MESSAGE_LIMIT}`,
    );

    return {
      format: 'dyce-data-export',
      version: 1,
      generatedAt: this.clock().toISOString(),
      profile: {
        username: profile.username,
        displayName: profile.display_name,
        level: profile.level,
        xp: profile.xp,
        city: profile.city,
        birthYear: profile.birth_year,
        createdAt: profile.created_at.toISOString(),
        requestPolicy: profile.request_policy,
        showOnline: profile.show_online,
      },
      wallet: {
        balanceKobo: Number(balance?.balance_kobo ?? 0),
        transactions: txns.map((t) => ({
          id: t.id,
          kind: t.kind,
          amountKobo: Number(t.amount_kobo),
          createdAt: t.created_at.toISOString(),
        })),
      },
      matches: matches.map((m) => ({
        id: m.id,
        game: m.game_slug,
        mode: m.mode,
        status: m.status,
        stakeKobo: Number(m.staked_kobo),
        result: m.result,
        payoutKobo: m.payout_kobo === null ? null : Number(m.payout_kobo),
        opponents: m.opponents ?? [],
        createdAt: m.created_at.toISOString(),
        finishedAt: m.finished_at ? m.finished_at.toISOString() : null,
      })),
      friends: friends.map((f) => f.username),
      blocked: blocked.map((b) => b.username),
      reportsFiled: reports.map((r) => ({
        reason: r.reason,
        status: r.status,
        createdAt: r.created_at.toISOString(),
      })),
      disputes: disputes.map((d) => ({
        reference: d.reference,
        reason: d.reason,
        status: d.status,
        createdAt: d.created_at.toISOString(),
      })),
      badges: badges.map((b) => ({ slug: b.badge_slug, earnedAt: b.earned_at.toISOString() })),
      streak: streak ? { current: streak.current, best: streak.best } : null,
      messagesSent: messages.map((m) => ({
        conversationId: m.conversation_id,
        kind: m.kind,
        body: m.body,
        createdAt: m.created_at.toISOString(),
      })),
    };
  }
}
