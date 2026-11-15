import fc from 'fast-check';
import { describeEngine } from '../testing/engineHarness.ts';
import { hashState } from '../hash.ts';
import {
  buildWordHuntDictionary,
  createWordHuntEngine,
  findWordHuntPath,
  generateWordHuntBoard,
  solveWordHuntBoard,
  wordHuntActionSchema,
  wordHuntDictionary,
  wordHuntEngine as E,
  wordHuntWordScore,
  type WordHuntAction,
  type WordHuntState,
} from './engine.ts';
import { WORD_HUNT_WORDS } from './words.ts';

const D = wordHuntDictionary;

/** A state on a hand-made board, so tests can name exact words. */
const BOARD = 'SUYA JOLF MEDI RTNK'.replace(/ /g, '').split('');
function onBoard(players = ['a', 'b']): WordHuntState {
  const s = E.init(players, 1n, {});
  return { ...s, board: BOARD };
}
const start = (s: WordHuntState, p: string) => E.apply(s, p, { kind: 'start' });
const submit = (s: WordHuntState, p: string, words: string[]) =>
  E.apply(s, p, { kind: 'submit', words });

describeEngine(E, {
  playerCounts: [2, 3],
  cfg: {},
  numRuns: 40,
  candidates: (s, by): WordHuntAction[] => {
    if (s.status[by] === 'idle') return [{ kind: 'start' }];
    const words = solveWordHuntBoard(s.board, D);
    return [
      { kind: 'submit', words: [] },
      { kind: 'submit', words: words.slice(0, 5) },
      { kind: 'submit', words: [...words, 'ZZZZ', 'QQQ'] },
    ];
  },
  illegal: (s, by): WordHuntAction[] => {
    if (s.status[by] === 'idle') return [{ kind: 'submit', words: ['CAT'] }];
    if (s.status[by] === 'playing') return [{ kind: 'start' }, { kind: 'submit', words: ['a b'] }];
    return [{ kind: 'start' }, { kind: 'submit', words: [] }];
  },
});

describe('word hunt dictionary', () => {
  it('only holds clean upper-case 3–8 letter words', () => {
    expect(WORD_HUNT_WORDS.length).toBeGreaterThan(3000);
    for (const w of WORD_HUNT_WORDS) expect(w).toMatch(/^[A-Z]{3,8}$/);
    expect(new Set(WORD_HUNT_WORDS).size).toBe(WORD_HUNT_WORDS.length);
  });

  it('has the Nigerian words the design shows', () => {
    for (const w of ['SUYA', 'JOLLOF', 'DANFO', 'OKADA', 'AGBADA', 'NAIRA']) {
      expect(WORD_HUNT_WORDS).toContain(w);
    }
  });
});

describe('word hunt board generator', () => {
  it('is deterministic from the seed and different across seeds', () => {
    const a = generateWordHuntBoard(42n, D);
    const b = generateWordHuntBoard(42n, D);
    expect(a).toEqual(b);
    const boards = new Set<string>();
    for (let seed = 0n; seed < 20n; seed++)
      boards.add(generateWordHuntBoard(seed, D).board.join(''));
    expect(boards.size).toBe(20);
  });

  it('always makes a 16-letter grid with enough words and a sane vowel count', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), (seed) => {
        const { board, words } = generateWordHuntBoard(seed, D, 25);
        expect(board).toHaveLength(16);
        for (const ch of board) expect(ch).toMatch(/^[A-Z]$/);
        expect(words.length).toBeGreaterThanOrEqual(25);
        const vowels = board.filter((c) => 'AEIOU'.includes(c)).length;
        expect(vowels).toBeGreaterThanOrEqual(3);
        expect(vowels).toBeLessThanOrEqual(7);
      }),
      { numRuns: 60 },
    );
  });

  it('every word the solver returns can be traced, and the engine accepts all of them', () => {
    const s0 = E.init(['a', 'b'], 5n, {});
    const words = solveWordHuntBoard(s0.board, D);
    expect(words).toHaveLength(s0.possibleWords);
    for (const w of words) expect(findWordHuntPath(s0.board, w)).not.toBeNull();
    const s = submit(start(s0, 'a'), 'a', words);
    expect(s.words.a).toHaveLength(words.length);
    expect(s.rejected.a).toBe(0);
    expect(s.scores.a).toBe(s0.possibleScore);
  });
});

describe('word hunt word finding', () => {
  it('traces words across neighbouring cells, diagonals included', () => {
    expect(findWordHuntPath(BOARD, 'SUYA')).toEqual([0, 1, 2, 3]);
    expect(findWordHuntPath(BOARD, 'suya')).toEqual([0, 1, 2, 3]);
    // S(0) → J(4)? S-J are vertical neighbours; "SOLD"? S(0) O(5)… this board has JOLF row: J4 O5 L6 F7
    expect(findWordHuntPath(BOARD, 'JOLF')).toEqual([4, 5, 6, 7]);
  });

  it('never reuses a cell and never jumps', () => {
    // "SUS" would need S twice; "SMA" jumps (S0 → M8 is two rows away).
    expect(findWordHuntPath(BOARD, 'SUS')).toBeNull();
    expect(findWordHuntPath(BOARD, 'SMA')).toBeNull();
    expect(
      findWordHuntPath(
        ['A', 'B', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N'],
        'ABA',
      ),
    ).toEqual([0, 1, 2]);
  });

  it('rejects words shorter than 3 letters', () => {
    expect(findWordHuntPath(BOARD, 'SU')).toBeNull();
  });
});

describe('word hunt rules', () => {
  it('scores by length', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 12].map(wordHuntWordScore)).toEqual([
      0, 0, 0, 1, 2, 4, 6, 9, 12, 12,
    ]);
  });

  it('start → submit, once each, in order', () => {
    const s = onBoard();
    expect(E.currentPlayers(s)).toEqual(['a', 'b']);
    expect(E.validate(s, 'a', { kind: 'submit', words: ['SUYA'] })).toEqual({
      ok: false,
      code: 'not_started',
    });
    expect(E.validate(s, 'a', { kind: 'start' })).toEqual({ ok: true });
    const a = start(s, 'a');
    expect(E.validate(a, 'a', { kind: 'start' })).toEqual({ ok: false, code: 'already_started' });
    expect(E.validate(a, 'a', { kind: 'submit', words: [] }).ok).toBe(true);
    const done = submit(a, 'a', []);
    expect(E.validate(done, 'a', { kind: 'submit', words: [] })).toEqual({
      ok: false,
      code: 'already_played',
    });
    expect(E.validate(done, 'a', { kind: 'start' })).toEqual({ ok: false, code: 'already_played' });
    expect(E.currentPlayers(done)).toEqual(['b']);
    expect(E.validate(s, 'zed', { kind: 'start' })).toEqual({ ok: false, code: 'not_a_player' });
  });

  it('counts only dictionary words that are on the grid; duplicates once; case ignored', () => {
    let s = start(onBoard(), 'a');
    s = submit(s, 'a', ['suya', 'SUYA', 'JOLF', 'SUY', 'SU', 'ZZZ', 'DIRT', 'MEDI']);
    // SUYA (4 → 2), SUY not a word, SU too short, JOLF not a word, ZZZ off-grid, DIRT not traceable
    // (D(10) I(11) R(12)? R is at 12, which is not adjacent to I(11)? 11→12 is a row jump), MEDI not a word.
    expect(s.words.a).toEqual(['SUYA']);
    expect(s.scores.a).toBe(2);
    expect(s.rejected.a).toBe(6);
  });

  it('the higher score wins; equal scores draw', () => {
    let s = onBoard();
    s = submit(start(s, 'a'), 'a', ['SUYA']);
    s = submit(start(s, 'b'), 'b', []);
    expect(E.isTerminal(s)).toBe(true);
    expect(E.currentPlayers(s)).toEqual([]);
    expect(E.result(s)).toEqual({ placements: [['a'], ['b']], draw: false });

    let t = onBoard();
    t = submit(start(t, 'a'), 'a', ['SUYA']);
    t = submit(start(t, 'b'), 'b', ['SUYA']);
    expect(E.result(t)).toEqual({ placements: [['a', 'b']], draw: true });
  });

  it('ranks three players and groups ties', () => {
    let s = onBoard(['a', 'b', 'c']);
    s = submit(start(s, 'a'), 'a', []);
    s = submit(start(s, 'b'), 'b', ['SUYA']);
    s = submit(start(s, 'c'), 'c', []);
    expect(E.result(s)).toEqual({ placements: [['b'], ['a', 'c']], draw: false });
  });

  it('is not terminal, and has no result, until everyone has played', () => {
    const s = submit(start(onBoard(), 'a'), 'a', ['SUYA']);
    expect(E.isTerminal(s)).toBe(false);
    expect(E.result(s)).toEqual({ placements: [], draw: false });
  });

  it('apply never mutates the input', () => {
    const s = start(onBoard(), 'a');
    const before = JSON.stringify(s);
    submit(s, 'a', ['SUYA']);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('init validates players and config', () => {
    expect(() => E.init(['a'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'a'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'b'], 1n, { roundMs: 5 })).toThrow();
    expect(E.init(['a', 'b'], 1n, { roundMs: 60_000 }).roundMs).toBe(60_000);
    expect(E.init(['a', 'b'], 1n, {}).roundMs).toBe(80_000);
  });

  it('both players get the identical grid', () => {
    const s = E.init(['a', 'b'], 77n, {});
    const va = E.view(start(s, 'a'), 'a') as { board: string[] };
    const vb = E.view(start(s, 'b'), 'b') as { board: string[] };
    expect(va.board).toEqual(vb.board);
  });

  it('a custom dictionary changes what counts (and is recorded in the state)', () => {
    const tiny = createWordHuntEngine(['SUY', 'JOL', 'AYS'].concat(WORD_HUNT_WORDS), 'test-dict');
    const s0 = { ...tiny.init(['a', 'b'], 3n, {}), board: BOARD };
    expect(s0.dict).toBe('test-dict');
    const s = tiny.apply(tiny.apply(s0, 'a', { kind: 'start' }), 'a', {
      kind: 'submit',
      words: ['SUY', 'JOL'],
    });
    expect(s.words.a).toEqual(['SUY', 'JOL']);
    expect(buildWordHuntDictionary(['abc', 'x', 'ABC'], 'x').size).toBe(1);
  });
});

describe('word hunt views hide what they must', () => {
  const base = onBoard();

  it('hides the grid until the viewer starts (and from spectators until the end)', () => {
    expect((E.view(base, 'a') as { board: unknown }).board).toBeNull();
    expect((E.view(base, 'spectator') as { board: unknown }).board).toBeNull();
    const a = start(base, 'a');
    expect((E.view(a, 'a') as { board: unknown }).board).toEqual(BOARD);
    // b has not started: still blind even though a has.
    expect((E.view(a, 'b') as { board: unknown }).board).toBeNull();
    expect(JSON.stringify(E.view(a, 'b'))).not.toContain('SUYAJOLF');
  });

  it("shows an opponent's score once they are done, but not their words until you are", () => {
    let s = submit(start(base, 'a'), 'a', ['SUYA']);
    type V = {
      scores: Record<string, number | null>;
      words: Record<string, string[] | null>;
      possibleWords: number | null;
    };
    const vb = E.view(s, 'b') as V;
    expect(vb.scores).toEqual({ a: 2, b: null });
    expect(vb.words.a).toBeNull();
    expect(vb.possibleWords).toBeNull();
    // the owner sees their own words
    expect((E.view(s, 'a') as V).words.a).toEqual(['SUYA']);
    // once b is done too, everyone sees everything
    s = submit(start(s, 'b'), 'b', ['JOLF']);
    const after = E.view(s, 'b') as V;
    expect(after.words.a).toEqual(['SUYA']);
    expect(after.possibleWords).toBe(s.possibleWords);
    expect((E.view(s, 'spectator') as V).words.b).toEqual([]);
  });

  it('a player in the middle of a round cannot see anyone else words', () => {
    let s = submit(start(base, 'a'), 'a', ['SUYA']);
    s = start(s, 'b');
    expect((E.view(s, 'b') as { words: Record<string, unknown> }).words.a).toBeNull();
  });

  it('is JSON-safe and carries no seed or RNG', () => {
    const v = JSON.stringify(E.view(start(base, 'a'), 'a'));
    expect(v).not.toContain('seed');
    expect(v).not.toContain('rng');
    expect(Object.keys(E.init(['a', 'b'], 1n, {}))).not.toContain('rng');
  });
});

describe('word hunt wire schema', () => {
  it('accepts start and submit; rejects junk', () => {
    expect(wordHuntActionSchema.safeParse({ kind: 'start' }).success).toBe(true);
    expect(wordHuntActionSchema.safeParse({ kind: 'submit', words: ['cat', 'DOG'] }).success).toBe(
      true,
    );
    expect(wordHuntActionSchema.safeParse({ kind: 'submit', words: ['c4t'] }).success).toBe(false);
    expect(
      wordHuntActionSchema.safeParse({ kind: 'submit', words: ['a'.repeat(17)] }).success,
    ).toBe(false);
    expect(
      wordHuntActionSchema.safeParse({
        kind: 'submit',
        words: Array.from({ length: 401 }, () => 'cat'),
      }).success,
    ).toBe(false);
    expect(wordHuntActionSchema.safeParse({ kind: 'submit' }).success).toBe(false);
  });
});

describe('word hunt scenario', () => {
  it('a fixed seed plays out to a stable hash', () => {
    const play = (): string => {
      let s = E.init(['a', 'b'], 20240101n, {});
      const words = solveWordHuntBoard(s.board, D);
      s = submit(
        start(s, 'a'),
        'a',
        words.filter((_, i) => i % 2 === 0),
      );
      s = submit(
        start(s, 'b'),
        'b',
        words.filter((_, i) => i % 3 === 0),
      );
      return hashState(s);
    };
    expect(play()).toBe(play());
  });
});
