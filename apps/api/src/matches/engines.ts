import {
  pigEngine,
  wordHuntEngine,
  WORD_HUNT_ROUND_MS,
  type GameEngine,
  type WordHuntAction,
  type WordHuntState,
} from '@dyce/games';

/** Engines are generic in their state and action; the match service only handles them as JSON. */
export type AnyEngine = GameEngine<unknown, unknown, unknown>;

/** What `screenAction` sees: the move about to be applied and the mover's own earlier moves. */
export type ScreenContext = {
  state: unknown;
  by: string;
  action: unknown;
  now: Date;
  history: { action: unknown; at: Date }[];
};

export type EngineEntry = {
  engine: AnyEngine;
  /** Config handed to `init` (captured in the match state, so later changes don't affect running matches). */
  cfg: unknown;
  /** Only offered and playable outside production (the reference engine). */
  devOnly?: boolean;
  /**
   * Server rules that need a clock, which engines don't have. Returns the action to apply (and store): a
   * move may be changed (e.g. a late Word Hunt submit loses its words) but never refused here.
   */
  screenAction?: (ctx: ScreenContext) => unknown;
};

/** Slack on top of the round for network time, as in the engine's `timers.turnMs`. */
export const WORD_HUNT_GRACE_MS = 10_000;

/** A Word Hunt submit that arrives later than the round plus grace after the player's `start` scores nothing. */
function screenWordHunt({ state, action, now, history }: ScreenContext): unknown {
  const a = action as WordHuntAction;
  if (a.kind !== 'submit') return action;
  const started = history.find((h) => (h.action as WordHuntAction).kind === 'start');
  const roundMs = (state as WordHuntState).roundMs;
  if (started && now.getTime() - started.at.getTime() <= roundMs + WORD_HUNT_GRACE_MS)
    return action;
  return { kind: 'submit', words: [] };
}

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
  'word-hunt': {
    engine: wordHuntEngine as unknown as AnyEngine,
    cfg: { roundMs: WORD_HUNT_ROUND_MS, minWords: 25 },
    screenAction: screenWordHunt,
  },
};
