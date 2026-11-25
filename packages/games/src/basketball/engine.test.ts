import { hashState } from '../hash.ts';
import { describeEngine } from '../testing/engineHarness.ts';
import {
  BASKETBALL_AIM_JITTER,
  BASKETBALL_MONEY_POINTS,
  BASKETBALL_POWER_JITTER,
  basketballActionSchema,
  basketballEngine as E,
  basketballIsMoneyRack,
  type BasketballAction,
  type BasketballState,
} from './engine.ts';
import { AIM_MAX, POWER_MAX, RACKS, launchSpeed, simulateShot } from './physics.ts';

const A = 'a';
const B = 'b';
const shoot = (aim = 0, power = 500): BasketballAction => ({ kind: 'shoot', aim, power });
/** Falls short whatever the wobble. */
const MISS = shoot(AIM_MAX, 0);

/** A power that swishes at aim 0 from this rack (found by scanning, like a player would). */
const swishCache: Record<number, number> = {};
const swishPower = (rack: number): number => {
  const hit = swishCache[rack];
  if (hit !== undefined) return hit;
  for (let p = 400; p < 700; p++) {
    if (simulateShot(rack, { aim: 0, power: p }).outcome.swish) return (swishCache[rack] = p + 8);
  }
  throw new Error('no swish power');
};

function play(s: BasketballState, who: string, ...actions: BasketballAction[]): BasketballState {
  let cur = s;
  for (const a of actions) {
    const v = E.validate(cur, who, a);
    if (!v.ok) throw new Error(`illegal ${JSON.stringify(a)}: ${v.code}`);
    cur = E.apply(cur, who, a);
  }
  return cur;
}

describe('basketball physics', () => {
  it('is a pure function: same input → same outcome, trace or not', () => {
    const a = simulateShot(2, { aim: 10, power: 520 });
    const b = simulateShot(2, { aim: 10, power: 520 }, true);
    expect(b.outcome).toEqual(a.outcome);
    expect(simulateShot(2, { aim: 10, power: 520 }, true)).toEqual(b);
    expect(a.trace).toEqual([]);
    expect(b.trace.length).toBeGreaterThan(10);
  });

  it('has five racks, mirrored left and right, all about the three-point distance', () => {
    expect(RACKS).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      const r = RACKS[i]!;
      const m = RACKS[4 - i]!;
      expect(m).toEqual({ x: r.x === 0 ? 0 : -r.x, z: r.z });
      const d = Math.sqrt(r.x * r.x + r.z * r.z) / 1000;
      expect(d).toBeGreaterThan(6.6);
      expect(d).toBeLessThan(6.9);
    }
  });

  it('every rack has a centred swish at some power, and the mirror rack mirrors it', () => {
    for (let r = 0; r < 5; r++) {
      const p = swishPower(r) - 8;
      const o = simulateShot(r, { aim: 0, power: p }).outcome;
      expect(o).toMatchObject({ made: true, swish: true, rimHits: 0, boardHits: 0 });
    }
    expect(simulateShot(0, { aim: 0, power: 515 }).outcome.made).toBe(
      simulateShot(4, { aim: 0, power: 515 }).outcome.made,
    );
  });

  it('too soft falls short, too hard flies over, off-line misses', () => {
    const p = swishPower(1) - 8;
    expect(simulateShot(1, { aim: 0, power: p - 80 }).outcome.made).toBe(false);
    expect(simulateShot(1, { aim: 0, power: p + 120 }).outcome.made).toBe(false);
    expect(simulateShot(1, { aim: 200, power: p }).outcome.made).toBe(false);
    expect(simulateShot(1, { aim: -200, power: p }).outcome.made).toBe(false);
  });

  it('a slightly strong shot can bank in off the backboard', () => {
    let bank = 0;
    for (let p = 520; p < 680; p++) {
      const o = simulateShot(2, { aim: 0, power: p }).outcome;
      if (o.made && o.boardHits > 0) bank++;
    }
    expect(bank).toBeGreaterThan(10);
  });

  it('the rim can turn a ball away', () => {
    let rim = 0;
    for (let a = -60; a <= 60; a += 4) {
      for (let p = 470; p < 560; p += 2) {
        const o = simulateShot(1, { aim: a, power: p }).outcome;
        if (!o.made && o.rimHits > 0) rim++;
      }
    }
    expect(rim).toBeGreaterThan(0);
  });

  it('a shot always ends, and reports whole millimetres', () => {
    for (let rack = 0; rack < 5; rack++) {
      for (const aim of [-500, -123, 0, 77, 500]) {
        for (const power of [0, 1, 300, 600, 999, 1000]) {
          const o = simulateShot(rack, { aim, power }).outcome;
          expect(o.steps).toBeLessThanOrEqual(600);
          expect(Number.isInteger(o.endX) && Number.isInteger(o.endZ)).toBe(true);
        }
      }
    }
  });

  it('launch speed rises with power', () => {
    expect(launchSpeed(0)).toBeLessThan(launchSpeed(500));
    expect(launchSpeed(500)).toBeLessThan(launchSpeed(POWER_MAX));
  });
});

describe('basketball match', () => {
  const fresh = (cfg = {}) => E.init([A, B], 5n, cfg);

  it('starts with A on the first rack with five shots', () => {
    const s = fresh();
    expect(E.currentPlayers(s)).toEqual([A]);
    expect(s).toMatchObject({ rack: 0, shotsLeft: 5, racks: 5, shotsPerRack: 5 });
  });

  it('a turn is one rack of five shots, then it passes; B shoots the same rack', () => {
    let s = fresh();
    s = play(s, A, MISS, MISS, MISS, MISS);
    expect(E.currentPlayers(s)).toEqual([A]);
    s = play(s, A, MISS);
    expect(E.currentPlayers(s)).toEqual([B]);
    expect(s.rack).toBe(0);
    s = play(s, B, MISS, MISS, MISS, MISS, MISS);
    expect(E.currentPlayers(s)).toEqual([A]);
    expect(s.rack).toBe(1);
    expect(s.last).toMatchObject({ by: B, rack: 0, shot: 5 });
  });

  it('plays 5 racks × 5 shots each, then ends and rejects more', () => {
    let s = fresh();
    for (let r = 0; r < 5; r++) {
      s = play(s, A, MISS, MISS, MISS, MISS, MISS);
      s = play(s, B, MISS, MISS, MISS, MISS, MISS);
    }
    expect(s.over).toBe(true);
    expect(s.shots[A]).toHaveLength(25);
    expect(s.shots[B]).toHaveLength(25);
    expect(s.score).toEqual({ [A]: 0, [B]: 0 });
    expect(E.result(s)).toEqual({ placements: [[A, B]], draw: true });
    expect(E.currentPlayers(s)).toEqual([]);
    expect(E.validate(s, A, MISS)).toEqual({ ok: false, code: 'game_over' });
  });

  it('each rack is shot from its own spot; the last rack is the money-ball rack', () => {
    expect(basketballIsMoneyRack(4, 5)).toBe(true);
    expect(basketballIsMoneyRack(3, 5)).toBe(false);
    let s = fresh();
    const seen: number[] = [];
    for (let r = 0; r < 5; r++) {
      s = play(s, A, MISS, MISS, MISS, MISS, MISS);
      seen.push(s.last!.rack);
      s = play(s, B, MISS, MISS, MISS, MISS, MISS);
    }
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect(s.shots[A]!.filter((x) => x.money)).toHaveLength(5);
    expect(s.shots[A]!.filter((x) => x.rack < 4).every((x) => !x.money)).toBe(true);
  });

  it('a make scores 1, and 2 on the money rack; the score is the sum of the shots', () => {
    // Find seeds where a centred swish-power shot goes in, on rack 0 and on the last rack.
    const first = (rack: number) => {
      for (let seed = 1n; seed < 400n; seed++) {
        const s = { ...E.init([A, B], seed, { racks: 5 }), rack };
        const t = E.apply(s, A, shoot(0, swishPower(rack)));
        if (t.last!.made) return t;
      }
      throw new Error('no make found');
    };
    const t0 = first(0);
    expect(t0.last).toMatchObject({ made: true, money: false, points: 1 });
    expect(t0.score[A]).toBe(1);
    expect(t0.made[A]).toBe(1);
    const t4 = first(4);
    expect(t4.last).toMatchObject({ made: true, money: true, points: BASKETBALL_MONEY_POINTS });
    expect(t4.score[A]).toBe(2);

    // And over a whole game the score always equals the points on the shot records.
    let s = fresh();
    for (let r = 0; r < 5; r++) {
      s = play(s, A, ...Array.from({ length: 5 }, () => shoot(0, swishPower(r))));
      s = play(s, B, ...Array.from({ length: 5 }, () => shoot(0, swishPower(r))));
    }
    for (const p of [A, B]) {
      expect(s.score[p]).toBe(s.shots[p]!.reduce((n, x) => n + x.points, 0));
      expect(s.made[p]).toBe(s.shots[p]!.filter((x) => x.made).length);
      expect(s.score[p]).toBeGreaterThan(5);
      expect(s.score[p]).toBeLessThanOrEqual(30);
    }
    expect(s.over).toBe(true);
    const res = E.result(s);
    if (s.winner)
      expect(res).toEqual({ placements: [[s.winner], [s.winner === A ? B : A]], draw: false });
    else expect(res.draw).toBe(true);
  });

  it('winner is the higher score; equal is a draw', () => {
    const last = (a: number, b: number): BasketballState => ({
      ...E.init([A, B], 1n, { racks: 1, shotsPerRack: 1 }),
      turn: 1,
      score: { [A]: a, [B]: b },
    });
    expect(play(last(3, 2), B, MISS).winner).toBe(A);
    expect(play(last(2, 3), B, MISS).winner).toBe(B);
    const d = play(last(3, 3), B, MISS);
    expect(d.winner).toBeNull();
    expect(E.result(d).draw).toBe(true);
  });

  it('rejects the wrong player and out-of-range input', () => {
    const s = fresh();
    expect(E.validate(s, B, shoot())).toEqual({ ok: false, code: 'not_your_turn' });
    expect(E.validate(s, A, shoot(AIM_MAX + 1))).toEqual({ ok: false, code: 'bad_aim' });
    expect(E.validate(s, A, shoot(0.5))).toEqual({ ok: false, code: 'bad_aim' });
    expect(E.validate(s, A, shoot(0, POWER_MAX + 1))).toEqual({ ok: false, code: 'bad_power' });
    expect(E.validate(s, A, shoot(0, -1))).toEqual({ ok: false, code: 'bad_power' });
  });

  it('the release wobble is seeded, bounded and always two draws', () => {
    const run = (seed: bigint) => {
      let s = E.init([A, B], seed, {});
      for (let i = 0; i < 5; i++) s = E.apply(s, A, shoot(0, 500));
      return s.shots[A]!.map((x) => x.applied);
    };
    expect(run(8n)).toEqual(run(8n));
    expect(run(8n)).not.toEqual(run(9n));
    for (const a of run(8n)) {
      expect(Math.abs(a.aim)).toBeLessThanOrEqual(BASKETBALL_AIM_JITTER);
      expect(Math.abs(a.power - 500)).toBeLessThanOrEqual(BASKETBALL_POWER_JITTER);
    }
    const s = E.init([A, B], 2n, {});
    expect(E.apply(s, A, shoot(0, swishPower(0))).rng).toEqual(E.apply(s, A, MISS).rng);
  });

  it('a centred input goes in sometimes but not always (the wobble matters)', () => {
    let made = 0;
    const N = 200;
    for (let i = 0; i < N; i++) {
      const s = { ...E.init([A, B], BigInt(i + 1), {}), rack: 1 };
      if (E.apply(s, A, shoot(0, swishPower(1))).last!.made) made++;
    }
    expect(made).toBeGreaterThan(N * 0.25);
    expect(made).toBeLessThan(N * 0.9);
  });

  it('apply does not mutate; view hides the RNG', () => {
    const s = fresh();
    const h = hashState(s);
    const t = E.apply(s, A, shoot());
    expect(hashState(s)).toBe(h);
    for (const v of [A, B, 'spectator'] as const) {
      expect(JSON.stringify(E.view(t, v))).not.toContain('"rng"');
    }
  });

  it('actionSchema is strict about integers and ranges', () => {
    expect(basketballActionSchema.safeParse(shoot(-500, 1000)).success).toBe(true);
    expect(basketballActionSchema.safeParse(shoot(501)).success).toBe(false);
    expect(basketballActionSchema.safeParse(shoot(0, 1001)).success).toBe(false);
    expect(basketballActionSchema.safeParse({ kind: 'shoot', aim: 0 }).success).toBe(false);
    expect(basketballActionSchema.safeParse({ kind: 'shoot', aim: 0, power: 0.5 }).success).toBe(
      false,
    );
  });

  it('rejects a bad setup', () => {
    expect(() => E.init([A], 1n, {})).toThrow();
    expect(() => E.init([A, A], 1n, {})).toThrow();
    expect(() => E.init([A, B], 1n, { racks: 0 })).toThrow();
    expect(() => E.init([A, B], 1n, { racks: 6 })).toThrow();
    expect(() => E.init([A, B], 1n, { shotsPerRack: 11 })).toThrow();
  });
});

describeEngine(E, {
  playerCounts: [2],
  cfg: {},
  candidates: (s): BasketballAction[] => [
    shoot(0, swishPower(s.rack)),
    shoot(30, 480),
    shoot(-20, 600),
    shoot(500, 0),
    shoot(0, 1000),
  ],
  illegal: () => [shoot(5000), shoot(0, 5000)],
  numRuns: 25,
});
