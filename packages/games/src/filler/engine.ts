import { z } from 'zod';
import type { GameEngine, GameResult, PlayerId, ValidateResult } from '../contract.ts';
import { nextInt, seedRng } from '../rng.ts';

/**
 * Filler (2 players, async). An 8 x 7 grid of six colours, seeded. players[0] starts in the bottom-left
 * corner, players[1] in the top-right. On your turn you pick a colour: your whole region turns that colour
 * and swallows every touching free cell of it (and the free cells of that colour touching those, and so on).
 * You may not pick your own current colour or the one your opponent currently holds. First to hold MORE THAN
 * HALF the board (29 of 56) wins at once; if the board fills up the larger region wins, equal is a draw.
 * Rules decided here are in docs/DECISIONS.md (ADR-030).
 *
 * Nothing in Filler is hidden, so `view` is the whole state. There is no randomness after `init`.
 */
export type FillerCfg = {
  /** Safety cap on turns (both players together); the larger region wins at the cap. Default 100. */
  maxTurns?: number;
};

export const FILLER_COLS = 8;
export const FILLER_ROWS = 7;
export const FILLER_CELLS = FILLER_COLS * FILLER_ROWS;
export const FILLER_COLOURS = 6;
/** A region strictly larger than this wins on the spot. */
export const FILLER_MAJORITY = Math.floor(FILLER_CELLS / 2);

export type FillerState = {
  players: [PlayerId, PlayerId];
  cols: number;
  rows: number;
  /** Current colour of each cell, row-major from the top-left, 0..5. */
  cells: number[];
  /** 0 free, 1 players[0], 2 players[1]. */
  owner: (0 | 1 | 2)[];
  /** The colour each player's region currently has. */
  colours: [number, number];
  /** Index into `players` of whoever moves. */
  turn: 0 | 1;
  turns: number;
  maxTurns: number;
  over: boolean;
  winner: PlayerId | null;
  /** The last move, for renderers: who, which colour, how many cells it gained. */
  last: { seq: number; by: PlayerId; colour: number; gained: number } | null;
};

export type FillerAction = { kind: 'pick'; colour: number };

export const fillerActionSchema: z.ZodType<FillerAction> = z.object({
  kind: z.literal('pick'),
  colour: z
    .number()
    .int()
    .min(0)
    .max(FILLER_COLOURS - 1),
});

const idx = (r: number, c: number): number => r * FILLER_COLS + c;
export const FILLER_START: readonly [number, number] = [
  idx(FILLER_ROWS - 1, 0),
  idx(0, FILLER_COLS - 1),
];

function neighbours(i: number): number[] {
  const r = Math.floor(i / FILLER_COLS);
  const c = i % FILLER_COLS;
  const out: number[] = [];
  if (r > 0) out.push(i - FILLER_COLS);
  if (c > 0) out.push(i - 1);
  if (c < FILLER_COLS - 1) out.push(i + 1);
  if (r < FILLER_ROWS - 1) out.push(i + FILLER_COLS);
  return out;
}

/** The seeded grid: no two touching cells share a colour, and the two start cells differ. */
export function generateFillerGrid(seed: bigint): number[] {
  let rng = seedRng(seed);
  const cells: number[] = new Array<number>(FILLER_CELLS).fill(-1);
  const topRight = FILLER_START[1];
  const bottomLeft = FILLER_START[0];
  for (let i = 0; i < FILLER_CELLS; i++) {
    const banned = new Set<number>();
    const r = Math.floor(i / FILLER_COLS);
    const c = i % FILLER_COLS;
    if (c > 0) banned.add(cells[i - 1] as number);
    if (r > 0) banned.add(cells[i - FILLER_COLS] as number);
    if (i === bottomLeft) banned.add(cells[topRight] as number);
    const avail: number[] = [];
    for (let k = 0; k < FILLER_COLOURS; k++) if (!banned.has(k)) avail.push(k);
    let pick: number;
    [pick, rng] = nextInt(rng, avail.length);
    cells[i] = avail[pick] as number;
  }
  return cells;
}

export const fillerCounts = (s: FillerState): [number, number] => {
  let a = 0;
  let b = 0;
  for (const o of s.owner) {
    if (o === 1) a++;
    else if (o === 2) b++;
  }
  return [a, b];
};

/** How many free cells `colour` would add for the player at `turn` (without changing anything). */
export function fillerGain(s: FillerState, turn: 0 | 1, colour: number): number {
  return pickColour(s.cells, s.owner, turn, colour).gained;
}

function pickColour(
  cells: readonly number[],
  owner: readonly (0 | 1 | 2)[],
  turn: 0 | 1,
  colour: number,
): { cells: number[]; owner: (0 | 1 | 2)[]; gained: number } {
  const me: 1 | 2 = turn === 0 ? 1 : 2;
  const nc = cells.slice();
  const no = owner.slice();
  const queue: number[] = [];
  for (let i = 0; i < FILLER_CELLS; i++) {
    if (no[i] === me) {
      nc[i] = colour;
      queue.push(i);
    }
  }
  let gained = 0;
  for (let q = 0; q < queue.length; q++) {
    for (const n of neighbours(queue[q] as number)) {
      if (no[n] === 0 && nc[n] === colour) {
        no[n] = me;
        gained++;
        queue.push(n);
      }
    }
  }
  return { cells: nc, owner: no, gained };
}

export const fillerEngine: GameEngine<FillerState, FillerAction, FillerCfg> = {
  slug: 'filler',
  actionSchema: fillerActionSchema,
  timers: { turnMs: 60_000 },

  init(players, seed, cfg) {
    if (players.length !== 2) throw new Error('Filler is a two-player game');
    if (players[0] === players[1]) throw new Error('Duplicate players');
    const maxTurns = cfg?.maxTurns ?? 100;
    if (!Number.isInteger(maxTurns) || maxTurns < 2 || maxTurns > 400) {
      throw new Error('Invalid maxTurns');
    }
    const cells = generateFillerGrid(seed);
    const owner: (0 | 1 | 2)[] = new Array<0 | 1 | 2>(FILLER_CELLS).fill(0);
    owner[FILLER_START[0]] = 1;
    owner[FILLER_START[1]] = 2;
    return {
      players: [players[0] as PlayerId, players[1] as PlayerId],
      cols: FILLER_COLS,
      rows: FILLER_ROWS,
      cells,
      owner,
      colours: [cells[FILLER_START[0]] as number, cells[FILLER_START[1]] as number],
      turn: 0,
      turns: 0,
      maxTurns,
      over: false,
      winner: null,
      last: null,
    };
  },

  currentPlayers(s) {
    return s.over ? [] : [s.players[s.turn]];
  },

  validate(s, by, a): ValidateResult {
    if (s.over) return { ok: false, code: 'game_over' };
    if (s.players[s.turn] !== by) return { ok: false, code: 'not_your_turn' };
    if (!Number.isInteger(a.colour) || a.colour < 0 || a.colour >= FILLER_COLOURS) {
      return { ok: false, code: 'bad_colour' };
    }
    if (a.colour === s.colours[s.turn]) return { ok: false, code: 'your_colour' };
    if (a.colour === s.colours[s.turn === 0 ? 1 : 0]) return { ok: false, code: 'their_colour' };
    return { ok: true };
  },

  apply(s, by, a) {
    const turn = s.turn;
    const { cells, owner, gained } = pickColour(s.cells, s.owner, turn, a.colour);
    const colours: [number, number] = [s.colours[0], s.colours[1]];
    colours[turn] = a.colour;
    const next: FillerState = {
      ...s,
      cells,
      owner,
      colours,
      turns: s.turns + 1,
      turn: turn === 0 ? 1 : 0,
      last: { seq: s.turns + 1, by, colour: a.colour, gained },
    };
    const [x, y] = fillerCounts(next);
    const free = FILLER_CELLS - x - y;
    if (x > FILLER_MAJORITY || y > FILLER_MAJORITY || free === 0 || next.turns >= s.maxTurns) {
      next.over = true;
      next.winner = x > y ? s.players[0] : y > x ? s.players[1] : null;
    }
    return next;
  },

  isTerminal(s) {
    return s.over;
  },

  result(s): GameResult {
    if (!s.over) return { placements: [], draw: false };
    if (s.winner === null) return { placements: [[s.players[0], s.players[1]]], draw: true };
    const loser = s.players[0] === s.winner ? s.players[1] : s.players[0];
    return { placements: [[s.winner], [loser]], draw: false };
  },

  view(s) {
    const [a, b] = fillerCounts(s);
    return { ...s, counts: { [s.players[0]]: a, [s.players[1]]: b } };
  },
};

/**
 * The move to play for a player who ran out of time (or a bot): the legal colour that gains the most free
 * cells, the lowest colour on a tie. Always legal while the game is running.
 */
export function fillerAutoAction(s: FillerState): FillerAction {
  let best = -1;
  let bestGain = -1;
  for (let colour = 0; colour < FILLER_COLOURS; colour++) {
    if (colour === s.colours[0] || colour === s.colours[1]) continue;
    const g = fillerGain(s, s.turn, colour);
    if (g > bestGain) {
      best = colour;
      bestGain = g;
    }
  }
  return { kind: 'pick', colour: best };
}
