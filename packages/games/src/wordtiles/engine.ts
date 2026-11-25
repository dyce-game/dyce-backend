import { z } from 'zod';
import type { GameEngine, GameResult, PlayerId, ValidateResult } from '../contract.ts';
import { seedRng, shuffle, type RngState } from '../rng.ts';
import { WORD_TILES_DICT_ID, WORD_TILES_WORDS } from './words.ts';

/**
 * Word Tiles (2-4 players, async). A 15 x 15 board, a bag of 102 letter tiles (two are blanks), a rack of
 * seven. Our own premium-square layout, letter values and tile counts (docs/DECISIONS.md ADR-031); the
 * name and the numbers are ours, not another game's.
 *
 *  - Turn: `play` tiles in ONE row or column, in one unbroken line (existing tiles may fill the gaps), joined
 *    to the tiles already down; `exchange` tiles for new ones (only while the bag holds a full rack); or
 *    `pass`. The first play must cover the centre star and be two tiles or more.
 *  - Every word the play makes (the main word and each cross word, 2+ letters) must be in the dictionary.
 *    The dictionary is an INJECTED word set: `createWordTilesEngine(wordSet)`. A play with an invalid word
 *    is refused (`invalid_word`) and costs nothing; there are no challenges.
 *  - Scoring: letter values, with premium squares counting only for tiles placed this turn (DL/TL multiply
 *    the letter, DW/TW multiply the word, several word premiums multiply together, each word is scored
 *    separately). A blank is worth 0. Using all seven tiles adds a 30 point bonus.
 *  - End: a player empties their rack with the bag empty (they gain the value of everyone else's tiles, and
 *    each opponent loses the value of their own), or every player passes/exchanges twice in a row (everyone
 *    loses the value of their own rack). Highest score wins; equal is a draw.
 *  - Secrets: other players' racks, the bag order and the RNG never leave `view()`.
 *
 * The engine has no clock. A turn that times out is turned into `{kind:'pass'}` by the match service.
 */
export const BOARD_SIZE = 15;
export const CENTER = 7;
export const RACK_SIZE = 7;
export const BINGO_BONUS = 30;
export const MAX_WORD_LENGTH = 15;

export type Premium = 'DL' | 'TL' | 'DW' | 'TW' | null;

/** Letter values (ours). A blank is worth 0. */
export const WORD_TILES_LETTER_VALUES: Readonly<Record<string, number>> = {
  E: 1, A: 1, I: 1, O: 1, N: 1, R: 1, T: 1, S: 1, L: 1, U: 1,
  D: 2, G: 2, M: 2, C: 2,
  B: 3, P: 3, H: 3, F: 3, Y: 3, W: 3,
  V: 4, K: 4,
  J: 6, X: 6,
  Z: 8, Q: 8,
}; // prettier-ignore

/** Tile counts (ours): 100 letters and 2 blanks (`?`), 102 in all. */
export const WORD_TILES_DISTRIBUTION: Readonly<Record<string, number>> = {
  E: 12, A: 9, I: 9, O: 8, N: 6, R: 6, T: 6, S: 5, L: 4, U: 4,
  D: 4, G: 3, M: 3, C: 3,
  B: 2, P: 2, H: 2, F: 2, Y: 2, W: 2,
  V: 1, K: 1,
  J: 1, X: 1, Z: 1, Q: 1,
  '?': 2,
}; // prettier-ignore

// ---------------------------------------------------------------------------------------------
// Premium layout: one base list per kind, mirrored into all eight symmetries.

const BASES: Record<Exclude<Premium, null>, [number, number][]> = {
  TW: [[0, 3]],
  DW: [[0, 0], [1, 5], [7, 7]],
  TL: [[3, 6], [1, 7]],
  DL: [[2, 2], [2, 7], [4, 4], [6, 6], [0, 7]],
}; // prettier-ignore

function buildPremiums(): Premium[] {
  const out: Premium[] = new Array<Premium>(BOARD_SIZE * BOARD_SIZE).fill(null);
  const n = BOARD_SIZE - 1;
  for (const kind of ['TW', 'DW', 'TL', 'DL'] as const) {
    for (const [a, b] of BASES[kind]) {
      const spots: [number, number][] = [
        [a, b], [b, a], [a, n - b], [n - a, b], [n - a, n - b], [b, n - a], [n - b, a], [n - b, n - a],
      ]; // prettier-ignore
      for (const [r, c] of spots) {
        const i = r * BOARD_SIZE + c;
        const have = out[i];
        if (have !== null && have !== kind) throw new Error(`Premium clash at ${r},${c}`);
        out[i] = kind;
      }
    }
  }
  return out;
}

/** Premium of every square, row-major from the top-left. */
export const WORD_TILES_PREMIUMS: readonly Premium[] = buildPremiums();

export const wordTilesPremium = (r: number, c: number): Premium =>
  WORD_TILES_PREMIUMS[r * BOARD_SIZE + c] ?? null;

// ---------------------------------------------------------------------------------------------
// Word set

/** What the engine needs from a dictionary: a pure membership test on UPPER-CASE words, and an id. */
export type WordSet = { id: string; size: number; has: (upperWord: string) => boolean };

export function makeWordSet(words: Iterable<string>, id: string): WordSet {
  const set = new Set<string>();
  for (const raw of words) {
    const w = raw.toUpperCase();
    if (/^[A-Z]{2,15}$/.test(w)) set.add(w);
  }
  return { id, size: set.size, has: (w) => set.has(w) };
}

// ---------------------------------------------------------------------------------------------
// Types

export type WordTilesTile = {
  r: number;
  c: number;
  /** The letter this tile shows. For a blank it is the letter the player says it stands for. */
  letter: string;
  /** True when the tile is taken from the rack as a blank. */
  blank?: boolean;
};

export type WordTilesAction =
  | { kind: 'play'; tiles: WordTilesTile[] }
  | { kind: 'exchange'; letters: string[] }
  | { kind: 'pass' };

export type WordTilesMove = {
  seq: number;
  by: PlayerId;
  kind: 'play' | 'exchange' | 'pass';
  score: number;
  words: { word: string; score: number }[];
  tiles: WordTilesTile[];
  /** Number of tiles exchanged (their letters stay private). */
  exchanged: number;
  bingo: boolean;
};

export type WordTilesCfg = object;

export type WordTilesState = {
  players: PlayerId[];
  /** Word set id the match started with (a live match keeps validating against it). */
  dict: string;
  /** 225 cells, row-major. '' empty, 'A'-'Z' a letter tile, 'a'-'z' a blank standing for that letter. */
  board: string[];
  /** SECRET. Each player's rack: letters, '?' for a blank. */
  racks: Record<PlayerId, string[]>;
  /** SECRET. The draw pile, next tile first. */
  bag: string[];
  scores: Record<PlayerId, number>;
  /** Index into `players` of whoever moves. */
  turn: number;
  /** Consecutive scoreless turns (pass or exchange). */
  scoreless: number;
  over: boolean;
  endReason: 'out' | 'passes' | null;
  /** Player who went out, when endReason is 'out'. */
  wentOut: PlayerId | null;
  last: WordTilesMove | null;
  seq: number;
  /** SECRET. Used to shuffle the bag after an exchange. */
  rng: RngState;
};

const tileSchema = z.object({
  r: z
    .number()
    .int()
    .min(0)
    .max(BOARD_SIZE - 1),
  c: z
    .number()
    .int()
    .min(0)
    .max(BOARD_SIZE - 1),
  letter: z.string().regex(/^[A-Z]$/),
  blank: z.boolean().optional(),
});

export const wordTilesActionSchema: z.ZodType<WordTilesAction> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('play'), tiles: z.array(tileSchema).min(1).max(RACK_SIZE) }),
  z.object({
    kind: z.literal('exchange'),
    letters: z
      .array(z.string().regex(/^[A-Z?]$/))
      .min(1)
      .max(RACK_SIZE),
  }),
  z.object({ kind: z.literal('pass') }),
]);

// ---------------------------------------------------------------------------------------------
// Play analysis: the pure dictionary-aware rules function (also used by hints, bots and renderers).

export type PlayAnalysis =
  | {
      ok: true;
      score: number;
      words: { word: string; score: number; cells: number[] }[];
      bingo: boolean;
    }
  | { ok: false; code: string; invalid?: string[] };

const isLower = (ch: string): boolean => ch >= 'a' && ch <= 'z';
const cellValue = (ch: string): number => (isLower(ch) ? 0 : (WORD_TILES_LETTER_VALUES[ch] ?? 0));
const fail = (code: string, invalid?: string[]): PlayAnalysis =>
  invalid ? { ok: false, code, invalid } : { ok: false, code };

/** Letters and '?' a play takes from a rack. */
export const tilesNeeded = (tiles: readonly WordTilesTile[]): string[] =>
  tiles.map((t) => (t.blank ? '?' : t.letter));

/** Is `need` a sub-multiset of `rack`? */
export function rackHolds(rack: readonly string[], need: readonly string[]): boolean {
  const have: Record<string, number> = {};
  for (const ch of rack) have[ch] = (have[ch] ?? 0) + 1;
  for (const ch of need) {
    const left = (have[ch] ?? 0) - 1;
    if (left < 0) return false;
    have[ch] = left;
  }
  return true;
}

function removeFromRack(rack: readonly string[], take: readonly string[]): string[] {
  const out = rack.slice();
  for (const ch of take) {
    const i = out.indexOf(ch);
    if (i < 0) throw new Error('Tile not in rack');
    out.splice(i, 1);
  }
  return out;
}

/** The whole word through (r, c) along (dr, dc): its cells, in order. */
function lineCells(
  board: readonly string[],
  r: number,
  c: number,
  dr: number,
  dc: number,
): number[] {
  let rr = r;
  let cc = c;
  while (rr - dr >= 0 && cc - dc >= 0 && board[(rr - dr) * BOARD_SIZE + (cc - dc)] !== '') {
    rr -= dr;
    cc -= dc;
  }
  const cells: number[] = [];
  while (rr < BOARD_SIZE && cc < BOARD_SIZE && board[rr * BOARD_SIZE + cc] !== '') {
    cells.push(rr * BOARD_SIZE + cc);
    rr += dr;
    cc += dc;
  }
  return cells;
}

/**
 * Check a play against the rules and the word set, and score it. Pure: it looks only at its arguments.
 * `board` is the state's board, `rack` the mover's rack.
 */
export function wordTilesAnalysePlay(
  board: readonly string[],
  rack: readonly string[],
  tiles: readonly WordTilesTile[],
  words: Pick<WordSet, 'has'>,
): PlayAnalysis {
  if (tiles.length === 0) return fail('no_tiles');
  if (tiles.length > RACK_SIZE) return fail('too_many_tiles');
  const placed = new Set<number>();
  for (const t of tiles) {
    if (
      !Number.isInteger(t.r) ||
      !Number.isInteger(t.c) ||
      t.r < 0 ||
      t.c < 0 ||
      t.r >= BOARD_SIZE ||
      t.c >= BOARD_SIZE
    ) {
      return fail('off_board');
    }
    if (typeof t.letter !== 'string' || !/^[A-Z]$/.test(t.letter)) return fail('bad_letter');
    const i = t.r * BOARD_SIZE + t.c;
    if (board[i] !== '') return fail('square_taken');
    if (placed.has(i)) return fail('duplicate_square');
    placed.add(i);
  }
  if (!rackHolds(rack, tilesNeeded(tiles))) return fail('tiles_not_in_rack');

  const first = tiles[0] as WordTilesTile;
  const sameRow = tiles.every((t) => t.r === first.r);
  const sameCol = tiles.every((t) => t.c === first.c);
  if (!sameRow && !sameCol) return fail('not_in_line');

  const trial = board.slice();
  for (const t of tiles)
    trial[t.r * BOARD_SIZE + t.c] = t.blank ? t.letter.toLowerCase() : t.letter;

  // No gaps: between the first and last tile every square is filled (by the play or by the board).
  if (tiles.length > 1) {
    if (sameRow) {
      const cs = tiles.map((t) => t.c);
      for (let c = Math.min(...cs); c <= Math.max(...cs); c++) {
        if (trial[first.r * BOARD_SIZE + c] === '') return fail('gap');
      }
    } else {
      const rs = tiles.map((t) => t.r);
      for (let r = Math.min(...rs); r <= Math.max(...rs); r++) {
        if (trial[r * BOARD_SIZE + first.c] === '') return fail('gap');
      }
    }
  }

  const boardEmpty = board.every((x) => x === '');
  if (boardEmpty) {
    if (!placed.has(CENTER * BOARD_SIZE + CENTER)) return fail('must_cover_center');
    if (tiles.length < 2) return fail('first_word_too_short');
  } else {
    const touches = tiles.some((t) =>
      [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dr, dc]) => {
        const rr = t.r + (dr as number);
        const cc = t.c + (dc as number);
        return (
          rr >= 0 && cc >= 0 && rr < BOARD_SIZE && cc < BOARD_SIZE && board[rr * BOARD_SIZE + cc] !== ''
        );
      }),
    ); // prettier-ignore
    if (!touches) return fail('not_connected');
  }

  // The words made: the main word along the line of play, and a cross word for each new tile.
  const found: number[][] = [];
  if (tiles.length === 1) {
    const h = lineCells(trial, first.r, first.c, 0, 1);
    const v = lineCells(trial, first.r, first.c, 1, 0);
    if (h.length >= 2) found.push(h);
    if (v.length >= 2) found.push(v);
  } else if (sameRow) {
    found.push(lineCells(trial, first.r, first.c, 0, 1));
    for (const t of tiles) {
      const w = lineCells(trial, t.r, t.c, 1, 0);
      if (w.length >= 2) found.push(w);
    }
  } else {
    found.push(lineCells(trial, first.r, first.c, 1, 0));
    for (const t of tiles) {
      const w = lineCells(trial, t.r, t.c, 0, 1);
      if (w.length >= 2) found.push(w);
    }
  }
  if (found.length === 0) return fail('no_word');

  const invalid: string[] = [];
  const scored: { word: string; score: number; cells: number[] }[] = [];
  let total = 0;
  for (const cells of found) {
    const word = cells.map((i) => (trial[i] as string).toUpperCase()).join('');
    if (!words.has(word)) invalid.push(word);
    let sum = 0;
    let mult = 1;
    for (const i of cells) {
      let v = cellValue(trial[i] as string);
      if (placed.has(i)) {
        const p = WORD_TILES_PREMIUMS[i];
        if (p === 'DL') v *= 2;
        else if (p === 'TL') v *= 3;
        else if (p === 'DW') mult *= 2;
        else if (p === 'TW') mult *= 3;
      }
      sum += v;
    }
    const score = sum * mult;
    scored.push({ word, score, cells });
    total += score;
  }
  if (invalid.length > 0) return fail('invalid_word', invalid);
  const bingo = tiles.length === RACK_SIZE;
  if (bingo) total += BINGO_BONUS;
  return { ok: true, score: total, words: scored, bingo };
}

// ---------------------------------------------------------------------------------------------
// Hints and bots: every legal play that spells one of `candidateWords` through the rack and the board.

export type WordTilesPlay = { tiles: WordTilesTile[]; score: number; words: string[] };

/**
 * The legal plays (best first, ties broken by position) that place a word from `candidateWords`, looking
 * only at the mover's own rack and the public board. Used by tests, the determinism scenario, and as the
 * engine behind a Coach/hint feature. `candidateWords` should be upper-case. Cost grows with the list, so
 * pass a trimmed one on hot paths.
 */
export function wordTilesPlays(
  s: WordTilesState,
  by: PlayerId,
  candidateWords: readonly string[],
  words: Pick<WordSet, 'has'>,
  limit = 20,
): WordTilesPlay[] {
  const rack = s.racks[by] ?? [];
  const have: Record<string, number> = {};
  for (const ch of rack) have[ch] = (have[ch] ?? 0) + 1;
  const blanks = have['?'] ?? 0;
  const onBoard = new Set<string>();
  for (const ch of s.board) if (ch !== '') onBoard.add(ch.toUpperCase());
  const empty = onBoard.size === 0;

  // A line (row or column) is worth trying when it has a tile on it or beside it, or it is the centre line.
  const rowActive = new Array<boolean>(BOARD_SIZE).fill(false);
  const colActive = new Array<boolean>(BOARD_SIZE).fill(false);
  for (let i = 0; i < s.board.length; i++) {
    if (s.board[i] === '') continue;
    const r = Math.floor(i / BOARD_SIZE);
    const c = i % BOARD_SIZE;
    for (const d of [-1, 0, 1]) {
      if (r + d >= 0 && r + d < BOARD_SIZE) rowActive[r + d] = true;
      if (c + d >= 0 && c + d < BOARD_SIZE) colActive[c + d] = true;
    }
  }

  const out: (WordTilesPlay & { key: string })[] = [];
  for (const word of candidateWords) {
    const len = word.length;
    if (len < 2 || len > BOARD_SIZE) continue;
    let possible = true;
    for (let k = 0; k < len; k++) {
      const l = word[k] as string;
      if ((have[l] ?? 0) + blanks === 0 && !onBoard.has(l)) {
        possible = false;
        break;
      }
    }
    if (!possible) continue;
    for (const horizontal of [true, false]) {
      for (let line = 0; line < BOARD_SIZE; line++) {
        if (empty ? line !== CENTER : !(horizontal ? rowActive[line] : colActive[line])) continue;
        for (let start = 0; start + len <= BOARD_SIZE; start++) {
          if (empty && !(start <= CENTER && CENTER < start + len)) continue;
          const left = { ...have };
          const tiles: WordTilesTile[] = [];
          let ok = true;
          for (let k = 0; k < len && ok; k++) {
            const r = horizontal ? line : start + k;
            const c = horizontal ? start + k : line;
            const cell = s.board[r * BOARD_SIZE + c] as string;
            const l = word[k] as string;
            if (cell !== '') {
              if (cell.toUpperCase() !== l) ok = false;
            } else if ((left[l] ?? 0) > 0) {
              left[l] = (left[l] as number) - 1;
              tiles.push({ r, c, letter: l });
            } else if ((left['?'] ?? 0) > 0) {
              left['?'] = (left['?'] as number) - 1;
              tiles.push({ r, c, letter: l, blank: true });
            } else ok = false;
          }
          if (!ok || tiles.length === 0 || tiles.length > RACK_SIZE) continue;
          const res = wordTilesAnalysePlay(s.board, rack, tiles, words);
          if (!res.ok) continue;
          out.push({
            tiles,
            score: res.score,
            words: res.words.map((w) => w.word),
            key: `${horizontal ? 'h' : 'v'}${String(line).padStart(2, '0')}${String(start).padStart(2, '0')}${word}`,
          });
        }
      }
    }
  }
  out.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out.slice(0, limit).map(({ tiles, score, words: w }) => ({ tiles, score, words: w }));
}

// ---------------------------------------------------------------------------------------------
// Engine

const rackValue = (rack: readonly string[]): number =>
  rack.reduce((sum, ch) => sum + (WORD_TILES_LETTER_VALUES[ch] ?? 0), 0);

function draw(rack: readonly string[], bag: readonly string[]): { rack: string[]; bag: string[] } {
  const n = Math.min(RACK_SIZE - rack.length, bag.length);
  return { rack: [...rack, ...bag.slice(0, n)], bag: bag.slice(n) };
}

export function createWordTilesEngine(
  wordSet: WordSet,
): GameEngine<WordTilesState, WordTilesAction, WordTilesCfg> {
  const engine: GameEngine<WordTilesState, WordTilesAction, WordTilesCfg> = {
    slug: 'word-tiles',
    actionSchema: wordTilesActionSchema,
    timers: { turnMs: 120_000 },

    init(players, seed) {
      if (players.length < 2 || players.length > 4)
        throw new Error('Word Tiles needs 2 to 4 players');
      if (new Set(players).size !== players.length) throw new Error('Duplicate players');
      const full: string[] = [];
      for (const letter of Object.keys(WORD_TILES_DISTRIBUTION).sort()) {
        for (let i = 0; i < (WORD_TILES_DISTRIBUTION[letter] as number); i++) full.push(letter);
      }
      const [shuffled, rng] = shuffle(seedRng(seed), full);
      let bag = shuffled;
      const racks: Record<PlayerId, string[]> = {};
      for (const p of players) {
        racks[p] = bag.slice(0, RACK_SIZE);
        bag = bag.slice(RACK_SIZE);
      }
      return {
        players: [...players],
        dict: wordSet.id,
        board: new Array<string>(BOARD_SIZE * BOARD_SIZE).fill(''),
        racks,
        bag,
        scores: Object.fromEntries(players.map((p) => [p, 0])),
        turn: 0,
        scoreless: 0,
        over: false,
        endReason: null,
        wentOut: null,
        last: null,
        seq: 0,
        rng,
      };
    },

    currentPlayers(s) {
      return s.over ? [] : [s.players[s.turn] as PlayerId];
    },

    validate(s, by, a): ValidateResult {
      if (s.over) return { ok: false, code: 'game_over' };
      if (s.players[s.turn] !== by) return { ok: false, code: 'not_your_turn' };
      const rack = s.racks[by] ?? [];
      switch (a.kind) {
        case 'pass':
          return { ok: true };
        case 'exchange': {
          if (!Array.isArray(a.letters) || a.letters.length === 0 || a.letters.length > RACK_SIZE) {
            return { ok: false, code: 'bad_exchange' };
          }
          if (s.bag.length < RACK_SIZE) return { ok: false, code: 'bag_too_small' };
          if (!rackHolds(rack, a.letters)) return { ok: false, code: 'tiles_not_in_rack' };
          return { ok: true };
        }
        case 'play': {
          if (!Array.isArray(a.tiles)) return { ok: false, code: 'no_tiles' };
          const res = wordTilesAnalysePlay(s.board, rack, a.tiles, wordSet);
          return res.ok ? { ok: true } : { ok: false, code: res.code };
        }
      }
    },

    apply(s, by, a) {
      const me = by;
      const rack = s.racks[me] ?? [];
      const next: WordTilesState = {
        ...s,
        racks: { ...s.racks },
        scores: { ...s.scores },
        seq: s.seq + 1,
      };
      let move: WordTilesMove;

      if (a.kind === 'play') {
        const res = wordTilesAnalysePlay(s.board, rack, a.tiles, wordSet);
        if (!res.ok) throw new Error(`Illegal play applied: ${res.code}`);
        const board = s.board.slice();
        for (const t of a.tiles) {
          board[t.r * BOARD_SIZE + t.c] = t.blank ? t.letter.toLowerCase() : t.letter;
        }
        const drawn = draw(removeFromRack(rack, tilesNeeded(a.tiles)), s.bag);
        next.board = board;
        next.racks[me] = drawn.rack;
        next.bag = drawn.bag;
        next.scores[me] = (s.scores[me] ?? 0) + res.score;
        next.scoreless = 0;
        move = {
          seq: next.seq,
          by: me,
          kind: 'play',
          score: res.score,
          words: res.words.map((w) => ({ word: w.word, score: w.score })),
          tiles: a.tiles.map((t) =>
            t.blank
              ? { r: t.r, c: t.c, letter: t.letter, blank: true }
              : { r: t.r, c: t.c, letter: t.letter },
          ),
          exchanged: 0,
          bingo: res.bingo,
        };
      } else if (a.kind === 'exchange') {
        const kept = removeFromRack(rack, a.letters);
        const drawn = draw(kept, s.bag);
        // Returned tiles go back into the bag, which is then reshuffled so nobody can track them.
        const [bag, rng] = shuffle(s.rng, [...drawn.bag, ...a.letters]);
        next.racks[me] = drawn.rack;
        next.bag = bag;
        next.rng = rng;
        next.scoreless = s.scoreless + 1;
        move = {
          seq: next.seq,
          by: me,
          kind: 'exchange',
          score: 0,
          words: [],
          tiles: [],
          exchanged: a.letters.length,
          bingo: false,
        };
      } else {
        next.scoreless = s.scoreless + 1;
        move = {
          seq: next.seq,
          by: me,
          kind: 'pass',
          score: 0,
          words: [],
          tiles: [],
          exchanged: 0,
          bingo: false,
        };
      }
      next.last = move;

      const out = (next.racks[me] ?? []).length === 0 && next.bag.length === 0;
      if (out) {
        next.over = true;
        next.endReason = 'out';
        next.wentOut = me;
        for (const p of s.players) {
          if (p === me) continue;
          const v = rackValue(next.racks[p] ?? []);
          next.scores[p] = (next.scores[p] ?? 0) - v;
          next.scores[me] = (next.scores[me] ?? 0) + v;
        }
      } else if (next.scoreless >= s.players.length * 2) {
        next.over = true;
        next.endReason = 'passes';
        for (const p of s.players) {
          next.scores[p] = (next.scores[p] ?? 0) - rackValue(next.racks[p] ?? []);
        }
      }
      if (!next.over) next.turn = (s.turn + 1) % s.players.length;
      return next;
    },

    isTerminal(s) {
      return s.over;
    },

    result(s): GameResult {
      if (!s.over) return { placements: [], draw: false };
      const groups = new Map<number, PlayerId[]>();
      for (const p of s.players) {
        const sc = s.scores[p] ?? 0;
        groups.set(sc, [...(groups.get(sc) ?? []), p]);
      }
      const placements = [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([, ps]) => ps);
      return { placements, draw: (placements[0]?.length ?? 0) > 1 };
    },

    view(s, viewer) {
      const me = viewer === 'spectator' ? null : viewer;
      return {
        players: s.players,
        dict: s.dict,
        board: s.board,
        scores: s.scores,
        turn: s.over ? null : s.players[s.turn],
        bagCount: s.bag.length,
        rackCounts: Object.fromEntries(s.players.map((p) => [p, (s.racks[p] ?? []).length])),
        // Your own rack only; everyone's once the game is over.
        rack: me !== null ? (s.racks[me] ?? []) : null,
        racks: s.over ? s.racks : null,
        scoreless: s.scoreless,
        over: s.over,
        endReason: s.endReason,
        wentOut: s.wentOut,
        last: s.last,
      };
    },
  };
  return engine;
}

/** The default engine, backed by the in-repo word list (see words.ts for its source, licence and limits). */
export const wordTilesWordSet: WordSet = makeWordSet(WORD_TILES_WORDS, WORD_TILES_DICT_ID);
export const wordTilesEngine = createWordTilesEngine(wordTilesWordSet);
