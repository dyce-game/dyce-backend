import { pigEngine, type GameEngine } from '@dyce/games';

/** Engines are generic in their state and action; the match service only handles them as JSON. */
export type AnyEngine = GameEngine<unknown, unknown, unknown>;

export type EngineEntry = {
  engine: AnyEngine;
  /** Config handed to `init` (captured in the match state, so later changes don't affect running matches). */
  cfg: unknown;
  /** Only offered and playable outside production (the reference engine). */
  devOnly?: boolean;
};

/**
 * The games the API can run, by slug. A game appears in the Games drawer once it has a row in `games`
 * (enabled) and an entry here. See docs/ADDING_A_GAME.md.
 */
export const ENGINES: Record<string, EngineEntry> = {
  _example: {
    engine: pigEngine as unknown as AnyEngine,
    cfg: { target: 50 },
    devOnly: true,
  },
};
