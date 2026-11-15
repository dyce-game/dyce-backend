import { z } from 'zod';
import type { GameEngine, GameResult, PlayerId, ValidateResult } from '../contract.ts';
import { nextInt, seedRng, type RngState } from '../rng.ts';
import { WORD_HUNT_DICT_ID, WORD_HUNT_WORDS } from './words.ts';

/**
 * Word Hunt: a 4×4 letter grid, an 80 second round, score by word length. Every player gets the SAME
 * seeded grid and plays it on their own time (async), then submits the words they found.
 *
 * Fairness (docs/DECISIONS.md ADR-013):
 *  - The grid is hidden from a player until they `start`, so nobody can study it (or run a solver) before
 *    the clock begins. The match service records when `start` and `submit` arrive and rejects a submit
 *    later than `roundMs` + grace; the engine only guarantees the order start → submit, once.
 *  - Words are re-checked here: a word counts only if it is in the dictionary and traceable on the grid
 *    (neighbouring cells, including diagonals, each used once). Anything else is dropped, not scored,
 *    and counted in `rejected` as a cheat signal. Duplicates count once.
 *  - A player's words stay private until the viewer has finished too (or the match is over); only the
 *    score of someone who is done is shown early ("Zainab · played · 41 pts · beat 41").
 */
export type WordHuntCfg = {
  /** Round length the client enforces and the server checks. Default 80 000. */
  roundMs?: number;
  /** Re-roll the grid until it holds at least this many dictionary words. Default 25. */
  minWords?: number;
};

export type WordHuntStatus = 'idle' | 'playing' | 'done';

export type WordHuntState = {
  players: PlayerId[];
  /** 16 single upper-case letters, row-major. */
  board: string[];
  roundMs: number;
  dict: string;
  possibleWords: number;
  possibleScore: number;
  status: Record<PlayerId, WordHuntStatus>;
  /** Accepted words per player, in the order submitted. */
  words: Record<PlayerId, string[]>;
  scores: Record<PlayerId, number>;
  /** Submitted words that were not valid (cheat / lag signal). */
  rejected: Record<PlayerId, number>;
};

export type WordHuntAction = { kind: 'start' } | { kind: 'submit'; words: string[] };

export const WORD_HUNT_MAX_WORDS = 400;

export const wordHuntActionSchema: z.ZodType<WordHuntAction> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('start') }),
  z.object({
    kind: z.literal('submit'),
    words: z.array(z.string().regex(/^[A-Za-z]{1,16}$/)).max(WORD_HUNT_MAX_WORDS),
  }),
]);

export const WORD_HUNT_ROUND_MS = 80_000;
export const WORD_HUNT_BOARD_SIZE = 4;
export const WORD_HUNT_MIN_LENGTH = 3;

/** Points for a word of this many letters (ADR-013). */
export function wordHuntWordScore(length: number): number {
  if (length < WORD_HUNT_MIN_LENGTH) return 0;
  if (length >= 8) return 12;
  return [0, 0, 0, 1, 2, 4, 6, 9][length] as number;
}

// ---------------------------------------------------------------------------------------------
// Dictionary (trie) and board search

type TrieNode = { next: Map<string, TrieNode>; end: boolean };

export type WordHuntDictionary = { id: string; root: TrieNode; size: number };

export function buildWordHuntDictionary(words: readonly string[], id: string): WordHuntDictionary {
  const root: TrieNode = { next: new Map(), end: false };
  let size = 0;
  for (const raw of words) {
    const w = raw.toUpperCase();
    if (!/^[A-Z]{3,16}$/.test(w)) continue;
    let node = root;
    for (const ch of w) {
      let n = node.next.get(ch);
      if (!n) {
        n = { next: new Map(), end: false };
        node.next.set(ch, n);
      }
      node = n;
    }
    if (!node.end) size++;
    node.end = true;
  }
  return { id, root, size };
}

const NEIGHBOURS: readonly (readonly number[])[] = Array.from({ length: 16 }, (_, i) => {
  const r = Math.floor(i / 4);
  const c = i % 4;
  const out: number[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const rr = r + dr;
      const cc = c + dc;
      if (rr >= 0 && rr < 4 && cc >= 0 && cc < 4) out.push(rr * 4 + cc);
    }
  }
  return out;
});

/** The cell path that spells `word` on `board`, or null. Used by validation and by the renderer. */
export function findWordHuntPath(board: readonly string[], word: string): number[] | null {
  const w = word.toUpperCase();
  if (w.length < WORD_HUNT_MIN_LENGTH || w.length > 16) return null;
  const used = new Array<boolean>(16).fill(false);
  const path: number[] = [];
  const go = (cell: number, k: number): boolean => {
    if (board[cell] !== w[k]) return false;
    used[cell] = true;
    path.push(cell);
    if (k === w.length - 1) return true;
    for (const nb of NEIGHBOURS[cell] as readonly number[]) {
      if (!used[nb] && go(nb, k + 1)) return true;
    }
    used[cell] = false;
    path.pop();
    return false;
  };
  for (let start = 0; start < 16; start++) {
    if (go(start, 0)) return path;
  }
  return null;
}

/** Every dictionary word that can be traced on `board`, upper-case, sorted. */
export function solveWordHuntBoard(board: readonly string[], dict: WordHuntDictionary): string[] {
  const found = new Set<string>();
  const used = new Array<boolean>(16).fill(false);
  const go = (cell: number, node: TrieNode, prefix: string): void => {
    const ch = board[cell] as string;
    const next = node.next.get(ch);
    if (!next) return;
    const word = prefix + ch;
    if (next.end) found.add(word);
    used[cell] = true;
    for (const nb of NEIGHBOURS[cell] as readonly number[]) {
      if (!used[nb]) go(nb, next, word);
    }
    used[cell] = false;
  };
  for (let i = 0; i < 16; i++) go(i, dict.root, '');
  return [...found].sort();
}

export const wordHuntTotalScore = (words: readonly string[]): number =>
  words.reduce((sum, w) => sum + wordHuntWordScore(w.length), 0);

// ---------------------------------------------------------------------------------------------
// Board generator

/** Relative letter weights (English-like, no Q so there is no "QU" tile to special-case). */
const LETTER_WEIGHTS: readonly [string, number][] = [
  ['E', 12], ['A', 9], ['I', 8], ['O', 8], ['T', 7], ['N', 7], ['R', 7], ['S', 7], ['L', 5],
  ['D', 4], ['U', 4], ['C', 3], ['M', 3], ['P', 3], ['H', 3], ['B', 2], ['G', 2], ['F', 2],
  ['Y', 2], ['W', 2], ['K', 1], ['V', 1], ['J', 1], ['X', 1], ['Z', 1],
]; // prettier-ignore
const WEIGHT_TOTAL = LETTER_WEIGHTS.reduce((n, [, w]) => n + w, 0);

function randomBoard(rng: RngState): [string[], RngState] {
  const board: string[] = [];
  let s = rng;
  for (let i = 0; i < 16; i++) {
    let r: number;
    [r, s] = nextInt(s, WEIGHT_TOTAL);
    for (const [ch, w] of LETTER_WEIGHTS) {
      if (r < w) {
        board.push(ch);
        break;
      }
      r -= w;
    }
  }
  return [board, s];
}

const MAX_BOARD_ATTEMPTS = 60;

/**
 * Deterministic: the same seed + dictionary + minWords always gives the same board. Tries up to 60
 * grids and returns the first with at least `minWords` words and 3–7 vowels; if none qualifies, the
 * richest one seen.
 */
export function generateWordHuntBoard(
  seed: bigint,
  dict: WordHuntDictionary,
  minWords = 25,
): { board: string[]; words: string[] } {
  let rng = seedRng(seed);
  let best: { board: string[]; words: string[] } | null = null;
  for (let attempt = 0; attempt < MAX_BOARD_ATTEMPTS; attempt++) {
    let board: string[];
    [board, rng] = randomBoard(rng);
    const vowels = board.filter((ch) => 'AEIOU'.includes(ch)).length;
    if (vowels < 3 || vowels > 7) continue;
    const words = solveWordHuntBoard(board, dict);
    if (words.length >= minWords) return { board, words };
    if (!best || words.length > best.words.length) best = { board, words };
  }
  // Practically unreachable with a sane dictionary; keeps init total.
  if (best) return best;
  const [board] = randomBoard(rng);
  return { board, words: solveWordHuntBoard(board, dict) };
}

// ---------------------------------------------------------------------------------------------
// Engine factory

export function createWordHuntEngine(
  words: readonly string[],
  dictId: string,
): GameEngine<WordHuntState, WordHuntAction, WordHuntCfg> {
  const dict = buildWordHuntDictionary(words, dictId);

  const engine: GameEngine<WordHuntState, WordHuntAction, WordHuntCfg> = {
    slug: 'word-hunt',
    actionSchema: wordHuntActionSchema,
    timers: { turnMs: WORD_HUNT_ROUND_MS + 10_000 },

    init(players, seed, cfg) {
      if (players.length < 2 || players.length > 8)
        throw new Error('Word Hunt needs 2 to 8 players');
      if (new Set(players).size !== players.length) throw new Error('Duplicate players');
      const roundMs = cfg?.roundMs ?? WORD_HUNT_ROUND_MS;
      if (!Number.isInteger(roundMs) || roundMs < 10_000 || roundMs > 600_000) {
        throw new Error('Invalid roundMs');
      }
      const minWords = cfg?.minWords ?? 25;
      const { board, words: possible } = generateWordHuntBoard(seed, dict, minWords);
      return {
        players: [...players],
        board,
        roundMs,
        dict: dict.id,
        possibleWords: possible.length,
        possibleScore: wordHuntTotalScore(possible),
        status: Object.fromEntries(players.map((p) => [p, 'idle' as const])),
        words: Object.fromEntries(players.map((p) => [p, []])),
        scores: Object.fromEntries(players.map((p) => [p, 0])),
        rejected: Object.fromEntries(players.map((p) => [p, 0])),
      };
    },

    currentPlayers(s) {
      return s.players.filter((p) => s.status[p] !== 'done');
    },

    validate(s, by, a): ValidateResult {
      if (!s.players.includes(by)) return { ok: false, code: 'not_a_player' };
      const st = s.status[by];
      if (st === 'done') return { ok: false, code: 'already_played' };
      if (a.kind === 'start') {
        return st === 'idle' ? { ok: true } : { ok: false, code: 'already_started' };
      }
      if (st !== 'playing') return { ok: false, code: 'not_started' };
      if (!Array.isArray(a.words) || a.words.length > WORD_HUNT_MAX_WORDS) {
        return { ok: false, code: 'too_many_words' };
      }
      for (const w of a.words) {
        if (typeof w !== 'string' || !/^[A-Za-z]{1,16}$/.test(w)) {
          return { ok: false, code: 'bad_word' };
        }
      }
      return { ok: true };
    },

    apply(s, by, a) {
      const next: WordHuntState = {
        ...s,
        status: { ...s.status },
        words: { ...s.words },
        scores: { ...s.scores },
        rejected: { ...s.rejected },
      };
      if (a.kind === 'start') {
        next.status[by] = 'playing';
        return next;
      }
      const seen = new Set<string>();
      const accepted: string[] = [];
      let rejected = 0;
      for (const raw of a.words) {
        const w = raw.toUpperCase();
        if (seen.has(w)) continue; // duplicates are free to send, they just count once
        seen.add(w);
        if (isWord(dict, w) && findWordHuntPath(s.board, w) !== null) accepted.push(w);
        else rejected++;
      }
      next.status[by] = 'done';
      next.words[by] = accepted;
      next.scores[by] = wordHuntTotalScore(accepted);
      next.rejected[by] = rejected;
      return next;
    },

    isTerminal(s) {
      return s.players.every((p) => s.status[p] === 'done');
    },

    result(s): GameResult {
      if (!engine.isTerminal(s)) return { placements: [], draw: false };
      const groups = new Map<number, PlayerId[]>();
      for (const p of s.players) {
        const sc = s.scores[p] ?? 0;
        groups.set(sc, [...(groups.get(sc) ?? []), p]);
      }
      const placements = [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([, ps]) => ps);
      return { placements, draw: (placements[0]?.length ?? 0) > 1 };
    },

    view(s, viewer) {
      const over = engine.isTerminal(s);
      const me = viewer === 'spectator' ? null : viewer;
      const mine = me !== null ? s.status[me] : undefined;
      // The grid is shown once the viewer has started their round (or the match is over).
      const showBoard = over || (mine !== undefined && mine !== 'idle');
      const iAmDone = over || mine === 'done';
      return {
        players: s.players,
        roundMs: s.roundMs,
        dict: s.dict,
        board: showBoard ? s.board : null,
        status: s.status,
        scores: Object.fromEntries(
          s.players.map((p) => [p, s.status[p] === 'done' ? (s.scores[p] ?? 0) : null]),
        ),
        // Words of finished players, only to someone who has finished (or everyone once over).
        words: Object.fromEntries(
          s.players.map((p) => {
            const visible = s.status[p] === 'done' && (p === me || iAmDone);
            return [p, visible ? (s.words[p] ?? []) : null];
          }),
        ),
        // Only the viewer's own count, and only once the round is finished.
        rejected: me !== null && s.status[me] === 'done' ? (s.rejected[me] ?? 0) : null,
        possibleWords: iAmDone ? s.possibleWords : null,
        possibleScore: iAmDone ? s.possibleScore : null,
      };
    },
  };
  return engine;
}

function isWord(dict: WordHuntDictionary, upper: string): boolean {
  let node = dict.root;
  for (const ch of upper) {
    const n = node.next.get(ch);
    if (!n) return false;
    node = n;
  }
  return node.end;
}

/** The default engine, backed by the in-repo dictionary (see words.ts for its source and licence). */
export const wordHuntDictionary: WordHuntDictionary = buildWordHuntDictionary(
  WORD_HUNT_WORDS,
  WORD_HUNT_DICT_ID,
);
export const wordHuntEngine = createWordHuntEngine(WORD_HUNT_WORDS, WORD_HUNT_DICT_ID);
