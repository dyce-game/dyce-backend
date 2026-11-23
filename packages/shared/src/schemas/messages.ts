import { z } from 'zod';
import type { PublicUser } from './contacts.ts';
import type { GameCardPayload, MatchView } from './games.ts';
import type { SpaceView } from './spaces.ts';
import type { QuickMatchTicket } from './quickmatch.ts';
import type { BotInfo } from '../bots.ts';

/** Longest text message, in characters. */
export const MAX_MESSAGE_LENGTH = 4000;

export const conversationIdParamSchema = z.uuid();

export const openDirectSchema = z.object({ userId: z.uuid() });
export type OpenDirectRequest = z.infer<typeof openDirectSchema>;

/**
 * The client makes the message id (a UUID) so the bubble can appear instantly and a retry after a bad
 * connection can't send it twice.
 */
export const sendMessageSchema = z.object({
  id: z.uuid(),
  body: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
  /** The message this one answers (it must be in the same conversation). */
  replyTo: z.uuid().optional(),
});
export type SendMessageRequest = z.infer<typeof sendMessageSchema>;

/** "<ISO timestamp>|<message id>": the position of the oldest message already loaded. */
export const messageCursorSchema = z
  .string()
  .max(80)
  .regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|[0-9a-f-]{36}$/i, 'invalid cursor');

export const messagesQuerySchema = z.object({
  before: messageCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});
export type MessagesQuery = z.infer<typeof messagesQuerySchema>;

export const conversationFilterSchema = z.enum([
  'all',
  'friends',
  'groups',
  'requests',
  'filtered',
  'bots',
]);
export type ConversationFilter = z.infer<typeof conversationFilterSchema>;
export const listConversationsQuerySchema = z.object({
  filter: conversationFilterSchema.default('all'),
});

/** What a money card in a chat carries (the card text is in `body`, e.g. "Sent ₦5,000"). */
export type MoneySentPayload = { amountKobo: number; note: string; txnId: string };
export type MoneyRequestPayload = {
  /** null = any amount. */
  amountKobo: number | null;
  note: string;
  code: string;
  status: 'open' | 'paid' | 'expired' | 'cancelled';
  expiresAt: string;
};

/**
 * The fixed set of reactions. They are keys, drawn by the app as short labels (GG, HA, !!, ?, L), never as
 * emoji (the design uses text chips).
 */
export const REACTION_KEYS = ['gg', 'ha', 'wow', 'q', 'l'] as const;
export type ReactionKey = (typeof REACTION_KEYS)[number];
export const reactionKeySchema = z.enum(REACTION_KEYS);

/** What the long-press bar shows: the chip text and the words for screen readers. */
export const REACTIONS: { key: ReactionKey; label: string; aria: string }[] = [
  { key: 'gg', label: 'GG', aria: 'Good game' },
  { key: 'ha', label: 'HA', aria: 'Ha ha' },
  { key: 'wow', label: '!!', aria: 'Wow' },
  { key: 'q', label: '?', aria: 'Question' },
  { key: 'l', label: 'L', aria: 'Took the L' },
];

/** Reactions on one message: how many people used each, and whether you did. */
export type ReactionCount = { key: ReactionKey; count: number; mine: boolean };

/** The quoted message above a reply. */
export type ReplyPreview = {
  id: string;
  /** Null when the sender has left Dyce, or for a bot (see `senderName`). */
  senderId: string | null;
  senderName: string;
  /** The text (or "Poll" / "Game" / "Money" for cards), shortened. Empty when the original was deleted. */
  snippet: string;
  deleted: boolean;
};

/** A poll in a group: one vote each, changeable. `myVote` is the option index you picked (yours alone). */
export type PollPayload = {
  question: string;
  options: { id: number; text: string; votes: number }[];
  total: number;
  myVote: number | null;
};

type MessageBase = {
  id: string;
  conversationId: string;
  /** A bot's messages come from `bot:<slug>`. */
  senderId: string;
  /** Set on the last message of a group in the Chat list ("Ifeoma: who's next?"). */
  senderName?: string;
  body: string;
  /** ISO timestamp, set by the server. */
  createdAt: string;
  /** The message this one answers. */
  replyTo?: ReplyPreview | null;
  reactions?: ReactionCount[];
  /** Deleted for everyone: the body is empty and the thread shows "This message was deleted". */
  deleted?: boolean;
};

export type Message =
  | (MessageBase & { kind: 'text'; payload?: undefined })
  /** "Tunde added Amaka", "Amaka left". Centred, not a bubble. */
  | (MessageBase & { kind: 'system'; payload?: undefined })
  | (MessageBase & { kind: 'poll'; payload: PollPayload })
  | (MessageBase & { kind: 'money_sent'; payload: MoneySentPayload })
  | (MessageBase & { kind: 'money_request'; payload: MoneyRequestPayload })
  | (MessageBase & { kind: 'game'; payload: GameCardPayload });

export type MessageKind = Message['kind'];

/** `request`: someone you don't know yet wrote to you. Nothing here is shown in Chat until you accept. */
export type ConversationState = 'active' | 'request';

type ConversationBase = {
  id: string;
  state: ConversationState;
  lastMessage: Message | null;
  /** Messages from other people you haven't read (capped at 99). */
  unread: number;
};

/** The first few other members of a group, for the avatar cluster in the list. */
export type GroupMemberPreview = Pick<PublicUser, 'id' | 'username' | 'displayName' | 'avatar'>;

export type GroupRole = 'admin' | 'member';

export type GroupInfo = {
  title: string;
  /** Always null for now: group photos are a placeholder until uploads exist (BACKLOG). */
  photoUrl: string | null;
  /** Active members, you included. */
  memberCount: number;
  /** Your role in it. */
  role: GroupRole;
  members: GroupMemberPreview[];
};

/**
 * One conversation in the Chat list. `kind` says which of `peer` (a person), `group` or `bot` is set; the
 * others are `undefined`, so `conversation.peer` is `undefined` for a group and the types narrow on `kind`.
 */
export type ConversationSummary =
  | (ConversationBase & { kind: 'direct'; peer: PublicUser; group?: undefined; bot?: undefined })
  | (ConversationBase & { kind: 'group'; group: GroupInfo; peer?: undefined; bot?: undefined })
  | (ConversationBase & { kind: 'bot'; bot: BotInfo; peer?: undefined; group?: undefined });

export type DirectConversation = Extract<ConversationSummary, { kind: 'direct' }>;
export type GroupConversation = Extract<ConversationSummary, { kind: 'group' }>;

export type ConversationsResponse = {
  conversations: ConversationSummary[];
  /** Conversations waiting in Requests (for the tab badge). Spam-filtered ones are not counted. */
  requestCount: number;
  /** Requests the spam filter put aside ("N filtered as spam · view"); list them with `filter=filtered`. */
  filteredCount: number;
  /** Unread messages across active conversations (for the Chat tab badge). */
  unreadTotal: number;
};

export type MessagesResponse = {
  /** Newest first. */
  messages: Message[];
  /** Pass as `before` to load older messages; null when there are no more. */
  nextCursor: string | null;
  /** When the other person last read the thread: your messages up to here are "Read". */
  peerReadAt: string | null;
};

// ---- realtime (WebSocket) ----------------------------------------------------------------------

/** Server to client. */
export type RealtimeEvent =
  | { type: 'ready' }
  | { type: 'message'; message: Message }
  | { type: 'read'; conversationId: string; userId: string; at: string }
  | { type: 'typing'; conversationId: string; userId: string; typing: boolean }
  /** Someone reacted (or took it back). `counts` is the whole tally; `mine` follows from `userId`. */
  | {
      type: 'reaction';
      conversationId: string;
      messageId: string;
      userId: string;
      reaction: ReactionKey | null;
      counts: { key: ReactionKey; count: number }[];
    }
  /** Someone voted in a poll. `votes` is the whole tally. */
  | {
      type: 'poll';
      conversationId: string;
      messageId: string;
      voterId: string;
      optionId: number | null;
      votes: { id: number; votes: number }[];
      total: number;
    }
  /** A message was deleted. `scope: 'me'` goes only to your own devices. */
  | {
      type: 'message_deleted';
      conversationId: string;
      messageId: string;
      scope: 'me' | 'everyone';
    }
  /** A group changed (name, members, roles) or you are no longer in it: refetch it and the lists. */
  | { type: 'conversation'; conversationId: string; change: 'updated' | 'removed' }
  /** A match you're in changed (accepted, moved, finished). Each player gets their own view of it. */
  | { type: 'match'; match: MatchView }
  /** A space you're in changed (someone sat down or left, it started, it ended). */
  | { type: 'space'; space: SpaceView }
  /** Your quick-match ticket changed (a match was found, the other person declined, it started). */
  | { type: 'quick_match'; ticket: QuickMatchTicket }
  /** Something new for the Notifications list (the list and its count refetch). */
  | { type: 'notification'; unread: number };

/** Client to server. The first frame must be `auth`. */
export type RealtimeClientFrame =
  { type: 'auth'; token: string } | { type: 'typing'; conversationId: string; typing: boolean };

export const realtimeClientFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().min(10).max(4000) }),
  z.object({ type: z.literal('typing'), conversationId: z.uuid(), typing: z.boolean() }),
]);
