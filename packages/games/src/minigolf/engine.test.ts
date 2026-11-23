import { hashState } from '../hash.ts';
import { Rng } from '../rng.ts';
import { describeEngine } from '../testing/engineHarness.ts';
import { BALL_R, CUP_R, POWER_MAX, puttSpeed, simulatePutt, type PuttInput } from './physics.ts';
import {
  FIELD_H,
  FIELD_W,
  HOLES,
  MAX_STROKES,
  MINI_GOLF_COURSE,
  miniGolfHole,
  type HoleDef,
} from './course.ts';
import {
  MINI_GOLF_PARS,
  miniGolfActionSchema,
  miniGolfAutoAction,
  miniGolfEngine as E,
  miniGolfTotal,
  type MiniGolfAction,
  type MiniGolfState,
} from './engine.ts';

type S = MiniGolfState;
const P = ['a', 'b'];
const init = (seed = 3n, players = P): S => E.init(players, seed, {});
const putt = (dx: number, dy: number, power: number): MiniGolfAction => ({
  kind: 'putt',
  dx,
  dy,
  power,
});
const mm = (v: number): number => Math.round(v * 10);

/** A putt that goes nowhere (power 1 is below the stopping speed), to burn strokes. */
const dud = putt(0, -1, 1);

function mover(s: S): string {
  return E.currentPlayers(s)[0] as string;
}
function go(s: S, a: MiniGolfAction, by = mover(s)): S {
  const v = E.validate(s, by, a);
  if (!v.ok) throw new Error(`refused: ${v.code}`);
  return E.apply(s, by, a);
}

/** Power that holes a straight shot up the middle of hole 1 (index 0), found by scanning. */
const HOLE0 = MINI_GOLF_COURSE[0] as HoleDef;
const ACE_POWER = ((): number => {
  for (let p = 1; p <= POWER_MAX; p++) {
    if (simulatePutt(HOLE0, mm(200), mm(700), { dx: 0, dy: -1, power: p }).outcome.sunk) return p;
  }
  throw new Error('hole 1 has no hole in one');
})();
const ace = putt(0, -1, ACE_POWER);

describe('mini golf course', () => {
  it('has nine holes inside the field, walls thick enough not to be skipped, tee and cup on the grass', () => {
    expect(MINI_GOLF_COURSE).toHaveLength(HOLES);
    expect(MINI_GOLF_PARS).toHaveLength(9);
    for (const mirrored of [false, true]) {
      for (let i = 0; i < HOLES; i++) {
        const h = miniGolfHole(i, mirrored);
        for (const pt of [h.tee, h.cup]) {
          expect(pt.x).toBeGreaterThan(CUP_R);
          expect(pt.x).toBeLessThan(FIELD_W - CUP_R);
          expect(pt.y).toBeGreaterThan(CUP_R);
          expect(pt.y).toBeLessThan(FIELD_H - CUP_R);
        }
        for (const w of h.walls) {
          expect(Math.min(w.w, w.h)).toBeGreaterThanOrEqual(12);
          expect(w.x).toBeGreaterThanOrEqual(0);
          expect(w.x + w.w).toBeLessThanOrEqual(FIELD_W);
          expect(w.y + w.h).toBeLessThanOrEqual(FIELD_H);
          // tee and cup are not inside a wall or bumper
          for (const pt of [h.tee, h.cup]) {
            expect(
              pt.x >= w.x - BALL_R &&
                pt.x <= w.x + w.w + BALL_R &&
                pt.y >= w.y - BALL_R &&
                pt.y <= w.y + w.h + BALL_R,
            ).toBe(false);
          }
        }
        for (const b of h.bumpers) {
          expect(b.r).toBeGreaterThanOrEqual(15);
          for (const pt of [h.tee, h.cup])
            expect(Math.hypot(pt.x - b.x, pt.y - b.y)).toBeGreaterThan(b.r + CUP_R);
        }
      }
    }
  });

  it('mirroring twice gives the hole back, and a mirrored putt mirrors the result', () => {
    for (let i = 0; i < HOLES; i++) {
      const a = miniGolfHole(i, false);
      const b = miniGolfHole(i, true);
      expect(b.tee.x).toBe(FIELD_W - a.tee.x);
      expect(b.cup.x).toBe(FIELD_W - a.cup.x);
      expect(b.par).toBe(a.par);
      const input = { dx: 7, dy: -90, power: 480 };
      const r1 = simulatePutt(a, mm(a.tee.x), mm(a.tee.y), input).outcome;
      const r2 = simulatePutt(b, mm(b.tee.x), mm(b.tee.y), { ...input, dx: -input.dx }).outcome;
      expect(Math.abs(r1.endX + r2.endX - mm(FIELD_W))).toBeLessThanOrEqual(2);
      expect(Math.abs(r1.endY - r2.endY)).toBeLessThanOrEqual(2);
      expect(r1.sunk).toBe(r2.sunk);
    }
  });
});

describe('mini golf physics', () => {
  const tee = { x: mm(200), y: mm(700) };

  it('is a pure function: same input → same outcome, trace or not', () => {
    const input = { dx: 12, dy: -100, power: 500 };
    const a = simulatePutt(HOLE0, tee.x, tee.y, input);
    const b = simulatePutt(HOLE0, tee.x, tee.y, input, true);
    expect(b.outcome).toEqual(a.outcome);
    expect(simulatePutt(HOLE0, tee.x, tee.y, input, true)).toEqual(b);
    expect(a.trace).toEqual([]);
    expect(b.trace.length).toBeGreaterThan(5);
  });

  it('does not mutate the hole', () => {
    const before = JSON.stringify(MINI_GOLF_COURSE);
    simulatePutt(MINI_GOLF_COURSE[1] as HoleDef, tee.x, tee.y, { dx: 0, dy: -1, power: 700 });
    expect(JSON.stringify(MINI_GOLF_COURSE)).toBe(before);
  });

  it('power sets the distance: harder rolls further, up the middle of an empty hole', () => {
    const y = (p: number): number =>
      simulatePutt(HOLE0, tee.x, tee.y, { dx: 0, dy: -1, power: p }).outcome.endY;
    expect(y(200)).toBeLessThan(tee.y);
    expect(y(300)).toBeLessThan(y(200));
    expect(y(400)).toBeLessThan(y(300));
    // v²/(2a): power 300 → 180 cm/s → 180 cm
    expect(Math.abs(tee.y - y(300) - 1800)).toBeLessThan(40);
    expect(puttSpeed(1000)).toBe(600);
  });

  it('a straight putt at the right power drops; too hard rolls over the cup; too soft stops short', () => {
    expect(ACE_POWER).toBeGreaterThan(400);
    const r = simulatePutt(HOLE0, tee.x, tee.y, { dx: 0, dy: -1, power: ACE_POWER });
    expect(r.outcome.sunk).toBe(true);
    expect([r.outcome.endX, r.outcome.endY]).toEqual([2000, 1200]);
    expect(simulatePutt(HOLE0, tee.x, tee.y, { dx: 0, dy: -1, power: 900 }).outcome.sunk).toBe(
      false,
    );
    const soft = simulatePutt(HOLE0, tee.x, tee.y, {
      dx: 0,
      dy: -1,
      power: ACE_POWER - 80,
    }).outcome;
    expect(soft.sunk).toBe(false);
    expect(soft.endY).toBeGreaterThan(1200);
    expect(
      simulatePutt(HOLE0, tee.x, tee.y, { dx: 1, dy: -1, power: ACE_POWER }).outcome.sunk,
    ).toBe(false);
  });

  it('power 1 does not move the ball', () => {
    const r = simulatePutt(HOLE0, tee.x, tee.y, { dx: 3, dy: -4, power: 1 }).outcome;
    expect([r.endX, r.endY]).toEqual([tee.x, tee.y]);
  });

  it('the field edge bounces the ball back', () => {
    const r = simulatePutt(HOLE0, tee.x, tee.y, { dx: 1, dy: 0, power: 800 }).outcome;
    expect(r.bounces).toBeGreaterThanOrEqual(1);
    expect(r.endX).toBeLessThanOrEqual(mm(FIELD_W));
    expect(r.endX).toBeGreaterThanOrEqual(mm(BALL_R));
  });

  it('a wall blocks the ball (hole 2 has a block in the middle)', () => {
    const h = MINI_GOLF_COURSE[1] as HoleDef;
    const r = simulatePutt(h, tee.x, tee.y, { dx: 0, dy: -1, power: 650 }).outcome;
    expect(r.sunk).toBe(false);
    expect(r.bounces).toBeGreaterThanOrEqual(1);
  });

  it('a bumper throws the ball back (hole 4)', () => {
    const h = MINI_GOLF_COURSE[3] as HoleDef;
    const bumper = h.bumpers[0]!;
    const r = simulatePutt(h, mm(bumper.x), mm(700), { dx: 0, dy: -1, power: 500 }).outcome;
    expect(r.bounces).toBeGreaterThanOrEqual(1);
    expect(r.endY).toBeGreaterThan(mm(bumper.y));
  });

  it('sand stops the ball much sooner (hole 5)', () => {
    const grass = simulatePutt(HOLE0, tee.x, tee.y, { dx: 0, dy: -1, power: 400 }).outcome;
    const sand = simulatePutt(MINI_GOLF_COURSE[4] as HoleDef, tee.x, tee.y, {
      dx: 0,
      dy: -1,
      power: 400,
    }).outcome;
    expect(sand.endY).toBeGreaterThan(grass.endY);
    expect(sand.endY).toBeLessThan(mm(470)); // it reached the sand belt (y 350-470)
  });

  it('whatever the input, the ball never ends inside a wall or outside the field', () => {
    const rng = new Rng(2024n);
    for (let n = 0; n < 400; n++) {
      const hi = rng.int(HOLES);
      const mirrored = rng.int(2) === 1;
      const h = miniGolfHole(hi, mirrored);
      const input: PuttInput = {
        dx: rng.int(2001) - 1000,
        dy: rng.int(2001) - 1000,
        power: 1 + rng.int(POWER_MAX),
      };
      if (input.dx === 0 && input.dy === 0) continue;
      const { endX, endY } = simulatePutt(h, mm(h.tee.x), mm(h.tee.y), input).outcome;
      const x = endX / 10;
      const y = endY / 10;
      expect(x).toBeGreaterThanOrEqual(BALL_R - 0.1);
      expect(x).toBeLessThanOrEqual(FIELD_W - BALL_R + 0.1);
      expect(y).toBeGreaterThanOrEqual(BALL_R - 0.1);
      expect(y).toBeLessThanOrEqual(FIELD_H - BALL_R + 0.1);
      for (const w of h.walls) {
        const inside = x > w.x + 0.1 && x < w.x + w.w - 0.1 && y > w.y + 0.1 && y < w.y + w.h - 0.1;
        expect(inside).toBe(false);
      }
    }
  });

  it('every hole can be holed in at most five strokes (beam search over coarse inputs)', () => {
    // Search on the unmirrored holes; mirroring is exact (checked above).
    for (let i = 0; i < HOLES; i++) {
      const h = MINI_GOLF_COURSE[i] as HoleDef;
      const best = solve(h, 5);
      expect({ hole: i + 1, strokes: best }).toEqual({ hole: i + 1, strokes: expect.any(Number) });
      expect(best).toBeLessThanOrEqual(5);
    }
  }, 180_000);
});

/** Fewest strokes the beam search needs, or Infinity. */
function solve(h: HoleDef, maxDepth: number): number {
  type Node = { x: number; y: number };
  let frontier: Node[] = [{ x: mm(h.tee.x), y: mm(h.tee.y) }];
  const cell = (n: Node): string => `${Math.round(n.x / 400)}:${Math.round(n.y / 400)}`;
  for (let depth = 1; depth <= maxDepth; depth++) {
    const seen = new Map<string, { n: Node; d: number }>();
    for (const from of frontier) {
      for (let deg = 0; deg < 360; deg += 4) {
        const rad = (deg * Math.PI) / 180;
        const dx = Math.round(Math.cos(rad) * 1000);
        const dy = Math.round(Math.sin(rad) * 1000);
        for (let power = 100; power <= 1000; power += 30) {
          const o = simulatePutt(h, from.x, from.y, { dx, dy, power }).outcome;
          if (o.sunk) return depth;
          const n = { x: o.endX, y: o.endY };
          const d = Math.hypot(n.x / 10 - h.cup.x, n.y / 10 - h.cup.y);
          const key = cell(n);
          const have = seen.get(key);
          if (!have || d < have.d) seen.set(key, { n, d });
        }
      }
    }
    frontier = [...seen.values()]
      .sort((a, b) => a.d - b.d)
      .slice(0, 14)
      .map((v) => v.n);
  }
  return Infinity;
}

describe('mini golf engine', () => {
  it('needs 2 to 4 distinct players; mirrors come from the seed', () => {
    expect(() => E.init(['a'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'b', 'c', 'd', 'e'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'a'], 1n, {})).toThrow();
    const s = init(5n);
    expect(s.mirror).toHaveLength(9);
    expect(hashState(init(5n))).toBe(hashState(s));
    const seen = new Set<string>();
    for (let i = 1n; i < 10n; i++) seen.add(init(i).mirror.join(','));
    expect(seen.size).toBeGreaterThan(5);
    expect(s.hole).toBe(0);
    expect(s.ball['a']).toEqual({ x: 2000, y: 7000 });
    expect(E.currentPlayers(s)).toEqual(['a']);
  });

  it('a player keeps the turn for the whole hole, then the next player plays it', () => {
    let s = init();
    s = go(s, dud);
    expect(E.currentPlayers(s)).toEqual(['a']);
    expect(s.strokes['a']).toBe(1);
    s = go(s, ace);
    expect(s.done['a']).toBe(true);
    expect(s.strokes['a']).toBe(2);
    expect(E.currentPlayers(s)).toEqual(['b']);
    expect(s.hole).toBe(0);
    s = go(s, ace);
    // everyone done: hole 2 begins, a first, balls on the new tee, card updated
    expect(s.hole).toBe(1);
    expect(E.currentPlayers(s)).toEqual(['a']);
    expect(s.card).toEqual({ a: [2], b: [1] });
    expect(s.strokes).toEqual({ a: 0, b: 0 });
    expect(s.done).toEqual({ a: false, b: false });
    expect(s.log).toEqual([]);
    expect(s.ball['b']).toEqual({
      x: Math.round(miniGolfHole(1, s.mirror[1]!).tee.x * 10),
      y: 7000,
    });
    expect(s.last?.hole).toBe(0); // the animation of the final putt of hole 1 is still there
  });

  it('turn order and malformed putts are refused', () => {
    const s = init();
    expect(E.validate(s, 'b', dud)).toEqual({ ok: false, code: 'not_your_turn' });
    expect(E.validate(s, 'zed', dud)).toEqual({ ok: false, code: 'not_your_turn' });
    expect(E.validate(s, 'a', putt(0, 0, 500))).toEqual({ ok: false, code: 'no_direction' });
    expect(E.validate(s, 'a', putt(1001, 0, 500))).toEqual({ ok: false, code: 'bad_aim' });
    expect(E.validate(s, 'a', putt(0.5, 1, 500))).toEqual({ ok: false, code: 'bad_aim' });
    expect(E.validate(s, 'a', putt(0, -1, 0))).toEqual({ ok: false, code: 'bad_power' });
    expect(E.validate(s, 'a', putt(0, -1, 1001))).toEqual({ ok: false, code: 'bad_power' });
    expect(E.validate(s, 'a', putt(0, -1, 2.5))).toEqual({ ok: false, code: 'bad_power' });
    expect(E.validate(s, 'a', putt(0, -1, 500)).ok).toBe(true);
  });

  it('the sixth stroke ends the hole at six, holed or not', () => {
    let s = init();
    for (let i = 1; i < MAX_STROKES; i++) {
      s = go(s, dud);
      expect(s.done['a']).toBe(false);
    }
    expect(E.validate(s, 'a', dud).ok).toBe(true);
    s = go(s, dud);
    expect(s.done['a']).toBe(true);
    expect(s.sunk['a']).toBe(false);
    expect(s.strokes['a']).toBe(6);
    expect(E.currentPlayers(s)).toEqual(['b']);
    s = go(s, ace);
    expect(s.card).toEqual({ a: [6], b: [1] });
  });

  it('plays nine holes with 2, 3 and 4 players, then ends; fewest strokes win', () => {
    for (const n of [2, 3, 4]) {
      const players = ['a', 'b', 'c', 'd'].slice(0, n);
      let s = init(8n, players);
      let guard = 0;
      while (!E.isTerminal(s) && guard++ < 1000) {
        const who = mover(s);
        // 'a' aces every hole 1 (hole 1 only; others burn six strokes), everyone else burns strokes
        s = go(s, who === 'a' && s.hole === 0 ? ace : dud);
      }
      expect(E.isTerminal(s)).toBe(true);
      expect(s.hole).toBe(HOLES);
      expect(E.currentPlayers(s)).toEqual([]);
      for (const p of players) expect(s.card[p]).toHaveLength(9);
      expect(miniGolfTotal(s, 'a')).toBe(1 + 6 * 8);
      expect(miniGolfTotal(s, 'b')).toBe(54);
      const res = E.result(s);
      expect(res.placements[0]).toEqual(['a']);
      expect(res.draw).toBe(false);
      expect(E.validate(s, 'a', dud)).toEqual({ ok: false, code: 'game_over' });
    }
  });

  it('equal totals share a placement; a tie for first is a draw', () => {
    const base: S = { ...init(1n, ['a', 'b', 'c']), over: true, hole: HOLES };
    expect(E.result({ ...base, card: { a: [10], b: [10], c: [12] } })).toEqual({
      placements: [['a', 'b'], ['c']],
      draw: true,
    });
    expect(E.result({ ...base, card: { a: [14], b: [9], c: [12] } })).toEqual({
      placements: [['b'], ['c'], ['a']],
      draw: false,
    });
    expect(E.result(init())).toEqual({ placements: [], draw: false });
  });

  it('apply never mutates its input and is deterministic', () => {
    const s = go(init(), dud);
    const before = hashState(s);
    const a = go(s, putt(10, -90, 520));
    expect(hashState(s)).toBe(before);
    expect(hashState(go(s, putt(10, -90, 520)))).toBe(hashState(a));
  });

  it('records each putt for animation: from, to, input and whether it dropped', () => {
    const s = go(init(), ace);
    expect(s.last).toMatchObject({
      seq: 1,
      hole: 0,
      by: 'a',
      stroke: 1,
      from: { x: 2000, y: 7000 },
      to: { x: 2000, y: 1200 },
      sunk: true,
      input: { dx: 0, dy: -1, power: ACE_POWER },
    });
  });

  it('actionSchema accepts the wire shape and rejects junk', () => {
    const ok = (x: unknown): boolean => miniGolfActionSchema.safeParse(x).success;
    expect(ok({ kind: 'putt', dx: -500, dy: 1000, power: 1000 })).toBe(true);
    expect(ok({ kind: 'putt', dx: 0, dy: 0, power: 1 })).toBe(true); // schema ok, the engine refuses it
    expect(ok({ kind: 'putt', dx: 0.5, dy: 1, power: 10 })).toBe(false);
    expect(ok({ kind: 'putt', dx: 1, dy: 1, power: 0 })).toBe(false);
    expect(ok({ kind: 'putt', dx: 1001, dy: 1, power: 5 })).toBe(false);
    expect(ok({ kind: 'putt', dx: 1, dy: 1 })).toBe(false);
  });
});

describe('mini golf view secrecy', () => {
  type V = {
    ball: Record<string, unknown>;
    strokes: Record<string, number | null>;
    log: { by: string }[];
    last: { by: string } | null;
    sunk: Record<string, boolean | null>;
    totals: Record<string, number>;
  };
  const view = (s: S, who: string): V => E.view(s, who) as V;

  it('until you finish a hole you only see your own putts on it', () => {
    let s = init();
    s = go(s, dud);
    s = go(s, dud);
    // a is mid-hole: a sees their own, b and spectators see nothing of it
    expect(view(s, 'a').log).toHaveLength(2);
    expect(view(s, 'a').last?.by).toBe('a');
    expect(view(s, 'a').strokes['a']).toBe(2);
    expect(view(s, 'b').log).toEqual([]);
    expect(view(s, 'b').last).toBeNull();
    expect(view(s, 'b').strokes['a']).toBeNull();
    expect(view(s, 'spectator').log).toEqual([]);
    expect(view(s, 'spectator').last).toBeNull();
    // finishing the hole reveals the count and the result, but b's own hole is still unplayed
    s = go(s, ace);
    expect(view(s, 'b').strokes['a']).toBe(3);
    expect(view(s, 'b').sunk['a']).toBe(true);
    expect(view(s, 'b').log).toEqual([]);
    expect(view(s, 'b').last).toBeNull();
    // b plays and finishes: now everything on the hole is open to b, and the hole advances
    s = go(s, ace);
    expect(view(s, 'b').last?.by).toBe('b');
    expect(view(s, 'a').last?.by).toBe('b');
    expect(view(s, 'spectator').last?.by).toBe('b');
    expect(view(s, 'b').totals).toEqual({ a: 3, b: 1 });
  });

  it('b, once done, sees every putt a made on that hole before the hole closes (3 players)', () => {
    let s = init(2n, ['a', 'b', 'c']);
    s = go(s, dud);
    s = go(s, ace); // a done
    s = go(s, ace); // b done; c yet to play
    expect(view(s, 'b').log.map((p) => p.by)).toEqual(['a', 'a', 'b']);
    expect(view(s, 'c').log).toEqual([]);
    expect(view(s, 'a').log).toHaveLength(3);
  });

  it('shows you your own ball only, never the others’, and nothing leaks the seed', () => {
    const s = init();
    expect(Object.keys(view(s, 'a').ball)).toEqual(['a']);
    expect(Object.keys(view(s, 'spectator').ball)).toEqual([]);
    expect(Object.keys(E.view(s, 'a') as object)).not.toContain('rng');
  });
});

describeEngine<S, MiniGolfAction, object>(E, {
  playerCounts: [2, 3, 4],
  cfg: {},
  numRuns: 20,
  maxSteps: 400,
  candidates: (s, by) => {
    const ball = s.ball[by]!;
    const h = miniGolfHole(s.hole, s.mirror[s.hole] === true);
    const dx = Math.round(h.cup.x * 10 - ball.x);
    const dy = Math.round(h.cup.y * 10 - ball.y);
    const k = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 1000));
    const ax = Math.round(dx / k);
    const ay = Math.round(dy / k);
    return [
      putt(ax, ay, 300),
      putt(ax, ay, 500),
      putt(ax, ay, 700),
      putt(-ay, ax, 400),
      putt(ay, -ax, 600),
      putt(-ax, -ay, 200),
    ].filter((a) => a.dx !== 0 || a.dy !== 0);
  },
  illegal: () => [putt(0, 0, 500), putt(0, -1, 0), putt(2000, 0, 100)],
});

describe('mini golf auto action', () => {
  it('is always legal and aims at the cup; on the straight hole it is a hole in one or close', () => {
    const s = init();
    const a = miniGolfAutoAction(s);
    expect(E.validate(s, 'a', a).ok).toBe(true);
    expect(a.dx).toBe(0);
    expect(a.dy).toBeLessThan(0);
    const n = go(s, a);
    const dist = Math.abs(n.ball['a']!.y - 1200);
    expect(dist).toBeLessThan(600); // within 60 cm of the cup on a 580 cm putt
    // a whole game of auto putts finishes
    let g = init(6n, ['a', 'b', 'c']);
    for (let i = 0; i < 400 && !E.isTerminal(g); i++) g = go(g, miniGolfAutoAction(g));
    expect(E.isTerminal(g)).toBe(true);
  });
});
