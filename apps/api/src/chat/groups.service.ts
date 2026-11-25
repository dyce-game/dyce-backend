import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  type ConversationSummary,
  type GroupMember,
  type GroupMembersResponse,
  type GroupRole,
  type RealtimeEvent,
} from '@dyce/shared';
import { AuthError } from '../auth/auth-error.ts';
import type { Clock } from '../auth/tokens.ts';
import { lagosDayStart, readConfigInt } from '../db/config.ts';
import { withTx } from '../db/tx.ts';
import { FRIENDSHIP_JOIN, toPublicUser, type PublicUserRow } from '../social/relationship.ts';
import { hydrateOne, type MessageRow } from './message-rows.ts';
import type { MessagesService, Publisher } from './messages.service.ts';

type Db = Pick<pg.Pool, 'query'>;

/** Someone in the group, as the rules need them. */
type Seat = { role: GroupRole; state: 'active' | 'left' | 'request' | 'declined' };

/**
 * Group chats (SPEC §6; ADR-026).
 *
 * - **Who can be in one:** you can only add your friends, so nobody lands in a group (and so in Chat) because
 *   a stranger put them there. Someone who blocked you looks like a user who doesn't exist; someone you
 *   blocked can't be added.
 * - **Admins:** whoever creates a group is its admin. Admins add and remove people, rename the group and make
 *   other members admins. Admins can't remove other admins, and an admin can only step down themselves, so
 *   no one can take a group from the person who made it. If the last admin leaves, the longest-standing
 *   member becomes admin.
 * - **Everyone** can read, write, react, reply, make polls and leave.
 * - **History:** a member only sees messages from when they joined. Leaving or being removed keeps the old
 *   messages' names but ends access.
 * - Every change is posted into the thread as a centred system line ("Tunde added Amaka").
 *
 * Changes to one group are serialised with an advisory lock, so the 50-member limit and the "always an
 * admin" rule hold under concurrent adds and leaves.
 */
export class GroupsService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly publisher: Publisher,
    private readonly messages: MessagesService,
    private readonly clock: Clock = () => new Date(),
  ) {}

  // ---- create ---------------------------------------------------------------------------------

  /** Makes a group of you and your friends. The client picks the id, so a retried "Create" returns the same group. */
  async create(
    userId: string,
    input: { id: string; title: string; memberIds: string[] },
  ): Promise<ConversationSummary> {
    const others = [...new Set(input.memberIds)].filter((id) => id !== userId);
    const title = input.title.trim();
    const now = this.clock();

    const fresh = await withTx(this.pool, async (c) => {
      await this.lock(c, `create:${input.id}`);
      const existing = await c.query<{ kind: string; created_by: string | null }>(
        `SELECT kind, created_by FROM conversations WHERE id = $1`,
        [input.id],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].kind === 'group' && existing.rows[0].created_by === userId) {
          return null; // a retry
        }
        throw new AuthError('group_id_taken');
      }
      if (others.length < 2) {
        throw new AuthError('validation_failed', {
          issues: [{ path: 'memberIds', message: 'A group needs at least two other people' }],
        });
      }
      const max = await readConfigInt(c, 'group_max_members', 50);
      if (others.length + 1 > max) throw new AuthError('group_full');

      const perDay = await readConfigInt(c, 'groups_created_per_day', 10);
      const made = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM conversations
          WHERE kind = 'group' AND created_by = $1 AND created_at >= $2`,
        [userId, lagosDayStart(now)],
      );
      if (Number(made.rows[0]?.n ?? 0) >= perDay) throw new AuthError('groups_rate_limited');

      await this.assertAddable(c, userId, others);

      await c.query(
        `INSERT INTO conversations (id, kind, title, created_by, created_at, last_message_at)
         VALUES ($1, 'group', $2, $3, $4, $4)`,
        [input.id, title, userId, now],
      );
      await c.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role, state, joined_at, last_read_at)
         SELECT $1, u, CASE WHEN u = $2::uuid THEN 'admin'::member_role ELSE 'member'::member_role END,
                'active', $4, $4
           FROM unnest($3::uuid[]) AS u`,
        [input.id, userId, [userId, ...others], now],
      );
      const [name] = await this.names(c, [userId]);
      const system = await this.postSystem(c, input.id, userId, `${name} created the group`, now);
      return { system, to: [userId, ...others] };
    });

    if (fresh) {
      this.publish(fresh.to, { type: 'message', message: fresh.system });
      this.publish(
        fresh.to.filter((id) => id !== userId),
        { type: 'conversation', conversationId: input.id, change: 'updated' },
      );
    }
    return this.messages.get(userId, input.id);
  }

  // ---- people ---------------------------------------------------------------------------------

  /** Everyone who is or was in the group. Only members can ask. */
  async members(userId: string, conversationId: string): Promise<GroupMembersResponse> {
    const m = await this.messages.membership(this.pool, userId, conversationId);
    if (m.kind !== 'group') throw new AuthError('not_a_group');
    const r = await this.pool.query<
      PublicUserRow & { role: GroupRole; state: 'active' | 'left'; joined_at: Date }
    >(
      `SELECT u.id, p.username, p.display_name, p.avatar,
              CASE WHEN f.status = 'accepted' THEN 'friends'
                   WHEN f.status IN ('pending', 'declined') AND f.requested_by = $1::uuid THEN 'pending_out'
                   WHEN f.status = 'pending' THEN 'pending_in'
                   ELSE 'none' END AS relationship,
              m.role, m.state, m.joined_at
         FROM conversation_members m
         JOIN users u ON u.id = m.user_id
         JOIN profiles p ON p.id = u.id
         ${FRIENDSHIP_JOIN}
        WHERE m.conversation_id = $2::uuid AND m.state IN ('active', 'left')
        ORDER BY (m.state = 'active') DESC, (m.role = 'admin') DESC,
                 lower(coalesce(nullif(p.display_name, ''), p.username)), p.username`,
      [userId, conversationId],
    );
    const members: GroupMember[] = r.rows.map((row) => ({
      user: toPublicUser(row),
      role: row.role,
      state: row.state,
      joinedAt: row.joined_at.toISOString(),
    }));
    return { members };
  }

  /** Admins add their friends. People who left or were removed can be added back. */
  async add(
    userId: string,
    conversationId: string,
    userIds: string[],
  ): Promise<GroupMembersResponse> {
    const wanted = [...new Set(userIds)].filter((id) => id !== userId);
    const now = this.clock();
    const done = await withTx(this.pool, async (c) => {
      await this.lock(c, conversationId);
      await this.requireAdmin(c, userId, conversationId);

      const active = await c.query<{ user_id: string }>(
        `SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND state = 'active'`,
        [conversationId],
      );
      const already = new Set(active.rows.map((r) => r.user_id));
      const adding = wanted.filter((id) => !already.has(id));
      if (adding.length === 0) return null; // all of them are in already: nothing to do

      const max = await readConfigInt(c, 'group_max_members', 50);
      if (already.size + adding.length > max) throw new AuthError('group_full');
      await this.assertAddable(c, userId, adding);

      await c.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role, state, joined_at, last_read_at)
         SELECT $1, u, 'member', 'active', $3, $3 FROM unnest($2::uuid[]) AS u
         ON CONFLICT (conversation_id, user_id)
         DO UPDATE SET state = 'active', role = 'member', joined_at = EXCLUDED.joined_at,
                       last_read_at = EXCLUDED.last_read_at`,
        [conversationId, adding, now],
      );
      const names = await this.names(c, [userId, ...adding]);
      const system = await this.postSystem(
        c,
        conversationId,
        userId,
        `${names[0]} added ${joinNames(names.slice(1))}`,
        now,
      );
      return { system, to: [...already, ...adding] };
    });
    if (done) {
      this.publish(done.to, { type: 'message', message: done.system });
      this.publish(done.to, { type: 'conversation', conversationId, change: 'updated' });
    }
    return this.members(userId, conversationId);
  }

  /** An admin removes a member (not another admin). To remove yourself, leave. */
  async remove(
    userId: string,
    conversationId: string,
    targetId: string,
  ): Promise<GroupMembersResponse> {
    if (targetId === userId) {
      await this.leave(userId, conversationId);
      return { members: [] };
    }
    const now = this.clock();
    const done = await withTx(this.pool, async (c) => {
      await this.lock(c, conversationId);
      await this.requireAdmin(c, userId, conversationId);
      const target = await this.seat(c, targetId, conversationId);
      if (!target || target.state !== 'active') return null; // already gone
      if (target.role === 'admin') throw new AuthError('not_group_admin');
      await c.query(
        `UPDATE conversation_members SET state = 'left' WHERE conversation_id = $1 AND user_id = $2`,
        [conversationId, targetId],
      );
      const names = await this.names(c, [userId, targetId]);
      const system = await this.postSystem(
        c,
        conversationId,
        userId,
        `${names[0]} removed ${names[1]}`,
        now,
      );
      return { system, to: await this.activeIds(c, conversationId) };
    });
    if (done) {
      this.publish(done.to, { type: 'message', message: done.system });
      this.publish(done.to, { type: 'conversation', conversationId, change: 'updated' });
      this.publish([targetId], { type: 'conversation', conversationId, change: 'removed' });
    }
    return this.members(userId, conversationId);
  }

  /** Anyone can leave. If they were the last admin, the longest-standing member takes over. Idempotent. */
  async leave(userId: string, conversationId: string): Promise<void> {
    const now = this.clock();
    const done = await withTx(this.pool, async (c) => {
      await this.lock(c, conversationId);
      const kind = await c.query<{ kind: string }>(`SELECT kind FROM conversations WHERE id = $1`, [
        conversationId,
      ]);
      if (!kind.rows[0]) throw new AuthError('conversation_not_found');
      const me = await this.seat(c, userId, conversationId);
      if (!me) throw new AuthError('conversation_not_found');
      if (kind.rows[0].kind !== 'group') throw new AuthError('not_a_group');
      if (me.state === 'left') return null; // already out

      await c.query(
        `UPDATE conversation_members SET state = 'left' WHERE conversation_id = $1 AND user_id = $2`,
        [conversationId, userId],
      );
      const [name] = await this.names(c, [userId]);
      const system = [await this.postSystem(c, conversationId, userId, `${name} left`, now)];

      if (me.role === 'admin') {
        const admins = await c.query(
          `SELECT 1 FROM conversation_members
            WHERE conversation_id = $1 AND state = 'active' AND role = 'admin' LIMIT 1`,
          [conversationId],
        );
        if (admins.rows.length === 0) {
          const next = await c.query<{ user_id: string }>(
            `UPDATE conversation_members SET role = 'admin'
              WHERE (conversation_id, user_id) = (
                SELECT conversation_id, user_id FROM conversation_members
                 WHERE conversation_id = $1 AND state = 'active'
                 ORDER BY joined_at, user_id LIMIT 1)
              RETURNING user_id`,
            [conversationId],
          );
          if (next.rows[0]) {
            const [promoted] = await this.names(c, [next.rows[0].user_id]);
            system.push(
              await this.postSystem(
                c,
                conversationId,
                next.rows[0].user_id,
                `${promoted} is now an admin`,
                now,
              ),
            );
          }
        }
      }
      return { system, to: await this.activeIds(c, conversationId) };
    });
    if (done) {
      for (const message of done.system) this.publish(done.to, { type: 'message', message });
      this.publish(done.to, { type: 'conversation', conversationId, change: 'updated' });
      this.publish([userId], { type: 'conversation', conversationId, change: 'removed' });
    }
  }

  /** Admins rename the group. */
  async rename(
    userId: string,
    conversationId: string,
    title: string,
  ): Promise<ConversationSummary> {
    const now = this.clock();
    const done = await withTx(this.pool, async (c) => {
      await this.lock(c, conversationId);
      await this.requireAdmin(c, userId, conversationId);
      const current = await c.query<{ title: string }>(
        `SELECT title FROM conversations WHERE id = $1`,
        [conversationId],
      );
      if (current.rows[0]?.title === title) return null;
      await c.query(`UPDATE conversations SET title = $2 WHERE id = $1`, [conversationId, title]);
      const [name] = await this.names(c, [userId]);
      const system = await this.postSystem(
        c,
        conversationId,
        userId,
        `${name} renamed the group to “${title}”`,
        now,
      );
      return { system, to: await this.activeIds(c, conversationId) };
    });
    if (done) {
      this.publish(done.to, { type: 'message', message: done.system });
      this.publish(done.to, { type: 'conversation', conversationId, change: 'updated' });
    }
    return this.messages.get(userId, conversationId);
  }

  /** An admin makes a member an admin; an admin can step down themselves (unless they are the only one). */
  async setRole(
    userId: string,
    conversationId: string,
    targetId: string,
    role: GroupRole,
  ): Promise<GroupMembersResponse> {
    const now = this.clock();
    const done = await withTx(this.pool, async (c) => {
      await this.lock(c, conversationId);
      await this.requireAdmin(c, userId, conversationId);
      const target = await this.seat(c, targetId, conversationId);
      if (!target || target.state !== 'active') throw new AuthError('user_not_found');
      if (target.role === role) return null;

      if (role === 'member') {
        if (targetId !== userId) throw new AuthError('not_group_admin');
        const others = await c.query(
          `SELECT 1 FROM conversation_members
            WHERE conversation_id = $1 AND state = 'active' AND role = 'admin' AND user_id <> $2 LIMIT 1`,
          [conversationId, userId],
        );
        if (others.rows.length === 0) throw new AuthError('last_admin');
      }
      await c.query(
        `UPDATE conversation_members SET role = $3::member_role WHERE conversation_id = $1 AND user_id = $2`,
        [conversationId, targetId, role],
      );
      const names = await this.names(c, [userId, targetId]);
      const text =
        role === 'admin'
          ? `${names[0]} made ${names[1]} an admin`
          : `${names[0]} is no longer an admin`;
      const system = await this.postSystem(c, conversationId, userId, text, now);
      return { system, to: await this.activeIds(c, conversationId) };
    });
    if (done) {
      this.publish(done.to, { type: 'message', message: done.system });
      this.publish(done.to, { type: 'conversation', conversationId, change: 'updated' });
    }
    return this.members(userId, conversationId);
  }

  // ---- internals ------------------------------------------------------------------------------

  private publish(userIds: string[], event: RealtimeEvent): void {
    try {
      this.publisher.publish(userIds, event);
    } catch {
      // best effort
    }
  }

  private async lock(c: pg.PoolClient, key: string): Promise<void> {
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [`group:${key}`]);
  }

  private async seat(db: Db, userId: string, conversationId: string): Promise<Seat | null> {
    const r = await db.query<Seat>(
      `SELECT role, state FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId],
    );
    return r.rows[0] ?? null;
  }

  /** You must be an active member of this group, and an admin. Someone outside it learns nothing. */
  private async requireAdmin(
    c: pg.PoolClient,
    userId: string,
    conversationId: string,
  ): Promise<void> {
    const r = await c.query<{ kind: string; role: GroupRole; state: string }>(
      `SELECT cv.kind, m.role, m.state FROM conversations cv
         JOIN conversation_members m ON m.conversation_id = cv.id AND m.user_id = $2
        WHERE cv.id = $1`,
      [conversationId, userId],
    );
    const row = r.rows[0];
    if (!row || row.state !== 'active') throw new AuthError('conversation_not_found');
    if (row.kind !== 'group') throw new AuthError('not_a_group');
    if (row.role !== 'admin') throw new AuthError('not_group_admin');
  }

  private async activeIds(db: Db, conversationId: string): Promise<string[]> {
    const r = await db.query<{ user_id: string }>(
      `SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND state = 'active'`,
      [conversationId],
    );
    return r.rows.map((x) => x.user_id);
  }

  /** Display names (or usernames), in the order asked. */
  private async names(db: Db, ids: string[]): Promise<string[]> {
    const r = await db.query<{ id: string; name: string }>(
      `SELECT id, coalesce(nullif(display_name, ''), username) AS name FROM profiles WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    const by = new Map(r.rows.map((x) => [x.id, x.name]));
    return ids.map((id) => by.get(id) ?? 'Someone');
  }

  /**
   * Each person must be an active user and a friend of `adderId`, and nobody blocked either way. Someone
   * who blocked the adder (or doesn't exist) is "not found"; one the adder blocked is `blocked`; a stranger
   * is `group_member_not_friend` (they would otherwise land in someone's Chat uninvited).
   */
  private async assertAddable(c: pg.PoolClient, adderId: string, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    const live = await c.query<{ id: string }>(
      `SELECT u.id FROM users u JOIN profiles p ON p.id = u.id
        WHERE u.id = ANY($1::uuid[]) AND u.disabled_at IS NULL`,
      [userIds],
    );
    if (live.rows.length !== userIds.length) throw new AuthError('user_not_found');

    const blocks = await c.query<{ blocker_id: string; blocked_id: string }>(
      `SELECT blocker_id, blocked_id FROM blocks
        WHERE (blocker_id = $1 AND blocked_id = ANY($2::uuid[]))
           OR (blocked_id = $1 AND blocker_id = ANY($2::uuid[]))`,
      [adderId, userIds],
    );
    if (blocks.rows.some((b) => b.blocker_id !== adderId)) throw new AuthError('user_not_found');
    if (blocks.rows.length > 0) throw new AuthError('blocked');

    const friends = await c.query<{ other: string }>(
      `SELECT CASE WHEN user_low = $1 THEN user_high ELSE user_low END AS other
         FROM friendships
        WHERE status = 'accepted' AND (
          (user_low = $1 AND user_high = ANY($2::uuid[])) OR (user_high = $1 AND user_low = ANY($2::uuid[])))`,
      [adderId, userIds],
    );
    const friendIds = new Set(friends.rows.map((r) => r.other));
    const strangers = userIds.filter((id) => !friendIds.has(id));
    if (strangers.length > 0)
      throw new AuthError('group_member_not_friend', { userIds: strangers });
  }

  /** "Tunde added Amaka": a centred line in the thread, sent by whoever did it. */
  private async postSystem(
    c: pg.PoolClient,
    conversationId: string,
    actorId: string,
    body: string,
    now: Date,
  ) {
    const inserted = await c.query<MessageRow>(
      `INSERT INTO messages (id, conversation_id, sender_id, kind, body, created_at)
       VALUES ($1, $2, $3, 'system', $4, $5)
       RETURNING id, conversation_id, sender_id, kind, body, payload, created_at, deleted_at, reply_to`,
      [randomUUID(), conversationId, actorId, body, now],
    );
    await c.query(`UPDATE conversations SET last_message_at = $2 WHERE id = $1`, [
      conversationId,
      now,
    ]);
    return hydrateOne(c, actorId, inserted.rows[0]!);
  }
}

/** "Amaka", "Amaka and Dayo", "Amaka, Dayo and Zee". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
