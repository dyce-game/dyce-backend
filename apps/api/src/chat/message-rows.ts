import type pg from 'pg';
import {
  botSenderId,
  REACTION_KEYS,
  type GameCardPayload,
  type Message,
  type MoneyRequestPayload,
  type MoneySentPayload,
  type PollPayload,
  type ReactionCount,
  type ReactionKey,
  type ReplyPreview,
} from '@dyce/shared';

type Db = Pick<pg.Pool, 'query'>;

/** A `messages` row (joined with its conversation for `bot_slug`). The newer columns are optional so older queries still fit. */
export type MessageRow = {
  id: string;
  conversation_id: string;
  /** Null for a bot's message, or when the sender's account is gone. */
  sender_id: string | null;
  kind: Message['kind'];
  body: string | null;
  payload: unknown;
  created_at: Date;
  deleted_at?: Date | null;
  reply_to?: string | null;
  bot_slug?: string | null;
};

/** Columns to select for `FROM messages m JOIN conversations c ON c.id = m.conversation_id`. */
export const MSG_COLS = `m.id, m.conversation_id, m.sender_id, m.kind, m.body, m.payload, m.created_at,
  m.deleted_at, m.reply_to, c.bot_slug`;

/** Hides messages the viewer chose to delete for themselves. `$viewer` is a SQL expression for the user id. */
export const NOT_HIDDEN = (viewer: string) =>
  `NOT EXISTS (SELECT 1 FROM message_hides h WHERE h.message_id = m.id AND h.user_id = ${viewer})`;

/** A message with no extras (no reactions, replies or tallies yet). */
export function toMessage(r: MessageRow): Message {
  const base = {
    id: r.id,
    conversationId: r.conversation_id,
    senderId: r.sender_id ?? (r.bot_slug ? botSenderId(r.bot_slug) : 'unknown'),
    body: r.body ?? '',
    createdAt: r.created_at.toISOString(),
  };
  // Deleted for everyone: nothing of the content is left.
  if (r.deleted_at) return { ...base, body: '', kind: 'text', deleted: true };
  switch (r.kind) {
    case 'money_sent':
      return { ...base, kind: 'money_sent', payload: r.payload as MoneySentPayload };
    case 'money_request':
      return { ...base, kind: 'money_request', payload: r.payload as MoneyRequestPayload };
    case 'game':
      return { ...base, kind: 'game', payload: r.payload as GameCardPayload };
    case 'system':
      return { ...base, kind: 'system' };
    case 'poll': {
      const p = r.payload as { question?: string; options?: { id: number; text: string }[] };
      return {
        ...base,
        kind: 'poll',
        payload: {
          question: p.question ?? '',
          options: (p.options ?? []).map((o) => ({ id: o.id, text: o.text, votes: 0 })),
          total: 0,
          myVote: null,
        },
      };
    }
    default:
      return { ...base, kind: 'text' };
  }
}

const SNIPPET_MAX = 80;

/** The one-line version of a message, for the quote above a reply. */
export function snippetOf(kind: Message['kind'], body: string | null, payload: unknown): string {
  switch (kind) {
    case 'poll':
      return `Poll: ${(payload as { question?: string })?.question ?? ''}`.slice(0, SNIPPET_MAX);
    case 'game':
      return 'Game';
    default: {
      const text = (body ?? '').replace(/\s+/g, ' ').trim();
      return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX - 1)}…` : text;
    }
  }
}

/**
 * Adds what lives in other tables: the quoted message of a reply, reactions (with `mine` for `viewerId`),
 * and a poll's tally with the viewer's vote. One query each, for the whole page.
 */
export async function hydrate(db: Db, viewerId: string, rows: MessageRow[]): Promise<Message[]> {
  const messages = rows.map(toMessage);
  if (rows.length === 0) return messages;
  const live = rows.filter((r) => !r.deleted_at);
  const ids = live.map((r) => r.id);

  const [reactions, polls, replies] = await Promise.all([
    ids.length
      ? db.query<{ message_id: string; emoji: ReactionKey; n: number; mine: boolean }>(
          `SELECT message_id, emoji, count(*)::int AS n, bool_or(user_id = $2::uuid) AS mine
             FROM reactions WHERE message_id = ANY($1::uuid[]) GROUP BY message_id, emoji`,
          [ids, viewerId],
        )
      : { rows: [] },
    live.some((r) => r.kind === 'poll')
      ? db.query<{ message_id: string; option_id: number; n: number; mine: boolean }>(
          `SELECT message_id, option_id, count(*)::int AS n, bool_or(user_id = $2::uuid) AS mine
             FROM poll_votes WHERE message_id = ANY($1::uuid[]) GROUP BY message_id, option_id`,
          [live.filter((r) => r.kind === 'poll').map((r) => r.id), viewerId],
        )
      : { rows: [] },
    live.some((r) => r.reply_to)
      ? db.query<{
          id: string;
          sender_id: string | null;
          kind: Message['kind'];
          body: string | null;
          payload: unknown;
          deleted_at: Date | null;
          bot_slug: string | null;
          name: string | null;
        }>(
          `SELECT r.id, r.sender_id, r.kind, r.body, r.payload, r.deleted_at, c.bot_slug,
                  coalesce(nullif(p.display_name, ''), p.username) AS name
             FROM messages r
             JOIN conversations c ON c.id = r.conversation_id
             LEFT JOIN profiles p ON p.id = r.sender_id
            WHERE r.id = ANY($1::uuid[])`,
          [live.filter((r) => r.reply_to).map((r) => r.reply_to)],
        )
      : { rows: [] },
  ]);

  const reactionsBy = new Map<string, ReactionCount[]>();
  for (const r of reactions.rows) {
    const list = reactionsBy.get(r.message_id) ?? [];
    list.push({ key: r.emoji, count: r.n, mine: r.mine });
    reactionsBy.set(r.message_id, list);
  }
  const order = (k: ReactionKey) => REACTION_KEYS.indexOf(k);

  const tally = new Map<string, Map<number, number>>();
  const myVote = new Map<string, number>();
  for (const v of polls.rows) {
    const m = tally.get(v.message_id) ?? new Map<number, number>();
    m.set(v.option_id, v.n);
    tally.set(v.message_id, m);
    if (v.mine) myVote.set(v.message_id, v.option_id);
  }

  const quoted = new Map<string, ReplyPreview>();
  for (const q of replies.rows) {
    quoted.set(q.id, {
      id: q.id,
      senderId: q.sender_id ?? (q.bot_slug ? botSenderId(q.bot_slug) : null),
      senderName: q.name ?? 'Someone',
      snippet: q.deleted_at ? '' : snippetOf(q.kind, q.body, q.payload),
      deleted: q.deleted_at !== null,
    });
  }

  return messages.map((m, i) => {
    const row = rows[i]!;
    if (m.deleted) return m;
    const extra: Partial<Pick<Message, 'reactions' | 'replyTo'>> = {};
    const rs = reactionsBy.get(m.id);
    if (rs?.length) extra.reactions = rs.sort((a, b) => order(a.key) - order(b.key));
    if (row.reply_to) extra.replyTo = quoted.get(row.reply_to) ?? null;
    if (m.kind === 'poll') {
      const counts = tally.get(m.id);
      const options = m.payload.options.map((o) => ({ ...o, votes: counts?.get(o.id) ?? 0 }));
      const payload: PollPayload = {
        question: m.payload.question,
        options,
        total: options.reduce((n, o) => n + o.votes, 0),
        myVote: myVote.get(m.id) ?? null,
      };
      return { ...m, ...extra, payload };
    }
    return { ...m, ...extra } as Message;
  });
}

/** Hydrates one message. */
export async function hydrateOne(db: Db, viewerId: string, row: MessageRow): Promise<Message> {
  return (await hydrate(db, viewerId, [row]))[0]!;
}
