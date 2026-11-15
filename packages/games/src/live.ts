import type { GameEngine, PlayerId } from './contract.ts';
import { whotAutoAction, whotEngine, type WhotAction, type WhotState } from './whot/engine.ts';

/**
 * Games that run in a live Space (a Colyseus room), as opposed to async chat matches. The API starts them
 * (it initialises the engine) and the game server runs them (it applies every move), so both read this one
 * list. Pure data + functions: no I/O, no clock.
 */
export type LiveGame = {
  slug: string;
  engine: GameEngine<unknown, unknown, unknown>;
  /** Config handed to `init` (stored in the state, so later changes don't affect running matches). */
  cfg: unknown;
  /** Seats the room supports (the `games` row carries the same numbers for the lobby). */
  minPlayers: number;
  maxPlayers: number;
  /** How long a player has to move before the room plays for them. */
  turnMs: number;
  /** A sensible move for a player who ran out of time or left; the room applies it for them. */
  autoAction(state: unknown, by: PlayerId): unknown;
};

export const LIVE_GAMES: Record<string, LiveGame> = {
  whot: {
    slug: 'whot',
    engine: whotEngine as unknown as GameEngine<unknown, unknown, unknown>,
    cfg: {},
    minPlayers: 2,
    maxPlayers: 4,
    turnMs: whotEngine.timers?.turnMs ?? 25_000,
    autoAction: (state, by) => whotAutoAction(state as WhotState, by) satisfies WhotAction,
  },
};

export const liveGame = (slug: string): LiveGame | null => LIVE_GAMES[slug] ?? null;
