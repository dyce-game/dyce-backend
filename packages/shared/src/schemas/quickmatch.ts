import { z } from 'zod';
import type { AvatarConfig } from './avatar.ts';
import type { MatchMode } from './games.ts';

/**
 * Quick match (SPEC section 7): pick a game and a mode, get matched with a stranger of a similar level,
 * accept within 10 seconds, play in a live room. Strangers never get a chat out of this: they can see each
 * other's public profile and play, and anything either writes later goes to Requests (ADR-010).
 */
export const quickMatchStatusSchema = z.enum([
  'searching',
  'found',
  'playing',
  'cancelled',
  'expired',
  'declined',
  'missed',
  'failed',
]);
export type QuickMatchStatus = z.infer<typeof quickMatchStatusSchema>;

export const startQuickMatchSchema = z.object({
  gameSlug: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9_-]+$/),
  mode: z.enum(['free', 'pool']).default('free'),
  /** Pool only: what each of the two pays in kobo. Both must pick the same amount to be matched. */
  stakeKobo: z.number().int().min(0).max(1_000_000_000).default(0),
});
export type StartQuickMatchRequest = z.input<typeof startQuickMatchSchema>;

export const quickMatchIdParamSchema = z.uuid();

/** The stranger you were matched with: public profile fields only, never a phone number or contacts. */
export type QuickMatchOpponent = {
  userId: string;
  username: string;
  displayName: string;
  avatar: AvatarConfig | null;
  level: number;
  /** Wins as a share of finished games (0-100), null before their first finished game. */
  winRatePct: number | null;
  games: number;
};

export type QuickMatchTicket = {
  id: string;
  status: QuickMatchStatus;
  gameSlug: string;
  gameName: string;
  mode: MatchMode;
  stakeKobo: number;
  createdAt: string;
  /** The search gives up at this time. */
  searchEndsAt: string;
  /** While `found`: accept before this time (the app counts down the accept window from it). */
  acceptBy: string | null;
  /** You have accepted and are waiting for them. */
  accepted: boolean;
  opponent: QuickMatchOpponent | null;
  /** The live space, once both accepted (status `playing`). */
  spaceId: string | null;
  /** People searching for the same game right now (yourself included). */
  lookingCount: number;
  /** Why it failed (`insufficient_funds`, `over_pool_stake_limit`, ...). */
  errorCode: string | null;
};

export type QuickMatchGame = { slug: string; name: string; supportsPool: boolean };

export type QuickMatchState = {
  /** Your open ticket (searching or found), or the one that just ended; null when you never searched. */
  ticket: QuickMatchTicket | null;
  /** Games you can quick match. */
  games: QuickMatchGame[];
};
