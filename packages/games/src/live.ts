import type { GameEngine, PlayerId } from './contract.ts';
import { whotAutoAction, whotEngine, type WhotAction, type WhotState } from './whot/engine.ts';
import {
  crazyCardsAutoAction,
  crazyCardsEngine,
  type CrazyCardsAction,
  type CrazyCardsState,
} from './crazycards/engine.ts';
import { ludoAutoAction, ludoEngine, type LudoState } from './ludo/engine.ts';
import { imposterEngine } from './imposter/engine.ts';
import { werewolfEngine } from './werewolf/engine.ts';
import { charadesEngine } from './charades/engine.ts';
import { doodleGuessEngine } from './doodleguess/engine.ts';
import {
  chatAudienceFor,
  clampInt,
  diffCanvas,
  splitDoodleView,
  type CanvasCursor,
  type PartyChatFn,
  type PartyBlockersFn,
} from './party/live-adapters.ts';

/**
 * Games that run in a live Space (a Colyseus room), as opposed to async chat matches. The API starts them
 * (it initialises the engine) and the game server runs them (it applies every move), so both read this one
 * list. Pure data + functions: no I/O, no clock.
 *
 * Two kinds of room (ADR-025):
 *  - `turns` (Whot!, Crazy Cards, the Ludo room): one player acts at a time, the room keeps a turn clock and plays for a
 *    seat that runs out of time or left (`autoAction`).
 *  - `party` (Imposter, Werewolf, Charades, Doodle Guess): phases with timers, several players acting at
 *    once. The room sends the engine `tick` actions as real time passes; nobody is auto-played, a seat
 *    that left simply stops acting and the phase timers do the rest.
 */
export type LiveOptions = Record<string, string | number | boolean>;
export type LivePayoutScheme = 'winner_all' | 'p60_40' | 'p50_30_20';

type LiveBase = {
  slug: string;
  engine: GameEngine<unknown, unknown, unknown>;
  /** Config handed to `init` (stored in the state, so later changes don't affect running matches). */
  cfg: unknown;
  /** Seats the room supports (the `games` row carries the same numbers for the lobby). */
  minPlayers: number;
  maxPlayers: number;
  /** How long a player has to move before the room plays for them (turns) / the engine's headline timer. */
  turnMs: number;
  /** Pool payout schemes the host may pick. Side games pay the winning side equally: winner takes all only. */
  payoutSchemes: readonly LivePayoutScheme[];
  /** True when two strangers can be matched into it (1 v 1). */
  quickMatch: boolean;
  /** The per-game options a host may set when creating a space (empty = none). Values already typed. */
  optionsValid(options: LiveOptions): boolean;
  /** The engine config for these options and this many seated players. Only called with valid options. */
  buildCfg(options: LiveOptions, seated: number): unknown;
};

export type TurnGame = LiveBase & {
  kind: 'turns';
  /** A sensible move for a player who ran out of time or left; the room applies it for them. */
  autoAction(state: unknown, by: PlayerId): unknown;
};

/**
 * A part of a party view that is large and grows (the Doodle canvas). The room takes it out of `state` and
 * sends it as its own `canvas` messages, only what each seat is missing.
 */
export type PartyStream = {
  split(view: unknown): { rest: unknown; stream: unknown };
  diff(cursor: unknown | null, stream: unknown): { msg: unknown | null; cursor: unknown };
};

export type PartyGame = LiveBase & {
  kind: 'party';
  /** Real time between engine ticks, in ms. */
  tickMs: number;
  /** Present when the view has a growing part that travels as deltas instead of inside every `state`. */
  stream?: PartyStream;
  /** Actions that arrive in streams (strokes): persisted and broadcast in batches, not one by one. */
  streamy(action: unknown): boolean;
  /** Seats the phase clock is waiting for. When all of them are gone the room skips ahead. */
  blockers: PartyBlockersFn;
  /** Who hears a chat line from `from` right now (null: chat is closed to them). Includes the sender. */
  chatAudience: PartyChatFn;
};

export type LiveGame = TurnGame | PartyGame;

const noOptions = (o: LiveOptions): boolean => Object.keys(o).length === 0;
const asEngine = <S, A, C>(e: GameEngine<S, A, C>): GameEngine<unknown, unknown, unknown> =>
  e as unknown as GameEngine<unknown, unknown, unknown>;

const ALL_SCHEMES: readonly LivePayoutScheme[] = ['winner_all', 'p60_40', 'p50_30_20'];
const WINNER_ONLY: readonly LivePayoutScheme[] = ['winner_all'];

const optionKeys = (o: LiveOptions, allowed: readonly string[]): boolean =>
  Object.keys(o).every((k) => allowed.includes(k));
const intIn = (v: unknown, lo: number, hi: number): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

export const LIVE_GAMES: Record<string, LiveGame> = {
  whot: {
    kind: 'turns',
    slug: 'whot',
    engine: asEngine(whotEngine),
    cfg: {},
    minPlayers: 2,
    maxPlayers: 4,
    turnMs: whotEngine.timers?.turnMs ?? 25_000,
    payoutSchemes: ALL_SCHEMES,
    quickMatch: true,
    optionsValid: noOptions,
    buildCfg: () => ({}),
    autoAction: (state, by) => whotAutoAction(state as WhotState, by) satisfies WhotAction,
  },
  'crazy-cards': {
    kind: 'turns',
    slug: 'crazy-cards',
    engine: asEngine(crazyCardsEngine),
    cfg: {},
    minPlayers: 2,
    maxPlayers: 4,
    turnMs: crazyCardsEngine.timers?.turnMs ?? 25_000,
    payoutSchemes: ALL_SCHEMES,
    quickMatch: true,
    optionsValid: noOptions,
    buildCfg: () => ({}),
    autoAction: (state, by) =>
      crazyCardsAutoAction(state as CrazyCardsState, by) satisfies CrazyCardsAction,
  },
  // Ludo for 3 or 4 at a table (the 2-player game is the async `ludo` match in a chat). One engine, one extra slug,
  // because `games.sync` is per slug. A turn is two actions (roll, then move a token), each on the 25 s clock; a seat
  // that runs out of time or leaves is played with `ludoAutoAction`. The first home wins and the rest rank by progress.
  'ludo-room': {
    kind: 'turns',
    slug: 'ludo-room',
    engine: asEngine(ludoEngine),
    cfg: { tokens: 4 },
    minPlayers: 3,
    maxPlayers: 4,
    turnMs: 25_000,
    payoutSchemes: ALL_SCHEMES,
    quickMatch: false,
    optionsValid: noOptions,
    buildCfg: () => ({ tokens: 4 }),
    autoAction: (state, by) => ludoAutoAction(state as LudoState, by),
  },
  imposter: {
    kind: 'party',
    slug: 'imposter',
    engine: asEngine(imposterEngine),
    cfg: {},
    minPlayers: 4,
    maxPlayers: 10,
    turnMs: imposterEngine.timers?.turnMs ?? 20_000,
    payoutSchemes: WINNER_ONLY,
    quickMatch: false,
    tickMs: 1000,
    optionsValid: (o) =>
      optionKeys(o, ['clueRounds', 'imposters']) &&
      (o.clueRounds === undefined || intIn(o.clueRounds, 1, 3)) &&
      (o.imposters === undefined || intIn(o.imposters, 1, 2)),
    buildCfg: (o, seated) => {
      const imposters = typeof o.imposters === 'number' ? o.imposters : undefined;
      return {
        ...(typeof o.clueRounds === 'number' ? { clueRounds: o.clueRounds } : {}),
        // Never half the table: a host who asked for 2 imposters and then started with 4 gets 1.
        ...(imposters !== undefined && imposters * 2 < seated ? { imposters } : {}),
      };
    },
    streamy: () => false,
    blockers: (s) => imposterEngine.currentPlayers(s as never),
    chatAudience: (s, from) => chatAudienceFor('imposter', s, from),
  },
  werewolf: {
    kind: 'party',
    slug: 'werewolf',
    engine: asEngine(werewolfEngine),
    cfg: {},
    minPlayers: 5,
    maxPlayers: 12,
    turnMs: werewolfEngine.timers?.turnMs ?? 30_000,
    payoutSchemes: WINNER_ONLY,
    quickMatch: false,
    tickMs: 1000,
    optionsValid: noOptions,
    buildCfg: () => ({}),
    streamy: () => false,
    blockers: (s) => werewolfEngine.currentPlayers(s as never),
    chatAudience: (s, from) => chatAudienceFor('werewolf', s, from),
  },
  charades: {
    kind: 'party',
    slug: 'charades',
    engine: asEngine(charadesEngine),
    cfg: {},
    minPlayers: 3,
    maxPlayers: 10,
    turnMs: charadesEngine.timers?.turnMs ?? 60_000,
    payoutSchemes: ALL_SCHEMES,
    quickMatch: false,
    tickMs: 1000,
    optionsValid: (o) =>
      optionKeys(o, ['mode', 'rounds']) &&
      (o.mode === undefined || o.mode === 'act' || o.mode === 'headsup') &&
      (o.rounds === undefined || intIn(o.rounds, 1, 5)),
    buildCfg: (o) => ({
      ...(o.mode === 'act' || o.mode === 'headsup' ? { mode: o.mode } : {}),
      ...(typeof o.rounds === 'number' ? { rounds: clampInt(o.rounds, 1, 5) } : {}),
    }),
    streamy: () => false,
    blockers: (s) => charadesEngine.currentPlayers(s as never),
    chatAudience: (s, from) => chatAudienceFor('charades', s, from),
  },
  'doodle-guess': {
    kind: 'party',
    slug: 'doodle-guess',
    engine: asEngine(doodleGuessEngine),
    cfg: {},
    minPlayers: 3,
    maxPlayers: 8,
    turnMs: doodleGuessEngine.timers?.turnMs ?? 80_000,
    payoutSchemes: ALL_SCHEMES,
    quickMatch: false,
    tickMs: 1000,
    optionsValid: (o) =>
      optionKeys(o, ['rounds']) && (o.rounds === undefined || intIn(o.rounds, 1, 5)),
    buildCfg: (o) => (typeof o.rounds === 'number' ? { rounds: clampInt(o.rounds, 1, 5) } : {}),
    streamy: (a) => {
      const k = (a as { kind?: unknown } | null)?.kind;
      return k === 'stroke' || k === 'undo' || k === 'clear';
    },
    // Only the drawer holds the clock back: guessers who left cannot stall a round.
    blockers: (s) => {
      const st = s as { phase: string; order: PlayerId[]; turn: number };
      if (st.phase === 'over') return [];
      const d = st.order[st.turn % st.order.length];
      return d === undefined ? [] : [d];
    },
    chatAudience: () => null,
    stream: {
      split: (view) => splitDoodleView(view),
      diff: (cursor, stream) =>
        diffCanvas(cursor as CanvasCursor | null, stream as Parameters<typeof diffCanvas>[1]),
    },
  },
};

export const liveGame = (slug: string): LiveGame | null => LIVE_GAMES[slug] ?? null;
