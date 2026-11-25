import { hashState } from '../hash.ts';
import { describeEngine } from '../testing/engineHarness.ts';
import {
  ARCHERY_WIND_MAX_DMS,
  archeryActionSchema,
  archeryEngine as E,
  archeryScore,
  archeryTremor,
  type ArcheryAction,
  type ArcheryState,
} from './engine.ts';
import { AIM_MAX, DRAW_MAX, arrowSpeed, flyArrow } from './physics.ts';

const A = 'a';
const B = 'b';
const shot = (aimX = 0, aimY = 0, draw = DRAW_MAX): ArcheryAction => ({
  kind: 'shoot',
  aimX,
  aimY,
  draw,
});
/** Certain to score 0: far off the face with no draw. */
const WILD = shot(AIM_MAX, AIM_MAX, 0);

function play(s: ArcheryState, who: string, ...actions: ArcheryAction[]): ArcheryState {
  let cur = s;
  for (const a of actions) {
    const v = E.validate(cur, who, a);
    if (!v.ok) throw new Error(`illegal ${JSON.stringify(a)}: ${v.code}`);
    cur = E.apply(cur, who, a);
  }
  return cur;
}

describe('archery arrow flight', () => {
  it('a full draw in still air lands on the aim point (the sight is calibrated for it)', () => {
    for (const [x, y] of [
      [0, 0],
      [200, -150],
      [-300, 250],
      [400, 400],
      [-1000, -900],
    ] as const) {
      const f = flyArrow({ aimX: x, aimY: y, draw: DRAW_MAX }, 0);
      expect(Math.abs(f.x - x)).toBeLessThanOrEqual(2);
      expect(Math.abs(f.y - y)).toBeLessThanOrEqual(4);
    }
  });

  it('wind pushes the arrow the way it blows, in proportion', () => {
    const still = flyArrow({ aimX: 0, aimY: 0, draw: DRAW_MAX }, 0);
    const right = flyArrow({ aimX: 0, aimY: 0, draw: DRAW_MAX }, 40);
    const left = flyArrow({ aimX: 0, aimY: 0, draw: DRAW_MAX }, -40);
    const strong = flyArrow({ aimX: 0, aimY: 0, draw: DRAW_MAX }, 80);
    expect(right.x).toBeGreaterThan(still.x + 100);
    expect(left.x).toBeLessThan(still.x - 100);
    expect(Math.abs(right.x + left.x)).toBeLessThanOrEqual(2);
    expect(strong.x).toBeGreaterThan(right.x * 1.9);
    expect(strong.x).toBeLessThan(right.x * 2.1);
    expect(right.y).toBe(still.y); // a cross-wind does not lift or drop it
  });

  it('a shorter draw is slower, drops further and drifts more', () => {
    expect(arrowSpeed(500)).toBeLessThan(arrowSpeed(1000));
    let prevY = Infinity;
    let prevX = -Infinity;
    for (const draw of [1000, 800, 600, 400, 200]) {
      const f = flyArrow({ aimX: 0, aimY: 0, draw }, 50);
      expect(f.y).toBeLessThan(prevY);
      expect(f.x).toBeGreaterThan(prevX);
      prevY = f.y;
      prevX = f.x;
    }
  });

  it('is pure, reports whole millimetres, and always lands', () => {
    const a = flyArrow({ aimX: 123, aimY: -77, draw: 640 }, -33, { x: 5, y: -4 });
    expect(flyArrow({ aimX: 123, aimY: -77, draw: 640 }, -33, { x: 5, y: -4 })).toEqual(a);
    expect(Number.isInteger(a.x) && Number.isInteger(a.y) && Number.isInteger(a.flightMs)).toBe(
      true,
    );
    for (const aimX of [-AIM_MAX, 0, AIM_MAX]) {
      for (const draw of [0, 1, 500, DRAW_MAX]) {
        const f = flyArrow({ aimX, aimY: AIM_MAX, draw }, 80);
        expect(f.flightMs).toBeGreaterThan(300);
        expect(f.flightMs).toBeLessThan(1500);
      }
    }
  });
});

describe('archery scoring', () => {
  it('rings are 40 mm apart from 10 down to 1; the inner 20 mm is an X', () => {
    expect(archeryScore(0, 0)).toEqual({ score: 10, isX: true });
    expect(archeryScore(20, 0)).toEqual({ score: 10, isX: true });
    expect(archeryScore(21, 0)).toEqual({ score: 10, isX: false });
    expect(archeryScore(0, 40)).toEqual({ score: 10, isX: false });
    expect(archeryScore(0, 41)).toEqual({ score: 9, isX: false });
    expect(archeryScore(81, 0).score).toBe(8);
    expect(archeryScore(0, -400).score).toBe(1);
    expect(archeryScore(0, -401).score).toBe(0);
    expect(archeryScore(300, 300).score).toBe(0); // corner of the box, off the face
    expect(archeryScore(30, 30).score).toBe(9); // 42 mm from the centre
  });

  it('tremor shrinks as the draw fills', () => {
    expect(archeryTremor(1000)).toBe(6);
    expect(archeryTremor(0)).toBe(26);
    expect(archeryTremor(500)).toBeGreaterThan(archeryTremor(900));
  });
});

describe('archery match', () => {
  const fresh = (cfg = {}) => E.init([A, B], 11n, cfg);

  it('has three winds in range, shown to both players only as they come up', () => {
    const s = fresh();
    expect(s.winds).toHaveLength(3);
    for (const w of s.winds) expect(Math.abs(w)).toBeLessThanOrEqual(ARCHERY_WIND_MAX_DMS);
    const v = E.view(s, A) as { winds: number[] };
    expect(v.winds).toEqual([s.winds[0]]);
  });

  it('three arrows each per end; the first shooter alternates; both shoot the same wind', () => {
    let s = fresh();
    expect(E.currentPlayers(s)).toEqual([A]);
    s = play(s, A, shot(), shot());
    expect(E.currentPlayers(s)).toEqual([A]);
    s = play(s, A, shot());
    expect(E.currentPlayers(s)).toEqual([B]);
    s = play(s, B, shot(), shot(), shot());
    // End 2: B starts.
    expect(s.end).toBe(1);
    expect(E.currentPlayers(s)).toEqual([B]);
    s = play(s, B, shot(), shot(), shot());
    expect(E.currentPlayers(s)).toEqual([A]);
    s = play(s, A, shot(), shot(), shot());
    expect(s.end).toBe(2);
    expect(E.currentPlayers(s)).toEqual([A]);

    const winds = (p: string, end: number) =>
      new Set(s.arrows[p]!.filter((r) => r.end === end).map((r) => r.windDms));
    for (let e = 0; e < 2; e++) {
      expect([...winds(A, e)]).toEqual([s.winds[e]]);
      expect([...winds(B, e)]).toEqual([s.winds[e]]);
    }
    expect((E.view(s, B) as { winds: number[] }).winds).toEqual(s.winds);
  });

  it('plays 18 arrows to the end, then it is over and rejects more', () => {
    let s = fresh();
    for (let end = 0; end < 3; end++) {
      const first = end % 2 === 0 ? A : B;
      const second = first === A ? B : A;
      s = play(s, first, shot(), shot(), shot());
      s = play(s, second, shot(), shot(), shot());
    }
    expect(s.over).toBe(true);
    expect(s.arrows[A]).toHaveLength(9);
    expect(s.arrows[B]).toHaveLength(9);
    expect(E.currentPlayers(s)).toEqual([]);
    expect(E.validate(s, A, shot())).toEqual({ ok: false, code: 'game_over' });
    expect(s.score[A]).toBe(s.arrows[A]!.reduce((n, r) => n + r.score, 0));
    const res = E.result(s);
    if (s.winner) expect(res.placements[0]).toEqual([s.winner]);
    else expect(res.draw).toBe(true);
  });

  it('rejects the wrong player and out-of-range input', () => {
    const s = fresh();
    expect(E.validate(s, B, shot())).toEqual({ ok: false, code: 'not_your_turn' });
    expect(E.validate(s, A, shot(AIM_MAX + 1))).toEqual({ ok: false, code: 'bad_aim' });
    expect(E.validate(s, A, shot(0, 0.5))).toEqual({ ok: false, code: 'bad_aim' });
    expect(E.validate(s, A, shot(0, 0, DRAW_MAX + 1))).toEqual({ ok: false, code: 'bad_draw' });
    expect(E.validate(s, A, shot(0, 0, -1))).toEqual({ ok: false, code: 'bad_draw' });
  });

  it('a clean full-draw shot at the gold in light wind scores well', () => {
    // Over many seeds a full draw aimed at the centre, corrected for the wind, mostly scores 8 or more.
    let good = 0;
    const N = 60;
    for (let i = 0; i < N; i++) {
      const s = E.init([A, B], BigInt(1000 + i), {});
      // Aim off by exactly the drift the wind will cause, the way a good player would.
      const drift = flyArrow({ aimX: 0, aimY: 0, draw: DRAW_MAX }, s.winds[0]!).x;
      const t = E.apply(s, A, shot(-drift, 0));
      if (t.last!.score >= 8) good++;
    }
    expect(good).toBeGreaterThan(N * 0.8);
  });

  it('ignoring the wind costs rings', () => {
    let windy = 0;
    for (let i = 0; i < 40; i++) {
      const s = E.init([A, B], BigInt(2000 + i), {});
      if (Math.abs(s.winds[0]!) < 60) continue;
      windy++;
      expect(E.apply(s, A, shot(0, 0)).last!.score).toBeLessThanOrEqual(7);
    }
    expect(windy).toBeGreaterThan(5);
  });

  it('the tremor is seeded: same seed same arrows, other seed other arrows; always four draws', () => {
    const arrows = (seed: bigint) => {
      let s = E.init([A, B], seed, {});
      for (let i = 0; i < 3; i++) s = E.apply(s, A, shot(10, 10, 700));
      return s.arrows[A]!.map((r) => [r.x, r.y]);
    };
    expect(arrows(3n)).toEqual(arrows(3n));
    expect(arrows(3n)).not.toEqual(arrows(4n));
    const s = E.init([A, B], 9n, {});
    expect(E.apply(s, A, shot(0, 0, 1000)).rng).toEqual(E.apply(s, A, WILD).rng);
  });

  it('winner: most points; then most Xs; then a draw', () => {
    const last = (score: [number, number], xs: [number, number]): ArcheryState => {
      const s = E.init([A, B], 1n, { ends: 1, arrowsPerEnd: 1 });
      // B is about to shoot the final arrow, which will miss and add nothing.
      return {
        ...s,
        turn: 1,
        score: { [A]: score[0], [B]: score[1] },
        xs: { [A]: xs[0], [B]: xs[1] },
      };
    };
    let s = play(last([40, 39], [0, 5]), B, WILD);
    expect(s.over).toBe(true);
    expect(s.winner).toBe(A);
    s = play(last([39, 40], [0, 0]), B, WILD);
    expect(s.winner).toBe(B);
    s = play(last([40, 40], [3, 2]), B, WILD);
    expect(s.winner).toBe(A);
    s = play(last([40, 40], [2, 2]), B, WILD);
    expect(s.winner).toBeNull();
    expect(E.result(s)).toEqual({ placements: [[A, B]], draw: true });
  });

  it('view never carries the RNG; apply does not mutate', () => {
    const s = fresh();
    const h = hashState(s);
    const t = E.apply(s, A, shot());
    expect(hashState(s)).toBe(h);
    for (const v of [A, B, 'spectator'] as const) {
      expect(JSON.stringify(E.view(t, v))).not.toContain('"rng"');
    }
  });

  it('actionSchema is strict about integers and ranges', () => {
    expect(archeryActionSchema.safeParse(shot(-1200, 1200, 0)).success).toBe(true);
    expect(archeryActionSchema.safeParse(shot(1201)).success).toBe(false);
    expect(archeryActionSchema.safeParse(shot(0, 0, 1001)).success).toBe(false);
    expect(archeryActionSchema.safeParse({ kind: 'shoot', aimX: 0, aimY: 0 }).success).toBe(false);
    expect(
      archeryActionSchema.safeParse({ kind: 'shoot', aimX: 0.5, aimY: 0, draw: 1 }).success,
    ).toBe(false);
  });

  it('rejects a bad setup', () => {
    expect(() => E.init([A], 1n, {})).toThrow();
    expect(() => E.init([A, A], 1n, {})).toThrow();
    expect(() => E.init([A, B], 1n, { ends: 0 })).toThrow();
    expect(() => E.init([A, B], 1n, { arrowsPerEnd: 7 })).toThrow();
  });
});

describeEngine(E, {
  playerCounts: [2],
  cfg: {},
  candidates: (s): ArcheryAction[] => [
    shot(0, 0, DRAW_MAX),
    shot(-(s.winds[s.end] ?? 0) * 3, 20, 900),
    shot(100, -100, 500),
    WILD,
  ],
  illegal: () => [shot(5000), shot(0, 0, 5000)],
  numRuns: 40,
});
