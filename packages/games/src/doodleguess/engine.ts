import { z } from 'zod';
import type { GameEngine, GameResult, PlayerId, ValidateResult } from '../contract.ts';
import { seedRng, shuffle, type RngState } from '../rng.ts';
import {
  ROOM_ACTOR,
  assertPlayers,
  isCleanText,
  normaliseText,
  oneEditApart,
  placementsByScore,
  tickSchema,
  tidyText,
  type TickAction,
} from '../party/common.ts';
import { DEFAULT_PACK_IDS, WORD_PACKS_VERSION, packLabel, packWords } from '../party/words.ts';

/**
 * Doodle Guess (3–8 players, live, 2D). Rules decided here are in docs/DECISIONS.md (ADR-023).
 *
 * Every player draws once per round (`rounds`, default 3) in a seeded order. A turn: the drawer is offered
 * 3 words and picks one (`choose`, or the first when the timer runs out), then draws while everyone else
 * guesses. A correct guess scores `50 + floor(150 × timeLeft / drawMs)` (50–200, faster is more) and
 * the drawer earns half of that for each guesser who gets it. The turn ends when every guesser has it or
 * the clock runs out. A few letters of the word are revealed as time passes. Highest total wins; equal
 * totals share a placement (Pool: 50/30/20 or 60/40 by placement).
 *
 * Strokes are actions carrying a bounded list of points on a 0–1000 canvas (`stroke`, with `cont: true`
 * to extend the previous stroke so a long line can be streamed in chunks). The canvas is capped per turn.
 * Time is an explicit `tick` from the room.
 */
export type DoodlePhase = 'choose' | 'draw' | 'over';

export const DOODLE_COORD_MAX = 1000;
export const DOODLE_MAX_POINTS_PER_ACTION = 64;
export const DOODLE_MAX_STROKES = 300;
export const DOODLE_MAX_POINTS = 4000;
export const DOODLE_FEED_MAX = 30;

export type DoodleCfg = {
  rounds?: number;
  packs?: string[];
  chooseMs?: number;
  drawMs?: number;
};

export type DoodleStroke = { id: number; color: number; width: number; pts: [number, number][] };

export type DoodleFeedEntry =
  | { seq: number; kind: 'guess'; by: PlayerId; text: string }
  | { seq: number; kind: 'close'; by: PlayerId }
  | { seq: number; kind: 'correct'; by: PlayerId; points: number };

export type DoodleTurnSummary = { drawer: PlayerId; word: string; solvers: PlayerId[] };

export type DoodleState = {
  players: PlayerId[];
  /** Drawing order (a seeded shuffle); repeated each round. */
  order: PlayerId[];
  rounds: number;
  /** 0-based turn number across all rounds. */
  turn: number;
  phase: DoodlePhase;
  timeLeftMs: number;
  /** The 3 words offered to the drawer. Hidden. */
  choices: string[];
  /** The word being drawn. Hidden from guessers until solved or the turn ends. */
  word: string | null;
  /** Order letters are revealed in (indexes into `word`). Hidden. */
  revealOrder: number[];
  strokes: DoodleStroke[];
  points: number;
  nextStrokeId: number;
  /** Who has guessed this turn's word, in order. */
  solvers: PlayerId[];
  scores: Record<PlayerId, number>;
  feed: DoodleFeedEntry[];
  history: DoodleTurnSummary[];
  pool: string[];
  deck: string[];
  packLabel: string;
  packVersion: string;
  ms: { choose: number; draw: number };
  seq: number;
  rng: RngState;
};

export type DoodleAction =
  | { kind: 'choose'; index: number }
  | { kind: 'stroke'; points: [number, number][]; color: number; width: number; cont?: boolean }
  | { kind: 'undo' }
  | { kind: 'clear' }
  | { kind: 'guess'; text: string }
  | TickAction;

const coord = z.number().int().min(0).max(DOODLE_COORD_MAX);
export const doodleActionSchema: z.ZodType<DoodleAction> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('choose'), index: z.number().int().min(0).max(2) }),
  z.object({
    kind: z.literal('stroke'),
    points: z
      .array(z.tuple([coord, coord]))
      .min(1)
      .max(DOODLE_MAX_POINTS_PER_ACTION),
    color: z.number().int().min(0).max(15),
    width: z.number().int().min(1).max(8),
    cont: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('undo') }),
  z.object({ kind: z.literal('clear') }),
  z.object({ kind: z.literal('guess'), text: z.string().min(1).max(60) }),
  tickSchema,
]);

export const DOODLE_GUESS_MAX_CHARS = 40;

const drawerOf = (s: DoodleState): PlayerId | null =>
  s.phase === 'over' ? null : (s.order[s.turn % s.order.length] ?? null);

/** Points for a correct guess with `timeLeftMs` still on the clock. */
export function doodleGuessPoints(timeLeftMs: number, drawMs: number): number {
  const frac = Math.max(0, Math.min(1, timeLeftMs / drawMs));
  return 50 + Math.floor(150 * frac);
}

/** Letter positions of the word (everything but spaces and punctuation). */
const letterIdx = (word: string): number[] =>
  [...word].map((c, i) => (/[a-z0-9]/i.test(c) ? i : -1)).filter((i) => i >= 0);

/** How many letters are showing: up to a third of the word (max 3), spread evenly over the clock. */
export function doodleHintsShown(word: string, timeLeftMs: number, drawMs: number): number {
  const max = Math.min(3, Math.floor(letterIdx(word).length / 3));
  if (max === 0) return 0;
  const elapsed = Math.max(0, drawMs - timeLeftMs);
  return Math.min(max, Math.floor(elapsed / (drawMs / (max + 1))));
}

type Work = DoodleState;
const copy = (s: DoodleState): Work => ({
  ...s,
  order: [...s.order],
  choices: [...s.choices],
  revealOrder: [...s.revealOrder],
  strokes: [...s.strokes],
  solvers: [...s.solvers],
  scores: { ...s.scores },
  feed: [...s.feed],
  history: [...s.history],
  deck: [...s.deck],
  ms: { ...s.ms },
});

function pushFeed(w: Work, e: DoodleFeedEntry): void {
  w.feed.push(e);
  if (w.feed.length > DOODLE_FEED_MAX) w.feed.splice(0, w.feed.length - DOODLE_FEED_MAX);
}

/** Offer the drawer 3 distinct words, refilling the deck from the pool when it runs short. */
function startChoose(w: Work): void {
  w.choices = [];
  while (w.choices.length < 3) {
    if (w.deck.length === 0) {
      const [d, rng] = shuffle(w.rng, w.pool);
      w.deck = d;
      w.rng = rng;
    }
    const next = w.deck.shift() as string;
    if (!w.choices.includes(next)) w.choices.push(next);
  }
  w.phase = 'choose';
  w.timeLeftMs = w.ms.choose;
  w.word = null;
  w.revealOrder = [];
  w.strokes = [];
  w.points = 0;
  w.solvers = [];
  w.feed = [];
}

function pickWord(w: Work, index: number): void {
  const word = w.choices[index] as string;
  const [order, rng] = shuffle(w.rng, letterIdx(word));
  w.rng = rng;
  w.word = word;
  w.revealOrder = order;
  w.choices = [];
  w.phase = 'draw';
  w.timeLeftMs = w.ms.draw;
}

function endTurn(w: Work): void {
  w.history.push({
    drawer: drawerOf(w) as PlayerId,
    word: w.word as string,
    solvers: [...w.solvers],
  });
  w.turn += 1;
  w.strokes = [];
  w.points = 0;
  if (w.turn >= w.order.length * w.rounds) {
    w.phase = 'over';
    w.timeLeftMs = 0;
    w.word = null;
    w.revealOrder = [];
    w.choices = [];
  } else startChoose(w);
}

export const doodleGuessEngine: GameEngine<DoodleState, DoodleAction, DoodleCfg> = {
  slug: 'doodle-guess',
  actionSchema: doodleActionSchema,
  timers: { turnMs: 80_000, matchMs: 1_800_000 },

  init(players, seed, cfg) {
    assertPlayers(players, 3, 8);
    const rounds = cfg?.rounds ?? 3;
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5)
      throw new Error('rounds must be 1 to 5');
    const packs = cfg?.packs ?? [...DEFAULT_PACK_IDS];
    const pool = packWords(packs);
    if (pool.length < 10) throw new Error('Doodle Guess needs at least 10 words');
    const [order, r1] = shuffle(seedRng(seed), players);
    const [deck, rng] = shuffle(r1, pool);
    const ms = { choose: cfg?.chooseMs ?? 10_000, draw: cfg?.drawMs ?? 80_000 };
    const w: Work = {
      players: [...players],
      order,
      rounds,
      turn: 0,
      phase: 'choose',
      timeLeftMs: ms.choose,
      choices: [],
      word: null,
      revealOrder: [],
      strokes: [],
      points: 0,
      nextStrokeId: 1,
      solvers: [],
      scores: Object.fromEntries(players.map((p) => [p, 0])),
      feed: [],
      history: [],
      pool,
      deck,
      packLabel: packLabel(packs),
      packVersion: WORD_PACKS_VERSION,
      ms,
      seq: 0,
      rng,
    };
    startChoose(w);
    return w;
  },

  currentPlayers(s) {
    if (s.phase === 'over') return [];
    const d = drawerOf(s) as PlayerId;
    if (s.phase === 'choose') return [d];
    return [d, ...s.players.filter((p) => p !== d && !s.solvers.includes(p))];
  },

  validate(s, by, a): ValidateResult {
    if (s.phase === 'over') return { ok: false, code: 'game_over' };
    if (a.kind === 'tick')
      return by === ROOM_ACTOR ? { ok: true } : { ok: false, code: 'room_only' };
    if (!s.players.includes(by)) return { ok: false, code: 'not_a_player' };
    const drawer = drawerOf(s);

    switch (a.kind) {
      case 'choose':
        if (s.phase !== 'choose') return { ok: false, code: 'wrong_phase' };
        return drawer === by ? { ok: true } : { ok: false, code: 'not_the_drawer' };
      case 'stroke':
      case 'undo':
      case 'clear': {
        if (s.phase !== 'draw') return { ok: false, code: 'wrong_phase' };
        if (drawer !== by) return { ok: false, code: 'not_the_drawer' };
        if (a.kind === 'undo' || a.kind === 'clear') {
          return s.strokes.length > 0 ? { ok: true } : { ok: false, code: 'nothing_to_remove' };
        }
        if (a.cont === true && s.strokes.length === 0)
          return { ok: false, code: 'no_stroke_to_continue' };
        if (a.cont !== true && s.strokes.length >= DOODLE_MAX_STROKES)
          return { ok: false, code: 'canvas_full' };
        if (s.points + a.points.length > DOODLE_MAX_POINTS)
          return { ok: false, code: 'canvas_full' };
        return { ok: true };
      }
      case 'guess': {
        if (s.phase !== 'draw') return { ok: false, code: 'wrong_phase' };
        if (drawer === by) return { ok: false, code: 'drawer_cannot_guess' };
        if (s.solvers.includes(by)) return { ok: false, code: 'already_guessed' };
        const text = tidyText(a.text);
        if (text.length === 0 || text.length > DOODLE_GUESS_MAX_CHARS)
          return { ok: false, code: 'invalid_guess' };
        if (!isCleanText(text)) return { ok: false, code: 'not_allowed' };
        return { ok: true };
      }
    }
  },

  apply(s, by, a) {
    const w = copy(s);
    w.seq = s.seq + 1;

    if (a.kind === 'tick') {
      w.timeLeftMs -= a.ms;
      if (w.timeLeftMs <= 0) {
        if (w.phase === 'choose') pickWord(w, 0);
        else endTurn(w);
      }
      return w;
    }
    if (a.kind === 'choose') {
      pickWord(w, a.index);
      return w;
    }
    if (a.kind === 'stroke') {
      const pts = a.points.map((p): [number, number] => [p[0], p[1]]);
      const last = w.strokes[w.strokes.length - 1];
      if (a.cont === true && last) {
        w.strokes[w.strokes.length - 1] = { ...last, pts: [...last.pts, ...pts] };
      } else {
        w.strokes.push({ id: w.nextStrokeId, color: a.color, width: a.width, pts });
        w.nextStrokeId += 1;
      }
      w.points += pts.length;
      return w;
    }
    if (a.kind === 'undo') {
      const gone = w.strokes.pop();
      w.points -= gone?.pts.length ?? 0;
      return w;
    }
    if (a.kind === 'clear') {
      w.strokes = [];
      w.points = 0;
      return w;
    }

    // guess
    const text = tidyText(a.text);
    const word = w.word as string;
    const g = normaliseText(text);
    const target = normaliseText(word);
    if (g === target) {
      const pts = doodleGuessPoints(w.timeLeftMs, w.ms.draw);
      const drawer = drawerOf(w) as PlayerId;
      w.scores[by] = (w.scores[by] ?? 0) + pts;
      w.scores[drawer] = (w.scores[drawer] ?? 0) + Math.floor(pts / 2);
      w.solvers.push(by);
      pushFeed(w, { seq: w.seq, kind: 'correct', by, points: pts });
      if (w.players.every((p) => p === drawer || w.solvers.includes(p))) endTurn(w);
    } else if (target.length >= 4 && oneEditApart(g, target)) {
      pushFeed(w, { seq: w.seq, kind: 'close', by });
    } else {
      pushFeed(w, { seq: w.seq, kind: 'guess', by, text });
    }
    return w;
  },

  isTerminal(s) {
    return s.phase === 'over';
  },

  result(s): GameResult {
    if (s.phase !== 'over') return { placements: [], draw: false };
    return placementsByScore(s.players, (p) => s.scores[p] ?? 0);
  },

  view(s, viewer) {
    const drawer = drawerOf(s);
    const isPlayer = viewer !== 'spectator' && s.players.includes(viewer);
    const isDrawer = isPlayer && viewer === drawer;
    const solved = isPlayer && s.solvers.includes(viewer);
    const word = s.word;
    const knows = word !== null && (isDrawer || solved);
    const shown = word === null ? 0 : doodleHintsShown(word, s.timeLeftMs, s.ms.draw);
    const revealed = new Set(s.revealOrder.slice(0, shown));
    /** One entry per character: the letter if you may see it, null for a hidden letter, ' ' for a space. */
    const mask =
      word === null
        ? null
        : [...word].map((c, i) => (!/[a-z0-9]/i.test(c) ? c : knows || revealed.has(i) ? c : null));
    return {
      players: s.players,
      phase: s.phase,
      timeLeftMs: s.timeLeftMs,
      turn: s.turn,
      turns: s.order.length * s.rounds,
      round: s.phase === 'over' ? s.rounds : Math.floor(s.turn / s.order.length) + 1,
      rounds: s.rounds,
      drawer,
      packLabel: s.packLabel,
      /** The 3 offered words: only for the drawer while choosing. */
      choices: isDrawer && s.phase === 'choose' ? s.choices : [],
      /** The full word: only for the drawer and players who already guessed it. */
      word: knows ? word : null,
      mask,
      strokes: s.strokes,
      solvers: s.solvers,
      scores: s.scores,
      feed: s.feed,
      /** Words of finished turns (public once the turn is over). */
      history: s.history,
      seq: s.seq,
    };
  },
};
