import { z } from 'zod';
import type { GameEngine, GameResult, PlayerId, ValidateResult } from '../contract.ts';
import { nextInt, seedRng, type RngState } from '../rng.ts';
import { sinCosCenti } from '../physics/angles.ts';

/**
 * Darts (2 players, async). Two variants (backend ADR-034):
 *  - `'501'`: count down from 501, three darts a turn, finish exactly on a DOUBLE (or the bull's eye, which
 *    counts as a double). A turn that would go below 0, leave 1, or reach 0 without a double is a BUST:
 *    the score goes back to what it was at the start of the turn and the turn ends.
 *  - `'clock'` ("Around the clock", the free variant): hit 1, 2, … 20, then the bull, in order. Any ring of
 *    the number counts. First to finish the bull wins.
 *
 * Input is only the aim point on the board (`x`, `y`, integers in 0.1 mm, y up, 0,0 = bull). The engine adds
 * a hand wobble from the seeded RNG (six draws per dart, always, so replays stay aligned), then reads the
 * board with integer arithmetic. Equal turns: if `players[0]` finishes, `players[1]` still throws that round;
 * both finished → fewer darts wins, equal → draw. `maxRounds` (default 20) ends the game: lower score left
 * (501) or fewer numbers left (clock) wins, equal is a draw.
 */
export type DartsVariant = '501' | 'clock';

export type DartsCfg = {
  variant?: DartsVariant;
  maxRounds?: number;
  /** Hand wobble in 0.1 mm per axis (sigma of the sum of three uniform draws). 0 = a perfect hand (tests). */
  wobble?: number;
};

export const DARTS_AIM_MAX = 2500;
export const DARTS_DEFAULT_WOBBLE = 60;
export const DARTS_DEFAULT_ROUNDS = 20;
export const DARTS_START_SCORE = 501;
export const DARTS_PER_TURN = 3;

/** Standard board order, clockwise from the top. */
export const DARTS_SECTORS: readonly number[] = [
  20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5,
];

// Ring edges in 0.1 mm (regulation board: 6.35, 15.9, 99, 107, 162, 170 mm).
const R_DBULL = 64;
const R_BULL = 159;
const R_TRIPLE_IN = 990;
const R_TRIPLE_OUT = 1070;
const R_DOUBLE_IN = 1620;
const R_DOUBLE_OUT = 1700;

export type DartsRing = 'dbull' | 'bull' | 'single' | 'double' | 'triple' | 'miss';

export type DartsDartRecord = {
  seq: number;
  by: PlayerId;
  /** What the player aimed at. */
  input: { x: number; y: number };
  /** Where the dart actually landed (input + wobble), 0.1 mm. */
  hit: { x: number; y: number };
  ring: DartsRing;
  /** 1–20, 25 for the outer bull, 50 for the inner bull (the bull's eye), 0 for a miss. */
  number: number;
  /** Points the dart is worth: number × ring multiplier (0 for a miss). */
  points: number;
  bust: boolean;
  /** This dart finished the game for its thrower. */
  finished: boolean;
};

export type DartsState = {
  players: [PlayerId, PlayerId];
  variant: DartsVariant;
  maxRounds: number;
  wobble: number;
  /** 501: points left to check out. clock: numbers left to hit (21 → 0; the next target is 22 − left, 21 = bull). */
  left: Record<PlayerId, number>;
  /** Value of `left` when the current turn began (a bust restores it). */
  turnStartLeft: Record<PlayerId, number>;
  thrown: Record<PlayerId, number>;
  /** Darts thrown when the player finished, or null. */
  finishedWith: Record<PlayerId, number | null>;
  turn: 0 | 1;
  round: number;
  dartsLeft: number;
  /** Darts of the turn in progress (cleared when a new turn starts). */
  turnDarts: DartsDartRecord[];
  over: boolean;
  winner: PlayerId | null;
  last: DartsDartRecord | null;
  seq: number;
  rng: RngState;
};

export type DartsAction = { kind: 'throw'; x: number; y: number };

const aimAxis = z.number().int().min(-DARTS_AIM_MAX).max(DARTS_AIM_MAX);
export const dartsActionSchema: z.ZodType<DartsAction> = z.object({
  kind: z.literal('throw'),
  x: aimAxis,
  y: aimAxis,
});

// ---------------------------------------------------------------------------------------------
// Board reading. Sector edges come from the deterministic trig helper; everything else is integers.

/** Unit vectors (x right, y up) of the 20 sector boundaries, clockwise from top; edge i is the START of sector i. */
const EDGES: readonly (readonly [number, number])[] = (() => {
  const out: [number, number][] = [];
  for (let i = 0; i < 20; i++) {
    // Angle clockwise from the top at the start edge of sector i: i × 18° − 9°. Centidegrees, CCW from +x.
    const clockwise = i * 1800 - 900;
    const [s, c] = sinCosCenti(9000 - clockwise);
    out.push([c, s]);
  }
  return out;
})();

const cross = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx;

/** Which sector index (0 = the 20) a point is in. Points on an edge belong to the sector clockwise of it. */
function sectorIndex(x: number, y: number): number {
  for (let i = 0; i < 20; i++) {
    const a = EDGES[i] as readonly [number, number];
    const b = EDGES[(i + 1) % 20] as readonly [number, number];
    if (cross(a[0], a[1], x, y) <= 0 && cross(b[0], b[1], x, y) > 0) return i;
  }
  return 0;
}

export type DartsReading = { ring: DartsRing; number: number; points: number };

/** Read the board at an integer point (0.1 mm). Pure. */
export function readDartboard(x: number, y: number): DartsReading {
  const d2 = x * x + y * y;
  if (d2 <= R_DBULL * R_DBULL) return { ring: 'dbull', number: 50, points: 50 };
  if (d2 <= R_BULL * R_BULL) return { ring: 'bull', number: 25, points: 25 };
  if (d2 > R_DOUBLE_OUT * R_DOUBLE_OUT) return { ring: 'miss', number: 0, points: 0 };
  const n = DARTS_SECTORS[sectorIndex(x, y)] as number;
  if (d2 > R_DOUBLE_IN * R_DOUBLE_IN) return { ring: 'double', number: n, points: 2 * n };
  if (d2 > R_TRIPLE_OUT * R_TRIPLE_OUT) return { ring: 'single', number: n, points: n };
  if (d2 > R_TRIPLE_IN * R_TRIPLE_IN) return { ring: 'triple', number: n, points: 3 * n };
  return { ring: 'single', number: n, points: n };
}

/** Centre of a segment in 0.1 mm, for tests, bots and the aim guide: ring 'single' | 'double' | 'triple'. */
export function dartsSegmentCentre(
  n: number,
  ring: 'single' | 'double' | 'triple' | 'bull' | 'dbull',
): { x: number; y: number } {
  if (ring === 'dbull') return { x: 0, y: 0 };
  if (ring === 'bull') return { x: 0, y: (R_DBULL + R_BULL) >> 1 };
  const idx = DARTS_SECTORS.indexOf(n);
  const clockwise = idx * 1800;
  const [s, c] = sinCosCenti(9000 - clockwise);
  const r =
    ring === 'double'
      ? (R_DOUBLE_IN + R_DOUBLE_OUT) >> 1
      : ring === 'triple'
        ? (R_TRIPLE_IN + R_TRIPLE_OUT) >> 1
        : (R_TRIPLE_OUT + R_DOUBLE_IN) >> 1;
  return { x: Math.round(c * r), y: Math.round(s * r) };
}

/** Does this dart count towards the next clock target? `left` is the number of targets left (21 = the 1). */
function clockHit(left: number, r: DartsReading): boolean {
  const target = 22 - left; // 1..21
  if (target === 21) return r.ring === 'bull' || r.ring === 'dbull';
  return r.number === target && r.ring !== 'miss' && r.ring !== 'bull' && r.ring !== 'dbull';
}

// ---------------------------------------------------------------------------------------------
// Engine

const other = (s: DartsState, p: PlayerId): PlayerId =>
  s.players[0] === p ? s.players[1] : s.players[0];

/** Three uniform draws in [-w, w] summed: a bell-ish wobble with sigma ≈ w. Always three draws. */
function wobble3(rng: RngState, w: number): [number, RngState] {
  let r = rng;
  let sum = 0;
  for (let i = 0; i < 3; i++) {
    const [v, n] = nextInt(r, 2 * w + 1);
    r = n;
    sum += v - w;
  }
  return [sum, r];
}

function settle(s: DartsState): DartsState {
  const [a, b] = s.players;
  const fa = s.finishedWith[a] ?? null;
  const fb = s.finishedWith[b] ?? null;
  let winner: PlayerId | null = null;
  if (fa !== null && fb !== null) winner = fa < fb ? a : fb < fa ? b : null;
  else if (fa !== null) winner = a;
  else if (fb !== null) winner = b;
  else if (s.left[a] !== s.left[b]) winner = (s.left[a] as number) < (s.left[b] as number) ? a : b;
  return { ...s, over: true, winner, dartsLeft: 0 };
}

export const dartsEngine: GameEngine<DartsState, DartsAction, DartsCfg> = {
  slug: 'darts',
  actionSchema: dartsActionSchema,
  timers: { turnMs: 60_000 },

  init(players, seed, cfg) {
    if (players.length !== 2) throw new Error('Darts is a two-player game');
    if (players[0] === players[1]) throw new Error('Duplicate players');
    const variant = cfg?.variant ?? '501';
    if (variant !== '501' && variant !== 'clock') throw new Error('Invalid variant');
    const maxRounds = cfg?.maxRounds ?? DARTS_DEFAULT_ROUNDS;
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 60) {
      throw new Error('Invalid maxRounds');
    }
    const wobble = cfg?.wobble ?? DARTS_DEFAULT_WOBBLE;
    if (!Number.isInteger(wobble) || wobble < 0 || wobble > 200) throw new Error('Invalid wobble');
    const [a, b] = players as [PlayerId, PlayerId];
    const start = variant === '501' ? DARTS_START_SCORE : 21;
    return {
      players: [a, b],
      variant,
      maxRounds,
      wobble,
      left: { [a]: start, [b]: start },
      turnStartLeft: { [a]: start, [b]: start },
      thrown: { [a]: 0, [b]: 0 },
      finishedWith: { [a]: null, [b]: null },
      turn: 0,
      round: 1,
      dartsLeft: DARTS_PER_TURN,
      turnDarts: [],
      over: false,
      winner: null,
      last: null,
      seq: 0,
      rng: seedRng(seed),
    };
  },

  currentPlayers(s) {
    return s.over ? [] : [s.players[s.turn]];
  },

  validate(s, by, a): ValidateResult {
    if (s.over) return { ok: false, code: 'game_over' };
    if (s.players[s.turn] !== by) return { ok: false, code: 'not_your_turn' };
    if (
      !Number.isInteger(a.x) ||
      !Number.isInteger(a.y) ||
      Math.abs(a.x) > DARTS_AIM_MAX ||
      Math.abs(a.y) > DARTS_AIM_MAX
    ) {
      return { ok: false, code: 'bad_aim' };
    }
    return { ok: true };
  },

  apply(s, by, a) {
    const next: DartsState = {
      ...s,
      left: { ...s.left },
      turnStartLeft: { ...s.turnStartLeft },
      thrown: { ...s.thrown },
      finishedWith: { ...s.finishedWith },
      seq: s.seq + 1,
    };

    // Hand wobble: six draws, always.
    const [wx, r1] = wobble3(s.rng, s.wobble);
    const [wy, rng] = wobble3(r1, s.wobble);
    next.rng = rng;
    const hit = { x: a.x + wx, y: a.y + wy };
    const read = readDartboard(hit.x, hit.y);

    next.thrown[by] = (s.thrown[by] ?? 0) + 1;
    let bust = false;
    let finished = false;
    let turnOver = false;
    const before = s.left[by] as number;

    if (s.variant === '501') {
      const after = before - read.points;
      const doubleOut = read.ring === 'double' || read.ring === 'dbull';
      if (after < 0 || after === 1 || (after === 0 && !doubleOut)) {
        bust = true;
        next.left[by] = s.turnStartLeft[by] as number;
        turnOver = true;
      } else {
        next.left[by] = after;
        if (after === 0) finished = true;
      }
    } else if (clockHit(before, read)) {
      next.left[by] = before - 1;
      if (before - 1 === 0) finished = true;
    }

    const record: DartsDartRecord = {
      seq: next.seq,
      by,
      input: { x: a.x, y: a.y },
      hit,
      ring: read.ring,
      number: read.number,
      points: read.points,
      bust,
      finished,
    };
    next.last = record;
    next.turnDarts = [...s.turnDarts, record];
    if (finished) next.finishedWith[by] = next.thrown[by] ?? 0;
    next.dartsLeft = s.dartsLeft - 1;
    if (next.dartsLeft <= 0 || finished) turnOver = true;
    if (!turnOver) return next;

    // The turn is over.
    if (s.turn === 1) {
      // End of a round: both players have had their turn.
      const anyFinished = next.finishedWith[s.players[0]] !== null || finished;
      if (anyFinished || s.round >= s.maxRounds) return settle(next);
      next.round = s.round + 1;
      next.turn = 0;
    } else {
      next.turn = 1;
    }
    next.turnStartLeft[other(s, by)] = next.left[other(s, by)] as number;
    next.dartsLeft = DARTS_PER_TURN;
    next.turnDarts = [];
    return next;
  },

  isTerminal(s) {
    return s.over;
  },

  result(s): GameResult {
    if (!s.over) return { placements: [], draw: false };
    if (s.winner === null) return { placements: [[s.players[0], s.players[1]]], draw: true };
    return { placements: [[s.winner], [other(s, s.winner)]], draw: false };
  },

  view(s) {
    // The whole board is public; only the RNG state (which sets the next wobble) is not.
    const { rng: _rng, ...visible } = s;
    return visible;
  },
};
