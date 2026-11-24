import type { AvatarConfig } from './avatar.ts';

/**
 * A streak is the number of consecutive Lagos days with a win (SPEC section 9). It ends when a whole day goes by
 * without a win. The person then has 24 hours (to the next Lagos midnight) to win one Free game, which brings the
 * old length back: the streak saver (backend ADR-042). It is used once, then not offered again for a week.
 */
export type StreakLost = {
  /** How long the streak was when it ended. */
  length: number;
  /** The Lagos day it ended (the first day with no win), `YYYY-MM-DD`. */
  endedOn: string;
  /** Someone who beat them on that day, if anyone did ("Amaka broke it"); else null. */
  brokenBy: {
    id: string;
    username: string;
    displayName: string;
    avatar: AvatarConfig | null;
  } | null;
  /** A saver is on offer (still inside its 24 hours and not used lately). */
  saverAvailable: boolean;
  /** When the saver runs out (ISO time), or null when none is on offer. */
  saverExpiresAt: string | null;
  /** The person has already seen the "streak lost" screen for this loss. */
  seen: boolean;
};

export type StreakStatus = {
  current: number;
  best: number;
  /** Won a game today (Lagos time): the streak is safe until tomorrow. */
  wonToday: boolean;
  /** A streak that has ended and can still be told about or saved; null when there is nothing to show. */
  lost: StreakLost | null;
  /** The longest streak among their friends right now (not them), for the design's "Longest among your friends". */
  friendsBest: { username: string; displayName: string; length: number } | null;
};
