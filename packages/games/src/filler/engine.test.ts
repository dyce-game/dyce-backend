import { hashState } from '../hash.ts';
import { describeEngine } from '../testing/engineHarness.ts';
import {
  FILLER_CELLS,
  FILLER_COLOURS,
  FILLER_COLS,
  FILLER_MAJORITY,
  FILLER_ROWS,
  FILLER_START,
  fillerActionSchema,
  fillerAutoAction,
  fillerCounts,
  fillerEngine as E,
  fillerGain,
  generateFillerGrid,
  type FillerAction,
  type FillerState,
} from './engine.ts';

const P: [string, string] = ['a', 'b'];
const init = (seed = 7n): FillerState => E.init(P, seed, {});

/** Build a state from rows of digits (7 rows of 8) for hand-made scenarios. */
function fromRows(rows: string[], turn: 0 | 1 = 0): FillerState {
  const cells = rows.join('').split('').map(Number);
  expect(cells).toHaveLength(FILLER_CELLS);
  const owner = new Array<0 | 1 | 2>(FILLER_CELLS).fill(0);
  owner[FILLER_START[0]] = 1;
  owner[FILLER_START[1]] = 2;
  return {
    ...init(),
    cells,
    owner,
    colours: [cells[FILLER_START[0]] as number, cells[FILLER_START[1]] as number],
    turn,
  };
}

describe('filler grid', () => {
  it('is 8 x 7, six colours, deterministic, no touching cells of one colour, start cells differ', () => {
    for (const seed of [1n, 2n, 42n, 999n, 1n << 62n]) {
      const g = generateFillerGrid(seed);
      expect(g).toHaveLength(56);
      expect(FILLER_COLS * FILLER_ROWS).toBe(56);
      expect(g.every((c) => c >= 0 && c < FILLER_COLOURS)).toBe(true);
      expect(generateFillerGrid(seed)).toEqual(g);
      for (let r = 0; r < FILLER_ROWS; r++) {
        for (let c = 0; c < FILLER_COLS; c++) {
          const here = g[r * FILLER_COLS + c];
          if (c + 1 < FILLER_COLS) expect(g[r * FILLER_COLS + c + 1]).not.toBe(here);
          if (r + 1 < FILLER_ROWS) expect(g[(r + 1) * FILLER_COLS + c]).not.toBe(here);
        }
      }
      expect(g[FILLER_START[0]]).not.toBe(g[FILLER_START[1]]);
    }
  });

  it('uses all six colours on a typical seed and varies by seed', () => {
    expect(new Set(generateFillerGrid(5n)).size).toBe(6);
    expect(generateFillerGrid(5n)).not.toEqual(generateFillerGrid(6n));
  });
});

describe('filler rules', () => {
  it('needs exactly two distinct players', () => {
    expect(() => E.init(['a'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'b', 'c'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'a'], 1n, {})).toThrow();
    expect(() => E.init(P, 1n, { maxTurns: 1 })).toThrow();
  });

  it('starts with one cell each, in opposite corners, players[0] to move', () => {
    const s = init();
    expect(fillerCounts(s)).toEqual([1, 1]);
    expect(s.owner[FILLER_START[0]]).toBe(1);
    expect(s.owner[FILLER_START[1]]).toBe(2);
    expect(FILLER_START).toEqual([48, 7]);
    expect(E.currentPlayers(s)).toEqual(['a']);
    expect(E.isTerminal(s)).toBe(false);
  });

  it('turn order and illegal colours', () => {
    const s = init();
    expect(E.validate(s, 'b', { kind: 'pick', colour: 0 })).toEqual({
      ok: false,
      code: 'not_your_turn',
    });
    expect(E.validate(s, 'a', { kind: 'pick', colour: s.colours[0] })).toEqual({
      ok: false,
      code: 'your_colour',
    });
    expect(E.validate(s, 'a', { kind: 'pick', colour: s.colours[1] })).toEqual({
      ok: false,
      code: 'their_colour',
    });
    expect(E.validate(s, 'a', { kind: 'pick', colour: 6 })).toEqual({
      ok: false,
      code: 'bad_colour',
    });
    expect(E.validate(s, 'a', { kind: 'pick', colour: 1.5 })).toEqual({
      ok: false,
      code: 'bad_colour',
    });
    expect(E.validate(s, 'a', { kind: 'pick', colour: -1 })).toEqual({
      ok: false,
      code: 'bad_colour',
    });
  });

  it('a pick recolours the region, swallows connected free cells of that colour, and passes the turn', () => {
    // a starts bottom-left on colour 1; colour 2 sits above and to the right of it, 3 beyond.
    const s = fromRows([
      '01010105', // top row, b's start (col 7) is colour 5
      '10101010',
      '01010101',
      '10101010',
      '01010101',
      '22101010',
      '10101010',
    ]);
    expect(s.colours).toEqual([1, 5]);
    // pick 2: swallows the free 2s next to a's region only if touching; (5,0) and (5,1) are 2s above (6,0)
    expect(fillerGain(s, 0, 2)).toBe(2);
    const n = E.apply(s, 'a', { kind: 'pick', colour: 2 });
    expect(n.colours).toEqual([2, 5]);
    expect(n.turn).toBe(1);
    expect(fillerCounts(n)).toEqual([3, 1]);
    expect(n.owner[40]).toBe(1);
    expect(n.owner[41]).toBe(1);
    expect(n.owner[48]).toBe(1);
    expect(n.cells[48]).toBe(2); // the region wears the new colour
    expect(n.last).toEqual({ seq: 1, by: 'a', colour: 2, gained: 2 });
    expect(E.currentPlayers(n)).toEqual(['b']);
  });

  it('chains: newly swallowed cells pull in their free neighbours of the same colour', () => {
    const s = fromRows([
      '00000005',
      '00000000',
      '00000000',
      '00000000',
      '00000000',
      '33333333',
      '14444444',
    ]);
    // a is at (6,0) colour 1; row 6 is 4s, row 5 is 3s
    const n = E.apply(s, 'a', { kind: 'pick', colour: 4 });
    expect(fillerCounts(n)[0]).toBe(8); // the whole bottom row, in a chain
  });

  it('your own cells recolour with you, so you keep absorbing what your old colour touched', () => {
    const s = fromRows([
      '00000005',
      '00000000',
      '00000000',
      '00000000',
      '00000000',
      '00000000',
      '12000000',
    ]);
    let n = E.apply(s, 'a', { kind: 'pick', colour: 2 }); // takes (6,1)
    expect(fillerCounts(n)[0]).toBe(2);
    n = E.apply(n, 'b', { kind: 'pick', colour: 3 });
    n = E.apply(n, 'a', { kind: 'pick', colour: 0 }); // swallows the 0 field around
    expect(fillerCounts(n)[0]).toBeGreaterThan(40);
  });

  it('wins at once with more than half the board', () => {
    const s = fromRows([
      '00000005',
      '00000000',
      '00000000',
      '00000000',
      '00000000',
      '00000000',
      '10000000',
    ]);
    const n = E.apply(s, 'a', { kind: 'pick', colour: 0 });
    expect(fillerCounts(n)[0]).toBeGreaterThan(FILLER_MAJORITY);
    expect(n.over).toBe(true);
    expect(n.winner).toBe('a');
    expect(E.isTerminal(n)).toBe(true);
    expect(E.currentPlayers(n)).toEqual([]);
    expect(E.result(n)).toEqual({ placements: [['a'], ['b']], draw: false });
    expect(E.validate(n, 'b', { kind: 'pick', colour: 2 })).toEqual({
      ok: false,
      code: 'game_over',
    });
  });

  it('exactly half is not a majority', () => {
    expect(FILLER_MAJORITY).toBe(28);
    const s = init();
    const n = {
      ...s,
      owner: s.owner.map((_, i) => (i < 28 ? 1 : i < 55 ? 2 : 0)) as FillerState['owner'],
    };
    expect(fillerCounts(n)).toEqual([28, 27]);
  });

  it('a full board with equal regions is a draw', () => {
    // 28 cells each, the free cell is the last one a takes... build: a owns 27 + gets 1 to make 28 vs b 28
    const s = init();
    const owner = new Array<0 | 1 | 2>(56).fill(2);
    for (let i = 0; i < 27; i++) owner[i] = 1;
    owner[27] = 0;
    // a's region is cells 0..26 (colour 0), cell 27 is free with colour 3; the rest is b's (colour 1)
    const cells = new Array<number>(56).fill(1);
    for (let i = 0; i < 27; i++) cells[i] = 0;
    cells[27] = 3;
    const t: FillerState = { ...s, cells, owner, colours: [0, 1], turn: 0 };
    const n = E.apply(t, 'a', { kind: 'pick', colour: 3 });
    expect(fillerCounts(n)).toEqual([28, 28]);
    expect(n.over).toBe(true);
    expect(n.winner).toBeNull();
    expect(E.result(n)).toEqual({ placements: [['a', 'b']], draw: true });
  });

  it('the turn cap ends the game and the larger region wins', () => {
    const s = E.init(P, 3n, { maxTurns: 2 });
    let n = E.apply(s, 'a', { kind: 'pick', colour: legalColour(s) });
    expect(n.over).toBe(false);
    n = E.apply(n, 'b', { kind: 'pick', colour: legalColour(n) });
    expect(n.over).toBe(true);
  });

  it('apply never mutates its input', () => {
    const s = init();
    const before = hashState(s);
    E.apply(s, 'a', { kind: 'pick', colour: legalColour(s) });
    expect(hashState(s)).toBe(before);
  });

  it('view is the whole state plus counts; nothing is hidden', () => {
    const s = init();
    const v = E.view(s, 'b') as FillerState & { counts: Record<string, number> };
    expect(v.cells).toEqual(s.cells);
    expect(v.counts).toEqual({ a: 1, b: 1 });
    expect(JSON.stringify(E.view(s, 'spectator'))).toBe(JSON.stringify(E.view(s, 'a')));
    expect(Object.keys(v)).not.toContain('rng');
  });

  it('actionSchema', () => {
    expect(fillerActionSchema.safeParse({ kind: 'pick', colour: 5 }).success).toBe(true);
    expect(fillerActionSchema.safeParse({ kind: 'pick', colour: 6 }).success).toBe(false);
    expect(fillerActionSchema.safeParse({ kind: 'pick', colour: 0.5 }).success).toBe(false);
    expect(fillerActionSchema.safeParse({ kind: 'pass' }).success).toBe(false);
  });
});

function legalColour(s: FillerState): number {
  for (let c = 0; c < FILLER_COLOURS; c++) {
    if (E.validate(s, s.players[s.turn], { kind: 'pick', colour: c }).ok) return c;
  }
  throw new Error('no legal colour');
}

describeEngine<FillerState, FillerAction, object>(E, {
  playerCounts: [2],
  cfg: {},
  numRuns: 60,
  maxSteps: 200,
  candidates: () =>
    Array.from({ length: FILLER_COLOURS }, (_, colour) => ({ kind: 'pick' as const, colour })),
  illegal: (s) => [
    { kind: 'pick', colour: s.colours[0] },
    { kind: 'pick', colour: s.colours[1] },
    { kind: 'pick', colour: 9 },
  ],
});

describe('filler auto action', () => {
  it('is always legal and takes the colour with the biggest gain', () => {
    for (const seed of [1n, 2n, 3n, 4n, 5n]) {
      let s = init(seed);
      for (let i = 0; i < 80 && !s.over; i++) {
        const a = fillerAutoAction(s);
        expect(E.validate(s, s.players[s.turn], a).ok).toBe(true);
        const best = Math.max(
          ...Array.from({ length: FILLER_COLOURS }, (_, c) =>
            E.validate(s, s.players[s.turn], { kind: 'pick', colour: c }).ok
              ? fillerGain(s, s.turn, c)
              : -1,
          ),
        );
        expect(fillerGain(s, s.turn, a.colour)).toBe(best);
        s = E.apply(s, s.players[s.turn], a);
      }
      expect(s.over).toBe(true);
    }
  });
});
