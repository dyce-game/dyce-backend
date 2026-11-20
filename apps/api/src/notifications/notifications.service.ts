import type pg from 'pg';
import {
  notificationFilterKinds,
  parseAvatar,
  PUSH_GROUPS,
  type MarkReadRequest,
  type NotificationFilter,
  type NotificationItem,
  type NotificationKind,
  type NotificationPrefs,
  type NotificationPrefsUpdate,
  type NotificationsResponse,
  type PushGroup,
  type PushTokenRequest,
  type UnreadCount,
} from '@dyce/shared';
import { AuthError } from '../auth/auth-error.ts';

/** Hides what a blocked person caused. `n` is the notification row, `$1` the signed-in user. */
const NOT_FROM_BLOCKED = `(n.actor_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM blocks b
   WHERE (b.blocker_id = n.actor_id AND b.blocked_id = n.user_id)
      OR (b.blocker_id = n.user_id AND b.blocked_id = n.actor_id)))`;

const MAX_TOKENS_PER_USER = 10;

export function defaultPrefs(): NotificationPrefs {
  return {
    groups: Object.fromEntries(PUSH_GROUPS.map((g) => [g, true])) as Record<PushGroup, boolean>,
    quietHours: { enabled: false, startMinute: 1320, endMinute: 420 },
    tzOffsetMin: 60,
  };
}

type PrefsRow = {
  prefs: Record<string, unknown>;
  quiet_enabled: boolean;
  quiet_start: number;
  quiet_end: number;
  tz_offset_min: number;
};

export function prefsFromRow(row: PrefsRow | undefined): NotificationPrefs {
  const out = defaultPrefs();
  if (!row) return out;
  for (const g of PUSH_GROUPS) if (row.prefs[g] === false) out.groups[g] = false;
  out.quietHours = {
    enabled: row.quiet_enabled,
    startMinute: row.quiet_start,
    endMinute: row.quiet_end,
  };
  out.tzOffsetMin = row.tz_offset_min;
  return out;
}

/** The in-app Notifications list, its unread count, preferences and the devices that receive push. */
export class NotificationsService {
  constructor(private readonly pool: pg.Pool) {}

  async list(
    userId: string,
    opts: { filter: NotificationFilter; before?: string; limit: number },
  ): Promise<NotificationsResponse> {
    const kinds = opts.filter === 'all' ? null : notificationFilterKinds[opts.filter];
    const cursor = parseCursor(opts.before);
    const r = await this.pool.query<{
      id: string;
      kind: NotificationKind;
      payload: Record<string, unknown>;
      created_at: Date;
      cursor_at: string;
      read_at: Date | null;
      actor_id: string | null;
      username: string | null;
      display_name: string | null;
      avatar: unknown;
    }>(
      `SELECT n.id, n.kind, n.payload, n.created_at,
              to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at, n.read_at, n.actor_id, p.username, p.display_name, p.avatar
         FROM notifications n
         LEFT JOIN profiles p ON p.id = n.actor_id
        WHERE n.user_id = $1 AND ${NOT_FROM_BLOCKED}
          AND ($2::text[] IS NULL OR n.kind = ANY($2))
          AND ($3::timestamptz IS NULL OR (n.created_at, n.id) < ($3::timestamptz, $4::uuid))
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT $5`,
      [userId, kinds, cursor?.at ?? null, cursor?.id ?? null, opts.limit + 1],
    );
    const page = r.rows.slice(0, opts.limit);
    const last = page[page.length - 1];
    const items = page.map((row): NotificationItem => ({
      id: row.id,
      kind: row.kind,
      actor: row.actor_id
        ? {
            id: row.actor_id,
            username: row.username ?? '',
            displayName: row.display_name ?? '',
            avatar: parseAvatar(row.avatar),
          }
        : null,
      payload: row.payload,
      createdAt: row.created_at.toISOString(),
      read: row.read_at !== null,
    }));
    return {
      items,
      nextCursor: r.rows.length > opts.limit && last ? `${last.cursor_at}|${last.id}` : null,
      unread: (await this.unread(userId)).unread,
    };
  }

  async unread(userId: string): Promise<UnreadCount> {
    const r = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications n
        WHERE n.user_id = $1 AND n.read_at IS NULL AND ${NOT_FROM_BLOCKED}`,
      [userId],
    );
    return { unread: r.rows[0]?.n ?? 0 };
  }

  /** Marks some (or all) of your notifications read. Others' ids are ignored, never an error. */
  async markRead(userId: string, req: MarkReadRequest): Promise<UnreadCount> {
    if ('all' in req) {
      await this.pool.query(
        `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`,
        [userId],
      );
    } else {
      await this.pool.query(
        `UPDATE notifications SET read_at = now()
          WHERE user_id = $1 AND read_at IS NULL AND id = ANY($2::uuid[])`,
        [userId, req.ids],
      );
    }
    return this.unread(userId);
  }

  // ---- preferences -------------------------------------------------------------------------------

  async getPrefs(userId: string): Promise<NotificationPrefs> {
    const r = await this.pool.query<PrefsRow>(
      `SELECT prefs, quiet_enabled, quiet_start, quiet_end, tz_offset_min
         FROM notification_prefs WHERE user_id = $1`,
      [userId],
    );
    return prefsFromRow(r.rows[0]);
  }

  async updatePrefs(userId: string, patch: NotificationPrefsUpdate): Promise<NotificationPrefs> {
    const groups = patch.groups ?? {};
    const q = patch.quietHours ?? {};
    await this.pool.query(
      `INSERT INTO notification_prefs (user_id, prefs, quiet_enabled, quiet_start, quiet_end, tz_offset_min)
       VALUES ($1, $2::jsonb, coalesce($3, false), coalesce($4, 1320), coalesce($5, 420), coalesce($6, 60))
       ON CONFLICT (user_id) DO UPDATE SET
         prefs = notification_prefs.prefs || $2::jsonb,
         quiet_enabled = coalesce($3, notification_prefs.quiet_enabled),
         quiet_start = coalesce($4, notification_prefs.quiet_start),
         quiet_end = coalesce($5, notification_prefs.quiet_end),
         tz_offset_min = coalesce($6, notification_prefs.tz_offset_min),
         updated_at = now()`,
      [
        userId,
        JSON.stringify(groups),
        q.enabled ?? null,
        q.startMinute ?? null,
        q.endMinute ?? null,
        patch.tzOffsetMin ?? null,
      ],
    );
    return this.getPrefs(userId);
  }

  // ---- devices -----------------------------------------------------------------------------------

  /** Registers (or moves) a device token: a token belongs to one person at a time. */
  async registerToken(userId: string, req: PushTokenRequest): Promise<void> {
    const exists = await this.pool.query('SELECT 1 FROM profiles WHERE id = $1', [userId]);
    if (exists.rowCount === 0) throw new AuthError('profile_required');
    await this.pool.query(
      `INSERT INTO push_tokens (user_id, token, platform) VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, updated_at = now()`,
      [userId, req.token, req.platform],
    );
    // a person with many reinstalls keeps only their newest devices
    await this.pool.query(
      `DELETE FROM push_tokens WHERE user_id = $1 AND token NOT IN (
         SELECT token FROM push_tokens WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2)`,
      [userId, MAX_TOKENS_PER_USER],
    );
  }

  /** Signing out (or turning notifications off) on a device: stop pushing to it. */
  async removeToken(userId: string, token: string): Promise<void> {
    await this.pool.query('DELETE FROM push_tokens WHERE user_id = $1 AND token = $2', [
      userId,
      token,
    ]);
  }
}

function parseCursor(before: string | undefined): { at: string; id: string } | null {
  if (!before) return null;
  const [at, id] = before.split('|');
  if (!at || !id || Number.isNaN(Date.parse(at)) || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new AuthError('validation_failed', {
      issues: [{ path: 'before', message: 'Bad cursor' }],
    });
  }
  return { at, id };
}
