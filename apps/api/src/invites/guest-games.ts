import { WORD_HUNT_ROUND_MS, type WordHuntState } from '@dyce/games';

/** The engine ids a guest run uses inside the state and view: the guest, and the (absent) inviter. */
export const GUEST_ID = 'guest';
export const GUEST_HOST_ID = 'host';

/** A guest token stops working this long after it was issued. The round itself is far shorter. */
export const GUEST_RUN_TTL_MS = 60 * 60 * 1000;

/** What a game needs to be playable by a guest in a browser, beyond having an engine in `ENGINES`. */
export type GuestGame = {
  roundMs(cfg: unknown): number;
  /** The guest's score once their turn is over, else null. */
  score(state: unknown): number | null;
  /** The move that ends the guest's turn (so a repeat of it is acknowledged, not an error). */
  isFinalMove(action: unknown): boolean;
};

/** Games a guest may play without an account. Cup Pong joins when its renderer does (BACKLOG). */
export const GUEST_GAMES: Record<string, GuestGame> = {
  'word-hunt': {
    roundMs: (cfg) => (cfg as { roundMs?: number } | null)?.roundMs ?? WORD_HUNT_ROUND_MS,
    score: (state) => {
      const s = state as WordHuntState | null;
      return s?.status?.[GUEST_ID] === 'done' ? (s.scores[GUEST_ID] ?? 0) : null;
    },
    isFinalMove: (action) => (action as { kind?: string } | null)?.kind === 'submit',
  },
};
