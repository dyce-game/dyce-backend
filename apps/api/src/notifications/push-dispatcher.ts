import type pg from 'pg';
import {
  describeNotification,
  inQuietHours,
  PUSH_GROUP_OF,
  type NotificationKind,
  type RealtimeEvent,
} from '@dyce/shared';
import type { Clock } from '../auth/tokens.ts';
import { withTx } from '../db/tx.ts';
import { prefsFromRow } from './notifications.service.ts';
import type { PushDriver, PushMessage } from './push-driver.ts';

/** A notification older than this is never pushed (the person was offline; the list still has it). */
const STALE_MS = 6 * 60 * 60 * 1000;
/** After this many failed attempts a notification is dropped from the push queue. */
const MAX_ATTEMPTS = 3;

export type Publisher = { publish(userIds: readonly string[], event: RealtimeEvent): void };

export type DispatchSummary = { handled: number; sent: number; skipped: number; failed: number };

type Pending = {
  id: string;
  user_id: string;
  kind: NotificationKind;
  payload: Record<string, unknown>;
  created_at: Date;
  push_attempts: number;
  actor_name: string | null;
};

/**
 * The push queue is the `notifications` table itself: rows with `dispatched_at IS NULL`. Each run claims a batch
 * (`FOR UPDATE SKIP LOCKED`, so several API instances can run it), then for every row decides:
 *
 *   never pushed (level-ups, Free results) · too old · the person switched that group off · quiet hours · no device
 *   -> marked handled without sending;  otherwise -> sent through the driver to every device they have.
 *
 * Quiet hours *skip* rather than delay (a "your turn" at 7am about a move made at 3am is noise). Dead tokens
 * reported by the driver are deleted. A failed send is retried on the next run, up to 3 times. Everyone with a
 * handled row also gets a realtime `notification` event so the open app refreshes its list and bell.
 */
export class PushDispatcher {
  constructor(
    private readonly pool: pg.Pool,
    private readonly driver: PushDriver,
    private readonly publisher: Publisher | null,
    private readonly clock: Clock = () => new Date(),
  ) {}

  async dispatchPending(limit = 100): Promise<DispatchSummary> {
    const touched = new Set<string>();
    const { summary, events } = await withTx(this.pool, async (c) => {
      const now = this.clock();
      const rows = (
        await c.query<Pending>(
          `SELECT n.id, n.user_id, n.kind, n.payload, n.created_at, n.push_attempts,
                  coalesce(nullif(p.display_name, ''), p.username) AS actor_name
             FROM notifications n
             LEFT JOIN profiles p ON p.id = n.actor_id
            WHERE n.dispatched_at IS NULL
            ORDER BY n.created_at
            LIMIT $1
              FOR UPDATE OF n SKIP LOCKED`,
          [limit],
        )
      ).rows;
      const out: DispatchSummary = { handled: 0, sent: 0, skipped: 0, failed: 0 };
      if (rows.length === 0)
        return { summary: out, events: [] as { id: string; unread: number }[] };

      const userIds = [...new Set(rows.map((r) => r.user_id))];
      const prefsRows = await c.query<Parameters<typeof prefsFromRow>[0] & { user_id: string }>(
        `SELECT user_id, prefs, quiet_enabled, quiet_start, quiet_end, tz_offset_min
           FROM notification_prefs WHERE user_id = ANY($1)`,
        [userIds],
      );
      const prefs = new Map(prefsRows.rows.map((p) => [p.user_id, prefsFromRow(p)]));
      const tokenRows = await c.query<{ user_id: string; token: string }>(
        `SELECT user_id, token FROM push_tokens WHERE user_id = ANY($1) ORDER BY updated_at DESC`,
        [userIds],
      );
      const tokens = new Map<string, string[]>();
      for (const t of tokenRows.rows)
        tokens.set(t.user_id, [...(tokens.get(t.user_id) ?? []), t.token]);
      const unreadRows = await c.query<{ user_id: string; n: number }>(
        `SELECT user_id, count(*)::int AS n FROM notifications
          WHERE user_id = ANY($1) AND read_at IS NULL GROUP BY user_id`,
        [userIds],
      );
      const unread = new Map(unreadRows.rows.map((u) => [u.user_id, u.n]));

      const handled: string[] = [];
      const retry: string[] = [];
      const toSend: { row: Pending; message: PushMessage }[] = [];

      for (const row of rows) {
        touched.add(row.user_id);
        const group = PUSH_GROUP_OF[row.kind] ?? null;
        const p = prefs.get(row.user_id) ?? prefsFromRow(undefined);
        const devices = tokens.get(row.user_id) ?? [];
        const skip =
          group === null ||
          now.getTime() - row.created_at.getTime() > STALE_MS ||
          !p.groups[group] ||
          inQuietHours(now, p.quietHours, p.tzOffsetMin) ||
          devices.length === 0;
        if (skip) {
          handled.push(row.id);
          out.skipped++;
          continue;
        }
        const text = describeNotification(row.kind, row.payload, row.actor_name);
        for (const to of devices) {
          toSend.push({
            row,
            message: {
              to,
              title: text.title,
              body: text.body,
              data: { notificationId: row.id, kind: row.kind, route: text.route },
              badge: unread.get(row.user_id) ?? 0,
            },
          });
        }
      }

      if (toSend.length > 0) {
        let results: Awaited<ReturnType<PushDriver['send']>>;
        try {
          results = await this.driver.send(toSend.map((s) => s.message));
        } catch {
          results = toSend.map(() => ({
            ok: false,
            error: 'driver',
            invalidToken: false,
            retry: true,
          }));
        }
        const dead: string[] = [];
        const outcome = new Map<string, { ok: boolean; retry: boolean }>();
        toSend.forEach((s, i) => {
          const res = results[i] ?? {
            ok: false as const,
            error: 'missing',
            invalidToken: false,
            retry: true,
          };
          if (!res.ok && res.invalidToken) dead.push(s.message.to);
          const prev = outcome.get(s.row.id);
          // delivered to at least one device = delivered
          outcome.set(s.row.id, {
            ok: (prev?.ok ?? false) || res.ok,
            retry: (prev?.retry ?? false) || (!res.ok && res.retry),
          });
        });
        if (dead.length > 0) await c.query('DELETE FROM push_tokens WHERE token = ANY($1)', [dead]);
        for (const [id, o] of outcome) {
          const row = rows.find((r) => r.id === id)!;
          if (o.ok) {
            handled.push(id);
            out.sent++;
          } else if (o.retry && row.push_attempts + 1 < MAX_ATTEMPTS) {
            retry.push(id);
            out.failed++;
          } else {
            handled.push(id);
            out.failed++;
          }
        }
      }

      if (handled.length > 0) {
        await c.query('UPDATE notifications SET dispatched_at = $2 WHERE id = ANY($1)', [
          handled,
          now,
        ]);
      }
      if (retry.length > 0) {
        await c.query(
          'UPDATE notifications SET push_attempts = push_attempts + 1 WHERE id = ANY($1)',
          [retry],
        );
      }
      out.handled = handled.length;
      // the open app refreshes its list and bell
      const events = [...touched].map((id) => ({ id, unread: unread.get(id) ?? 0 }));
      return { summary: out, events };
    });
    if (this.publisher) {
      for (const e of events)
        this.publisher.publish([e.id], { type: 'notification', unread: e.unread });
    }
    return summary;
  }
}
