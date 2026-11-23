import { hashState } from '../hash.ts';
import { describeEngine } from '../testing/engineHarness.ts';
import {
  BOARD_SIZE,
  CENTER,
  RACK_SIZE,
  WORD_TILES_DISTRIBUTION,
  WORD_TILES_LETTER_VALUES,
  WORD_TILES_PREMIUMS,
  createWordTilesEngine,
  makeWordSet,
  rackHolds,
  wordTilesActionSchema,
  wordTilesAnalysePlay,
  wordTilesEngine as DEFAULT_ENGINE,
  wordTilesPlays,
  wordTilesPremium,
  wordTilesWordSet,
  type WordTilesAction,
  type WordTilesState,
  type WordTilesTile,
} from './engine.ts';
import { WORD_TILES_WORDS } from './words.ts';

const WORDS = [
  'CAT', 'CATS', 'AT', 'TA', 'AS', 'SO', 'TO', 'ON', 'NO', 'AN', 'PLANETS', 'ZA', 'AD', 'DO', 'ED', 'ER',
]; // prettier-ignore
const WS = makeWordSet(WORDS, 'test-1');
const E = createWordTilesEngine(WS);
const at = (r: number, c: number, letter: string, blank?: boolean): WordTilesTile =>
  blank ? { r, c, letter, blank: true } : { r, c, letter };
const idx = (r: number, c: number): number => r * BOARD_SIZE + c;

type S = WordTilesState;
const init = (seed = 1n, players = ['a', 'b']): S => E.init(players, seed, {});

function withRack(s: S, p: string, rack: string[]): S {
  return { ...s, racks: { ...s.racks, [p]: rack } };
}
function withBoard(s: S, cells: Record<string, string>): S {
  const board = s.board.slice();
  for (const [k, v] of Object.entries(cells)) {
    const [r, c] = k.split(',').map(Number) as [number, number];
    board[idx(r, c)] = v;
  }
  return { ...s, board };
}
const play = (s: S, by: string, tiles: WordTilesTile[]): S => {
  const v = E.validate(s, by, { kind: 'play', tiles });
  if (!v.ok) throw new Error(`play refused: ${v.code}`);
  return E.apply(s, by, { kind: 'play', tiles });
};
const catRow = (): Record<string, string> => ({ '7,5': 'C', '7,6': 'A', '7,7': 'T' });
/** A fresh state with CAT already on the board (row 7, columns 5-7) and 'b' to move. */
function afterCat(): S {
  return { ...withBoard(init(), catRow()), turn: 1 };
}

describe('word tiles board and tiles', () => {
  it('premium layout is symmetric in all eight ways, centre is a double word, no square twice', () => {
    const n = BOARD_SIZE - 1;
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        const p = wordTilesPremium(r, c);
        expect(wordTilesPremium(c, r)).toBe(p);
        expect(wordTilesPremium(n - r, c)).toBe(p);
        expect(wordTilesPremium(r, n - c)).toBe(p);
      }
    }
    expect(wordTilesPremium(CENTER, CENTER)).toBe('DW');
    const count = (k: string): number => WORD_TILES_PREMIUMS.filter((p) => p === k).length;
    expect([count('TW'), count('DW'), count('TL'), count('DL')]).toEqual([8, 13, 12, 20]);
  });

  it('has 102 tiles (2 blanks) and a value for every letter', () => {
    expect(Object.values(WORD_TILES_DISTRIBUTION).reduce((a, b) => a + b, 0)).toBe(102);
    expect(WORD_TILES_DISTRIBUTION['?']).toBe(2);
    for (const l of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      expect(WORD_TILES_LETTER_VALUES[l]).toBeGreaterThan(0);
      expect(WORD_TILES_DISTRIBUTION[l]).toBeGreaterThan(0);
    }
  });

  it('the default word list is upper-case, 2+ letters, and has the common short words', () => {
    expect(WORD_TILES_WORDS.every((w) => /^[A-Z]{2,15}$/.test(w))).toBe(true);
    expect(wordTilesWordSet.has('QUICK') || wordTilesWordSet.has('WORLD')).toBe(true);
    expect(wordTilesWordSet.has('XQZVV')).toBe(false);
    expect(wordTilesWordSet.has('TO')).toBe(true);
    expect(DEFAULT_ENGINE.init(['a', 'b'], 1n, {}).dict).toBe('dyce-v1');
  });
});

describe('word tiles init', () => {
  it('2 to 4 distinct players, 7 tiles each, the rest in the bag, deterministic per seed', () => {
    expect(() => E.init(['a'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'b', 'c', 'd', 'e'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'a'], 1n, {})).toThrow();
    for (const n of [2, 3, 4]) {
      const players = ['a', 'b', 'c', 'd'].slice(0, n);
      const s = E.init(players, 5n, {});
      for (const p of players) expect(s.racks[p]).toHaveLength(RACK_SIZE);
      expect(s.bag).toHaveLength(102 - 7 * n);
      expect(s.board.every((x) => x === '')).toBe(true);
      expect(s.dict).toBe('test-1');
      expect(hashState(E.init(players, 5n, {}))).toBe(hashState(s));
    }
    expect(init(1n).racks).not.toEqual(init(2n).racks);
  });

  it('the whole tile set is dealt exactly once', () => {
    const s = init(9n);
    const all = [...s.bag, ...s.racks['a']!, ...s.racks['b']!].sort();
    const want: string[] = [];
    for (const [l, n] of Object.entries(WORD_TILES_DISTRIBUTION))
      for (let i = 0; i < n; i++) want.push(l);
    expect(all).toEqual(want.sort());
  });

  it('players[0] moves first', () => {
    expect(E.currentPlayers(init())).toEqual(['a']);
  });
});

describe('word tiles first move', () => {
  const rack = ['C', 'A', 'T', 'S', 'E', 'R', 'D'];
  const s0 = withRack(init(), 'a', rack);

  it('must cover the centre and be two tiles or more', () => {
    expect(
      E.validate(s0, 'a', { kind: 'play', tiles: [at(7, 8, 'C'), at(7, 9, 'A'), at(7, 10, 'T')] }),
    ).toEqual({ ok: false, code: 'must_cover_center' });
    expect(E.validate(s0, 'a', { kind: 'play', tiles: [at(7, 7, 'A')] })).toEqual({
      ok: false,
      code: 'first_word_too_short',
    });
  });

  it('scores letters with the centre double word: CAT on the star = (2+1+1) x 2', () => {
    const s = play(s0, 'a', [at(7, 5, 'C'), at(7, 6, 'A'), at(7, 7, 'T')]);
    expect(s.scores['a']).toBe(8);
    expect(s.last).toMatchObject({ kind: 'play', score: 8, by: 'a', bingo: false });
    expect(s.last?.words).toEqual([{ word: 'CAT', score: 8 }]);
    expect(s.board[idx(7, 5)]).toBe('C');
    expect(s.racks['a']).toHaveLength(7); // refilled from the bag
    expect(s.bag).toHaveLength(init().bag.length - 3);
    expect(s.turn).toBe(1);
    expect(E.currentPlayers(s)).toEqual(['b']);
  });

  it('a vertical first word works too', () => {
    const s = play(s0, 'a', [at(5, 7, 'C'), at(6, 7, 'A'), at(7, 7, 'T')]);
    // (5,7) none, (6,7) none, (7,7) DW
    expect(s.scores['a']).toBe(8);
  });

  it('seven tiles in one play earn the 30 point bonus', () => {
    const rk = ['P', 'L', 'A', 'N', 'E', 'T', 'S'];
    const s = play(withRack(init(), 'a', rk), 'a', [
      at(7, 1, 'P'),
      at(7, 2, 'L'),
      at(7, 3, 'A'),
      at(7, 4, 'N'),
      at(7, 5, 'E'),
      at(7, 6, 'T'),
      at(7, 7, 'S'),
    ]);
    // P 3 on a TL = 9, L 1 on a DL = 2, then 1+1+1+1 and S on the DW: (9+2+4+1) x 2 = 32, +30
    expect(s.scores['a']).toBe(62);
    expect(s.last?.bingo).toBe(true);
  });
});

describe('word tiles play rules', () => {
  it('turn order', () => {
    const s = withRack(afterCat(), 'b', ['T', 'A', 'S', 'S', 'S', 'S', 'S']);
    expect(E.validate(s, 'a', { kind: 'pass' })).toEqual({ ok: false, code: 'not_your_turn' });
  });

  it('extends a word with one tile (hook), scoring only what is on the board', () => {
    const s = withRack(afterCat(), 'b', ['S', 'S', 'E', 'E', 'E', 'E', 'E']);
    const n = play(s, 'b', [at(7, 8, 'S')]);
    expect(n.scores['b']).toBe(5); // CATS = 2+1+1+1; the star was used by the first move
    expect(n.last?.words).toEqual([{ word: 'CATS', score: 5 }]);
  });

  it('scores the main word and every cross word, premiums only under new tiles', () => {
    const s = withRack(afterCat(), 'b', ['T', 'A', 'E', 'E', 'E', 'E', 'E']);
    const n = play(s, 'b', [at(8, 6, 'T'), at(8, 7, 'A')]);
    // main TA (T on a DL): 2+1 = 3; cross AT (col 6): 1 + 2 = 3; cross TA (col 7): 1 + 1 = 2
    expect(n.last?.words.map((w) => `${w.word}:${w.score}`).sort()).toEqual([
      'AT:3',
      'TA:2',
      'TA:3',
    ]);
    expect(n.scores['b']).toBe(8);
  });

  it('a blank is worth nothing and shows in lower case', () => {
    const s = withRack(afterCat(), 'b', ['?', 'A', 'E', 'E', 'E', 'E', 'E']);
    const n = play(s, 'b', [at(8, 6, 'T', true), at(8, 7, 'A')]);
    expect(n.board[idx(8, 6)]).toBe('t');
    expect(n.racks['b']).not.toContain('?');
    expect(n.scores['b']).toBe(4); // TA: 0+1, AT: 1+0, TA: 1+1
    expect(n.last?.tiles[0]).toEqual({ r: 8, c: 6, letter: 'T', blank: true });
  });

  it('refuses each kind of illegal play with its own code', () => {
    const base = withRack(afterCat(), 'b', ['T', 'A', 'S', 'Z', 'Z', 'Q', 'E']);
    const code = (tiles: WordTilesTile[]): string | undefined => {
      const v = E.validate(base, 'b', { kind: 'play', tiles });
      return v.ok ? undefined : v.code;
    };
    expect(code([at(8, 5, 'T'), at(9, 6, 'A')])).toBe('not_in_line');
    expect(code([at(8, 6, 'T'), at(8, 8, 'A')])).toBe('gap');
    expect(code([at(0, 0, 'T'), at(0, 1, 'A')])).toBe('not_connected');
    expect(code([at(7, 5, 'T'), at(7, 4, 'A')])).toBe('square_taken');
    expect(code([at(8, 6, 'T'), at(8, 6, 'A')])).toBe('duplicate_square');
    expect(code([at(8, 6, 'O')])).toBe('tiles_not_in_rack');
    expect(code([at(8, 6, 'T'), at(8, 7, 'T')])).toBe('tiles_not_in_rack'); // only one T
    expect(code([at(8, 6, 'Z')])).toBe('invalid_word'); // AZ
    expect(code([at(8, 6, 'Q'), at(8, 7, 'Z')])).toBe('invalid_word');
    expect(code([at(15, 6, 'T')])).toBe('off_board');
    expect(code([at(8, -1, 'T')])).toBe('off_board');
    expect(code([])).toBe('no_tiles');
    expect(code(Array.from({ length: 8 }, (_, i) => at(8, i, 'T')))).toBe('too_many_tiles');
  });

  it('reports which words were invalid', () => {
    const rk = ['Z', 'Q', 'E', 'E', 'E', 'E', 'E'];
    const res = wordTilesAnalysePlay(afterCat().board, rk, [at(8, 6, 'Z'), at(8, 7, 'Q')], WS);
    expect(res).toEqual({ ok: false, code: 'invalid_word', invalid: ['ZQ', 'AZ', 'TQ'] });
  });

  it('only the injected word set decides what is a word', () => {
    const rk = ['O', 'E', 'E', 'E', 'E', 'E', 'E'];
    const tiles = [at(8, 7, 'O')]; // TO
    expect(wordTilesAnalysePlay(afterCat().board, rk, tiles, WS).ok).toBe(true);
    expect(wordTilesAnalysePlay(afterCat().board, rk, tiles, makeWordSet(['CAT'], 'x')).ok).toBe(
      false,
    );
  });

  it('apply never mutates its input and is deterministic', () => {
    const s = withRack(afterCat(), 'b', ['T', 'A', 'E', 'E', 'E', 'E', 'E']);
    const before = hashState(s);
    const t = [at(8, 6, 'T'), at(8, 7, 'A')];
    const a = play(s, 'b', t);
    expect(hashState(s)).toBe(before);
    expect(hashState(play(s, 'b', t))).toBe(hashState(a));
  });
});

describe('word tiles exchange and pass', () => {
  it('exchange swaps tiles, keeps the rack full, reshuffles the bag, costs a turn', () => {
    const s = init(3n);
    const give = s.racks['a']!.slice(0, 3);
    const n = E.apply(s, 'a', { kind: 'exchange', letters: give });
    expect(n.racks['a']).toHaveLength(7);
    expect(n.bag).toHaveLength(s.bag.length);
    expect([...n.racks['a']!, ...n.bag].sort()).toEqual([...s.racks['a']!, ...s.bag].sort());
    expect(n.bag).not.toEqual(s.bag);
    expect(n.scoreless).toBe(1);
    expect(n.turn).toBe(1);
    expect(n.last).toMatchObject({ kind: 'exchange', exchanged: 3, score: 0 });
  });

  it('exchange needs tiles you hold and a bag of at least a full rack', () => {
    const s = withRack(init(), 'a', ['A', 'A', 'B', 'C', 'D', 'E', 'F']);
    expect(E.validate(s, 'a', { kind: 'exchange', letters: ['Z'] })).toEqual({
      ok: false,
      code: 'tiles_not_in_rack',
    });
    expect(E.validate(s, 'a', { kind: 'exchange', letters: ['A', 'A', 'A'] })).toEqual({
      ok: false,
      code: 'tiles_not_in_rack',
    });
    expect(E.validate(s, 'a', { kind: 'exchange', letters: [] })).toEqual({
      ok: false,
      code: 'bad_exchange',
    });
    expect(
      E.validate({ ...s, bag: s.bag.slice(0, 6) }, 'a', { kind: 'exchange', letters: ['A'] }),
    ).toEqual({
      ok: false,
      code: 'bag_too_small',
    });
    expect(
      E.validate({ ...s, bag: s.bag.slice(0, 7) }, 'a', { kind: 'exchange', letters: ['A'] }).ok,
    ).toBe(true);
  });

  it('a pass costs a turn; everyone passing twice in a row ends the game and each loses their rack', () => {
    let s = init(4n, ['a', 'b']);
    s = { ...s, scores: { a: 10, b: 20 } };
    const va = s.racks['a']!.reduce((n, l) => n + (WORD_TILES_LETTER_VALUES[l] ?? 0), 0);
    const vb = s.racks['b']!.reduce((n, l) => n + (WORD_TILES_LETTER_VALUES[l] ?? 0), 0);
    for (let i = 0; i < 3; i++) {
      s = E.apply(s, E.currentPlayers(s)[0]!, { kind: 'pass' });
      expect(E.isTerminal(s)).toBe(false);
    }
    s = E.apply(s, E.currentPlayers(s)[0]!, { kind: 'pass' });
    expect(E.isTerminal(s)).toBe(true);
    expect(s.endReason).toBe('passes');
    expect(s.scores).toEqual({ a: 10 - va, b: 20 - vb });
    expect(E.currentPlayers(s)).toEqual([]);
    expect(E.validate(s, 'a', { kind: 'pass' })).toEqual({ ok: false, code: 'game_over' });
  });

  it('a play resets the pass streak', () => {
    let s = withRack(afterCat(), 'b', ['T', 'A', 'E', 'E', 'E', 'E', 'E']);
    s = E.apply({ ...s, turn: 0 }, 'a', { kind: 'pass' });
    expect(s.scoreless).toBe(1);
    s = play(s, 'b', [at(8, 6, 'T'), at(8, 7, 'A')]);
    expect(s.scoreless).toBe(0);
  });
});

describe('word tiles end of game', () => {
  it('going out with the bag empty takes everyone else’s tile values and ends the game', () => {
    let s = withRack(afterCat(), 'b', ['T', 'A']);
    s = withRack(s, 'a', ['Z', 'Q']);
    s = { ...s, bag: [], scores: { a: 8, b: 5 } };
    const n = play(s, 'b', [at(8, 6, 'T'), at(8, 7, 'A')]);
    expect(n.over).toBe(true);
    expect(n.endReason).toBe('out');
    expect(n.wentOut).toBe('b');
    expect(n.scores['b']).toBe(5 + 8 + 16);
    expect(n.scores['a']).toBe(8 - 16);
    expect(E.result(n)).toEqual({ placements: [['b'], ['a']], draw: false });
    expect(E.currentPlayers(n)).toEqual([]);
  });

  it('equal scores are a draw; three players rank by score', () => {
    const s: S = { ...init(), over: true, scores: { a: 12, b: 12 } };
    expect(E.result(s)).toEqual({ placements: [['a', 'b']], draw: true });
    const t: S = { ...init(1n, ['a', 'b', 'c']), over: true, scores: { a: 5, b: 30, c: -2 } };
    expect(E.result(t)).toEqual({ placements: [['b'], ['a'], ['c']], draw: false });
    expect(E.result(init())).toEqual({ placements: [], draw: false });
  });
});

describe('word tiles view secrecy', () => {
  it('shows only your own rack, never the bag or the RNG', () => {
    const s = init(6n, ['a', 'b', 'c']);
    for (const viewer of ['a', 'b', 'c'] as const) {
      const v = E.view(s, viewer) as Record<string, unknown>;
      expect(v['rack']).toEqual(s.racks[viewer]);
      expect(v['racks']).toBeNull();
      expect(v['bagCount']).toBe(s.bag.length);
      expect(v['rackCounts']).toEqual({ a: 7, b: 7, c: 7 });
      expect(Object.keys(v)).not.toEqual(expect.arrayContaining(['bag']));
      expect(Object.keys(v)).not.toContain('rng');
      const text = JSON.stringify(v);
      expect(text).not.toContain('"bag"');
      expect(text).not.toContain('"rng"');
    }
    const sp = E.view(s, 'spectator') as Record<string, unknown>;
    expect(sp['rack']).toBeNull();
    expect(sp['racks']).toBeNull();
  });

  it('the other players’ racks do not appear anywhere in your view', () => {
    // Make b's rack letters impossible to find by chance: a unique marker is not possible with real
    // letters, so compare the structure: only `rack` (yours) and `racks` (null until over) hold tiles.
    const s = init(6n);
    const v = E.view(s, 'a') as { rack: string[]; racks: unknown; last: unknown };
    expect(v.rack).toEqual(s.racks['a']);
    expect(v.racks).toBeNull();
    const over = E.view({ ...s, over: true }, 'a') as { racks: Record<string, string[]> };
    expect(over.racks['b']).toEqual(s.racks['b']);
  });

  it('a move record does not leak exchanged letters', () => {
    const s = init(3n);
    const n = E.apply(s, 'a', { kind: 'exchange', letters: s.racks['a']!.slice(0, 2) });
    const v = E.view(n, 'b') as { last: { exchanged: number; tiles: unknown[] } };
    expect(v.last.exchanged).toBe(2);
    expect(v.last.tiles).toEqual([]);
  });
});

describe('word tiles helpers', () => {
  it('rackHolds is a multiset test', () => {
    expect(rackHolds(['A', 'A', 'B'], ['A', 'B'])).toBe(true);
    expect(rackHolds(['A', 'B'], ['A', 'A'])).toBe(false);
    expect(rackHolds(['?'], ['?'])).toBe(true);
  });

  it('wordTilesPlays finds legal plays, best first, and every one validates', () => {
    const s = withRack(afterCat(), 'b', ['S', 'T', 'A', 'N', 'O', 'D', 'E']);
    const plays = wordTilesPlays(s, 'b', WORDS, WS, 50);
    expect(plays.length).toBeGreaterThan(3);
    for (let i = 1; i < plays.length; i++)
      expect(plays[i - 1]!.score).toBeGreaterThanOrEqual(plays[i]!.score);
    for (const p of plays)
      expect(E.validate(s, 'b', { kind: 'play', tiles: p.tiles }).ok).toBe(true);
    // the first move of a game must cross the star
    const first = wordTilesPlays(
      withRack(init(), 'a', ['C', 'A', 'T', 'S', 'E', 'R', 'D']),
      'a',
      WORDS,
      WS,
    );
    expect(first.length).toBeGreaterThan(0);
    for (const p of first) expect(p.tiles.some((t) => t.r === 7 && t.c === 7)).toBe(true);
  });

  it('actionSchema accepts the wire shapes and rejects junk', () => {
    const ok = (x: unknown): boolean => wordTilesActionSchema.safeParse(x).success;
    expect(ok({ kind: 'pass' })).toBe(true);
    expect(ok({ kind: 'exchange', letters: ['A', '?'] })).toBe(true);
    expect(ok({ kind: 'play', tiles: [{ r: 7, c: 7, letter: 'A' }] })).toBe(true);
    expect(ok({ kind: 'play', tiles: [{ r: 7, c: 7, letter: 'A', blank: true }] })).toBe(true);
    expect(ok({ kind: 'play', tiles: [] })).toBe(false);
    expect(ok({ kind: 'play', tiles: [{ r: 15, c: 7, letter: 'A' }] })).toBe(false);
    expect(ok({ kind: 'play', tiles: [{ r: 7, c: 7, letter: 'a' }] })).toBe(false);
    expect(ok({ kind: 'exchange', letters: ['AB'] })).toBe(false);
    expect(ok({ kind: 'resign' })).toBe(false);
  });
});

// Property test: random legal play (plays found from a short word list, exchanges, passes) to the end.
const SHORT = [
  'CAT', 'DOG', 'SUN', 'TEN', 'RAT', 'EAT', 'TEA', 'ARE', 'EAR', 'ERA', 'TIN', 'NET', 'SET', 'LET', 'OIL',
  'OAR', 'ORE', 'ONE', 'RED', 'DEN', 'AND', 'END', 'TOO', 'TWO', 'NOT', 'TON', 'RUN', 'URN', 'SIT', 'AT',
  'TO', 'IT', 'IN', 'ON', 'AN', 'AS', 'IS', 'US', 'OR', 'ER', 'BE', 'DO', 'GO', 'NO', 'SO', 'ME', 'HE',
]; // prettier-ignore
const GAME_SET = makeWordSet(
  [...SHORT, ...WORD_TILES_WORDS.filter((w) => w.length <= 4)],
  'prop-1',
);
const G = createWordTilesEngine(GAME_SET);

describeEngine<WordTilesState, WordTilesAction, object>(G, {
  playerCounts: [2, 3, 4],
  cfg: {},
  numRuns: 8,
  maxSteps: 700,
  candidates: (s, by) => {
    const plays = wordTilesPlays(s, by, SHORT, GAME_SET, 4).map((p): WordTilesAction => ({
      kind: 'play',
      tiles: p.tiles,
    }));
    const rack = s.racks[by] ?? [];
    return [
      ...plays,
      { kind: 'pass' },
      { kind: 'pass' },
      { kind: 'exchange', letters: rack.slice(0, 2) },
    ];
  },
  illegal: (s, by) => [
    { kind: 'play', tiles: [{ r: 0, c: 0, letter: 'Q' }] },
    { kind: 'play', tiles: [{ r: 7, c: 7, letter: 'A' }] },
    { kind: 'exchange', letters: [] },
    ...(s.players[s.turn] === by ? [] : [{ kind: 'pass' as const }]),
  ],
});
