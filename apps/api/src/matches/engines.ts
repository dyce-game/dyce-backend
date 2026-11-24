import { readFileSync } from 'node:fs';
import {
  anagramsEngine,
  archeryEngine,
  ayoEngine,
  basketballEngine,
  checkersEngine,
  chessEngine,
  createWordTilesEngine,
  cupPongEngine,
  dartsEngine,
  dotsAndBoxesEngine,
  eightBallEngine,
  fillerEngine,
  ludoEngine,
  makeWordTilesWordSet,
  miniGolfEngine,
  pigEngine,
  seaBattleEngine,
  tanksEngine,
  wordHuntEngine,
  wordTilesWordSet,
  ANAGRAMS_ROUND_MS,
  WORD_HUNT_ROUND_MS,
  type GameEngine,
  type WordTilesWordSet,
} from '@dyce/games';
import type { GameOption, MatchOptions } from '@dyce/shared';
import { AuthError } from '../auth/auth-error.ts';

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
  /**
   * Variants a sender can pick when the game is sent (ADR-041). Each option's `key` is the engine `cfg` key it
   * sets; only the listed values are accepted, and the result must still initialise the engine.
   */
  options?: GameOption[];
};

/** What a game's cfg and variant label are for the options a sender chose. */
export type ResolvedOptions = {
  /** Only the options that were given and are valid, as stored on the match. */
  options: MatchOptions;
  /** The entry's cfg with the options laid over it. */
  cfg: unknown;
  /** "Mancala (Kalah)" for a non-default variant, else null. */
  variantLabel: string | null;
  /** False when a chosen variant is not offered for stakes (Darts: Around the clock). */
  poolOk: boolean;
};

/**
 * Checks the options a sender asked for against what the game offers and lays them over its cfg. Anything the
 * game does not offer, a value that is not one of its choices, or a result the engine cannot start with is
 * `invalid_options`. An option equal to its default is not stored, so "no option" and "the default" are the same
 * match (and a retried create with either spelling is the same create).
 */
export function resolveOptions(
  entry: EngineEntry,
  input: MatchOptions | undefined,
): ResolvedOptions {
  const spec = entry.options ?? [];
  const given = input ?? {};
  const options: MatchOptions = {};
  let label: string | null = null;
  let poolOk = true;
  for (const key of Object.keys(given)) {
    const opt = spec.find((o) => o.key === key);
    const choice = opt?.choices.find((c) => c.value === given[key]);
    if (!opt || !choice) throw new AuthError('invalid_options');
    if (choice.value === opt.default) continue;
    options[key] = choice.value;
    label = choice.label;
    if (!choice.pool) poolOk = false;
  }
  const cfg = { ...(entry.cfg as Record<string, unknown>), ...options };
  if (Object.keys(options).length > 0) {
    try {
      entry.engine.init(['a', 'b'], 1n, cfg);
    } catch {
      throw new AuthError('invalid_options');
    }
  }
  return { options, cfg, variantLabel: label, poolOk };
}

/** The label of the variant stored on a match, for cards (null for the default rules). */
export function variantLabelOf(entry: EngineEntry | null, options: MatchOptions): string | null {
  if (!entry) return null;
  for (const opt of entry.options ?? []) {
    const choice = opt.choices.find((c) => c.value === options[opt.key]);
    if (choice && choice.value !== opt.default) return choice.label;
  }
  return null;
}

/** Slack on top of the round for network time, as in the engine's `timers.turnMs`. */
export const WORD_HUNT_GRACE_MS = 10_000;
/** Same slack for Anagrams. */
export const ANAGRAMS_GRACE_MS = 10_000;

/** The two actions of a "press start, play a round, submit your words" game (Word Hunt, Anagrams). */
type RoundAction = { kind: 'start' } | { kind: 'submit'; words: string[] };

/**
 * A submit that arrives later than the round plus grace after the player's `start` scores nothing. Shared by
 * every game with a round clock; `graceMs` is per game.
 */
export function screenRoundClock(graceMs: number): (ctx: ScreenContext) => unknown {
  return ({ state, action, now, history }) => {
    const a = action as RoundAction;
    if (a.kind !== 'submit') return action;
    const started = history.find((h) => (h.action as RoundAction).kind === 'start');
    const roundMs = (state as { roundMs: number }).roundMs;
    if (started && now.getTime() - started.at.getTime() <= roundMs + graceMs) return action;
    return { kind: 'submit', words: [] };
  };
}

/**
 * The Word Tiles dictionary, loaded ONCE when the API starts and injected into the engine (ADR-031): the
 * engine never reads a global list. By default it is the in-repo list; point `WORD_TILES_WORDLIST_FILE` (one
 * word per line) and `WORD_TILES_WORDLIST_ID` (e.g. `enable-1`) at a bigger one. The id is copied into every
 * match's state, so a list change only affects new matches if the old id is kept registered while matches
 * using it are live (see docs/ADDING_A_GAME.md, "Word Tiles dictionary").
 */
export function loadWordTilesWordSet(
  env: Record<string, string | undefined> = process.env,
): WordTilesWordSet {
  const file = env.WORD_TILES_WORDLIST_FILE;
  const id = env.WORD_TILES_WORDLIST_ID;
  if (!file && !id) return wordTilesWordSet;
  if (!file || !id) {
    throw new Error('Set both WORD_TILES_WORDLIST_FILE and WORD_TILES_WORDLIST_ID, or neither');
  }
  const words = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((w) => w.trim().toUpperCase())
    .filter((w) => /^[A-Z]{2,15}$/.test(w));
  return makeWordTilesWordSet(words, id);
}

/** The Word Tiles registry entry for a given word set (the default one is built once, below). */
export function wordTilesEntry(wordSet: WordTilesWordSet): EngineEntry {
  return { engine: createWordTilesEngine(wordSet) as unknown as AnyEngine, cfg: {} };
}

const asEngine = (e: unknown): AnyEngine => e as AnyEngine;

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
    screenAction: screenRoundClock(WORD_HUNT_GRACE_MS),
  },
  'cup-pong': {
    engine: cupPongEngine as unknown as AnyEngine,
    // Three balls a turn, at most 12 rounds (the engine's own defaults, written down so a later change to
    // them can't alter matches already running: the config is captured in each match's state).
    cfg: { ballsPerTurn: 3, maxRounds: 12 },
  },

  // ---- Phase 4 (ADR-029 to ADR-035) ----------------------------------------------------------
  // Every game below also needs a `games` row (migration 0020) and stays hidden from `GET /games` until its
  // row is enabled, which happens when its board ships. Defaults of every engine's `cfg` are written out so
  // a later change to them can't alter matches already running.
  anagrams: {
    engine: asEngine(anagramsEngine),
    cfg: { roundMs: ANAGRAMS_ROUND_MS },
    screenAction: screenRoundClock(ANAGRAMS_GRACE_MS),
  },
  filler: { engine: asEngine(fillerEngine), cfg: { maxTurns: 100 } },
  'word-tiles': wordTilesEntry(loadWordTilesWordSet()),
  'mini-golf': { engine: asEngine(miniGolfEngine), cfg: {} },
  tanks: { engine: asEngine(tanksEngine), cfg: { maxShots: 12 } },
  chess: { engine: asEngine(chessEngine), cfg: {} },
  checkers: { engine: asEngine(checkersEngine), cfg: {} },
  // Ayo Olopon by default; "Mancala" (Kalah) is a variant of the same board (ADR-041).
  ayo: {
    engine: asEngine(ayoEngine),
    cfg: { variant: 'ayo' },
    options: [
      {
        key: 'variant',
        label: 'Rules',
        default: 'ayo',
        choices: [
          { value: 'ayo', label: 'Ayo', note: 'Ayo Olopon, the Nigerian rules', pool: true },
          { value: 'kalah', label: 'Mancala (Kalah)', note: 'Stores and extra turns', pool: true },
        ],
      },
    ],
  },
  'dots-and-boxes': { engine: asEngine(dotsAndBoxesEngine), cfg: { dots: 5 } },
  // Async Ludo is two players; the 3-4 player live room is a backlog item (needs its own slug).
  ludo: { engine: asEngine(ludoEngine), cfg: { tokens: 4 } },
  'sea-battle': {
    engine: asEngine(seaBattleEngine),
    cfg: { salvo: false },
    options: [
      {
        key: 'salvo',
        label: 'Rules',
        default: false,
        choices: [
          { value: false, label: 'Classic', note: 'One shot a turn', pool: true },
          { value: true, label: 'Salvo', note: 'One shot per ship you still have', pool: true },
        ],
      },
    ],
  },
  'eight-ball': { engine: asEngine(eightBallEngine), cfg: { maxShots: 120 } },
  darts: {
    engine: asEngine(dartsEngine),
    cfg: { variant: '501', maxRounds: 20, wobble: 60 },
    options: [
      {
        key: 'variant',
        label: 'Rules',
        default: '501',
        choices: [
          {
            value: '501',
            label: '501',
            note: 'Race down from 501, finish on a double',
            pool: true,
          },
          {
            value: 'clock',
            label: 'Around the clock',
            note: 'Hit 1 to 20, then the bull. Free only',
            pool: false,
          },
        ],
      },
    ],
  },
  basketball: { engine: asEngine(basketballEngine), cfg: { racks: 5, shotsPerRack: 5 } },
  archery: { engine: asEngine(archeryEngine), cfg: { ends: 3, arrowsPerEnd: 3 } },
};
