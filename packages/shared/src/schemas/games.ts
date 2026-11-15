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
    .regex(/^[a-z0-9_-]+$/), // engine slugs include hyphens: word-hunt, cup-pong
  mode: matchModeSchema.default('free'),
  /** Each player's stake in kobo. Required (and within the limits) for Pool; ignored for Free. */
  stakeKobo: z.number().int().min(0).max(1_000_000_000).default(0),
  /** Pool only: may the other person suggest a smaller stake (or play free) once? */
  allowCounter: z.boolean().default(true),
});
export type CreateMatchRequest = z.input<typeof createMatchSchema>;

/** The invitee's one counter-offer on a Pool invite: a smaller stake, or 0 to play it free. */
export const counterMatchSchema = z.object({
  stakeKobo: z.number().int().min(0).max(1_000_000_000),
});
export type CounterMatchRequest = z.infer<typeof counterMatchSchema>;

/** What the app needs to build the Pool stake picker and explain a refused stake. */
export type PoolInfo = {
  isAdult: boolean;
  /** False until the person has answered the age gate (it is asked once). */
  ageAnswered: boolean;
  minStakeKobo: number;
  maxStakeKobo: number;
  dailyStakeLimitKobo: number;
  stakedTodayKobo: number;
  dailyGamesLimit: number;
  gamesToday: number;
  /** Seconds until the daily Pool limits reset (midnight in Lagos). */
  resetsInSeconds: number;
};

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
  /** What this player has locked in the pot (0 in Free). */
  stakedKobo: number;
  /** What came back to them: the pot for a winner, their stake on a draw, decline or expiry. Null until then. */
  payoutKobo: number | null;
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
  /** Each player's stake (0 in Free). */
  stakeKobo: number;
  /** What the winner takes: both stakes (0 in Free). */
  potKobo: number;
  /** Pool: the invitee's counter-offer while the match is `countered` (0 = play free). */
  counterStakeKobo: number | null;
  allowCounter: boolean;
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
  /** Each player's stake and the pot (both 0 in Free). */
  stakeKobo: number;
  potKobo: number;
  /** The invitee's counter-offer while the match is `countered`. */
  counterStakeKobo: number | null;
  /** Pool: may the invitee counter? (Decides which buttons the card shows.) */
  allowCounter: boolean;
  status: MatchStatus;
  currentTurn: string | null;
  /** null until the match has finished. */
  winnerIds: string[] | null;
  draw: boolean;
  /** Orders card updates so a late one can't overwrite a newer one. */
  stateVersion: number;
};
