import { hashState } from '../hash.ts';
import { describeEngine } from '../testing/engineHarness.ts';
import { cosDeg, sinDeg } from './detmath.ts';
import {
  TANKS_COLS,
  generateTanksTerrain,
  tanksActionSchema,
  tanksAutoAction,
  tanksEngine as E,
  type TanksAction,
  type TanksState,
} from './engine.ts';
import { seedRng } from '../rng.ts';
import {
  COLS,
  COL_W,
  TANK_HP,
  WEAPONS,
  WORLD_H,
  carve,
  groundAt,
  simulateShot,
  tankCentre,
  type Weapon,
} from './physics.ts';

type S = TanksState;
const P: [string, string] = ['a', 'b'];
const init = (seed = 5n, cfg = {}): S => E.init(P, seed, cfg);
const fire = (angle: number, power: number, weapon: Weapon = 'shell'): TanksAction => ({
  kind: 'fire',
  angle,
  power,
  weapon,
});
function go(s: S, a: TanksAction): S {
  const by = E.currentPlayers(s)[0] as string;
  const v = E.validate(s, by, a);
  if (!v.ok) throw new Error(`refused: ${v.code}`);
  return E.apply(s, by, a);
}
const flat = (h: number): number[] => new Array<number>(COLS).fill(h);

/** A shot from tank 0 that damages tank 1 on this state (searched, not hand-tuned). */
function findHit(s: S, weapon: Weapon = 'shell'): { angle: number; power: number } {
  for (let power = 100; power >= 1; power--) {
    for (let angle = 20; angle <= 80; angle++) {
      const r = simulateShot(s.terrain, s.tankCols, s.hp, 0, s.wind, weapon, angle, power);
      if (r.impacts.some((i) => i.damage[1] > 0)) return { angle, power };
    }
  }
  throw new Error('no hit found');
}

describe('tanks trig table', () => {
  it('matches the real functions closely and is symmetric', () => {
    for (let d = 0; d <= 180; d++) {
      const rad = (d * Math.PI) / 180;
      expect(Math.abs(sinDeg(d) - Math.sin(rad))).toBeLessThan(1e-12);
      expect(Math.abs(cosDeg(d) - Math.cos(rad))).toBeLessThan(1e-12);
      expect(Math.abs(sinDeg(d) ** 2 + cosDeg(d) ** 2 - 1)).toBeLessThan(1e-12);
      expect(sinDeg(d)).toBe(sinDeg(180 - d));
      expect(cosDeg(d) + 0).toBe(-cosDeg(180 - d) + 0);
    }
    expect(cosDeg(90)).toBe(0);
    expect(sinDeg(0)).toBe(0);
  });
});

describe('tanks terrain', () => {
  it('is 200 sane columns, deterministic, different per seed, with a flat pad under each tank', () => {
    const [t, rng] = generateTanksTerrain(seedRng(11n));
    expect(t).toHaveLength(COLS);
    expect(t.every((h) => Number.isInteger(h) && h >= 90 && h <= 260 && h < WORLD_H)).toBe(true);
    expect(generateTanksTerrain(seedRng(11n))[0]).toEqual(t);
    expect(generateTanksTerrain(seedRng(12n))[0]).not.toEqual(t);
    expect(rng).not.toEqual(seedRng(11n));
    for (const tc of TANKS_COLS) {
      for (let c = tc - 5; c <= tc + 5; c++) expect(t[c]).toBe(t[tc]);
    }
  });

  it('carve digs craters, leaves the rest, never goes below zero and does not mutate', () => {
    const g = flat(100);
    const before = g.slice();
    const c = carve(g, 400, 100, 30);
    expect(g).toEqual(before);
    expect(c[100]).toBeLessThan(100); // col 100 is the centre (x = 402)
    expect(c[100]).toBe(70);
    expect(c[0]).toBe(100);
    expect(c[199]).toBe(100);
    for (let col = 0; col < COLS; col++) expect(c[col]).toBeLessThanOrEqual(100);
    const deep = carve(flat(10), 400, 0, 50);
    expect(deep.every((h) => h >= 0)).toBe(true);
    const edge = carve(g, 0, 100, 30);
    expect(edge).toHaveLength(COLS);
    expect(groundAt(c, 402)).toBe(70);
    expect(groundAt(c, -5)).toBe(c[0]);
    expect(groundAt(c, 5000)).toBe(c[COLS - 1]);
  });
});

describe('tanks shell physics', () => {
  const s0 = init();

  it('is a pure function: same input → same outcome, trace or not', () => {
    const a = simulateShot(s0.terrain, s0.tankCols, s0.hp, 0, 3, 'shell', 50, 70);
    const b = simulateShot(s0.terrain, s0.tankCols, s0.hp, 0, 3, 'shell', 50, 70, true);
    expect(b.impacts).toEqual(a.impacts);
    expect(b.terrain).toEqual(a.terrain);
    expect(b.hp).toEqual(a.hp);
    expect(a.traces).toEqual([]);
    expect(b.traces).toHaveLength(1);
    expect(b.traces[0]!.length).toBeGreaterThan(5);
  });

  it('does not mutate the terrain it is given', () => {
    const before = s0.terrain.slice();
    simulateShot(s0.terrain, s0.tankCols, s0.hp, 0, 0, 'heavy', 45, 60);
    expect(s0.terrain).toEqual(before);
  });

  it('a shell fired straight up falls back on its own tank', () => {
    const r = simulateShot(flat(100), [25, 175], [100, 100], 0, 0, 'shell', 90, 20);
    expect(r.impacts[0]!.kind).toBe('tank');
    expect(r.impacts[0]!.damage[0]).toBeGreaterThan(0);
    expect(r.impacts[0]!.damage[1]).toBe(0);
    expect(r.hp[0]).toBeLessThan(100);
    expect(r.hp[1]).toBe(100);
  });

  it('wind pushes the shell: a tailwind lands further than a headwind', () => {
    const land = (wind: number): number =>
      simulateShot(flat(100), [25, 175], [100, 100], 0, wind, 'shell', 45, 60).impacts[0]!.x;
    expect(land(10)).toBeGreaterThan(land(0));
    expect(land(0)).toBeGreaterThan(land(-10));
  });

  it('more power flies further on flat ground', () => {
    const land = (power: number): number =>
      simulateShot(flat(60), [25, 175], [100, 100], 0, 0, 'shell', 45, power).impacts[0]!.x;
    expect(land(40)).toBeLessThan(land(60));
    expect(land(60)).toBeLessThan(land(80));
  });

  it('a shot that leaves the world does nothing', () => {
    const t = flat(40);
    const r = simulateShot(t, [25, 175], [100, 100], 0, 0, 'shell', 180, 100);
    expect(r.impacts).toHaveLength(1);
    expect(r.impacts[0]!.kind).toBe('out');
    expect(r.terrain).toEqual(t);
    expect(r.hp).toEqual([100, 100]);
  });

  it('a hit on the ground carves a crater and damage falls off with distance', () => {
    const t = flat(100);
    const near = simulateShot(t, [60, 62], [100, 100], 0, 0, 'heavy', 90, 15);
    const far = simulateShot(t, [60, 100], [100, 100], 0, 0, 'heavy', 90, 15);
    expect(near.impacts[0]!.damage[1]).toBeGreaterThan(far.impacts[0]!.damage[1]);
    expect(near.impacts[0]!.damage[1]).toBeGreaterThan(0);
    expect(far.impacts[0]!.damage[1]).toBe(0);
    expect(near.terrain.some((h, i) => h < (t[i] as number))).toBe(true);
  });

  it('weapons differ: heavy digs and hurts more than a shell; a triple fires three shells', () => {
    const t = flat(100);
    const args = [t, [60, 62], [100, 100], 0, 0] as const;
    const shell = simulateShot(...args, 'shell', 90, 15);
    const heavy = simulateShot(...args, 'heavy', 90, 15);
    expect(heavy.impacts[0]!.damage[0]).toBeGreaterThan(shell.impacts[0]!.damage[0]);
    const dug = (r: { terrain: number[] }): number =>
      t.reduce((n, h, i) => n + (h - (r.terrain[i] as number)), 0);
    expect(dug(heavy)).toBeGreaterThan(dug(shell));
    const tri = simulateShot(t, [30, 170], [100, 100], 0, 0, 'triple', 60, 50);
    expect(tri.impacts).toHaveLength(3);
    const xs = tri.impacts.map((i) => i.x);
    expect(new Set(xs).size).toBe(3);
    expect(WEAPONS.triple.shells).toBe(3);
  });

  it('tanks settle onto the ground a blast leaves', () => {
    const t = flat(100);
    const r = simulateShot(t, [60, 120], [100, 100], 0, 0, 'heavy', 90, 15);
    expect(tankCentre(r.terrain, 60).y).toBeLessThan(tankCentre(t, 60).y);
  });
});

describe('tanks engine', () => {
  it('needs exactly two distinct players and sane config', () => {
    expect(() => E.init(['a'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'b', 'c'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'a'], 1n, {})).toThrow();
    expect(() => E.init(P, 1n, { maxShots: 0 })).toThrow();
  });

  it('starts deterministically: hp 100, full ammo, a wind in range, players[0] first', () => {
    const s = init(9n);
    expect(hashState(init(9n))).toBe(hashState(s));
    expect(s.hp).toEqual([TANK_HP, TANK_HP]);
    expect(s.ammo['a']).toEqual({ heavy: 2, triple: 2 });
    expect(Math.abs(s.wind)).toBeLessThanOrEqual(10);
    expect(E.currentPlayers(s)).toEqual(['a']);
    expect(s.tankCols).toEqual([25, 175]);
    const winds = new Set<number>();
    for (let i = 1n; i < 30n; i++) winds.add(init(i).wind);
    expect(winds.size).toBeGreaterThan(5);
  });

  it('validates turn order, ranges, weapons and ammo', () => {
    const s = init();
    expect(E.validate(s, 'b', fire(45, 50))).toEqual({ ok: false, code: 'not_your_turn' });
    expect(E.validate(s, 'a', fire(181, 50))).toEqual({ ok: false, code: 'bad_angle' });
    expect(E.validate(s, 'a', fire(-1, 50))).toEqual({ ok: false, code: 'bad_angle' });
    expect(E.validate(s, 'a', fire(45.5, 50))).toEqual({ ok: false, code: 'bad_angle' });
    expect(E.validate(s, 'a', fire(45, 0))).toEqual({ ok: false, code: 'bad_power' });
    expect(E.validate(s, 'a', fire(45, 101))).toEqual({ ok: false, code: 'bad_power' });
    expect(
      E.validate(s, 'a', { kind: 'fire', angle: 45, power: 50, weapon: 'nuke' as Weapon }),
    ).toEqual({
      ok: false,
      code: 'bad_weapon',
    });
    expect(E.validate(s, 'a', fire(45, 50, 'heavy')).ok).toBe(true);
    const spent: S = { ...s, ammo: { ...s.ammo, a: { heavy: 0, triple: 1 } } };
    expect(E.validate(spent, 'a', fire(45, 50, 'heavy'))).toEqual({ ok: false, code: 'no_ammo' });
    expect(E.validate(spent, 'a', fire(45, 50, 'triple')).ok).toBe(true);
    expect(E.validate(spent, 'a', fire(45, 50, 'shell')).ok).toBe(true);
  });

  it('a shot passes the turn, counts the shot, draws a new wind and records the shot', () => {
    const s = init(3n);
    const n = go(s, fire(40, 60));
    expect(n.turn).toBe(1);
    expect(n.shots).toEqual([1, 0]);
    expect(E.currentPlayers(n)).toEqual(['b']);
    expect(n.last).toMatchObject({
      seq: 1,
      by: 'a',
      angle: 40,
      power: 60,
      weapon: 'shell',
      wind: s.wind,
    });
    expect(n.last!.impacts.length).toBe(1);
    expect(n.rng).not.toEqual(s.rng);
    let differs = false;
    for (let i = 1n; i < 20n && !differs; i++)
      differs = go(init(i), fire(40, 60)).wind !== init(i).wind;
    expect(differs).toBe(true);
  });

  it('special weapons use up ammo; a shell never does', () => {
    let s = init();
    s = go(s, fire(45, 50, 'heavy'));
    expect(s.ammo['a']).toEqual({ heavy: 1, triple: 2 });
    expect(s.ammo['b']).toEqual({ heavy: 2, triple: 2 });
    s = go(s, fire(135, 50, 'triple'));
    expect(s.ammo['b']).toEqual({ heavy: 2, triple: 1 });
    s = go(s, fire(45, 50, 'shell'));
    expect(s.ammo['a']).toEqual({ heavy: 1, triple: 2 });
  });

  it('a hit costs hit points and craters the ground', () => {
    const s = init(5n);
    const { angle, power } = findHit(s);
    const n = go(s, fire(angle, power));
    expect(n.hp[1]).toBeLessThan(100);
    expect(n.hp[0]).toBe(100);
    expect(n.terrain).not.toEqual(s.terrain);
    expect(n.last!.impacts[0]!.damage[1]).toBe(100 - n.hp[1]);
  });

  it('the first tank to reach 0 hp loses', () => {
    const s: S = { ...init(5n), hp: [100, 1] };
    const { angle, power } = findHit(s);
    const n = go(s, fire(angle, power));
    expect(n.over).toBe(true);
    expect(n.winner).toBe('a');
    expect(E.isTerminal(n)).toBe(true);
    expect(E.currentPlayers(n)).toEqual([]);
    expect(E.result(n)).toEqual({ placements: [['a'], ['b']], draw: false });
    expect(E.validate(n, 'b', fire(45, 50))).toEqual({ ok: false, code: 'game_over' });
  });

  it('killing yourself loses; both dying from one shot is a draw', () => {
    const base = init(2n);
    // a fires straight up and the shell comes back down on a's own tank
    const suicide: S = { ...base, terrain: flat(100), tankCols: [60, 160], hp: [1, 100] };
    const lost = go(suicide, fire(90, 20));
    expect(lost.over).toBe(true);
    expect(lost.winner).toBe('b');
    // two tanks side by side, both at 1 hp: the same blast takes both
    const both: S = { ...base, terrain: flat(100), tankCols: [60, 62], hp: [1, 1] };
    const draw = go(both, fire(90, 20));
    expect(draw.over).toBe(true);
    expect(draw.winner).toBeNull();
    expect(E.result(draw)).toEqual({ placements: [['a', 'b']], draw: true });
  });

  it('after maxShots each, more hit points wins; equal hit points is a draw', () => {
    // both fire into the air from far apart: nobody is touched
    const far: S = { ...init(4n, { maxShots: 1 }), terrain: flat(100) };
    // angle 180 at full power flies off the left edge for a (and off the right for b at angle 0)
    let n = go(far, fire(180, 100));
    expect(n.over).toBe(false);
    n = go(n, fire(0, 100));
    expect(n.over).toBe(true);
    expect(n.winner).toBeNull();
    expect(E.result(n).draw).toBe(true);
    // unequal: b has taken damage
    const hurt: S = { ...far, hp: [100, 60] };
    let m = go(hurt, fire(180, 100));
    m = go(m, fire(0, 100));
    expect(m.over).toBe(true);
    expect(m.winner).toBe('a');
  });

  it('apply never mutates its input and is deterministic', () => {
    const s = init(6n);
    const before = hashState(s);
    const a = go(s, fire(50, 65, 'triple'));
    expect(hashState(s)).toBe(before);
    expect(hashState(go(s, fire(50, 65, 'triple')))).toBe(hashState(a));
  });

  it('view shows the whole battlefield but never the RNG', () => {
    const s = init();
    const v = E.view(s, 'b') as Record<string, unknown>;
    expect(Object.keys(v)).not.toContain('rng');
    expect(v['terrain']).toEqual(s.terrain);
    expect(v['wind']).toBe(s.wind);
    expect(JSON.stringify(E.view(s, 'spectator'))).toBe(JSON.stringify(v));
    expect(JSON.stringify(v)).not.toContain('"rng"');
  });

  it('actionSchema accepts the wire shape and rejects junk', () => {
    const ok = (x: unknown): boolean => tanksActionSchema.safeParse(x).success;
    expect(ok({ kind: 'fire', angle: 0, power: 1, weapon: 'shell' })).toBe(true);
    expect(ok({ kind: 'fire', angle: 180, power: 100, weapon: 'triple' })).toBe(true);
    expect(ok({ kind: 'fire', angle: 181, power: 100, weapon: 'shell' })).toBe(false);
    expect(ok({ kind: 'fire', angle: 90, power: 0, weapon: 'shell' })).toBe(false);
    expect(ok({ kind: 'fire', angle: 90, power: 50, weapon: 'nuke' })).toBe(false);
    expect(ok({ kind: 'fire', angle: 90.5, power: 50, weapon: 'shell' })).toBe(false);
    expect(ok({ kind: 'fire', angle: 90, power: 50 })).toBe(false);
    expect(COL_W * COLS).toBe(800);
  });
});

describeEngine<S, TanksAction, object>(E, {
  playerCounts: [2],
  cfg: { maxShots: 6 },
  numRuns: 15,
  maxSteps: 40,
  candidates: (s, by) => {
    const mine = by === s.players[0];
    const base = mine ? 45 : 135;
    const spend = (w: Weapon): TanksAction[] => [
      fire(base, 55, w),
      fire(base + 10, 70, w),
      fire(base - 15, 85, w),
    ];
    return [
      ...spend('shell'),
      ...spend('heavy'),
      ...spend('triple'),
      fire(90, 30),
      fire(0, 100),
      fire(180, 100),
    ];
  },
  illegal: () => [fire(181, 50), fire(45, 0), fire(45, 101), fire(-1, 10)],
});

describe('tanks auto action', () => {
  it('is legal and leaves the shooter unhurt on most seeds', () => {
    let unhurt = 0;
    for (let seed = 1n; seed <= 20n; seed++) {
      const s = init(seed);
      const a = tanksAutoAction(s);
      expect(E.validate(s, 'a', a).ok).toBe(true);
      expect(a.weapon).toBe('shell');
      if (go(s, a).hp[0] === 100) unhurt++;
    }
    expect(unhurt).toBeGreaterThanOrEqual(15);
  });
});
