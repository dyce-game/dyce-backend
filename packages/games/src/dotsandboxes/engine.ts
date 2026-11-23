import { z } from 'zod';
import type { GameEngine, GameResult, PlayerId, ValidateResult } from '../contract.ts';

/**
 * Dots & Boxes (ADR-035). A grid of `dots` x `dots` points (5 x 5 by default, so 4 x 4 = 16 boxes).
 * On your turn you draw one line between two neighbouring dots. Closing the fourth side of a box
 * claims it and you **move again**; otherwise the turn passes. When every box is claimed the player
 * with more boxes wins (an equal split is a draw). Perfect information, no randomness.
 *
 * Lines: horizontal line `h(r, c)` joins dot (r, c) to (r, c+1), `r` in 0..dots-1, `c` in 0..dots-2.
 * Vertical line `v(r, c)` joins dot (r, c) to (r+1, c), `r` in 0..dots-2, `c` in 0..dots-1.
 * Box (r, c) has top h(r, c), bottom h(r+1, c), left v(r, c) and right v(r, c+1).
 */
export type DotsAndBoxesCfg = { dots?: number };

export const DOTS_DEFAULT = 5;
export const DOTS_MIN = 3;
export const DOTS_MAX = 8;

export type DotsAndBoxesState = {
  players: PlayerId[];
  dots: number;
  /** Horizontal lines, row-major (`dots` rows of `dots - 1`): the index of the player who drew it, or -1. */
  h: number[];
  /** Vertical lines, row-major (`dots - 1` rows of `dots`): drawn-by index or -1. */
  v: number[];
  /** Boxes, row-major (`dots - 1` x `dots - 1`): owner index or -1. */
  boxes: number[];
  turn: 0 | 1;
  scores: number[];
  winner: PlayerId | null;
  draw: boolean;
  endReason: 'complete' | 'resign' | null;
  /** The last line drawn and the boxes it closed, for animation. */
  last: { by: PlayerId; dir: 'h' | 'v'; r: number; c: number; boxes: number[] } | null;
  seq: number;
};

export type DotsAndBoxesAction =
  { kind: 'line'; dir: 'h' | 'v'; r: number; c: number } | { kind: 'resign' };

export const dotsAndBoxesActionSchema: z.ZodType<DotsAndBoxesAction> = z.discriminatedUnion(
  'kind',
  [
    z.object({
      kind: z.literal('line'),
      dir: z.enum(['h', 'v']),
      r: z.number().int().min(0).max(DOTS_MAX),
      c: z.number().int().min(0).max(DOTS_MAX),
    }),
    z.object({ kind: z.literal('resign') }),
  ],
);

/** Number of boxes along one side. */
const side = (dots: number): number => dots - 1;

const hIndex = (dots: number, r: number, c: number): number => r * (dots - 1) + c;
const vIndex = (dots: number, r: number, c: number): number => r * dots + c;

/** Is (dir, r, c) a line on this board? */
export function dotsLineExists(dots: number, dir: 'h' | 'v', r: number, c: number): boolean {
  if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0) return false;
  return dir === 'h' ? r < dots && c < dots - 1 : r < dots - 1 && c < dots;
}

function lineOwner(s: DotsAndBoxesState, dir: 'h' | 'v', r: number, c: number): number {
  return dir === 'h' ? s.h[hIndex(s.dots, r, c)]! : s.v[vIndex(s.dots, r, c)]!;
}

function boxClosed(s: DotsAndBoxesState, r: number, c: number): boolean {
  return (
    s.h[hIndex(s.dots, r, c)]! >= 0 &&
    s.h[hIndex(s.dots, r + 1, c)]! >= 0 &&
    s.v[vIndex(s.dots, r, c)]! >= 0 &&
    s.v[vIndex(s.dots, r, c + 1)]! >= 0
  );
}

/** Every line still to be drawn. */
export function dotsOpenLines(s: DotsAndBoxesState): { dir: 'h' | 'v'; r: number; c: number }[] {
  const out: { dir: 'h' | 'v'; r: number; c: number }[] = [];
  for (let r = 0; r < s.dots; r++) {
    for (let c = 0; c < s.dots - 1; c++)
      if (lineOwner(s, 'h', r, c) < 0) out.push({ dir: 'h', r, c });
  }
  for (let r = 0; r < s.dots - 1; r++) {
    for (let c = 0; c < s.dots; c++) if (lineOwner(s, 'v', r, c) < 0) out.push({ dir: 'v', r, c });
  }
  return out;
}

export const dotsAndBoxesEngine: GameEngine<
  DotsAndBoxesState,
  DotsAndBoxesAction,
  DotsAndBoxesCfg
> = {
  slug: 'dots-and-boxes',
  actionSchema: dotsAndBoxesActionSchema,
  timers: { turnMs: 24 * 60 * 60 * 1000 },

  init(players, _seed, cfg) {
    if (players.length !== 2) throw new Error('Dots & Boxes needs exactly 2 players');
    if (players[0] === players[1]) throw new Error('Duplicate players');
    const dots = cfg.dots ?? DOTS_DEFAULT;
    if (!Number.isInteger(dots) || dots < DOTS_MIN || dots > DOTS_MAX) {
      throw new Error(`dots must be an integer in ${DOTS_MIN}..${DOTS_MAX}`);
    }
    return {
      players: [...players],
      dots,
      h: new Array<number>(dots * (dots - 1)).fill(-1),
      v: new Array<number>((dots - 1) * dots).fill(-1),
      boxes: new Array<number>(side(dots) * side(dots)).fill(-1),
      turn: 0,
      scores: [0, 0],
      winner: null,
      draw: false,
      endReason: null,
      last: null,
      seq: 0,
    };
  },

  currentPlayers(s) {
    if (s.winner !== null || s.draw) return [];
    return [s.players[s.turn]!];
  },

  validate(s, by, a): ValidateResult {
    if (s.winner !== null || s.draw) return { ok: false, code: 'game_over' };
    if (!s.players.includes(by)) return { ok: false, code: 'not_a_player' };
    if (a.kind === 'resign') return { ok: true };
    if (s.players[s.turn] !== by) return { ok: false, code: 'not_your_turn' };
    if (!dotsLineExists(s.dots, a.dir, a.r, a.c)) return { ok: false, code: 'no_such_line' };
    if (lineOwner(s, a.dir, a.r, a.c) >= 0) return { ok: false, code: 'line_taken' };
    return { ok: true };
  },

  apply(s, by, a) {
    if (a.kind === 'resign') {
      const other = s.players.find((p) => p !== by)!;
      return { ...s, winner: other, endReason: 'resign', seq: s.seq + 1 };
    }
    const me = s.turn;
    const next: DotsAndBoxesState = {
      ...s,
      h: s.h.slice(),
      v: s.v.slice(),
      boxes: s.boxes.slice(),
      scores: s.scores.slice(),
      seq: s.seq + 1,
    };
    if (a.dir === 'h') next.h[hIndex(s.dots, a.r, a.c)] = me;
    else next.v[vIndex(s.dots, a.r, a.c)] = me;

    // The (at most two) boxes this line touches.
    const touching: [number, number][] =
      a.dir === 'h'
        ? [
            [a.r - 1, a.c],
            [a.r, a.c],
          ]
        : [
            [a.r, a.c - 1],
            [a.r, a.c],
          ];
    const closed: number[] = [];
    for (const [br, bc] of touching) {
      if (br < 0 || bc < 0 || br >= side(s.dots) || bc >= side(s.dots)) continue;
      if (boxClosed(next, br, bc)) {
        const idx = br * side(s.dots) + bc;
        next.boxes[idx] = me;
        next.scores[me] = next.scores[me]! + 1;
        closed.push(idx);
      }
    }
    next.last = { by, dir: a.dir, r: a.r, c: a.c, boxes: closed };

    if (next.boxes.every((b) => b >= 0)) {
      next.endReason = 'complete';
      if (next.scores[0]! > next.scores[1]!) next.winner = s.players[0]!;
      else if (next.scores[1]! > next.scores[0]!) next.winner = s.players[1]!;
      else next.draw = true;
    } else if (closed.length === 0) {
      next.turn = (1 - me) as 0 | 1;
    }
    return next;
  },

  isTerminal(s) {
    return s.winner !== null || s.draw;
  },

  result(s): GameResult {
    if (s.winner !== null) {
      return { placements: [[s.winner], s.players.filter((p) => p !== s.winner)], draw: false };
    }
    if (s.draw) return { placements: [[...s.players]], draw: true };
    return { placements: [], draw: false };
  },

  view(s) {
    return s;
  },
};
