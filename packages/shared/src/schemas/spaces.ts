import { z } from 'zod';
import type { AvatarConfig } from './avatar.ts';
import type { MatchMode, MatchPlayerResult } from './games.ts';

/**
 * Spaces: private rooms (friends or a code) where a group plays one live game together (SPEC section 7).
 * The lobby is plain HTTP + the `space` realtime event; the match itself runs in the Colyseus game server
 * (ARCHITECTURE section 5), which speaks the `Live*` messages at the bottom of this file.
 */

export const spaceIdParamSchema = z.uuid();

/** `DY-` + four characters, no 0/O/1/I so it can be read out loud. */
export const SPACE_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const SPACE_CODE_LENGTH = 4;

/** Accepts `DY-4K9P`, `dy4k9p` or `4K9P`; returns the canonical `DY-4K9P`, or null when it can't be one. */
export function normalizeSpaceCode(raw: string): string | null {
  const t = raw.trim().toUpperCase().replace(/[\s-]/g, '');
  const body = t.startsWith('DY') ? t.slice(2) : t;
  if (body.length !== SPACE_CODE_LENGTH) return null;
  for (const ch of body) if (!SPACE_CODE_ALPHABET.includes(ch)) return null;
  return `DY-${body}`;
}

export const spaceCodeSchema = z
  .string()
  .max(16)
  .transform((s, ctx) => {
    const code = normalizeSpaceCode(s);
    if (!code) ctx.addIssue({ code: 'custom', message: 'invalid space code' });
    return code ?? '';
  });

export const spaceVisibilitySchema = z.enum(['friends', 'invite']);
export type SpaceVisibility = z.infer<typeof spaceVisibilitySchema>;
export const spaceStartRuleSchema = z.enum(['when_full', 'host']);
export type SpaceStartRule = z.infer<typeof spaceStartRuleSchema>;
export const spacePayoutSchemeSchema = z.enum(['winner_all', 'p60_40', 'p50_30_20']);
export type SpacePayoutScheme = z.infer<typeof spacePayoutSchemeSchema>;

export const SPACE_NAME_MAX = 32;

export const spaceOptionsSchema = z
  .record(z.string().max(24), z.union([z.string().max(16), z.number(), z.boolean()]))
  .refine((o) => Object.keys(o).length <= 6, 'too many options');
export type SpaceOptions = z.infer<typeof spaceOptionsSchema>;

/** The app picks the space id, so retrying a create after a bad connection can't make two spaces. */
export const createSpaceSchema = z.object({
  id: z.uuid(),
  gameSlug: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9_-]+$/),
  name: z.string().trim().min(1).max(SPACE_NAME_MAX),
  mode: z.enum(['free', 'pool']).default('free'),
  /** Pool only: what each seat pays in kobo. Ignored (0) in Free. */
  seatFeeKobo: z.number().int().min(0).max(1_000_000_000).default(0),
  payoutScheme: spacePayoutSchemeSchema.default('winner_all'),
  maxSeats: z.number().int().min(2).max(12),
  /** Per-game options (Imposter clue rounds, Charades mode, ...). Checked against the game when the space is created. */
  options: spaceOptionsSchema.optional(),
  visibility: spaceVisibilitySchema.default('friends'),
  startRule: spaceStartRuleSchema.default('host'),
});
export type CreateSpaceRequest = z.input<typeof createSpaceSchema>;

export const joinSpaceSchema = z.object({ code: spaceCodeSchema });
export type JoinSpaceRequest = z.input<typeof joinSpaceSchema>;

export const removeSpaceMemberSchema = z.object({ userId: z.uuid() });

export type SpaceStatus = 'waiting' | 'live' | 'ended' | 'closed';

/**
 * Why you are no longer in a space you were in (SpaceView.exit): the host closed it, it timed out unstarted,
 * you were removed, or you left. `refundedKobo` is the seat fee that came back (0 in Free).
 */
export type SpaceExit = {
  reason: 'host_closed' | 'expired' | 'removed' | 'left';
  hostName: string | null;
  refundedKobo: number;
};

export type SpaceMember = {
  userId: string;
  username: string;
  displayName: string;
  avatar: AvatarConfig | null;
  /** 1-based seat. */
  seat: number;
  isHost: boolean;
  /** What this seat has locked in the pot (0 in Free). */
  stakedKobo: number;
  /** After the game: 1 = winner. */
  placement: number | null;
  result: MatchPlayerResult | null;
  payoutKobo: number | null;
};

/** A space as one of its members (or someone previewing it by code) sees it. */
export type SpaceView = {
  id: string;
  code: string;
  name: string;
  hostId: string;
  gameSlug: string;
  gameName: string;
  mode: MatchMode;
  seatFeeKobo: number;
  /** All seat fees currently in the pot (fee x seated, 0 in Free). */
  potKobo: number;
  payoutScheme: SpacePayoutScheme;
  maxSeats: number;
  /** Fewest people the game can start with. */
  minSeats: number;
  visibility: SpaceVisibility;
  startRule: SpaceStartRule;
  /** Per-game options chosen by the host (empty = defaults). */
  options: SpaceOptions;
  /** Opened by quick match: two people who were matched, not a room anyone can join. */
  quickMatch: boolean;
  status: SpaceStatus;
  members: SpaceMember[];
  /** The current round's match (the room runs under this id). */
  matchId: string | null;
  /** You are seated. False for a preview by code. */
  seated: boolean;
  /** You are the host. */
  hosting: boolean;
  /** Set only when you used to sit here and no longer do (then `members` and `matchId` are empty). */
  exit?: SpaceExit | null;
  createdAt: string;
};

export type SpacesResponse = { spaces: SpaceView[] };

/** Where to open the live connection for a space that is running. */
export type SpaceConnection = {
  /** WebSocket endpoint of the game server (ws:// or wss://). */
  url: string;
  roomId: string;
  matchId: string;
};

// ---- live room protocol (game server <-> app) --------------------------------------------------

/** Close code the game server uses when a seat was taken over by a newer connection of the same person. */
export const LIVE_CLOSE_REPLACED = 4010;

/**
 * The seat's own messages to the room (Colyseus message names). The room validates everything with the engine.
 * - `move`: `expectedVersion` is required in turn games (Whot!, Crazy Cards) and ignored in party games,
 *   where several people act at once; `action` is the engine's action (see docs/PARTY_ROOM_PROTOCOL.md).
 * - `chat`: a line of text for the audience the game allows right now (party games only).
 * - `sync`: ask for the current state again. `leave`: forfeit the seat.
 */
export type LiveClientMessage =
  | {
      type: 'move';
      /** The state version the player was looking at (stale moves are refused in turn games). */
      expectedVersion?: number;
      action: unknown;
    }
  | { type: 'chat'; text: string }
  | { type: 'sync' }
  | { type: 'leave' };

/** What the room sends: `state` (LiveState), `error` (LiveError), `chat` (LiveChat) and `chat_history` (LiveChat[]). */
export type LiveChat = {
  id: number;
  userId: string;
  text: string;
  /** Server epoch ms. */
  at: number;
};

export const LIVE_CHAT_MAX_CHARS = 200;

export type LiveSeat = {
  userId: string;
  seat: number;
  connected: boolean;
  /** Left the game (or was away too long): out of the running, last place. */
  forfeited: boolean;
};

export type LiveResultRow = {
  userId: string;
  placement: number;
  result: MatchPlayerResult;
  payoutKobo: number | null;
};

/** Sent to every seat after every change (and on join / reconnect). `view` is that seat's own engine view. */
export type LiveState = {
  matchId: string;
  spaceId: string;
  gameSlug: string;
  mode: MatchMode;
  /** Bumps by one with every accepted move; send it back as `expectedVersion`. */
  version: number;
  status: 'live' | 'finished';
  view: unknown;
  seats: LiveSeat[];
  /** Turn games: whose clock is running. Always null in party games (it would give roles away). */
  turnUserId: string | null;
  /** Turn games: when the room moves for the player on turn. Party games: when the current phase ends (server epoch ms). */
  turnDeadlineAt: number | null;
  /** `turns` (one player acts: Whot!, Crazy Cards) or `party` (phases and timers, many act at once). */
  roomKind: 'turns' | 'party';
  /** You may act right now (your turn, or the engine is waiting for something from you). */
  canAct: boolean;
  /** Party games: clocks are stopped until every seat has connected (or the join grace forfeits the absent). */
  waiting: boolean;
  /** Server clock at send time, so the app can correct for a skewed device clock. */
  serverNow: number;
  /** Set once the match is finished and settled. */
  results: LiveResultRow[] | null;
};

export type LiveError = {
  code: string;
  /** The move that was refused, so the app can undo its prediction. */
  expectedVersion?: number;
};
