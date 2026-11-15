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
  maxSeats: z.number().int().min(2).max(8),
  visibility: spaceVisibilitySchema.default('friends'),
  startRule: spaceStartRuleSchema.default('host'),
});
export type CreateSpaceRequest = z.input<typeof createSpaceSchema>;

export const joinSpaceSchema = z.object({ code: spaceCodeSchema });
export type JoinSpaceRequest = z.input<typeof joinSpaceSchema>;

export const removeSpaceMemberSchema = z.object({ userId: z.uuid() });

export type SpaceStatus = 'waiting' | 'live' | 'ended' | 'closed';

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
  status: SpaceStatus;
  members: SpaceMember[];
  /** The current round's match (the room runs under this id). */
  matchId: string | null;
  /** You are seated. False for a preview by code. */
  seated: boolean;
  /** You are the host. */
  hosting: boolean;
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

/** The seat's own message to the room. The room validates everything with the engine. */
export type LiveClientMessage =
  | {
      type: 'move';
      /** The state version the player was looking at (stale moves are refused). */ expectedVersion: number;
      action: unknown;
    }
  | { type: 'leave' };

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
  /** Whose clock is running, and when (server epoch ms) the room will move for them. */
  turnUserId: string | null;
  turnDeadlineAt: number | null;
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
