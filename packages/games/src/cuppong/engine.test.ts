import { hashState } from '../hash.ts';
import { describeEngine } from '../testing/engineHarness.ts';
import {
  CUP_PONG_AIM_JITTER,
  CUP_PONG_POWER_JITTER,
  cupPongCanRerack,
  cupPongActionSchema,
  cupPongEngine as E,
  cupPongRack,
  type CupPongAction,
  type CupPongState,
} from './engine.ts';
import { simulateThrow, type CupPos } from './physics.ts';

const FRONT: CupPos = { id: 9, x: 0, z: 2109 };
const RACK = cupPongRack();

describe('cup pong physics', () => {
  it('is a pure function: same input → same outcome, trace or not', () => {
    const a = simulateThrow(RACK, { aim: 40, power: 560 });
    const b = simulateThrow(RACK, { aim: 40, power: 560 }, true);
    expect(b.outcome).toEqual(a.outcome);
    expect(simulateThrow(RACK, { aim: 40, power: 560 }, true)).toEqual(b);
    expect(a.trace).toEqual([]);
    expect(b.trace.length).toBeGreaterThan(10);
  });

  it('does not mutate the cups', () => {
    const before = JSON.stringify(RACK);
    simulateThrow(RACK, { aim: 0, power: 540 });
    expect(JSON.stringify(RACK)).toBe(before);
  });

  it('a centred throw at the right power drops into the front cup', () => {
    const r = simulateThrow([FRONT], { aim: 0, power: 538 });
    expect(r.outcome.sunk).toBe(9);
    expect(r.outcome.bounces).toBe(0);
  });

  it('too soft falls short, too hard flies over, off-line misses', () => {
    expect(simulateThrow([FRONT], { aim: 0, power: 400 }).outcome.sunk).toBeNull();
    expect(simulateThrow([FRONT], { aim: 0, power: 700 }).outcome.sunk).toBeNull();
    expect(simulateThrow([FRONT], { aim: 120, power: 538 }).outcome.sunk).toBeNull();
    expect(simulateThrow([FRONT], { aim: -120, power: 538 }).outcome.sunk).toBeNull();
  });

  it('a ball that bounces on the table first can still drop in (bounce shot)', () => {
    let found = false;
    for (let p = 250; p < 360 && !found; p++) {
      const o = simulateThrow([FRONT], { aim: 0, power: p }).outcome;
      if (o.sunk === 9) {
        expect(o.bounces).toBeGreaterThanOrEqual(1);
        found = true;
      }
    }
    expect(found).toBe(true);
  });

  it('the rim can turn a ball away', () => {
    let rim = 0;
    for (let a = -60; a <= 60; a += 2) {
      for (let p = 520; p < 560; p++) {
        const o = simulateThrow([FRONT], { aim: a, power: p }).outcome;
        if (o.sunk === null && o.rimHits > 0) rim++;
      }
    }
    expect(rim).toBeGreaterThan(0);
  });

  it('a throw always ends (no input runs forever) and reports whole millimetres', () => {
    for (const aim of [-500, -123, 0, 77, 500]) {
      for (const power of [0, 1, 300, 600, 999, 1000]) {
        const o = simulateThrow(RACK, { aim, power }).outcome;
        expect(o.steps).toBeLessThanOrEqual(1200);
        expect(Number.isInteger(o.endX)).toBe(true);
        expect(Number.isInteger(o.endZ)).toBe(true);
      }
    }
  });

  it('keeps pinned results (cross-runtime drift would change these)', () => {
    const grid: [number, number][] = [
      [0, 538],
      [-110, 584],
      [57, 560],
      [200, 300],
      [-500, 1000],
    ];
    const got = grid.map(([aim, power]) => {
      const o = simulateThrow(RACK, { aim, power }).outcome;
      return [o.sunk, o.bounces, o.rimHits, o.endX, o.endZ];
    });
    // [sunk cup, bounces, rim hits, end x mm, end z mm]
    expect(got).toEqual([
      [9, 0, 0, 0, 2110],
      [4, 0, 0, -98, 2318],
      [8, 0, 0, 47, 2210],
      [null, 2, 0, 243, 3188],
      [null, 0, 0, -659, 3444],
    ]);
  });
});

describe('cup pong racks', () => {
  it('has 10 cups with unique ids, inside the table and not overlapping', () => {
    expect(RACK).toHaveLength(10);
    expect(new Set(RACK.map((c) => c.id)).size).toBe(10);
    for (const c of RACK) {
      expect(Math.abs(c.x)).toBeLessThanOrEqual(150);
      expect(c.z).toBeGreaterThan(2000);
      expect(c.z).toBeLessThan(2440);
    }
    for (let i = 0; i < RACK.length; i++) {
      for (let j = i + 1; j < RACK.length; j++) {
        const a = RACK[i]!;
        const b = RACK[j]!;
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(95);
      }
    }
  });

  it('re-racks only 2–6 cups, keeping ids, with no overlaps', () => {
    for (let n = 1; n <= 10; n++) expect(cupPongCanRerack(n)).toBe(n >= 2 && n <= 6);
    for (let n = 2; n <= 6; n++) {
      const s = withRacks({ a: RACK.slice(0, n), b: RACK });
      const r = E.apply(s, 'a', { kind: 'rerack' }).racks.a!;
      expect(r.map((c) => c.id).sort()).toEqual(RACK.slice(0, n).map((c) => c.id));
      for (let i = 0; i < r.length; i++) {
        for (let j = i + 1; j < r.length; j++) {
          expect(Math.hypot(r[i]!.x - r[j]!.x, r[i]!.z - r[j]!.z)).toBeGreaterThanOrEqual(95);
        }
      }
    }
  });
});

function fresh(seed = 1n): CupPongState {
  return E.init(['a', 'b'], seed, {});
}
function withRacks(
  racks: { a: CupPos[]; b: CupPos[] },
  over: Partial<CupPongState> = {},
): CupPongState {
  return { ...fresh(), racks, ...over };
}
/** The first throw (searching powers around the direct window) that sinks a cup in this state. */
function findHit(s: CupPongState, by: string): CupPongAction {
  for (const aim of [0, 20, -20, 40, -40, 57, -57, 100, -100]) {
    for (let power = 480; power <= 620; power++) {
      const a: CupPongAction = { kind: 'throw', aim, power };
      if (E.apply(s, by, a).last?.sunk != null) return a;
    }
  }
  throw new Error('no hit found');
}
const MISS: CupPongAction = { kind: 'throw', aim: 0, power: 100 };

describeEngine(E, {
  playerCounts: [2],
  cfg: {},
  numRuns: 40,
  candidates: (s, by): CupPongAction[] => {
    const out: CupPongAction[] = [];
    if (s.ballsLeft === s.ballsPerTurn && !s.rerackUsed[by]) out.push({ kind: 'rerack' });
    for (const aim of [-60, 0, 60])
      for (const power of [100, 300, 540, 560, 580, 900]) out.push({ kind: 'throw', aim, power });
    return out;
  },
  illegal: (s, by): CupPongAction[] => [
    { kind: 'throw', aim: 501, power: 500 },
    { kind: 'throw', aim: 0, power: -1 },
    { kind: 'throw', aim: 0.5, power: 500 },
    ...(s.over || s.players[s.turn] !== by ? [MISS, { kind: 'rerack' } as CupPongAction] : []),
  ],
});

describe('cup pong turns', () => {
  it('starts with 10 cups each and players[0] to throw three balls', () => {
    const s = fresh();
    expect(s.racks.a).toHaveLength(10);
    expect(s.racks.b).toHaveLength(10);
    expect(E.currentPlayers(s)).toEqual(['a']);
    expect(s.ballsLeft).toBe(3);
  });

  it('alternates after ballsPerTurn throws and counts rounds', () => {
    let s = fresh();
    for (let i = 0; i < 2; i++) {
      s = E.apply(s, 'a', MISS);
      expect(E.currentPlayers(s)).toEqual(['a']);
    }
    s = E.apply(s, 'a', MISS);
    expect(E.currentPlayers(s)).toEqual(['b']);
    expect(s.round).toBe(1);
    for (let i = 0; i < 3; i++) s = E.apply(s, 'b', MISS);
    expect(E.currentPlayers(s)).toEqual(['a']);
    expect(s.round).toBe(2);
    expect(s.thrown).toEqual({ a: 3, b: 3 });
  });

  it('a hit removes exactly that cup from the defender and counts for the thrower', () => {
    const s = fresh(3n);
    const hit = findHit(s, 'a');
    const n = E.apply(s, 'a', hit);
    const id = n.last!.sunk!;
    expect(n.racks.b).toHaveLength(9);
    expect(n.racks.b!.some((c) => c.id === id)).toBe(false);
    expect(n.racks.a).toHaveLength(10);
    expect(n.sunk.a).toBe(1);
    expect(n.sunk.b).toBe(0);
  });

  it('the release wobble comes from the seed: replays agree, other seeds can differ', () => {
    const run = (seed: bigint) => {
      let s = fresh(seed);
      for (let i = 0; i < 3; i++) s = E.apply(s, 'a', { kind: 'throw', aim: 0, power: 540 });
      return s;
    };
    expect(hashState(run(5n))).toBe(hashState(run(5n)));
    const applied = new Set<string>();
    for (let seed = 0n; seed < 30n; seed++) {
      const l = run(seed).last!.applied;
      applied.add(`${l.aim},${l.power}`);
      expect(Math.abs(l.aim)).toBeLessThanOrEqual(CUP_PONG_AIM_JITTER);
      expect(Math.abs(l.power - 540)).toBeLessThanOrEqual(CUP_PONG_POWER_JITTER);
    }
    expect(applied.size).toBeGreaterThan(5);
  });

  it('clamps the wobbled input into the legal range', () => {
    for (let seed = 0n; seed < 40n; seed++) {
      const s = E.apply(fresh(seed), 'a', { kind: 'throw', aim: 500, power: 1000 });
      expect(s.last!.applied.aim).toBeLessThanOrEqual(500);
      expect(s.last!.applied.power).toBeLessThanOrEqual(1000);
    }
  });

  it('rejects out of turn, bad input and acting after the end', () => {
    const s = fresh();
    expect(E.validate(s, 'b', MISS)).toEqual({ ok: false, code: 'not_your_turn' });
    expect(E.validate(s, 'a', { kind: 'throw', aim: 600, power: 5 })).toEqual({
      ok: false,
      code: 'bad_aim',
    });
    expect(E.validate(s, 'a', { kind: 'throw', aim: 0, power: 1001 })).toEqual({
      ok: false,
      code: 'bad_power',
    });
    expect(E.validate({ ...s, over: true }, 'a', MISS)).toEqual({ ok: false, code: 'game_over' });
  });

  it('apply never mutates its input', () => {
    const s = fresh();
    const before = JSON.stringify(s);
    E.apply(s, 'a', findHit(s, 'a'));
    E.apply(s, 'a', MISS);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('init validates players and config', () => {
    expect(() => E.init(['a'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'b', 'c'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'a'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'b'], 1n, { ballsPerTurn: 0 })).toThrow();
    expect(E.init(['a', 'b'], 1n, { ballsPerTurn: 2 }).ballsLeft).toBe(2);
  });
});

describe('cup pong re-rack', () => {
  const six = RACK.slice(0, 6);

  it('is allowed once, at the start of your turn, with 2–6 cups left', () => {
    const s = withRacks({ a: six, b: RACK });
    expect(E.validate(s, 'a', { kind: 'rerack' })).toEqual({ ok: true });
    const r = E.apply(s, 'a', { kind: 'rerack' });
    expect(r.rerackUsed.a).toBe(true);
    expect(E.currentPlayers(r)).toEqual(['a']); // costs no ball
    expect(r.ballsLeft).toBe(3);
    expect(E.validate(r, 'a', { kind: 'rerack' })).toEqual({ ok: false, code: 'rerack_used' });
  });

  it('is refused with too many cups, too few, or after a ball was thrown', () => {
    expect(E.validate(fresh(), 'a', { kind: 'rerack' })).toEqual({
      ok: false,
      code: 'rerack_not_allowed',
    });
    expect(E.validate(withRacks({ a: [RACK[0]!], b: RACK }), 'a', { kind: 'rerack' }).ok).toBe(
      false,
    );
    const mid = E.apply(withRacks({ a: six, b: RACK }), 'a', MISS);
    expect(E.validate(mid, 'a', { kind: 'rerack' })).toEqual({
      ok: false,
      code: 'rerack_before_throwing',
    });
  });

  it('changes only your own rack', () => {
    const s = withRacks({ a: six, b: RACK });
    const r = E.apply(s, 'a', { kind: 'rerack' });
    expect(r.racks.b).toEqual(RACK);
    expect(r.racks.a).not.toEqual(six);
  });
});

describe('cup pong endings', () => {
  const one = (id: number): CupPos[] => [RACK[id]!];

  it('equal turns: clearing first still lets the other player throw', () => {
    // a has 1 cup standing... b has 1 cup standing; a clears b, then b must get a turn.
    let s = withRacks({ a: [FRONT], b: [FRONT] });
    s = E.apply(s, 'a', findHit(s, 'a'));
    expect(s.racks.b).toHaveLength(0);
    expect(E.isTerminal(s)).toBe(false);
    expect(E.currentPlayers(s)).toEqual(['b']); // turn passes at once, remaining balls are void
    expect(s.ballsLeft).toBe(3);
    // b misses all three balls: a wins
    for (let i = 0; i < 3; i++) s = E.apply(s, 'b', MISS);
    expect(E.isTerminal(s)).toBe(true);
    expect(E.result(s)).toEqual({ placements: [['a'], ['b']], draw: false });
    expect(E.currentPlayers(s)).toEqual([]);
  });

  it('both clear: fewer balls used wins', () => {
    // a needs a hit on its first ball; b only hits on a later ball.
    let s = withRacks({ a: [FRONT], b: [FRONT] });
    s = E.apply(s, 'a', findHit(s, 'a'));
    s = E.apply(s, 'b', MISS);
    s = E.apply(s, 'b', MISS);
    const last = findHit(s, 'b');
    s = E.apply(s, 'b', last);
    expect(s.racks.a).toHaveLength(0);
    expect(E.isTerminal(s)).toBe(true);
    expect(s.clearedWith).toEqual({ a: 1, b: 3 });
    expect(E.result(s)).toEqual({ placements: [['a'], ['b']], draw: false });
  });

  it('both clear on the same ball count is a draw', () => {
    let s = withRacks({ a: [FRONT], b: [FRONT] });
    s = E.apply(s, 'a', findHit(s, 'a'));
    s = E.apply(s, 'b', findHit(s, 'b'));
    expect(E.isTerminal(s)).toBe(true);
    expect(E.result(s)).toEqual({ placements: [['a', 'b']], draw: true });
  });

  it('the second thrower clearing ends the game at once', () => {
    let s = withRacks({ a: [FRONT], b: RACK });
    for (let i = 0; i < 3; i++) s = E.apply(s, 'a', MISS);
    s = E.apply(s, 'b', findHit(s, 'b'));
    expect(E.isTerminal(s)).toBe(true);
    expect(E.result(s).placements).toEqual([['b'], ['a']]);
  });

  it('at maxRounds the player who sank more cups wins', () => {
    let s = E.init(['a', 'b'], 8n, { ballsPerTurn: 1, maxRounds: 2 });
    s = E.apply(s, 'a', findHit(s, 'a'));
    s = E.apply(s, 'b', MISS);
    s = E.apply(s, 'a', MISS);
    expect(E.isTerminal(s)).toBe(false);
    s = E.apply(s, 'b', MISS);
    expect(E.isTerminal(s)).toBe(true);
    expect(s.sunk).toEqual({ a: 1, b: 0 });
    expect(E.result(s)).toEqual({ placements: [['a'], ['b']], draw: false });
  });

  it('at maxRounds with equal cups the game is a draw', () => {
    let s = E.init(['a', 'b'], 8n, { ballsPerTurn: 1, maxRounds: 1 });
    s = E.apply(s, 'a', MISS);
    s = E.apply(s, 'b', MISS);
    expect(E.result(s)).toEqual({ placements: [['a', 'b']], draw: true });
  });

  it('has no result until it is over', () => {
    expect(E.result(fresh())).toEqual({ placements: [], draw: false });
    void one;
  });
});

describe('cup pong view and wire schema', () => {
  it('never exposes the RNG state (it decides the next wobble)', () => {
    const s = fresh();
    for (const v of ['a', 'b', 'spectator'] as const) {
      const view = E.view(s, v);
      expect(view).not.toHaveProperty('rng');
      expect(JSON.stringify(view)).not.toContain(JSON.stringify(s.rng));
    }
  });

  it('shows the cups and the last throw to everyone', () => {
    let s = fresh();
    s = E.apply(s, 'a', MISS);
    const v = E.view(s, 'spectator') as CupPongState;
    expect(v.racks.a).toHaveLength(10);
    expect(v.last?.by).toBe('a');
    expect(v.last?.applied).toBeDefined();
  });

  it('state holds only integers (no float drift between runtimes)', () => {
    let s = fresh(4n);
    for (let i = 0; i < 6; i++)
      s = E.apply(s, E.currentPlayers(s)[0]!, { kind: 'throw', aim: 13, power: 541 });
    const walk = (v: unknown): void => {
      if (typeof v === 'number') expect(Number.isInteger(v)).toBe(true);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(s);
  });

  it('validates actions with zod', () => {
    expect(cupPongActionSchema.safeParse({ kind: 'throw', aim: -500, power: 1000 }).success).toBe(
      true,
    );
    expect(cupPongActionSchema.safeParse({ kind: 'rerack' }).success).toBe(true);
    expect(cupPongActionSchema.safeParse({ kind: 'throw', aim: 0.5, power: 10 }).success).toBe(
      false,
    );
    expect(cupPongActionSchema.safeParse({ kind: 'throw', aim: 0, power: 1001 }).success).toBe(
      false,
    );
    expect(cupPongActionSchema.safeParse({ kind: 'throw', aim: 0 }).success).toBe(false);
    expect(cupPongActionSchema.safeParse({ kind: 'teleport' }).success).toBe(false);
  });
});
