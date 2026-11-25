import { hashState } from '../hash.ts';
import { describeEngine } from '../testing/engineHarness.ts';
import {
  anagramsActionSchema,
  anagramsDictionary as DICT,
  anagramsEngine as E,
  anagramsWordScore,
  canSpell,
  createAnagramsEngine,
  generateAnagramsLetters,
  solveAnagrams,
  type AnagramsAction,
  type AnagramsState,
} from './engine.ts';

const init = (seed = 7n, players = ['a', 'b']): AnagramsState => E.init(players, seed, {});

describe('anagrams letters', () => {
  it('are six upper-case letters, deterministic per seed, and hold a 6-letter word', () => {
    for (const seed of [1n, 2n, 99n, 123456789n]) {
      const letters = generateAnagramsLetters(seed, DICT);
      expect(letters).toHaveLength(6);
      expect(letters.every((l) => /^[A-Z]$/.test(l))).toBe(true);
      expect(generateAnagramsLetters(seed, DICT)).toEqual(letters);
      const full = solveAnagrams(letters, DICT).filter((w) => w.length === 6);
      expect(full.length).toBeGreaterThanOrEqual(1);
      // never handed over already spelled
      expect(full).not.toContain(letters.join(''));
    }
  });

  it('differ between seeds', () => {
    const seen = new Set<string>();
    for (let i = 1n; i <= 12n; i++) seen.add(generateAnagramsLetters(i, DICT).join(''));
    expect(seen.size).toBeGreaterThan(6);
  });

  it('canSpell counts letters, not just presence', () => {
    expect(canSpell(['T', 'E', 'A', 'M', 'S', 'X'], 'MEAT')).toBe(true);
    expect(canSpell(['T', 'E', 'A', 'M', 'S', 'X'], 'MEET')).toBe(false);
    expect(canSpell(['T', 'E', 'A', 'M', 'S', 'X'], 'TEAMS')).toBe(true);
    expect(canSpell(['T', 'E', 'A', 'M', 'S', 'X'], 'STEAMY')).toBe(false);
  });

  it('scores by length, all six letters is the bonus', () => {
    expect([2, 3, 4, 5, 6, 7].map(anagramsWordScore)).toEqual([0, 1, 2, 4, 10, 0]);
  });
});

describe('anagrams engine', () => {
  it('needs 2 to 8 distinct players and a sane round length', () => {
    expect(() => E.init(['a'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'a'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'b'], 1n, { roundMs: 5 })).toThrow();
    expect(E.init(['a', 'b', 'c'], 1n, { roundMs: 30_000 }).roundMs).toBe(30_000);
  });

  it('both players get the same letters, and both may act at once', () => {
    const s = init();
    expect(E.currentPlayers(s)).toEqual(['a', 'b']);
    const va = E.view(s, 'a') as { letters: string[] | null };
    expect(va.letters).toBeNull();
    const a = E.apply(s, 'a', { kind: 'start' });
    const b = E.apply(a, 'b', { kind: 'start' });
    expect((E.view(b, 'a') as { letters: string[] }).letters).toEqual(
      (E.view(b, 'b') as { letters: string[] }).letters,
    );
  });

  it('enforces start → submit, once', () => {
    const s = init();
    expect(E.validate(s, 'a', { kind: 'submit', words: [] })).toEqual({
      ok: false,
      code: 'not_started',
    });
    expect(E.validate(s, 'zed', { kind: 'start' })).toEqual({ ok: false, code: 'not_a_player' });
    const a = E.apply(s, 'a', { kind: 'start' });
    expect(E.validate(a, 'a', { kind: 'start' })).toEqual({ ok: false, code: 'already_started' });
    const done = E.apply(a, 'a', { kind: 'submit', words: [] });
    expect(E.validate(done, 'a', { kind: 'start' })).toEqual({ ok: false, code: 'already_played' });
    expect(E.validate(done, 'a', { kind: 'submit', words: [] }).ok).toBe(false);
    expect(E.currentPlayers(done)).toEqual(['b']);
  });

  it('rejects malformed submissions', () => {
    const a = E.apply(init(), 'a', { kind: 'start' });
    expect(E.validate(a, 'a', { kind: 'submit', words: ['ok1'] })).toEqual({
      ok: false,
      code: 'bad_word',
    });
    expect(
      E.validate(a, 'a', { kind: 'submit', words: Array.from({ length: 201 }, () => 'CAT') }),
    ).toEqual({ ok: false, code: 'too_many_words' });
  });

  it('scores real words, drops invalid / unspellable ones and counts duplicates once', () => {
    let s = init(3n);
    const letters = s.letters;
    const all = solveAnagrams(letters, DICT);
    const six = all.filter((w) => w.length === 6);
    const three = all.filter((w) => w.length === 3).slice(0, 2);
    s = E.apply(s, 'a', { kind: 'start' });
    s = E.apply(s, 'a', {
      kind: 'submit',
      words: [
        six[0]!.toLowerCase(),
        six[0]!, // duplicate, free
        ...three,
        'QQQQQQ', // not a word
        'ZZZZ', // not a word / not spellable
      ],
    });
    expect(s.words['a']).toEqual([six[0], ...three]);
    expect(s.scores['a']).toBe(10 + three.length);
    expect(s.rejected['a']).toBe(2);
  });

  it('a word in the dictionary that the letters cannot spell is rejected', () => {
    let s = init(11n);
    const unspellable = [...DICT.words].find(
      (w) => w.length === 4 && !canSpell(s.letters, w),
    ) as string;
    s = E.apply(s, 'a', { kind: 'start' });
    s = E.apply(s, 'a', { kind: 'submit', words: [unspellable] });
    expect(s.words['a']).toEqual([]);
    expect(s.rejected['a']).toBe(1);
  });

  it('apply never mutates its input', () => {
    const s = init();
    const before = hashState(s);
    E.apply(s, 'a', { kind: 'start' });
    expect(hashState(s)).toBe(before);
  });

  it('ends when everyone has played; most points win, equal is a draw', () => {
    let s = init(5n);
    const full = solveAnagrams(s.letters, DICT);
    for (const p of ['a', 'b']) s = E.apply(s, p, { kind: 'start' });
    expect(E.isTerminal(s)).toBe(false);
    expect(E.result(s)).toEqual({ placements: [], draw: false });
    s = E.apply(s, 'a', { kind: 'submit', words: full });
    s = E.apply(s, 'b', { kind: 'submit', words: [] });
    expect(E.isTerminal(s)).toBe(true);
    expect(E.currentPlayers(s)).toEqual([]);
    expect(E.result(s)).toEqual({ placements: [['a'], ['b']], draw: false });

    let t = init(5n);
    for (const p of ['a', 'b'])
      t = E.apply(E.apply(t, p, { kind: 'start' }), p, { kind: 'submit', words: [] });
    expect(E.result(t)).toEqual({ placements: [['a', 'b']], draw: true });
  });

  it('view hides letters until you start, and others’ words until you are done', () => {
    let s = init(5n);
    const full = solveAnagrams(s.letters, DICT);
    expect((E.view(s, 'spectator') as { letters: unknown }).letters).toBeNull();
    s = E.apply(s, 'a', { kind: 'start' });
    expect((E.view(s, 'a') as { letters: unknown }).letters).toEqual(s.letters);
    expect((E.view(s, 'b') as { letters: unknown }).letters).toBeNull();
    s = E.apply(s, 'a', { kind: 'submit', words: full });
    // b has not started: sees a's score but not the words, nor the possible total
    const vb = E.view(s, 'b') as {
      scores: Record<string, number | null>;
      words: Record<string, string[] | null>;
      possibleWords: number | null;
      letters: unknown;
    };
    expect(vb.scores['a']).toBe(s.scores['a']);
    expect(vb.scores['b']).toBeNull();
    expect(vb.words['a']).toBeNull();
    expect(vb.possibleWords).toBeNull();
    expect(vb.letters).toBeNull();
    // a sees their own words, and the possible total
    const va = E.view(s, 'a') as typeof vb;
    expect(va.words['a']).toEqual(s.words['a']);
    expect(va.possibleWords).toBe(s.possibleWords);
    // once b is done, everything opens up
    s = E.apply(E.apply(s, 'b', { kind: 'start' }), 'b', { kind: 'submit', words: [] });
    const vb2 = E.view(s, 'b') as typeof vb;
    expect(vb2.words['a']).toEqual(s.words['a']);
  });

  it('actionSchema accepts the wire shapes and rejects junk', () => {
    expect(anagramsActionSchema.safeParse({ kind: 'start' }).success).toBe(true);
    expect(anagramsActionSchema.safeParse({ kind: 'submit', words: ['cat', 'Dog'] }).success).toBe(
      true,
    );
    expect(anagramsActionSchema.safeParse({ kind: 'submit', words: ['c4t'] }).success).toBe(false);
    expect(anagramsActionSchema.safeParse({ kind: 'submit' }).success).toBe(false);
    expect(anagramsActionSchema.safeParse({ kind: 'nope' }).success).toBe(false);
  });

  it('an injected dictionary changes the id and the accepted words', () => {
    const tiny = createAnagramsEngine(['PLANET', 'PLANT', 'PANEL', 'PLAN', 'LAP'], 'tiny-1');
    const s = tiny.init(['a', 'b'], 9n, {});
    expect(s.dict).toBe('tiny-1');
    expect([...s.letters].sort().join('')).toBe('AELNPT');
    expect(s.possibleWords).toBe(5);
    expect(s.possibleScore).toBe(10 + 4 + 4 + 2 + 1);
  });

  it('a 6-letter dictionary entry is required', () => {
    expect(() => createAnagramsEngine(['CAT', 'DOG'], 'x')).toThrow();
  });
});

describeEngine<AnagramsState, AnagramsAction, object>(E, {
  playerCounts: [2, 3],
  cfg: {},
  numRuns: 40,
  maxSteps: 60,
  candidates: (s, by) => {
    const st = s.status[by];
    if (st === 'idle') return [{ kind: 'start' }];
    const words = solveAnagrams(s.letters, DICT);
    return [{ kind: 'submit', words: words.filter((_, i) => i % 2 === 0) }];
  },
  illegal: (s, by) => (s.status[by] === 'done' ? [{ kind: 'start' }] : []),
});
