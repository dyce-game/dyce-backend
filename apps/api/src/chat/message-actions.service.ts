import type pg from 'pg';
import {
  REACTION_KEYS,
  type Message,
  type PollPayload,
  type ReactionCount,
  type ReactionKey,
  type RealtimeEvent,
} from '@dyce/shared';
import { AuthError } from '../auth/auth-error.ts';
import type { Clock } from '../auth/tokens.ts';
import { readConfigInt } from '../db/config.ts';
import { withTx } from '../db/tx.ts';
import { hydrate, hydrateOne, MSG_COLS, type MessageRow } from './message-rows.ts';
import type { MessagesService, Publisher } from './messages.service.ts';

const FROM_MESSAGES = 'FROM messages m JOIN conversations c ON c.id = m.conversation_id';

/**
 * What you can do to a message after it is sent (ADR-026): react, delete (for yourself, or for everyone for a
 * short while), and in a group, make a poll and vote in it. Replying is part of sending.
 *
 * All of these need the same access as reading the conversation: a person who left or was removed, or a
 * blocked pair, can't react, delete or vote. Reactions and votes change one row per person and are safe to
 * repeat. Live events carry the whole new tally, so a client that missed one still ends up right.
 */
export class MessageActionsService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly publisher: Publisher,
    private readonly messages: MessagesService,
    private readonly clock: Clock = () => new Date(),
  ) {}

  // ---- reactions ------------------------------------------------------------------------------

  /** Sets (or, with null, removes) your one reaction to a message. Returns the message's reactions as you see them. */
  async react(
    userId: string,
    conversationId: string,
    messageId: string,
    reaction: ReactionKey | null,
  ): Promise<ReactionCount[]> {
    const access = await this.messages.access(userId, conversationId);
    // An unaccepted request can be read but not answered, not even with a reaction.
    if (!access.active) throw new AuthError('conversation_not_found');

    const counts = await withTx(this.pool, async (c) => {
      const msg = await c.query<{ kind: string; deleted_at: Date | null }>(
        `SELECT kind, deleted_at FROM messages WHERE id = $1 AND conversation_id = $2 FOR SHARE`,
        [messageId, conversationId],
      );
      const row = msg.rows[0];
      // System lines and deleted messages take no reactions.
      if (!row || row.deleted_at || row.kind === 'system') throw new AuthError('message_not_found');
      if (reaction === null) {
        await c.query(`DELETE FROM reactions WHERE message_id = $1 AND user_id = $2`, [
          messageId,
          userId,
        ]);
      } else {
        await c.query(
          `INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)
           ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji, created_at = now()`,
          [messageId, userId, reaction],
        );
      }
      return this.tally(c, messageId, userId);
    });

    this.publish(access.recipients, {
      type: 'reaction',
      conversationId,
      messageId,
      userId,
      reaction,
      counts: counts.map(({ key, count }) => ({ key, count })),
    });
    return counts;
  }

  private async tally(db: Pick<pg.Pool, 'query'>, messageId: string, viewerId: string) {
    const r = await db.query<{ emoji: ReactionKey; n: number; mine: boolean }>(
      `SELECT emoji, count(*)::int AS n, bool_or(user_id = $2::uuid) AS mine
         FROM reactions WHERE message_id = $1 GROUP BY emoji`,
      [messageId, viewerId],
    );
    return r.rows
      .map((x): ReactionCount => ({ key: x.emoji, count: x.n, mine: x.mine }))
      .sort((a, b) => REACTION_KEYS.indexOf(a.key) - REACTION_KEYS.indexOf(b.key));
  }

  // ---- deleting -------------------------------------------------------------------------------

  /**
   * `me`: the message disappears from your view only (any message, any time).
   * `everyone`: you sent it, it is a text or a poll, and it is within the window
   * (`delete_for_everyone_minutes`, 15): its content is wiped and the thread shows "This message was
   * deleted". Money and game cards are records, so they can only be deleted for yourself. Both are idempotent.
   */
  async delete(
    userId: string,
    conversationId: string,
    messageId: string,
    scope: 'me' | 'everyone',
  ): Promise<void> {
    const access = await this.messages.access(userId, conversationId);
    const now = this.clock();

    if (scope === 'me') {
      const found = await this.pool.query(
        `SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2`,
        [messageId, conversationId],
      );
      if (found.rows.length === 0) throw new AuthError('message_not_found');
      await this.pool.query(
        `INSERT INTO message_hides (user_id, message_id, hidden_at) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [userId, messageId, now],
      );
      this.publish([userId], { type: 'message_deleted', conversationId, messageId, scope: 'me' });
      return;
    }

    const wiped = await withTx(this.pool, async (c) => {
      const r = await c.query<{
        sender_id: string | null;
        kind: string;
        created_at: Date;
        deleted_at: Date | null;
      }>(
        `SELECT sender_id, kind, created_at, deleted_at FROM messages
          WHERE id = $1 AND conversation_id = $2 FOR UPDATE`,
        [messageId, conversationId],
      );
      const row = r.rows[0];
      if (!row) throw new AuthError('message_not_found');
      if (row.sender_id !== userId || (row.kind !== 'text' && row.kind !== 'poll')) {
        throw new AuthError('cannot_delete_message');
      }
      if (row.deleted_at) return false; // already deleted
      const minutes = await readConfigInt(c, 'delete_for_everyone_minutes', 15);
      if (now.getTime() - row.created_at.getTime() > minutes * 60_000) {
        throw new AuthError('delete_window_closed', { minutes });
      }
      await c.query(
        `UPDATE messages SET deleted_at = $2, body = '', payload = '{}'::jsonb WHERE id = $1`,
        [messageId, now],
      );
      await c.query(`DELETE FROM poll_votes WHERE message_id = $1`, [messageId]);
      return true;
    });
    if (wiped) {
      this.publish(access.recipients, {
        type: 'message_deleted',
        conversationId,
        messageId,
        scope: 'everyone',
      });
    }
  }

  // ---- polls ----------------------------------------------------------------------------------

  /** A poll in a group. The client picks the message id, so a retry posts it once. */
  async createPoll(
    userId: string,
    conversationId: string,
    input: { id: string; question: string; options: string[] },
  ): Promise<Message> {
    const access = await this.messages.access(userId, conversationId);
    if (access.kind !== 'group') throw new AuthError('not_a_group');
    const now = this.clock();

    const result = await withTx(this.pool, async (c) => {
      const existing = await c.query<MessageRow>(
        `SELECT ${MSG_COLS} ${FROM_MESSAGES} WHERE m.id = $1`,
        [input.id],
      );
      const prior = existing.rows[0];
      if (prior) {
        if (
          prior.conversation_id !== conversationId ||
          prior.sender_id !== userId ||
          prior.kind !== 'poll'
        ) {
          throw new AuthError('message_id_taken');
        }
        return { row: prior, fresh: false };
      }
      const payload = {
        question: input.question,
        options: input.options.map((text, id) => ({ id, text })),
      };
      const inserted = await c.query<MessageRow>(
        `INSERT INTO messages (id, conversation_id, sender_id, kind, body, payload, created_at)
         VALUES ($1, $2, $3, 'poll', $4, $5::jsonb, $6)
         RETURNING id, conversation_id, sender_id, kind, body, payload, created_at, deleted_at, reply_to`,
        [input.id, conversationId, userId, `Poll: ${input.question}`, JSON.stringify(payload), now],
      );
      await c.query(`UPDATE conversations SET last_message_at = $2 WHERE id = $1`, [
        conversationId,
        now,
      ]);
      return { row: inserted.rows[0]!, fresh: true };
    });
    const message = await hydrateOne(this.pool, userId, result.row);
    if (result.fresh) this.publish(access.recipients, { type: 'message', message });
    return message;
  }

  /** Your one vote in a poll (change it any time; `null` takes it back). Returns the poll as you see it. */
  async vote(
    userId: string,
    conversationId: string,
    messageId: string,
    optionId: number | null,
  ): Promise<PollPayload> {
    const access = await this.messages.access(userId, conversationId);
    if (access.kind !== 'group') throw new AuthError('not_a_group');

    const row = await withTx(this.pool, async (c) => {
      const r = await c.query<MessageRow>(
        `SELECT ${MSG_COLS} ${FROM_MESSAGES}
          WHERE m.id = $1 AND m.conversation_id = $2 AND m.kind = 'poll' FOR SHARE OF m`,
        [messageId, conversationId],
      );
      const poll = r.rows[0];
      if (!poll || poll.deleted_at) throw new AuthError('message_not_found');
      const options = (poll.payload as { options: { id: number }[] }).options;
      if (optionId !== null && !options.some((o) => o.id === optionId)) {
        throw new AuthError('invalid_vote');
      }
      if (optionId === null) {
        await c.query(`DELETE FROM poll_votes WHERE message_id = $1 AND user_id = $2`, [
          messageId,
          userId,
        ]);
      } else {
        await c.query(
          `INSERT INTO poll_votes (message_id, user_id, option_id) VALUES ($1, $2, $3)
           ON CONFLICT (message_id, user_id) DO UPDATE SET option_id = EXCLUDED.option_id, voted_at = now()`,
          [messageId, userId, optionId],
        );
      }
      return poll;
    });

    const message = (await hydrate(this.pool, userId, [row]))[0]!;
    if (message.kind !== 'poll') throw new AuthError('message_not_found');
    this.publish(access.recipients, {
      type: 'poll',
      conversationId,
      messageId,
      voterId: userId,
      optionId,
      votes: message.payload.options.map((o) => ({ id: o.id, votes: o.votes })),
      total: message.payload.total,
    });
    return message.payload;
  }

  private publish(userIds: string[], event: RealtimeEvent): void {
    try {
      this.publisher.publish(userIds, event);
    } catch {
      // best effort: the app refetches on reconnect
    }
  }
}
