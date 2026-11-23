import { z } from 'zod';
import type { GameEngine, GameResult, PlayerId, ValidateResult } from '../contract.ts';
import { nextInt, seedRng, shuffle } from '../rng.ts';
import { WORD_HUNT_DICT_ID, WORD_HUNT_WORDS } from '../wordhunt/words.ts';

/**
 * Anagrams: six seeded letters, a 60 second round, make as many words as you can. Every player gets the
 * SAME six letters and plays on their own time (async), then submits the words they found. Rules decided
 * here are in docs/DECISIONS.md (ADR-029).
 *
 *  - The six letters are a shuffled 6-letter dictionary word, so at least one full-length anagram exists
 *    (it is worth a bonus). The letters are hidden until a player presses `start`, like Word Hunt.
 *  - A word counts when it is in the dictionary, is 3-6 letters, and can be spelled from the letters
 *    (each letter used at most as often as it appears). Anything else is dropped and counted in `rejected`.
 *    Duplicates count once.
 *  - The engine has no clock: the match service records when `start` and `submit` arrive and turns a late
 *    submit into an empty one (`screenAction`, as for Word Hunt).
 */
export type AnagramsCfg = {
  /** Round length the client enforces and the server checks. Default 60 000. */
  roundMs?: number;
};

export type AnagramsStatus = 'idle' | 'playing' | 'done';

export type AnagramsState = {
  players: PlayerId[];
  /** Six single upper-case letters, already shuffled. */
  letters: string[];
  roundMs: number;
  dict: string;
  possibleWords: number;
  possibleScore: number;
  status: Record<PlayerId, AnagramsStatus>;
  words: Record<PlayerId, string[]>;
  scores: Record<PlayerId, number>;
  rejected: Record<PlayerId, number>;
};

export type AnagramsAction = { kind: 'start' } | { kind: 'submit'; words: string[] };

export const ANAGRAMS_ROUND_MS = 60_000;
export const ANAGRAMS_LETTERS = 6;
export const ANAGRAMS_MIN_LENGTH = 3;
export const ANAGRAMS_MAX_WORDS = 200;

export const anagramsActionSchema: z.ZodType<AnagramsAction> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('start') }),
  z.object({
    kind: z.literal('submit'),
    words: z.array(z.string().regex(/^[A-Za-z]{1,16}$/)).max(ANAGRAMS_MAX_WORDS),
  }),
]);

/** Points for a word of this many letters (ADR-029): 3 → 1, 4 → 2, 5 → 4, 6 (all the letters) → 10. */
export function anagramsWordScore(length: number): number {
  if (length < ANAGRAMS_MIN_LENGTH || length > ANAGRAMS_LETTERS) return 0;
  return [0, 0, 0, 1, 2, 4, 10][length] as number;
}

export const anagramsTotalScore = (words: readonly string[]): number =>
  words.reduce((sum, w) => sum + anagramsWordScore(w.length), 0);

// ---------------------------------------------------------------------------------------------
// Dictionary

export type AnagramsDictionary = {
  id: string;
  /** Upper-case words of 3-6 letters. */
  words: ReadonlySet<string>;
  /** The 6-letter words, sorted: the pool the letters are drawn from. */
  sixes: readonly string[];
};

export function buildAnagramsDictionary(words: readonly string[], id: string): AnagramsDictionary {
  const set = new Set<string>();
  for (const raw of words) {
    const w = raw.toUpperCase();
    if (/^[A-Z]{3,6}$/.test(w)) set.add(w);
  }
  const sixes = [...set].filter((w) => w.length === ANAGRAMS_LETTERS).sort();
  if (sixes.length === 0) throw new Error('Anagrams needs at least one 6-letter word');
  return { id, words: set, sixes };
}

const counts = (letters: readonly string[]): number[] => {
  const out = new Array<number>(26).fill(0);
  for (const ch of letters) out[ch.charCodeAt(0) - 65] = (out[ch.charCodeAt(0) - 65] ?? 0) + 1;
  return out;
};

/** Can `word` be spelled from `letters` (multiset)? Upper-case A-Z only. */
export function canSpell(letters: readonly string[], word: string): boolean {
  const have = counts(letters);
  for (let i = 0; i < word.length; i++) {
    const k = word.charCodeAt(i) - 65;
    if (k < 0 || k > 25) return false;
    const left = (have[k] ?? 0) - 1;
    if (left < 0) return false;
    have[k] = left;
  }
  return true;
}

/** Every dictionary word that can be spelled from `letters`, sorted. */
export function solveAnagrams(letters: readonly string[], dict: AnagramsDictionary): string[] {
  const out: string[] = [];
  for (const w of dict.words) if (canSpell(letters, w)) out.push(w);
  return out.sort();
}

/** Deterministic: the same seed + dictionary always gives the same six letters. */
export function generateAnagramsLetters(seed: bigint, dict: AnagramsDictionary): string[] {
  const [idx, first] = nextInt(seedRng(seed), dict.sixes.length);
  let rng = first;
  const word = dict.sixes[idx] as string;
  const original = word.split('');
  let letters: string[] = original;
  // Re-shuffle (a few times at most) so the letters do not simply spell the answer.
  for (let attempt = 0; attempt < 8; attempt++) {
    [letters, rng] = shuffle(rng, original);
    if (letters.join('') !== word) return letters;
  }
  // Every letter the same or astronomically unlucky: rotate by one.
  return [...original.slice(1), original[0] as string];
}

// ---------------------------------------------------------------------------------------------
// Engine factory

export function createAnagramsEngine(
  words: readonly string[],
  dictId: string,
): GameEngine<AnagramsState, AnagramsAction, AnagramsCfg> {
  const dict = buildAnagramsDictionary(words, dictId);

  const engine: GameEngine<AnagramsState, AnagramsAction, AnagramsCfg> = {
    slug: 'anagrams',
    actionSchema: anagramsActionSchema,
    timers: { turnMs: ANAGRAMS_ROUND_MS + 10_000 },

    init(players, seed, cfg) {
      if (players.length < 2 || players.length > 8)
        throw new Error('Anagrams needs 2 to 8 players');
      if (new Set(players).size !== players.length) throw new Error('Duplicate players');
      const roundMs = cfg?.roundMs ?? ANAGRAMS_ROUND_MS;
      if (!Number.isInteger(roundMs) || roundMs < 10_000 || roundMs > 600_000) {
        throw new Error('Invalid roundMs');
      }
      const letters = generateAnagramsLetters(seed, dict);
      const possible = solveAnagrams(letters, dict);
      return {
        players: [...players],
        letters,
        roundMs,
        dict: dict.id,
        possibleWords: possible.length,
        possibleScore: anagramsTotalScore(possible),
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
      if (!Array.isArray(a.words) || a.words.length > ANAGRAMS_MAX_WORDS) {
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
      const next: AnagramsState = {
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
        if (seen.has(w)) continue;
        seen.add(w);
        if (dict.words.has(w) && canSpell(s.letters, w)) accepted.push(w);
        else rejected++;
      }
      next.status[by] = 'done';
      next.words[by] = accepted;
      next.scores[by] = anagramsTotalScore(accepted);
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
      const showLetters = over || (mine !== undefined && mine !== 'idle');
      const iAmDone = over || mine === 'done';
      return {
        players: s.players,
        roundMs: s.roundMs,
        dict: s.dict,
        letters: showLetters ? s.letters : null,
        status: s.status,
        scores: Object.fromEntries(
          s.players.map((p) => [p, s.status[p] === 'done' ? (s.scores[p] ?? 0) : null]),
        ),
        words: Object.fromEntries(
          s.players.map((p) => {
            const visible = s.status[p] === 'done' && (p === me || iAmDone);
            return [p, visible ? (s.words[p] ?? []) : null];
          }),
        ),
        rejected: me !== null && s.status[me] === 'done' ? (s.rejected[me] ?? 0) : null,
        possibleWords: iAmDone ? s.possibleWords : null,
        possibleScore: iAmDone ? s.possibleScore : null,
      };
    },
  };
  return engine;
}

/** The default engine, backed by the Word Hunt dictionary (see wordhunt/words.ts for source and licence). */
export const anagramsDictionary: AnagramsDictionary = buildAnagramsDictionary(
  WORD_HUNT_WORDS,
  WORD_HUNT_DICT_ID,
);
export const anagramsEngine = createAnagramsEngine(WORD_HUNT_WORDS, WORD_HUNT_DICT_ID);
