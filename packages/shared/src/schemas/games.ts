import { z } from 'zod';
import type { AvatarConfig } from './avatar.ts';

export const matchIdParamSchema = z.uuid();

export const matchModeSchema = z.enum(['free', 'pool']);
export type MatchMode = z.infer<typeof matchModeSchema>;

/**
 * The app makes the match id (a UUID, also the id of its chat card), so a retry after a bad connection
 * can't send the same game twice.
 */
export const createMatchSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  gameSlug: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9_]+$/),
  mode: matchModeSchema.default('free'),
});
export type CreateMatchRequest = z.input<typeof createMatchSchema>;

/**
 * One move. `expectedVersion` is the `stateVersion` the player was looking at: the server rejects the move
 * (`stale_version`) if the match has moved on, and treats a repeat of an already-applied move as a success.
 */
export const submitMoveSchema = z.object({
  expectedVersion: z.number().int().min(0).max(1_000_000),
  action: z.record(z.string(), z.unknown()),
});
export type SubmitMoveRequest = z.infer<typeof submitMoveSchema>;

export type GameDimension = '2d' | '3d';

/** A game in the Games drawer. */
export type GameInfo = {
  slug: string;
  name: string;
  dimension: GameDimension;
  sync: 'async' | 'live';
  minPlayers: number;
  maxPlayers: number;
  categories: string[];
  supportsPool: boolean;
};

export type GamesResponse = { games: GameInfo[] };

export type MatchStatus =
  'invited' | 'countered' | 'active' | 'finished' | 'expired' | 'cancelled' | 'disputed';

export type MatchPlayerResult = 'win' | 'loss' | 'draw' | 'forfeit';

export type MatchPlayer = {
  userId: string;
  username: string;
  displayName: string;
  avatar: AvatarConfig | null;
  seat: number;
  /** The creator is in from the start; the invitee once they accept. */
  accepted: boolean;
  result: MatchPlayerResult | null;
  /** 1 = winner. */
  placement: number | null;
};

export type MatchOutcome = {
  /** Winners first-place players; empty on a draw. */
  winnerIds: string[];
  draw: boolean;
};

/**
 * A match as one of its players sees it. `view` is the game's `view()` for that player (hidden information
 * never leaves the server any other way) and is null until the match starts.
 */
export type MatchView = {
  id: string;
  gameSlug: string;
  gameName: string;
  mode: MatchMode;
  stakeKobo: number;
  status: MatchStatus;
  conversationId: string | null;
  createdBy: string;
  players: MatchPlayer[];
  /** Bumps by one with every accepted move; send it back as `expectedVersion`. */
  stateVersion: number;
  /** Whose move it is (null unless the match is active). */
  currentTurn: string | null;
  view: unknown;
  outcome: MatchOutcome | null;
  inviteExpiresAt: string | null;
  createdAt: string;
  finishedAt: string | null;
};

/** What a game card in a chat carries (the card text is in `body`, e.g. "Pig · Free"). Same for both players. */
export type GameCardPayload = {
  matchId: string;
  gameSlug: string;
  gameName: string;
  mode: MatchMode;
  status: MatchStatus;
  currentTurn: string | null;
  /** null until the match has finished. */
  winnerIds: string[] | null;
  draw: boolean;
  /** Orders card updates so a late one can't overwrite a newer one. */
  stateVersion: number;
};
