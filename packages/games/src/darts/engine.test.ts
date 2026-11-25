import { hashState } from '../hash.ts';
import { describeEngine } from '../testing/engineHarness.ts';
import {
  DARTS_SECTORS,
  dartsActionSchema,
  dartsEngine as E,
  dartsSegmentCentre,
  readDartboard,
  type DartsAction,
  type DartsState,
} from './engine.ts';

const A = 'a';
const B = 'b';
const PERFECT = { wobble: 0 };

const at = (n: number, ring: 'single' | 'double' | 'triple' | 'bull' | 'dbull'): DartsAction => ({
  kind: 'throw',
  ...dartsSegmentCentre(n, ring),
});
const MISS: DartsAction = { kind: 'throw', x: 2400, y: 2400 };

function play(s: DartsState, who: string, ...actions: DartsAction[]): DartsState {
  let cur = s;
  for (const a of actions) {
    const v = E.validate(cur, who, a);
    if (!v.ok) throw new Error(`illegal ${JSON.stringify(a)}: ${v.code}`);
    cur = E.apply(cur, who, a);
  }
  return cur;
}

const fresh = (cfg = {}) => E.init([A, B], 7n, { ...PERFECT, ...cfg });
const withLeft = (s: DartsState, a: number, b: number): DartsState => ({
  ...s,
  left: { [A]: a, [B]: b },
  turnStartLeft: { [A]: a, [B]: b },
});

describe('darts board reading', () => {
  it('reads the bull and the rings', () => {
    expect(readDartboard(0, 0)).toEqual({ ring: 'dbull', number: 50, points: 50 });
    expect(readDartboard(0, 100)).toEqual({ ring: 'bull', number: 25, points: 25 });
    expect(readDartboard(0, 1000)).toMatchObject({ ring: 'triple', number: 20, points: 60 });
    expect(readDartboard(0, 1650)).toMatchObject({ ring: 'double', number: 20, points: 40 });
    expect(readDartboard(0, 600)).toMatchObject({ ring: 'single', number: 20, points: 20 });
    expect(readDartboard(0, 1300)).toMatchObject({ ring: 'single', number: 20, points: 20 });
    expect(readDartboard(0, 1701)).toEqual({ ring: 'miss', number: 0, points: 0 });
  });

  it('every sector reads as its own number in every ring', () => {
    for (const n of DARTS_SECTORS) {
      expect(readDartboard(...xy(dartsSegmentCentre(n, 'single')))).toMatchObject({
        number: n,
        ring: 'single',
      });
      expect(readDartboard(...xy(dartsSegmentCentre(n, 'double')))).toMatchObject({
        number: n,
        ring: 'double',
        points: 2 * n,
      });
      expect(readDartboard(...xy(dartsSegmentCentre(n, 'triple')))).toMatchObject({
        number: n,
        ring: 'triple',
        points: 3 * n,
      });
    }
  });

  it('has the regulation sector order (neighbours of the 20 are 1 and 5; of the 3 are 17 and 19)', () => {
    expect(DARTS_SECTORS.slice().sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    expect(readDartboard(300, 1000)).toMatchObject({ number: 1 });
    expect(readDartboard(-300, 1000)).toMatchObject({ number: 5 });
    expect(readDartboard(0, -1000)).toMatchObject({ number: 3 });
    expect(readDartboard(1000, 0)).toMatchObject({ number: 6 });
    expect(readDartboard(-1000, 0)).toMatchObject({ number: 11 });
  });
});

function xy(p: { x: number; y: number }): [number, number] {
  return [p.x, p.y];
}

describe('darts 501', () => {
  it('starts at 501, a turn is three darts, then it passes', () => {
    let s = fresh();
    expect(s.left).toEqual({ [A]: 501, [B]: 501 });
    expect(E.currentPlayers(s)).toEqual([A]);
    s = play(s, A, at(20, 'triple'), at(20, 'triple'));
    expect(s.left[A]).toBe(381);
    expect(E.currentPlayers(s)).toEqual([A]);
    s = play(s, A, at(20, 'triple'));
    expect(s.left[A]).toBe(321);
    expect(E.currentPlayers(s)).toEqual([B]);
    expect(s.turnDarts).toEqual([]);
    expect(s.last?.points).toBe(60);
  });

  it('rejects the wrong player, bad aim and play after the end', () => {
    const s = fresh();
    expect(E.validate(s, B, at(20, 'single'))).toEqual({ ok: false, code: 'not_your_turn' });
    expect(E.validate(s, A, { kind: 'throw', x: 2501, y: 0 })).toEqual({
      ok: false,
      code: 'bad_aim',
    });
    expect(E.validate(s, A, { kind: 'throw', x: 1.5, y: 0 })).toEqual({
      ok: false,
      code: 'bad_aim',
    });
    const done = withLeft(s, 40, 100);
    const won = play(done, A, at(20, 'double'));
    expect(E.validate(won, B, at(20, 'single'))).toMatchObject({ ok: true }); // B's last turn
  });

  it('a throw that would go below zero, leave one, or end on a single is a bust', () => {
    let s = withLeft(fresh(), 40, 501);
    // 40 left, throws a triple 20 (60): below zero.
    s = play(s, A, at(20, 'triple'));
    expect(s.left[A]).toBe(40);
    expect(s.last?.bust).toBe(true);
    expect(E.currentPlayers(s)).toEqual([B]);

    // 41 left, a 20 leaves 21... but 40 + 1 left: single 20 from 21 leaves 1 → bust.
    s = withLeft(fresh(), 21, 501);
    s = play(s, A, at(20, 'single'));
    expect(s.last?.bust).toBe(true);
    expect(s.left[A]).toBe(21);

    // 20 left, single 20 would finish but it is not a double → bust.
    s = withLeft(fresh(), 20, 501);
    s = play(s, A, at(20, 'single'));
    expect(s.last).toMatchObject({ bust: true, finished: false });
    expect(s.left[A]).toBe(20);
  });

  it('a bust gives back the whole turn, not just the last dart', () => {
    let s = withLeft(fresh(), 100, 501);
    s = play(s, A, at(20, 'triple')); // 40 left
    expect(s.left[A]).toBe(40);
    s = play(s, A, at(19, 'triple')); // 57 > 40 → bust
    expect(s.left[A]).toBe(100);
    expect(E.currentPlayers(s)).toEqual([B]);
    // Next turn starts from the restored value.
    s = play(s, B, MISS, MISS, MISS);
    s = play(s, A, at(20, 'single'));
    expect(s.left[A]).toBe(80);
  });

  it('checks out on a double and the bull counts as one', () => {
    let s = withLeft(fresh(), 40, 501);
    s = play(s, A, at(20, 'double'));
    expect(s.finishedWith[A]).toBe(1);
    expect(s.last?.finished).toBe(true);
    // Equal turns: B still throws.
    expect(s.over).toBe(false);
    expect(E.currentPlayers(s)).toEqual([B]);

    s = withLeft(fresh(), 50, 501);
    s = play(s, A, at(0, 'dbull'));
    expect(s.finishedWith[A]).toBe(1);
  });

  it('equal turns: the second player gets a last turn; fewer darts wins; equal darts is a draw', () => {
    // A checks out with one dart; B can check out with their third → A wins.
    let s = withLeft(fresh(), 40, 80);
    s = play(s, A, at(20, 'double'));
    s = play(s, B, MISS, MISS);
    expect(s.over).toBe(false);
    s = play(s, B, at(20, 'double')); // 80 → 40, not a finish
    expect(s.over).toBe(true);
    expect(s.winner).toBe(A);

    // Both finish with the first dart: a draw.
    s = withLeft(fresh(), 40, 40);
    s = play(s, A, at(20, 'double'));
    s = play(s, B, at(20, 'double'));
    expect(s.over).toBe(true);
    expect(s.winner).toBeNull();
    expect(E.result(s)).toEqual({ placements: [[A, B]], draw: true });

    // A takes two darts, B takes one: B wins.
    s = withLeft(fresh(), 41, 40);
    s = play(s, A, at(1, 'single'), at(20, 'double'));
    expect(s.finishedWith[A]).toBe(2);
    s = play(s, B, at(20, 'double'));
    expect(s.winner).toBe(B);
    expect(E.result(s)).toEqual({ placements: [[B], [A]], draw: false });
  });

  it('B finishing first ends the game at once', () => {
    let s = withLeft(fresh(), 100, 40);
    s = play(s, A, MISS, MISS, MISS);
    s = play(s, B, at(20, 'double'));
    expect(s.over).toBe(true);
    expect(s.winner).toBe(B);
    expect(E.currentPlayers(s)).toEqual([]);
    expect(E.validate(s, A, MISS)).toEqual({ ok: false, code: 'game_over' });
  });

  it('maxRounds ends the game: the lower score wins, equal is a draw', () => {
    let s = fresh({ maxRounds: 2 });
    s = play(s, A, at(20, 'triple'), MISS, MISS); // 441
    s = play(s, B, at(19, 'triple'), MISS, MISS); // 444
    expect(s.round).toBe(2);
    s = play(s, A, MISS, MISS, MISS);
    expect(s.over).toBe(false);
    s = play(s, B, MISS, MISS, MISS);
    expect(s.over).toBe(true);
    expect(s.winner).toBe(A);

    let d = fresh({ maxRounds: 1 });
    d = play(d, A, MISS, MISS, MISS);
    d = play(d, B, MISS, MISS, MISS);
    expect(d.over).toBe(true);
    expect(E.result(d).draw).toBe(true);
  });

  it('the wobble is seeded: same seed → same landings; different seed → different', () => {
    const run = (seed: bigint) => {
      let s = E.init([A, B], seed, { wobble: 80 });
      const hits: unknown[] = [];
      for (let i = 0; i < 3; i++) {
        s = E.apply(s, A, at(20, 'triple'));
        hits.push(s.last?.hit);
      }
      return hits;
    };
    expect(run(5n)).toEqual(run(5n));
    expect(run(5n)).not.toEqual(run(6n));
  });

  it('with the default wobble a dart lands near the aim but not always on it', () => {
    let near = 0;
    let exact = 0;
    const N = 300;
    for (let i = 0; i < N; i++) {
      const s = E.init([A, B], BigInt(i + 1), {});
      const t = E.apply(s, A, at(20, 'triple'));
      const h = t.last!.hit;
      const aim = dartsSegmentCentre(20, 'triple');
      const d2 = (h.x - aim.x) ** 2 + (h.y - aim.y) ** 2;
      if (d2 <= 200 * 200) near++;
      if (h.x === aim.x && h.y === aim.y) exact++;
    }
    expect(near).toBeGreaterThan(N * 0.7);
    expect(exact).toBeLessThan(N * 0.1);
  });

  it('uses the same number of RNG draws per dart whatever happens', () => {
    const s = E.init([A, B], 99n, {});
    const x = E.apply(s, A, at(20, 'triple'));
    const y = E.apply(s, A, MISS);
    expect(x.rng).toEqual(y.rng);
    expect(x.rng).not.toEqual(s.rng);
  });

  it('apply does not mutate and view hides the RNG', () => {
    const s = fresh();
    const before = hashState(s);
    const t = E.apply(s, A, at(20, 'single'));
    expect(hashState(s)).toBe(before);
    expect(t).not.toBe(s);
    for (const v of [A, B, 'spectator'] as const) {
      expect(JSON.stringify(E.view(t, v))).not.toContain('"rng"');
      expect(E.view(t, v)).toMatchObject({ left: t.left });
    }
  });
});

describe('darts around the clock', () => {
  const clock = (cfg = {}) => fresh({ variant: 'clock', ...cfg });

  it('starts with 21 targets to go and advances only on the right number (any ring)', () => {
    let s = clock();
    expect(s.left[A]).toBe(21);
    s = play(s, A, at(2, 'single')); // wrong: target is 1
    expect(s.left[A]).toBe(21);
    s = play(s, A, at(1, 'triple')); // any ring counts
    expect(s.left[A]).toBe(20);
    s = play(s, A, at(2, 'double'));
    expect(s.left[A]).toBe(19);
    expect(E.currentPlayers(s)).toEqual([B]);
  });

  it('every dart is a hit-or-miss turn of exactly three, and a hit does not earn extras', () => {
    let s = clock();
    s = play(s, A, at(1, 'single'), at(2, 'single'), at(3, 'single'));
    expect(s.left[A]).toBe(18);
    expect(E.currentPlayers(s)).toEqual([B]);
  });

  it('the bull is last; the outer bull or the bull eye both count; the 20 does not', () => {
    let s: DartsState = {
      ...clock(),
      left: { [A]: 2, [B]: 21 },
      turnStartLeft: { [A]: 2, [B]: 21 },
    };
    s = play(s, A, at(20, 'single'));
    expect(s.left[A]).toBe(1);
    s = play(s, A, at(20, 'single')); // target is now the bull
    expect(s.left[A]).toBe(1);
    s = play(s, A, at(0, 'bull'));
    expect(s.left[A]).toBe(0);
    expect(s.finishedWith[A]).toBe(3);
    // B has a last turn; B hits nothing → A wins.
    s = play(s, B, MISS, MISS, MISS);
    expect(s.over).toBe(true);
    expect(s.winner).toBe(A);
  });

  it('the outer/inner bull does not count as a number', () => {
    let s = clock();
    s = play(s, A, at(0, 'bull'), at(0, 'dbull'), MISS);
    expect(s.left[A]).toBe(21);
  });

  it('the round cap decides by progress', () => {
    let s = clock({ maxRounds: 1 });
    s = play(s, A, at(1, 'single'), at(2, 'single'), MISS);
    s = play(s, B, at(1, 'single'), MISS, MISS);
    expect(s.over).toBe(true);
    expect(s.winner).toBe(A);
  });
});

describe('darts schema and config', () => {
  it('actionSchema accepts quantised aim points and rejects everything else', () => {
    expect(dartsActionSchema.safeParse({ kind: 'throw', x: 0, y: -1700 }).success).toBe(true);
    expect(dartsActionSchema.safeParse({ kind: 'throw', x: 0.5, y: 0 }).success).toBe(false);
    expect(dartsActionSchema.safeParse({ kind: 'throw', x: 2501, y: 0 }).success).toBe(false);
    expect(dartsActionSchema.safeParse({ kind: 'throw', x: 0 }).success).toBe(false);
    expect(dartsActionSchema.safeParse({ kind: 'aim', x: 0, y: 0 }).success).toBe(false);
  });

  it('rejects a bad setup', () => {
    expect(() => E.init([A], 1n, {})).toThrow();
    expect(() => E.init([A, A], 1n, {})).toThrow();
    expect(() => E.init([A, B], 1n, { variant: 'x' as never })).toThrow();
    expect(() => E.init([A, B], 1n, { maxRounds: 0 })).toThrow();
    expect(() => E.init([A, B], 1n, { wobble: -1 })).toThrow();
  });
});

const sweep = (s: DartsState, by: string): DartsAction[] => {
  const turnStart = s.left[by] as number;
  return [
    at(20, 'triple'),
    at(19, 'single'),
    at(0, 'dbull'),
    at(Math.max(1, Math.min(20, turnStart >> 1)), 'double'),
    MISS,
    { kind: 'throw', x: (s.seq * 137) % 1500, y: (s.seq * 71) % 1500 },
  ];
};

describeEngine(E, {
  playerCounts: [2],
  cfg: { maxRounds: 12 },
  candidates: sweep,
  illegal: (s, by) =>
    [
      { kind: 'throw', x: 9999, y: 0 },
      { kind: 'throw', x: 0.1, y: 0 },
    ].concat(by === s.players[s.turn] ? [] : [at(20, 'single')]),
  numRuns: 40,
});

describeEngine(E, {
  playerCounts: [2],
  cfg: { variant: 'clock', maxRounds: 10 },
  candidates: sweep,
  numRuns: 40,
});
