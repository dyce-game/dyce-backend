import type pg from 'pg';
import {
  BOTS,
  botBySlug,
  parseAvatar,
  type ConversationFilter,
  type ConversationState,
  type ConversationSummary,
  type ConversationsResponse,
  type GameCardPayload,
  type GroupRole,
  type Message,
  type MessagesResponse,
  type MoneyRequestPayload,
  type MoneySentPayload,
  type RealtimeEvent,
  type Relationship,
} from '@dyce/shared';
import { AuthError } from '../auth/auth-error.ts';
import type { Clock } from '../auth/tokens.ts';
import { lagosDayStart, readConfigInt } from '../db/config.ts';
import { withTx } from '../db/tx.ts';
import { assertNotRestricted } from '../integrity/restrictions.ts';
import { applySpamFilter } from '../integrity/spam-filter.ts';
import {
  FRIENDSHIP_JOIN,
  lockPair,
  NOT_BLOCKED,
  RELATIONSHIP_EXPR,
} from '../social/relationship.ts';
import { BotService } from './bots.ts';
import {
  hydrate,
  hydrateOne,
  MSG_COLS,
  NOT_HIDDEN,
  toMessage,
  type MessageRow,
} from './message-rows.ts';

/** Where live events go. The WebSocket hub implements it; tests pass a recorder. */
export interface Publisher {
  publish(userIds: readonly string[], event: RealtimeEvent): void;
}

type MemberState = 'active' | 'request' | 'declined' | 'left';

/** Rows selected with MSG_COLS come from this join. */
const FROM_MESSAGES = 'FROM messages m JOIN conversations c ON c.id = m.conversation_id';

/** What you are to a conversation: how it is shaped, and where you stand in it. */
type Membership = {
  kind: 'direct' | 'group' | 'bot' | 'sms';
  botSlug: string | null;
  state: MemberState;
  role: GroupRole;
  joinedAt: Date;
};

/** The list row of a group or a bot. */
type GroupSummaryRow = {
  id: string;
  kind: 'group' | 'bot';
  title: string | null;
  photo_url: string | null;
  bot_slug: string | null;
  role: GroupRole;
  member_count: number;
  preview: { id: string; username: string; display_name: string; avatar: unknown }[];
  unread: number;
  has_user_msg: boolean;
  m_id: string | null;
  m_sender: string | null;
  m_kind: Message['kind'] | null;
  m_body: string | null;
  m_payload: unknown;
  m_created: Date | null;
  m_deleted: Date | null;
  m_sender_name: string | null;
};

type SummaryRow = {
  id: string;
  peer_id: string;
  username: string;
  display_name: string;
  avatar: unknown;
  relationship: Relationship;
  state: ConversationState | 'declined' | 'left';
  /** Set when the spam filter put this request aside (ADR-039). */
  filtered_at: Date | null;
  unread: number;
  m_id: string | null;
  m_sender: string | null;
  m_kind: Message['kind'] | null;
  m_body: string | null;
  m_payload: unknown;
  m_created: Date | null;
  m_deleted: Date | null;
};

/** What the two people in a conversation can do right now, from `viewer`'s side. */
type Seat = {
  peerId: string;
  friends: boolean;
  isNew: boolean; // no message has been sent yet
  myState: MemberState;
  peerState: MemberState;
  /** The spam filter put the peer's copy of this request aside: they are not told about new messages. */
  peerFiltered: boolean;
  peerReadAt: Date | null;
};

/**
 * One-to-one messaging.
 *
 * Friends chat freely. A message to someone who isn't a friend creates the conversation in the Requests
 * inbox of the *recipient* (their membership is `request`); it never reaches their Chat until they accept
 * or reply, and only a few messages can be sent before they do. Ignoring ("declined") is silent: the
 * sender is not told, and the recipient gets no live events or read receipts from then on. Requests also
 * never reveal whether they've been opened (no read receipts until accepted).
 *
 * "Effective" state: once two people are friends, a conversation that was a request (or ignored) counts as
 * active for both, so becoming friends is enough and nothing needs rewriting.
 */
export class MessagesService {
  /** The practice bots (scripted replies). Exposed so tests and shutdown can wait for pending replies. */
  readonly bots: BotService;

  constructor(
    private readonly pool: pg.Pool,
    private readonly publisher: Publisher,
    private readonly clock: Clock = () => new Date(),
    options: { botReplyDelayMs?: number } = {},
  ) {
    this.bots = new BotService(pool, publisher, clock, options.botReplyDelayMs);
  }

  // ---- opening --------------------------------------------------------------------------------

  /**
   * The conversation with `peerId`, created if it doesn't exist. Creating it sends nothing: it appears in
   * lists only once a message is sent.
   */
  async openDirect(userId: string, peerId: string): Promise<ConversationSummary> {
    if (userId === peerId) throw new AuthError('cannot_add_self');
    const now = this.clock();
    const id = await withTx(this.pool, async (c) => {
      await lockPair(c, userId, peerId);
      await this.assertReachable(c, userId, peerId);

      const key = directKey(userId, peerId);
      const found = await c.query<{ id: string }>(
        `SELECT id FROM conversations WHERE direct_key = $1`,
        [key],
      );
      if (found.rows[0]) return found.rows[0].id;

      const friends = await this.areFriends(c, userId, peerId);
      const created = await c.query<{ id: string }>(
        `INSERT INTO conversations (kind, direct_key, created_by, created_at)
         VALUES ('direct', $1, $2, $3) RETURNING id`,
        [key, userId, now],
      );
      const conversationId = created.rows[0]!.id;
      await c.query(
        `INSERT INTO conversation_members (conversation_id, user_id, state) VALUES
           ($1, $2, 'active'), ($1, $3, $4)`,
        [conversationId, userId, peerId, friends ? 'active' : 'request'],
      );
      return conversationId;
    });
    return this.get(userId, id);
  }

  // ---- reading --------------------------------------------------------------------------------

  /** Your conversations, most recent first. Requests are separate from the rest. */
  async list(userId: string, filter: ConversationFilter = 'all'): Promise<ConversationsResponse> {
    // The Bots filter always lists all four bots: they are created (with a greeting) the first time you look.
    if (filter === 'bots') await this.bots.ensureAll(userId);

    const directRows = await this.summaries(this.pool, userId, { onlyWithMessages: true });
    const direct = directRows.map(toSummary);
    // Requests the spam filter put aside: still there, in their own bucket, not in the badge (ADR-039).
    const filteredIds = new Set(
      directRows.filter((r) => r.state === 'request' && r.filtered_at).map((r) => r.id),
    );
    const others = (await this.groupSummaries(this.pool, userId, {})).map(toGroupSummary);

    const activeDirect = direct.filter((c) => c.state === 'active');
    const requests = direct.filter((c) => c.state === 'request' && !filteredIds.has(c.id));
    const filtered = direct.filter((c) => filteredIds.has(c.id));
    // A bot joins "All" once you have said something to it, so four greetings don't fill a new inbox.
    const groups = others.filter((c) => c.summary.kind === 'group').map((c) => c.summary);
    const bots = others.filter((c) => c.summary.kind === 'bot');
    const usedBots = bots.filter((c) => c.started).map((c) => c.summary);

    const byRecent = (a: ConversationSummary, b: ConversationSummary) =>
      (b.lastMessage?.createdAt ?? '').localeCompare(a.lastMessage?.createdAt ?? '');

    const shown =
      filter === 'requests'
        ? requests
        : filter === 'filtered'
          ? filtered
          : filter === 'friends'
            ? activeDirect.filter((c) => c.peer?.relationship === 'friends')
            : filter === 'groups'
              ? groups
              : filter === 'bots'
                ? bots.map((c) => c.summary)
                : [...activeDirect, ...groups, ...usedBots].sort(byRecent);
    return {
      conversations: filter === 'bots' ? [...shown].sort(botOrder) : shown,
      requestCount: requests.length,
      filteredCount: filtered.length,
      unreadTotal: [...activeDirect, ...groups, ...bots.map((b) => b.summary)].reduce(
        (n, c) => n + c.unread,
        0,
      ),
    };
  }

  async get(userId: string, conversationId: string): Promise<ConversationSummary> {
    const rows = await this.summaries(this.pool, userId, { conversationId });
    const row = rows[0];
    if (row) return toSummary(row);
    const other = (await this.groupSummaries(this.pool, userId, { conversationId }))[0];
    if (!other) throw new AuthError('conversation_not_found');
    return toGroupSummary(other).summary;
  }

  /** A page of messages, newest first. */
  async messages(
    userId: string,
    conversationId: string,
    opts: { before?: string; limit?: number } = {},
  ): Promise<MessagesResponse> {
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 50);
    const member = await this.membership(this.pool, userId, conversationId);
    const seat =
      member.kind === 'direct' ? await this.seat(this.pool, userId, conversationId) : null;

    // Deleted-for-everyone messages stay as tombstones; ones you deleted for yourself are gone.
    const params: unknown[] = [conversationId, limit + 1, userId];
    let where = `m.conversation_id = $1 AND ${NOT_HIDDEN('$3::uuid')}`;
    if (member.kind === 'group') {
      // A group shows its history from when you joined, and nothing from people you blocked.
      params.push(member.joinedAt);
      where += ` AND m.created_at >= $${params.length}::timestamptz
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = $3::uuid AND b.blocked_id = m.sender_id)`;
    }
    if (opts.before) {
      const [ts, id] = opts.before.split('|') as [string, string];
      params.push(ts, id);
      where += ` AND (m.created_at, m.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    const r = await this.pool.query<MessageRow>(
      `SELECT ${MSG_COLS} ${FROM_MESSAGES}
        WHERE ${where}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $2`,
      params,
    );
    const page = await hydrate(this.pool, userId, r.rows.slice(0, limit));
    const last = page[page.length - 1];
    return {
      messages: page,
      nextCursor: r.rows.length > limit && last ? `${last.createdAt}|${last.id}` : null,
      // Reading is only visible to the sender once the conversation is accepted. Groups and bots have no read receipts.
      peerReadAt:
        seat && effective(seat.peerState, seat.friends) === 'active'
          ? (seat.peerReadAt?.toISOString() ?? null)
          : null,
    };
  }

  // ---- writing --------------------------------------------------------------------------------

  /**
   * Sends a text message. Idempotent on `input.id`: a retry returns the stored message and sends nothing
   * new, so a flaky connection can't produce duplicates.
   */
  async send(
    userId: string,
    conversationId: string,
    input: { id: string; body: string; replyTo?: string },
  ): Promise<Message> {
    const member = await this.membership(this.pool, userId, conversationId);
    if (member.kind === 'group') return this.sendInGroup(userId, conversationId, input);
    if (member.kind === 'bot') return this.sendToBot(userId, conversationId, input);
    return this.sendDirect(userId, conversationId, input);
  }

  private async sendDirect(
    userId: string,
    conversationId: string,
    input: { id: string; body: string; replyTo?: string },
  ): Promise<Message> {
    const now = this.clock();

    const result = await withTx(this.pool, async (c) => {
      // Find the other person first so both of them can be serialised, then read everything under the lock.
      const peerId = await this.peerOf(c, userId, conversationId);
      await lockPair(c, userId, peerId);
      const seat = await this.seat(c, userId, conversationId);
      await this.assertReachable(c, userId, peerId);

      const prior = await this.priorSend(c, userId, conversationId, input.id);
      if (prior) return { row: prior, fresh: false, notifyPeer: false, peerId: seat.peerId };

      await assertNotRestricted(c, userId);
      if (input.replyTo) await this.assertReplyTarget(c, conversationId, input.replyTo);
      if (!seat.friends) await this.checkStrangerRules(c, userId, conversationId, seat, now);
      // A request that looks like spam goes to the recipient's filtered bucket and is not pushed to them.
      const filtered =
        !seat.friends && seat.peerState === 'request'
          ? await applySpamFilter(c, {
              conversationId,
              sender: userId,
              recipient: seat.peerId,
              now,
            })
          : false;

      // Writing in a request is accepting it; becoming friends also makes both sides active.
      if (seat.myState !== 'active') {
        await this.setState(c, conversationId, userId, 'active');
      }
      if (seat.friends && seat.peerState !== 'active') {
        await this.setState(c, conversationId, seat.peerId, 'active');
      }

      const row = await this.insertText(c, userId, conversationId, input, now);
      // Someone who ignored a request gets no live events (and nothing else) from the sender.
      const notifyPeer = !isQuiet(seat) && !filtered;
      return { row, fresh: true, notifyPeer, peerId: seat.peerId };
    });

    const message = await hydrateOne(this.pool, userId, result.row);
    if (result.fresh) {
      const targets = result.notifyPeer ? [userId, result.peerId] : [userId];
      this.safePublish(targets, { type: 'message', message });
    }
    return message;
  }

  /** Text into a group: everyone still in it gets it live, except people who blocked the sender. */
  private async sendInGroup(
    userId: string,
    conversationId: string,
    input: { id: string; body: string; replyTo?: string },
  ): Promise<Message> {
    const now = this.clock();
    const result = await withTx(this.pool, async (c) => {
      // Share-lock your own row: a removal in flight finishes first, so a removed member can't slip a message in.
      const me = await c.query(
        `SELECT 1 FROM conversation_members m JOIN conversations cv ON cv.id = m.conversation_id
          WHERE m.conversation_id = $1 AND m.user_id = $2 AND m.state = 'active' AND cv.kind = 'group'
            FOR SHARE OF m`,
        [conversationId, userId],
      );
      if (me.rows.length === 0) throw new AuthError('conversation_not_found');
      const prior = await this.priorSend(c, userId, conversationId, input.id);
      if (prior) return { row: prior, fresh: false, to: [] as string[] };
      await assertNotRestricted(c, userId);
      if (input.replyTo) await this.assertReplyTarget(c, conversationId, input.replyTo);
      const row = await this.insertText(c, userId, conversationId, input, now);
      return { row, fresh: true, to: await this.groupRecipients(c, conversationId, userId) };
    });
    const message = await hydrateOne(this.pool, userId, result.row);
    if (result.fresh) this.safePublish(result.to, { type: 'message', message });
    return message;
  }

  /** Text to a bot: stored, shown at once, and answered by the script a moment later. */
  private async sendToBot(
    userId: string,
    conversationId: string,
    input: { id: string; body: string; replyTo?: string },
  ): Promise<Message> {
    const now = this.clock();
    const result = await withTx(this.pool, async (c) => {
      const prior = await this.priorSend(c, userId, conversationId, input.id);
      if (prior) return { row: prior, fresh: false };
      if (input.replyTo) await this.assertReplyTarget(c, conversationId, input.replyTo);
      return { row: await this.insertText(c, userId, conversationId, input, now), fresh: true };
    });
    const message = await hydrateOne(this.pool, userId, result.row);
    if (result.fresh) {
      this.safePublish([userId], { type: 'message', message });
      this.bots.scheduleReply(userId, conversationId, message.id);
    }
    return message;
  }

  /** The message with this id if you already sent it here (a retry); another conversation's or person's id is taken. */
  private async priorSend(
    c: pg.PoolClient,
    userId: string,
    conversationId: string,
    id: string,
  ): Promise<MessageRow | null> {
    const existing = await c.query<MessageRow>(
      `SELECT ${MSG_COLS} ${FROM_MESSAGES} WHERE m.id = $1`,
      [id],
    );
    const prior = existing.rows[0];
    if (!prior) return null;
    if (prior.conversation_id !== conversationId || prior.sender_id !== userId) {
      throw new AuthError('message_id_taken');
    }
    return prior;
  }

  /** A reply must answer a live message of the same conversation. */
  private async assertReplyTarget(
    c: pg.PoolClient,
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    const r = await c.query(
      `SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2 AND deleted_at IS NULL`,
      [messageId, conversationId],
    );
    if (r.rows.length === 0) throw new AuthError('message_not_found');
  }

  private async insertText(
    c: pg.PoolClient,
    userId: string,
    conversationId: string,
    input: { id: string; body: string; replyTo?: string },
    now: Date,
  ): Promise<MessageRow> {
    const inserted = await c.query<MessageRow>(
      `INSERT INTO messages (id, conversation_id, sender_id, kind, body, reply_to, created_at)
       VALUES ($1, $2, $3, 'text', $4, $5, $6)
       RETURNING id, conversation_id, sender_id, kind, body, payload, created_at, deleted_at, reply_to`,
      [input.id, conversationId, userId, input.body, input.replyTo ?? null, now],
    );
    await c.query(`UPDATE conversations SET last_message_at = $2 WHERE id = $1`, [
      conversationId,
      now,
    ]);
    return inserted.rows[0]!;
  }

  /** The active members of a group who should get a live event from `senderId` (not those who blocked them). */
  async groupRecipients(
    db: Pick<pg.Pool, 'query'>,
    conversationId: string,
    senderId: string,
  ): Promise<string[]> {
    const r = await db.query<{ user_id: string }>(
      `SELECT m.user_id FROM conversation_members m
        WHERE m.conversation_id = $1 AND m.state = 'active'
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = m.user_id AND b.blocked_id = $2)`,
      [conversationId, senderId],
    );
    return r.rows.map((x) => x.user_id);
  }

  /**
   * Posts a money card (sent / requested) into the conversation. Not subject to the stranger limits: the
   * money movement already passed its own checks. `input.id` is the transaction or request id, so posting
   * twice (a retried payment) stores one card. Live delivery goes to both people unless the other ignored
   * the conversation.
   */
  async postCard(
    conversationId: string,
    senderId: string,
    input:
      | { id: string; kind: 'money_sent'; body: string; payload: MoneySentPayload }
      | { id: string; kind: 'money_request'; body: string; payload: MoneyRequestPayload }
      | { id: string; kind: 'game'; body: string; payload: GameCardPayload },
  ): Promise<Message> {
    const now = this.clock();
    const result = await withTx(this.pool, async (c) => {
      const seat = await this.seat(c, senderId, conversationId);
      const inserted = await c.query<MessageRow>(
        `INSERT INTO messages (id, conversation_id, sender_id, kind, body, payload, created_at)
         VALUES ($1, $2, $3, $4::message_kind, $5, $6::jsonb, $7)
         ON CONFLICT (id) DO NOTHING
         RETURNING id, conversation_id, sender_id, kind, body, payload, created_at`,
        [
          input.id,
          conversationId,
          senderId,
          input.kind,
          input.body,
          JSON.stringify(input.payload),
          now,
        ],
      );
      const row =
        inserted.rows[0] ??
        (
          await c.query<MessageRow>(
            `SELECT id, conversation_id, sender_id, kind, body, payload, created_at FROM messages WHERE id = $1`,
            [input.id],
          )
        ).rows[0]!;
      if (inserted.rows[0]) {
        await c.query(`UPDATE conversations SET last_message_at = $2 WHERE id = $1`, [
          conversationId,
          now,
        ]);
      }
      return {
        message: toMessage(row),
        fresh: Boolean(inserted.rows[0]),
        notify: !isQuiet(seat),
        peerId: seat.peerId,
      };
    });
    if (result.fresh) {
      this.safePublish(result.notify ? [senderId, result.peerId] : [senderId], {
        type: 'message',
        message: result.message,
      });
    }
    return result.message;
  }

  /** Updates a card's status (a request that was paid, cancelled or expired) and tells both people. */
  async updateCardPayload(messageId: string, patch: Record<string, unknown>): Promise<void> {
    const r = await this.pool.query<MessageRow & { peer_a: string; peer_b: string }>(
      `UPDATE messages SET payload = payload || $2::jsonb, edited_at = $3
        WHERE id = $1 AND kind = 'money_request'
        RETURNING id, conversation_id, sender_id, kind, body, payload, created_at,
                  sender_id AS peer_a,
                  (SELECT user_id FROM conversation_members
                    WHERE conversation_id = messages.conversation_id AND user_id <> messages.sender_id) AS peer_b`,
      [messageId, JSON.stringify(patch), this.clock()],
    );
    const row = r.rows[0];
    if (row) {
      this.safePublish([row.peer_a, row.peer_b], { type: 'message', message: toMessage(row) });
    }
  }

  /**
   * Updates a game card (invited -> active -> finished) and tells both people. Only moves forward: a late
   * update with an older `stateVersion` is ignored, so two quick moves can't leave the card behind.
   */
  async updateGameCard(matchId: string, payload: GameCardPayload): Promise<void> {
    const r = await this.pool.query<MessageRow & { peer_a: string; peer_b: string }>(
      `UPDATE messages SET payload = $2::jsonb, edited_at = $3
        WHERE id = $1 AND kind = 'game' AND coalesce((payload->>'stateVersion')::int, 0) <= $4
        RETURNING id, conversation_id, sender_id, kind, body, payload, created_at,
                  sender_id AS peer_a,
                  (SELECT user_id FROM conversation_members
                    WHERE conversation_id = messages.conversation_id AND user_id <> messages.sender_id) AS peer_b`,
      [matchId, JSON.stringify(payload), this.clock(), payload.stateVersion],
    );
    const row = r.rows[0];
    if (row) {
      this.safePublish([row.peer_a, row.peer_b], { type: 'message', message: toMessage(row) });
    }
  }

  /**
   * The other person in a conversation `userId` is in, if you can interact with them (not blocked either
   * way), and whether you're friends. Games are only played between friends.
   */
  async playablePeer(
    userId: string,
    conversationId: string,
    /** Pass the transaction's connection when calling from inside one: asking the pool for a second connection while holding one can starve it. */
    db: Pick<pg.Pool, 'query'> = this.pool,
  ): Promise<{ peerId: string; friends: boolean }> {
    const seat = await this.seat(db, userId, conversationId);
    await this.assertReachable(db, userId, seat.peerId);
    return { peerId: seat.peerId, friends: seat.friends };
  }

  /** Marks everything up to now as read. Only an accepted conversation tells the sender. */
  async markRead(userId: string, conversationId: string): Promise<{ readAt: string }> {
    const now = this.clock();
    const member = await this.membership(this.pool, userId, conversationId);
    const seat =
      member.kind === 'direct' ? await this.seat(this.pool, userId, conversationId) : null;
    await this.pool.query(
      `UPDATE conversation_members
          SET last_read_at = greatest(coalesce(last_read_at, $3), $3)
        WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId, now],
    );
    // Only a direct chat tells the other person (groups and bots have no read receipts).
    if (seat && effective(seat.myState, seat.friends) === 'active') {
      this.safePublish([seat.peerId], {
        type: 'read',
        conversationId,
        userId,
        at: now.toISOString(),
      });
    }
    return { readAt: now.toISOString() };
  }

  /** "Accept" a request (or an ignored one): it becomes a normal conversation. Idempotent. */
  async accept(userId: string, conversationId: string): Promise<ConversationSummary> {
    const seat = await this.seat(this.pool, userId, conversationId);
    if (seat.myState !== 'active') await this.setState(this.pool, conversationId, userId, 'active');
    return this.get(userId, conversationId);
  }

  /** "Decline": hides a request without telling the sender. Idempotent. */
  async decline(userId: string, conversationId: string): Promise<void> {
    const seat = await this.seat(this.pool, userId, conversationId);
    // Only a request can be declined; a normal chat is left alone (and a friend's chat is never a request).
    if (effective(seat.myState, seat.friends) !== 'request' && seat.myState !== 'declined') {
      throw new AuthError('conversation_not_found');
    }
    await this.setState(this.pool, conversationId, userId, 'declined');
  }

  /**
   * Who a typing signal from `userId` in this conversation should go to: nobody if it shouldn't be sent
   * (not a member, blocked, the other person ignored the request, or it's a bot).
   */
  async typingTargets(userId: string, conversationId: string): Promise<string[]> {
    try {
      const member = await this.membership(this.pool, userId, conversationId);
      if (member.kind === 'group') {
        return (await this.groupRecipients(this.pool, conversationId, userId)).filter(
          (id) => id !== userId,
        );
      }
      if (member.kind !== 'direct') return [];
      const seat = await this.seat(this.pool, userId, conversationId);
      await this.assertReachable(this.pool, userId, seat.peerId);
      return isQuiet(seat) ? [] : [seat.peerId];
    } catch {
      return [];
    }
  }

  /**
   * What `userId` may do in a conversation right now, for the services that act on messages (reactions,
   * deletes, polls). Throws `conversation_not_found` for someone who isn't in it (or was removed) and, in a
   * direct chat, for a blocked pair. `recipients` are who should hear about a change; `active` is false for
   * a request you haven't accepted yet (you can read it, not react in it).
   */
  async access(
    userId: string,
    conversationId: string,
  ): Promise<{
    kind: 'direct' | 'group' | 'bot' | 'sms';
    role: GroupRole;
    active: boolean;
    recipients: string[];
  }> {
    const member = await this.membership(this.pool, userId, conversationId);
    if (member.kind === 'group') {
      return {
        kind: 'group',
        role: member.role,
        active: true,
        recipients: await this.groupRecipients(this.pool, conversationId, userId),
      };
    }
    if (member.kind === 'direct') {
      const seat = await this.seat(this.pool, userId, conversationId);
      await this.assertReachable(this.pool, userId, seat.peerId);
      return {
        kind: 'direct',
        role: 'member',
        active: effective(seat.myState, seat.friends) === 'active',
        recipients: isQuiet(seat) ? [userId] : [userId, seat.peerId],
      };
    }
    return { kind: member.kind, role: 'member', active: true, recipients: [userId] };
  }

  /** Your place in a conversation. Throws `conversation_not_found` if you are not in it (or left, or were removed). */
  async membership(
    db: Pick<pg.Pool, 'query'>,
    userId: string,
    conversationId: string,
  ): Promise<Membership> {
    const r = await db.query<{
      kind: Membership['kind'];
      bot_slug: string | null;
      state: MemberState;
      role: GroupRole;
      joined_at: Date;
    }>(
      `SELECT c.kind, c.bot_slug, m.state, m.role, m.joined_at
         FROM conversations c
         JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = $1::uuid
        WHERE c.id = $2::uuid AND m.state <> 'left'`,
      [userId, conversationId],
    );
    const row = r.rows[0];
    if (!row) throw new AuthError('conversation_not_found');
    return {
      kind: row.kind,
      botSlug: row.bot_slug,
      state: row.state,
      role: row.role,
      joinedAt: row.joined_at,
    };
  }

  // ---- internals ------------------------------------------------------------------------------

  private safePublish(userIds: string[], event: RealtimeEvent): void {
    try {
      this.publisher.publish(userIds, event);
    } catch {
      // Live delivery is best effort: the message is stored and the app catches up on reconnect.
    }
  }

  private async setState(
    db: Pick<pg.Pool, 'query'>,
    conversationId: string,
    userId: string,
    state: MemberState,
  ): Promise<void> {
    // Answering a request (accepting, declining) takes it out of the spam bucket.
    await db.query(
      `UPDATE conversation_members
          SET state = $3::member_state,
              filtered_at = CASE WHEN $3::member_state = 'request' THEN filtered_at END,
              filter_reason = CASE WHEN $3::member_state = 'request' THEN filter_reason END
        WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId, state],
    );
  }

  private async areFriends(db: Pick<pg.Pool, 'query'>, a: string, b: string): Promise<boolean> {
    const r = await db.query(
      `SELECT 1 FROM friendships
        WHERE user_low = LEAST($1::uuid, $2::uuid) AND user_high = GREATEST($1::uuid, $2::uuid)
          AND status = 'accepted'`,
      [a, b],
    );
    return r.rows.length > 0;
  }

  /** The other member of a direct conversation `userId` belongs to. */
  private async peerOf(
    db: Pick<pg.Pool, 'query'>,
    userId: string,
    conversationId: string,
  ): Promise<string> {
    const r = await db.query<{ peer: string }>(
      `SELECT o.user_id AS peer
         FROM conversations c
         JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = $1::uuid
         JOIN conversation_members o ON o.conversation_id = c.id AND o.user_id <> $1::uuid
        WHERE c.id = $2::uuid AND c.kind = 'direct' AND m.state <> 'left'`,
      [userId, conversationId],
    );
    const peer = r.rows[0]?.peer;
    if (!peer) throw new AuthError('conversation_not_found');
    return peer;
  }

  private async seat(
    db: Pick<pg.Pool, 'query'>,
    userId: string,
    conversationId: string,
  ): Promise<Seat> {
    const r = await db.query<{
      peer: string;
      my_state: MemberState;
      peer_state: MemberState;
      peer_filtered: boolean;
      peer_read: Date | null;
      last_message_at: Date | null;
      friends: boolean;
    }>(
      `SELECT o.user_id AS peer, m.state AS my_state, o.state AS peer_state,
              o.filtered_at IS NOT NULL AS peer_filtered, o.last_read_at AS peer_read, c.last_message_at,
              EXISTS (SELECT 1 FROM friendships f
                       WHERE f.user_low = LEAST($1::uuid, o.user_id) AND f.user_high = GREATEST($1::uuid, o.user_id)
                         AND f.status = 'accepted') AS friends
         FROM conversations c
         JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = $1::uuid
         JOIN conversation_members o ON o.conversation_id = c.id AND o.user_id <> $1::uuid
        WHERE c.id = $2::uuid AND c.kind = 'direct' AND m.state <> 'left'`,
      [userId, conversationId],
    );
    const row = r.rows[0];
    if (!row) throw new AuthError('conversation_not_found');
    return {
      peerId: row.peer,
      friends: row.friends,
      isNew: row.last_message_at === null,
      myState: row.my_state,
      peerState: row.peer_state,
      peerFiltered: row.peer_filtered && row.peer_state === 'request' && !row.friends,
      peerReadAt: row.peer_read,
    };
  }

  /**
   * The other person must exist and be active, and neither of you has blocked the other. If they blocked
   * you the chat looks like it doesn't exist; if you blocked them you're told so.
   */
  private async assertReachable(
    db: Pick<pg.Pool, 'query'>,
    userId: string,
    peerId: string,
  ): Promise<void> {
    const peer = await db.query(
      `SELECT 1 FROM users u JOIN profiles p ON p.id = u.id WHERE u.id = $1 AND u.disabled_at IS NULL`,
      [peerId],
    );
    if (peer.rows.length === 0) throw new AuthError('user_not_found');
    const blocks = await db.query<{ blocker_id: string }>(
      `SELECT blocker_id FROM blocks
        WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
      [userId, peerId],
    );
    if (blocks.rows.some((b) => b.blocker_id === peerId)) throw new AuthError('user_not_found');
    if (blocks.rows.length > 0) throw new AuthError('blocked');
  }

  /** Limits on writing to someone you aren't friends with. */
  private async checkStrangerRules(
    c: pg.PoolClient,
    userId: string,
    conversationId: string,
    seat: Seat,
    now: Date,
  ): Promise<void> {
    // The other person has already answered (accepted, or wrote back): ordinary chat from here on.
    if (seat.peerState === 'active') return;

    if (seat.isNew) {
      const target = await c.query<{ request_policy: 'everyone' | 'fof' | 'nobody' }>(
        `SELECT request_policy FROM profiles WHERE id = $1`,
        [seat.peerId],
      );
      const policy = target.rows[0]?.request_policy ?? 'everyone';
      if (policy === 'nobody') throw new AuthError('requests_closed');
      if (policy === 'fof' && !(await this.knowsEachOther(c, userId, seat.peerId))) {
        throw new AuthError('requests_closed');
      }

      const perDay = await readConfigInt(c, 'stranger_requests_per_day', 20);
      const started = await c.query<{ n: string }>(
        `SELECT count(*) AS n
           FROM conversations cv
           JOIN conversation_members o ON o.conversation_id = cv.id AND o.user_id <> $1::uuid
          WHERE cv.created_by = $1::uuid AND cv.kind = 'direct'
            AND cv.last_message_at >= $2 AND o.state IN ('request', 'declined')`,
        [userId, lagosDayStart(now)],
      );
      if (Number(started.rows[0]?.n ?? 0) >= perDay) {
        throw new AuthError('message_requests_rate_limited');
      }
    }

    const cap = await readConfigInt(c, 'request_messages_before_accept', 3);
    const sent = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM messages
        WHERE conversation_id = $1 AND sender_id = $2`,
      [conversationId, userId],
    );
    if (Number(sent.rows[0]?.n ?? 0) >= cap) throw new AuthError('request_pending');
  }

  /** A friend in common, or one of you has the other in their contacts. */
  private async knowsEachOther(c: pg.PoolClient, a: string, b: string): Promise<boolean> {
    const r = await c.query<{ ok: boolean }>(
      `WITH mine AS (
         SELECT CASE WHEN user_low = $1 THEN user_high ELSE user_low END AS f
           FROM friendships WHERE status = 'accepted' AND $1 IN (user_low, user_high)),
       theirs AS (
         SELECT CASE WHEN user_low = $2 THEN user_high ELSE user_low END AS f
           FROM friendships WHERE status = 'accepted' AND $2 IN (user_low, user_high))
       SELECT (
         EXISTS (SELECT 1 FROM mine JOIN theirs USING (f))
         OR EXISTS (SELECT 1 FROM contact_links
                     WHERE (owner_id = $1 AND contact_user_id = $2) OR (owner_id = $2 AND contact_user_id = $1))
       ) AS ok`,
      [a, b],
    );
    return r.rows[0]?.ok === true;
  }

  /** The list/detail query: one row per conversation `userId` is in, with the other person and the latest message. */
  private async summaries(
    db: Pick<pg.Pool, 'query'>,
    userId: string,
    opts: { conversationId?: string; onlyWithMessages?: boolean },
  ): Promise<SummaryRow[]> {
    const params: unknown[] = [userId];
    let where = `m.user_id = $1::uuid AND m.state <> 'left' AND ${NOT_BLOCKED}`;
    if (opts.conversationId) {
      params.push(opts.conversationId);
      where += ` AND c.id = $${params.length}::uuid`;
    }
    if (opts.onlyWithMessages) where += ` AND c.last_message_at IS NOT NULL`;

    const r = await db.query<SummaryRow>(
      `SELECT c.id, u.id AS peer_id, p.username, p.display_name, p.avatar,
              ${RELATIONSHIP_EXPR} AS relationship,
              CASE WHEN f.status = 'accepted' AND m.state IN ('request', 'declined') THEN 'active'
                   ELSE m.state::text END AS state,
              m.filtered_at,
              (SELECT count(*)::int FROM (
                 SELECT 1 FROM messages x
                  WHERE x.conversation_id = c.id AND x.sender_id <> $1::uuid AND x.deleted_at IS NULL
                    AND (m.last_read_at IS NULL OR x.created_at > m.last_read_at)
                  LIMIT 99) s) AS unread,
              lm.id AS m_id, lm.sender_id AS m_sender, lm.kind AS m_kind, lm.body AS m_body,
              lm.payload AS m_payload, lm.created_at AS m_created, lm.deleted_at AS m_deleted
         FROM conversation_members m
         JOIN conversations c ON c.id = m.conversation_id AND c.kind = 'direct'
         JOIN conversation_members o ON o.conversation_id = c.id AND o.user_id <> $1::uuid
         JOIN users u ON u.id = o.user_id AND u.disabled_at IS NULL
         JOIN profiles p ON p.id = u.id
         ${FRIENDSHIP_JOIN}
         LEFT JOIN LATERAL (
           SELECT x.id, x.sender_id, x.kind, x.body, x.payload, x.created_at, x.deleted_at FROM messages x
            WHERE x.conversation_id = c.id
              AND NOT EXISTS (SELECT 1 FROM message_hides h WHERE h.message_id = x.id AND h.user_id = $1::uuid)
            ORDER BY x.created_at DESC, x.id DESC LIMIT 1) lm ON true
        WHERE ${where}
        ORDER BY coalesce(c.last_message_at, c.created_at) DESC
        LIMIT 200`,
      params,
    );
    // An ignored request is hidden from lists; a conversation opened by id (detail) still resolves.
    return opts.conversationId ? r.rows : r.rows.filter((row) => row.state !== 'declined');
  }

  /** The list/detail rows of the groups and bots `userId` is in (people who left are not listed). */
  private async groupSummaries(
    db: Pick<pg.Pool, 'query'>,
    userId: string,
    opts: { conversationId?: string },
  ): Promise<GroupSummaryRow[]> {
    const params: unknown[] = [userId];
    let where = `m.user_id = $1::uuid AND m.state = 'active'`;
    if (opts.conversationId) {
      params.push(opts.conversationId);
      where += ` AND c.id = $${params.length}::uuid`;
    }
    const hidden = (x: string) =>
      `NOT EXISTS (SELECT 1 FROM message_hides h WHERE h.message_id = ${x}.id AND h.user_id = $1::uuid)`;
    const blockedSender = (x: string) =>
      `NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = $1::uuid AND b.blocked_id = ${x}.sender_id)`;
    const r = await db.query<GroupSummaryRow>(
      `SELECT c.id, c.kind, c.title, c.photo_url, c.bot_slug, m.role,
              (SELECT count(*)::int FROM conversation_members gm
                WHERE gm.conversation_id = c.id AND gm.state = 'active') AS member_count,
              (SELECT coalesce(jsonb_agg(jsonb_build_object(
                        'id', x.id, 'username', x.username, 'display_name', x.display_name, 'avatar', x.avatar)), '[]'::jsonb)
                 FROM (SELECT p.id, p.username, p.display_name, p.avatar
                         FROM conversation_members gm JOIN profiles p ON p.id = gm.user_id
                        WHERE gm.conversation_id = c.id AND gm.state = 'active' AND gm.user_id <> $1::uuid
                        ORDER BY gm.joined_at, gm.user_id LIMIT 3) x) AS preview,
              (SELECT count(*)::int FROM (
                 SELECT 1 FROM messages x
                  WHERE x.conversation_id = c.id AND x.sender_id IS DISTINCT FROM $1::uuid
                    AND x.deleted_at IS NULL AND x.kind <> 'system' AND x.created_at >= m.joined_at
                    AND (m.last_read_at IS NULL OR x.created_at > m.last_read_at)
                    AND ${hidden('x')} AND ${blockedSender('x')}
                  LIMIT 99) s) AS unread,
              EXISTS (SELECT 1 FROM messages x WHERE x.conversation_id = c.id AND x.sender_id = $1::uuid
                       AND x.kind = 'text') AS has_user_msg,
              lm.id AS m_id, lm.sender_id AS m_sender, lm.kind AS m_kind, lm.body AS m_body,
              lm.payload AS m_payload, lm.created_at AS m_created, lm.deleted_at AS m_deleted,
              coalesce(nullif(sp.display_name, ''), sp.username) AS m_sender_name
         FROM conversation_members m
         JOIN conversations c ON c.id = m.conversation_id AND c.kind IN ('group', 'bot')
         LEFT JOIN LATERAL (
           SELECT x.id, x.sender_id, x.kind, x.body, x.payload, x.created_at, x.deleted_at FROM messages x
            WHERE x.conversation_id = c.id AND x.created_at >= m.joined_at
              AND ${hidden('x')} AND ${blockedSender('x')}
            ORDER BY x.created_at DESC, x.id DESC LIMIT 1) lm ON true
         LEFT JOIN profiles sp ON sp.id = lm.sender_id
        WHERE ${where}
        ORDER BY coalesce(c.last_message_at, c.created_at) DESC
        LIMIT 200`,
      params,
    );
    return r.rows;
  }
}

/** The Bots tab keeps the catalogue's order (Coach Cue, Quiz Mama, Word Hunt Trainer, Admiral Ade). */
const BOT_ORDER: string[] = BOTS.map((b) => b.slug);
function botOrder(a: ConversationSummary, b: ConversationSummary): number {
  const at = (c: ConversationSummary) => BOT_ORDER.indexOf(c.bot?.slug ?? '');
  return at(a) - at(b);
}

const directKey = (a: string, b: string): string => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** The other person gets no live events from you: they ignored the request, or the spam filter set it aside. */
function isQuiet(seat: Seat): boolean {
  return effective(seat.peerState, seat.friends) === 'declined' || seat.peerFiltered;
}

/** A request between friends is just a chat. */
function effective(state: MemberState, friends: boolean): MemberState {
  return friends && (state === 'request' || state === 'declined') ? 'active' : state;
}

function toSummary(row: SummaryRow): ConversationSummary {
  const state: ConversationState = row.state === 'request' ? 'request' : 'active';
  return {
    id: row.id,
    kind: 'direct',
    peer: {
      id: row.peer_id,
      username: row.username,
      displayName: row.display_name,
      avatar: parseAvatar(row.avatar),
      relationship: row.relationship,
    },
    state,
    lastMessage:
      row.m_id && row.m_sender && row.m_kind && row.m_body !== null && row.m_created
        ? toMessage({
            id: row.m_id,
            conversation_id: row.id,
            sender_id: row.m_sender,
            kind: row.m_kind,
            body: row.m_body,
            payload: row.m_payload,
            created_at: row.m_created,
            deleted_at: row.m_deleted,
          })
        : null,
    unread: row.unread,
  };
}

/** A group or bot as a list row. `started`: you have said something to it (bots only appear in All then). */
function toGroupSummary(row: GroupSummaryRow): { summary: ConversationSummary; started: boolean } {
  const last: Message | null =
    row.m_id && row.m_kind && row.m_created
      ? toMessage({
          id: row.m_id,
          conversation_id: row.id,
          sender_id: row.m_sender,
          kind: row.m_kind,
          body: row.m_body,
          payload: row.m_payload,
          created_at: row.m_created,
          deleted_at: row.m_deleted,
          bot_slug: row.bot_slug,
        })
      : null;
  const lastMessage =
    last && row.kind === 'group' && row.m_sender_name && last.kind !== 'system'
      ? { ...last, senderName: row.m_sender_name }
      : last;
  const base = { id: row.id, state: 'active' as const, lastMessage, unread: row.unread };
  if (row.kind === 'bot') {
    const bot = botBySlug(row.bot_slug ?? '');
    // A bot we no longer ship is left out of the lists rather than breaking them.
    if (bot) return { summary: { ...base, kind: 'bot', bot }, started: row.has_user_msg };
  }
  return {
    summary: {
      ...base,
      kind: 'group',
      group: {
        title: row.title ?? '',
        photoUrl: row.photo_url,
        memberCount: row.member_count,
        role: row.role,
        members: row.preview.map((p) => ({
          id: p.id,
          username: p.username,
          displayName: p.display_name,
          avatar: parseAvatar(p.avatar),
        })),
      },
    },
    started: row.has_user_msg,
  };
}
