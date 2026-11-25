import { hashState } from '../hash.ts';
import { describeEngine } from '../testing/engineHarness.ts';
import {
  EIGHT_BALL_HEAD_X,
  eightBallActionSchema,
  eightBallCanPlace,
  eightBallEngine as E,
  eightBallGroupOf,
  eightBallOnEight,
  type EightBallAction,
  type EightBallState,
} from './engine.ts';
import {
  BALL_R,
  DMM,
  POCKETS,
  TABLE_L,
  TABLE_W,
  cueSpeed,
  simulateShot,
  type TableBall,
} from './physics.ts';

const A = 'a';
const B = 'b';

/** Cue direction from one point to another, in centidegrees (test helper: engines never call atan2). */
const angleTo = (from: { x: number; y: number }, to: { x: number; y: number }): number => {
  const a = Math.atan2(to.y - from.y, to.x - from.x);
  const centi = Math.round((a * 18000) / Math.PI);
  return ((centi % 36000) + 36000) % 36000;
};

const shot = (
  angle: number,
  power = 500,
  extra: Partial<EightBallAction> = {},
): EightBallAction => ({
  kind: 'shoot',
  angle,
  power,
  spinX: 0,
  spinY: 0,
  ...extra,
});

const ball = (id: number, mmX: number, mmY: number): TableBall => ({
  id,
  x: Math.round(mmX * DMM),
  y: Math.round(mmY * DMM),
});

/** A hand-made position: after the break, nobody has a group unless `groups` is given. */
function table(
  balls: TableBall[],
  over: Partial<EightBallState> = {},
  groups?: { a: 'solid' | 'stripe' },
): EightBallState {
  const s = E.init([A, B], 1n, {});
  return {
    ...s,
    balls: [...balls].sort((p, q) => p.id - q.id),
    breaking: false,
    hand: 'none',
    groups: groups ? { [A]: groups.a, [B]: groups.a === 'solid' ? 'stripe' : 'solid' } : null,
    ...over,
  };
}

function play(s: EightBallState, who: string, ...actions: EightBallAction[]): EightBallState {
  let cur = s;
  for (const a of actions) {
    const v = E.validate(cur, who, a);
    if (!v.ok) throw new Error(`illegal ${JSON.stringify(a)}: ${v.code}`);
    cur = E.apply(cur, who, a);
  }
  return cur;
}

const centre = (b: TableBall): { x: number; y: number } => ({ x: b.x, y: b.y });
const cueOf = (s: EightBallState): TableBall => s.balls.find((b) => b.id === 0)!;

describe('8 ball physics', () => {
  const rack = E.init([A, B], 3n, {}).balls;

  it('is a pure function: same input → same outcome, trace or not; inputs are not mutated', () => {
    const before = JSON.stringify(rack);
    const input = { angle: 123, power: 900, spinX: 10, spinY: -20 };
    const a = simulateShot(rack, input);
    const b = simulateShot(rack, input, true);
    expect(b.outcome).toEqual(a.outcome);
    expect(simulateShot(rack, input, true)).toEqual(b);
    expect(a.trace).toEqual([]);
    expect(b.trace.length).toBeGreaterThan(10);
    expect(JSON.stringify(rack)).toBe(before);
  });

  it('a lone ball stops (it always comes to rest) and rolls further when hit harder', () => {
    const one = [ball(0, 300, 560)];
    const soft = simulateShot(one, { angle: 0, power: 100, spinX: 0, spinY: 0 }).outcome;
    const hard = simulateShot(one, { angle: 0, power: 600, spinX: 0, spinY: 0 }).outcome;
    expect(soft.steps).toBeLessThan(hard.steps);
    expect(soft.balls[0]!.x).toBeGreaterThan(3000);
    // A cue ball with nothing to hit stays on the table; no contact reported.
    expect(hard.firstContact).toBeNull();
    expect(hard.railAfterContact).toBe(0);
    expect(cueSpeed(0)).toBeLessThan(cueSpeed(1000));
  });

  it('a ball sent at the cushion bounces back with less speed', () => {
    const one = [ball(0, 300, 560)];
    // Straight at the far cushion at medium power: it must end nearer to it than it started but not beyond.
    const out = simulateShot(one, { angle: 0, power: 400, spinX: 0, spinY: 0 }).outcome;
    const c = out.balls[0]!;
    expect(c.x).toBeLessThan((TABLE_L - BALL_R) * DMM);
    expect(c.y).toBe(5600);
    // Hard enough to hit the cushion and come back past the start.
    const back = simulateShot(one, { angle: 0, power: 1000, spinX: 0, spinY: 0 }).outcome;
    expect(back.balls[0]!.x).toBeLessThan((TABLE_L - BALL_R) * DMM);
    expect(back.balls[0]!.x).toBeLessThan(21000);
  });

  it('angle of incidence ≈ angle of reflection off a cushion', () => {
    // Fire at 45° from the left half into the top cushion with no spin and check the rebound goes down-right.
    const one = [ball(0, 500, 300)];
    const t = simulateShot(one, { angle: 4500, power: 500, spinX: 0, spinY: 0 }, true).trace;
    const xs = t.map((f) => f[0]![1]);
    const ys = t.map((f) => f[0]![2]);
    const top = ys.indexOf(Math.max(...ys));
    expect(top).toBeGreaterThan(0);
    expect(top).toBeLessThan(ys.length - 1);
    expect(xs[ys.length - 1]!).toBeGreaterThan(xs[top]!);
    expect(ys[ys.length - 1]!).toBeLessThan(ys[top]!);
  });

  it('a cue ball striking a ball head-on stops (stun) with no spin, follows with top, draws back with bottom', () => {
    const run = (spinY: number) =>
      simulateShot([ball(0, 300, 560), ball(1, 600, 560)], {
        angle: 0,
        power: 200,
        spinX: 0,
        spinY,
      }).outcome;
    const stun = run(0);
    const follow = run(100);
    const draw = run(-100);
    const cx = (o: typeof stun) => o.balls.find((b) => b.id === 0)!.x;
    const ox = (o: typeof stun) => o.balls.find((b) => b.id === 1)!.x;
    expect(follow.firstContact).toBe(1);
    expect(cx(follow)).toBeGreaterThan(cx(stun) + 1500);
    expect(cx(draw)).toBeLessThan(cx(stun) - 1500);
    // The object ball goes the same way whatever the spin.
    expect(ox(stun)).toBeGreaterThan(11000);
    expect(Math.abs(ox(follow) - ox(stun))).toBeLessThan(1500);
  });

  it('side spin changes where the cue ball goes after a cushion, in opposite ways for opposite spin', () => {
    const run = (spinX: number) =>
      simulateShot([ball(0, 1100, 300)], { angle: 6500, power: 300, spinX, spinY: 0 }).outcome;
    const [left, none, right] = [-50, 0, 50].map((s) => run(s).balls[0]!) as [
      TableBall,
      TableBall,
      TableBall,
    ];
    expect(left.x).toBeLessThan(none.x - 500);
    expect(right.x).toBeGreaterThan(none.x + 500);
  });

  it('every one of the six pockets takes a ball', () => {
    // An object ball 200 mm from each pocket on the line to the table centre, cue ball behind it on that line.
    const centreMm = { x: TABLE_L / 2, y: TABLE_W / 2 };
    POCKETS.forEach((p, i) => {
      const dx = centreMm.x - p.x;
      const dy = centreMm.y - p.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      const objMm = { x: p.x + (dx / len) * 200, y: p.y + (dy / len) * 200 };
      const cueMm = { x: p.x + (dx / len) * 650, y: p.y + (dy / len) * 650 };
      const balls = [ball(0, cueMm.x, cueMm.y), ball(3, objMm.x, objMm.y)];
      const out = simulateShot(balls, {
        angle:
          angleTo(balls[0]!, balls[1]!) === 0
            ? 0
            : angleTo(centre(balls[0]!), p ? { x: p.x * DMM, y: p.y * DMM } : { x: 0, y: 0 }),
        power: 350,
        spinX: 0,
        spinY: 0,
      }).outcome;
      expect(out.pocketed.map((e) => e.id)).toContain(3);
      expect(out.pocketed.find((e) => e.id === 3)!.pocket).toBe(i);
    });
  });

  it('the rack is a tight triangle of 15 with the cue ball on the head spot', () => {
    expect(rack).toHaveLength(16);
    expect(new Set(rack.map((b) => b.id)).size).toBe(16);
    const min = 2 * BALL_R * DMM;
    for (let i = 0; i < rack.length; i++) {
      for (let j = i + 1; j < rack.length; j++) {
        const dx = rack[i]!.x - rack[j]!.x;
        const dy = rack[i]!.y - rack[j]!.y;
        expect(dx * dx + dy * dy).toBeGreaterThanOrEqual(min * min);
      }
    }
    expect(cueOf({ ...table(rack) }).x).toBe(EIGHT_BALL_HEAD_X);
  });

  it('a break from the head spot at full power is deterministic and scatters the rack', () => {
    const a = simulateShot(rack, { angle: 0, power: 1000, spinX: 0, spinY: 0 }).outcome;
    const b = simulateShot(rack, { angle: 0, power: 1000, spinX: 0, spinY: 0 }).outcome;
    expect(a).toEqual(b);
    expect(a.firstContact).not.toBeNull();
    expect(a.objectBallsOnRail).toBeGreaterThanOrEqual(2);
    const moved = a.balls.filter((x) => {
      const o = rack.find((r) => r.id === x.id)!;
      return o.x !== x.x || o.y !== x.y;
    }).length;
    expect(moved).toBeGreaterThan(8);
  });

  it('no two balls overlap when everything stops, whatever the shot', () => {
    const min = 2 * BALL_R * DMM - 20; // 2 mm of tolerance for rounding to 0.1 mm and the contact solver
    for (const [angle, power] of [
      [0, 1000],
      [300, 700],
      [-300 + 36000, 800],
      [100, 1000],
    ] as const) {
      const out = simulateShot(rack, { angle, power, spinX: 0, spinY: 0 }).outcome.balls;
      for (let i = 0; i < out.length; i++) {
        for (let j = i + 1; j < out.length; j++) {
          const dx = out[i]!.x - out[j]!.x;
          const dy = out[i]!.y - out[j]!.y;
          expect(Math.sqrt(dx * dx + dy * dy)).toBeGreaterThan(min);
        }
      }
    }
  });
});

describe('8 ball setup and input', () => {
  it('racks 15 balls from the seed: the 8 in the middle, a solid and a stripe at the back corners', () => {
    const s = E.init([A, B], 99n, {});
    expect(s.balls).toHaveLength(16);
    expect(s).toMatchObject({ hand: 'kitchen', breaking: true, groups: null, turn: 0, shots: 0 });
    // Slot 4 (third row, middle) is the 8: the ball with y at the centre and x two rows back.
    const eight = s.balls.find((b) => b.id === 8)!;
    expect(eight).toMatchObject({ x: 17800, y: 5600 });
    const back = s.balls.filter((b) => b.x === 18800).sort((p, q) => p.y - q.y);
    expect(back).toHaveLength(5);
    const ends = [back[0]!, back[4]!].map((b) => eightBallGroupOf(b.id));
    expect([...ends].sort()).toEqual(['solid', 'stripe']);
  });

  it('is deterministic by seed and different seeds give different racks', () => {
    expect(hashState(E.init([A, B], 5n, {}))).toBe(hashState(E.init([A, B], 5n, {})));
    expect(hashState(E.init([A, B], 5n, {}).balls)).not.toBe(
      hashState(E.init([A, B], 6n, {}).balls),
    );
  });

  it('rejects a bad setup', () => {
    expect(() => E.init([A], 1n, {})).toThrow();
    expect(() => E.init([A, A], 1n, {})).toThrow();
    expect(() => E.init([A, B], 1n, { maxShots: 5 })).toThrow();
  });

  it('validates turn, angle, power and spin', () => {
    const s = E.init([A, B], 1n, {});
    expect(E.validate(s, B, shot(0))).toEqual({ ok: false, code: 'not_your_turn' });
    expect(E.validate(s, A, shot(36000))).toEqual({ ok: false, code: 'bad_angle' });
    expect(E.validate(s, A, shot(-1))).toEqual({ ok: false, code: 'bad_angle' });
    expect(E.validate(s, A, shot(0.5))).toEqual({ ok: false, code: 'bad_angle' });
    expect(E.validate(s, A, shot(0, 1001))).toEqual({ ok: false, code: 'bad_power' });
    expect(E.validate(s, A, { ...shot(0), spinX: 80, spinY: 80 })).toEqual({
      ok: false,
      code: 'bad_spin',
    });
    expect(E.validate(s, A, { ...shot(0), spinX: 60, spinY: -80 })).toEqual({ ok: true });
  });

  it('ball in hand: the break is from behind the head string; placements are checked', () => {
    const s = E.init([A, B], 1n, {});
    const at = (x: number, y: number) => shot(0, 500, { place: { x, y } });
    expect(E.validate(s, A, at(3000, 3000))).toEqual({ ok: true });
    expect(E.validate(s, A, at(EIGHT_BALL_HEAD_X + 1, 5600))).toEqual({
      ok: false,
      code: 'bad_placement',
    });
    expect(E.validate(s, A, at(100, 5600))).toEqual({ ok: false, code: 'bad_placement' });
    expect(E.validate(s, A, at(300, 200))).toEqual({ ok: false, code: 'bad_placement' }); // in a pocket
    expect(E.validate(s, A, at(3000, 3000.5))).toEqual({ ok: false, code: 'bad_placement' });
    const foul = { ...s, breaking: false, hand: 'anywhere' as const };
    expect(E.validate(foul, A, at(12000, 5000))).toEqual({ ok: true });
    // On top of the 8 ball: not allowed.
    const eight = s.balls.find((b) => b.id === 8)!;
    expect(E.validate(foul, A, at(eight.x + 100, eight.y))).toEqual({
      ok: false,
      code: 'bad_placement',
    });
    // No placing without ball in hand.
    expect(E.validate({ ...s, hand: 'none' }, A, at(3000, 3000))).toEqual({
      ok: false,
      code: 'no_ball_in_hand',
    });
    expect(eightBallCanPlace(s.balls, 5600, 5600, 'kitchen')).toBe(true);
  });

  it('actionSchema is strict about integers and ranges', () => {
    expect(eightBallActionSchema.safeParse(shot(35999, 1000)).success).toBe(true);
    expect(eightBallActionSchema.safeParse(shot(36000)).success).toBe(false);
    expect(eightBallActionSchema.safeParse(shot(10, 1001)).success).toBe(false);
    expect(eightBallActionSchema.safeParse({ ...shot(10), spinX: 101 }).success).toBe(false);
    expect(eightBallActionSchema.safeParse({ ...shot(10), call: { pocket: 6 } }).success).toBe(
      false,
    );
    expect(eightBallActionSchema.safeParse({ ...shot(10), call: { pocket: 5 } }).success).toBe(
      true,
    );
    expect(eightBallActionSchema.safeParse({ ...shot(10), place: { x: 1.5, y: 2 } }).success).toBe(
      false,
    );
    expect(eightBallActionSchema.safeParse({ kind: 'shoot', angle: 1 }).success).toBe(false);
  });
});

describe('8 ball rules', () => {
  // Cue (5000,5000 dmm → 500,500 mm) shooting down the diagonal at pocket 0 (bottom-left corner).
  const diag = (ids: [number, number][]): TableBall[] => [
    ball(0, 700, 700),
    ...ids.map(([id, d]) => ball(id, d, d)),
  ];

  it('potting a ball on an open table assigns that group and keeps the turn', () => {
    const s = table(diag([[3, 400]]).concat([ball(12, 1700, 900)]));
    const t = play(s, A, shot(22500, 350));
    expect(t.last!.pocketed.map((p) => p.id)).toEqual([3]);
    expect(t.last!.fouls).toEqual([]);
    expect(t.groups).toEqual({ [A]: 'solid', [B]: 'stripe' });
    expect(E.currentPlayers(t)).toEqual([A]);
    expect(t.hand).toBe('none');
    expect(t.pocketed).toEqual([3]);
    expect(t.balls.map((b) => b.id)).toEqual([0, 12]);
    expect(t.last!.keepsTurn).toBe(true);
  });

  it('missing passes the turn without a foul when you hit your ball and reach a cushion', () => {
    const s = table(
      [ball(0, 700, 500), ball(3, 1500, 500), ball(10, 1800, 900)],
      {},
      { a: 'solid' },
    );
    // Hit the 3 on its right side so nothing is pocketed but balls run to cushions.
    const t = play(s, A, shot(0, 900));
    expect(t.last!.firstContact).toBe(3);
    expect(t.last!.pocketed).toEqual([]);
    expect(t.last!.fouls).toEqual([]);
    expect(t.hand).toBe('none');
    expect(E.currentPlayers(t)).toEqual([B]);
  });

  it('a scratch with no contact is a foul: the opponent gets ball in hand and the cue comes back', () => {
    // Cue straight into the corner pocket with nothing in the way.
    const s = table([ball(0, 700, 700), ball(1, 1800, 900)]);
    const t = play(s, A, shot(22500, 500));
    expect(t.last!.pocketed.map((p) => p.id)).toEqual([0]);
    expect(t.last!.fouls).toEqual(['scratch', 'no_contact']);
    expect(E.currentPlayers(t)).toEqual([B]);
    expect(t.hand).toBe('anywhere');
    expect(cueOf(t)).toMatchObject({ x: EIGHT_BALL_HEAD_X, y: 5600 });
    // B may place the cue anywhere (not only behind the head string).
    expect(E.validate(t, B, shot(0, 300, { place: { x: 15000, y: 3000 } }))).toEqual({ ok: true });
  });

  it('touching nothing is a foul', () => {
    const s = table([ball(0, 700, 500), ball(1, 1800, 900)]);
    const t = play(s, A, shot(0, 150)); // too soft to reach anything
    expect(t.last!.fouls).toEqual(['no_contact']);
    expect(t.hand).toBe('anywhere');
    expect(E.currentPlayers(t)).toEqual([B]);
  });

  it('hitting an opponent ball first is a foul once groups are set', () => {
    const s = table(
      [ball(0, 700, 500), ball(9, 1500, 500), ball(2, 1900, 900)],
      {},
      { a: 'solid' },
    );
    const t = play(s, A, shot(0, 700));
    expect(t.last!.firstContact).toBe(9);
    expect(t.last!.fouls).toContain('wrong_first_contact');
    expect(t.hand).toBe('anywhere');
    expect(E.currentPlayers(t)).toEqual([B]);
  });

  it('on an open table the 8 may not be hit first', () => {
    const s = table([ball(0, 700, 500), ball(8, 1500, 500), ball(2, 1900, 900)]);
    const t = play(s, A, shot(0, 700));
    expect(t.last!.firstContact).toBe(8);
    expect(t.last!.fouls).toContain('wrong_first_contact');
  });

  it('a legal contact that reaches no cushion and pots nothing is a foul (no rail)', () => {
    const s = table([ball(0, 700, 500), ball(1, 1000, 500), ball(12, 1900, 900)]);
    const t = play(s, A, shot(0, 120));
    expect(t.last!.firstContact).toBe(1);
    expect(t.last!.railAfterContact).toBe(0);
    expect(t.last!.fouls).toEqual(['no_rail']);
    expect(t.hand).toBe('anywhere');
  });

  it('potting the opponent’s ball (own ball hit first) ends the turn with no foul', () => {
    // Cue → solid 1 → stripe 9 → corner pocket: the stripe goes down, so the turn passes.
    const s = table(
      diag([
        [1, 600],
        [9, 330],
      ]).concat([ball(14, 1700, 900)]),
      {},
      { a: 'solid' },
    );
    const t = play(s, A, shot(22500, 600));
    expect(t.last!.firstContact).toBe(1);
    expect(t.last!.pocketed.map((p) => p.id)).toEqual([9]);
    expect(t.last!.fouls).toEqual([]);
    expect(E.currentPlayers(t)).toEqual([B]);
    expect(t.hand).toBe('none');
    expect(t.pocketed).toEqual([9]);
  });

  it('the 8 goes down early: you lose', () => {
    const s = table(
      diag([[8, 400]]).concat([ball(2, 1700, 900), ball(12, 1800, 300)]),
      {},
      { a: 'solid' },
    );
    // Hitting the 8 first while solids remain is a foul too, but losing is what matters.
    const t = play(s, A, shot(22500, 350));
    expect(t.over).toBe(true);
    expect(t.end).toBe('eight_early');
    expect(t.winner).toBe(B);
    expect(E.currentPlayers(t)).toEqual([]);
    expect(E.result(t)).toEqual({ placements: [[B], [A]], draw: false });
    expect(E.validate(t, A, shot(0))).toEqual({ ok: false, code: 'game_over' });
  });

  it('on the 8, the pocket must be called; the right pocket wins', () => {
    // All of A's solids are down (none on the table).
    const s = table(diag([[8, 400]]).concat([ball(12, 1700, 900)]), {}, { a: 'solid' });
    expect(eightBallOnEight(s, A)).toBe(true);
    expect(eightBallOnEight(s, B)).toBe(false);
    expect(E.validate(s, A, shot(22500, 350))).toEqual({ ok: false, code: 'call_required' });
    expect(E.validate(s, A, shot(22500, 350, { call: { pocket: 9 } }))).toEqual({
      ok: false,
      code: 'bad_call',
    });
    const t = play(s, A, shot(22500, 350, { call: { pocket: 0 } }));
    expect(t.over).toBe(true);
    expect(t.end).toBe('eight_pocketed');
    expect(t.winner).toBe(A);
    expect(E.result(t)).toEqual({ placements: [[A], [B]], draw: false });
  });

  it('the 8 in a pocket other than the one called loses', () => {
    const s = table(diag([[8, 400]]).concat([ball(12, 1700, 900)]), {}, { a: 'solid' });
    const t = play(s, A, shot(22500, 350, { call: { pocket: 5 } }));
    expect(t.over).toBe(true);
    expect(t.end).toBe('eight_wrong_pocket');
    expect(t.winner).toBe(B);
  });

  it('the 8 with a foul in the same shot loses even in the called pocket', () => {
    // On the 8 but the cue ball follows it into the pocket (scratch).
    const s = table(diag([[8, 400]]).concat([ball(12, 1700, 900)]), {}, { a: 'solid' });
    const t = play(s, A, shot(22500, 450, { spinY: 100, call: { pocket: 0 } }));
    expect(t.last!.pocketed.map((p) => p.id).sort()).toEqual([0, 8]);
    expect(t.end).toBe('eight_foul');
    expect(t.winner).toBe(B);
  });

  it('the 8 on the break is re-spotted by re-racking; the breaker goes again', () => {
    const s = table([ball(0, 700, 700), ball(8, 400, 400), ball(1, 1800, 900)], {
      breaking: true,
      hand: 'kitchen',
    });
    const t = play(s, A, shot(22500, 350));
    expect(t.last!.reRack).toBe(true);
    expect(t.over).toBe(false);
    expect(t.balls).toHaveLength(16);
    expect(t.breaking).toBe(true);
    expect(t.hand).toBe('kitchen');
    expect(t.groups).toBeNull();
    expect(t.pocketed).toEqual([]);
    expect(E.currentPlayers(t)).toEqual([A]);
    expect(hashState(t.balls)).not.toBe(hashState(s.balls));
  });

  it('a break that pockets nothing and sends fewer than 4 balls to a cushion is a foul', () => {
    const s = E.init([A, B], 4n, {});
    const t = play(s, A, shot(0, 120));
    expect(t.last!.wasBreak).toBe(true);
    expect(t.last!.fouls).toContain('bad_break');
    expect(t.hand).toBe('anywhere');
    expect(t.breaking).toBe(false);
    expect(E.currentPlayers(t)).toEqual([B]);
  });

  it('breaking records the shot and starts the game; the table stays open', () => {
    const s = E.init([A, B], 4n, {});
    const t = play(s, A, shot(0, 1000, { place: { x: 4000, y: 5600 } }));
    expect(t.last!.wasBreak).toBe(true);
    expect(t.last!.from.find((b) => b.id === 0)).toMatchObject({ x: 4000, y: 5600 });
    expect(t.last!.from).toHaveLength(16);
    expect(t.breaking).toBe(false);
    expect(t.groups).toBeNull();
    expect(t.shots).toBe(1);
    expect(t.seq).toBe(1);
  });

  it('ball in hand: the placed cue ball is where the shot starts from', () => {
    const s = table([ball(0, 700, 500), ball(1, 1800, 900), ball(12, 2000, 300)], {
      hand: 'anywhere',
    });
    const t = play(s, A, shot(0, 200, { place: { x: 15000, y: 3000 } }));
    expect(t.last!.from.find((b) => b.id === 0)).toMatchObject({ x: 15000, y: 3000 });
  });

  it('shot limit: the game ends and fewer balls left wins; open table or equal is a draw', () => {
    const base = table(
      [ball(0, 700, 500), ball(1, 1800, 900), ball(2, 1800, 300), ball(9, 1900, 700)],
      { shots: 119 },
      { a: 'solid' },
    );
    const t = play(base, A, shot(0, 150)); // foul, no pocket, shot 120
    expect(t.over).toBe(true);
    expect(t.end).toBe('max_shots');
    // A has two solids left, B one stripe left → B wins.
    expect(t.winner).toBe(B);
    const open = table([ball(0, 700, 500), ball(1, 1800, 900)], { shots: 119 });
    expect(play(open, A, shot(0, 150)).winner).toBeNull();
    expect(E.result(play(open, A, shot(0, 150))).draw).toBe(true);
  });

  it('apply does not mutate its input; view hides only the RNG', () => {
    const s = E.init([A, B], 2n, {});
    const h = hashState(s);
    const t = E.apply(s, A, shot(0, 800));
    expect(hashState(s)).toBe(h);
    for (const v of [A, B, 'spectator'] as const) {
      const view = E.view(t, v) as Record<string, unknown>;
      expect(JSON.stringify(view)).not.toContain('"rng"');
      expect(view.balls).toBeDefined();
    }
  });
});

const aimAtNearest = (s: EightBallState, by: string): number => {
  const cue = cueOf(s);
  const want = s.groups?.[by] ?? null;
  const targets = s.balls.filter((b) => {
    if (b.id === 0) return false;
    const g = eightBallGroupOf(b.id);
    if (want === null) return g !== 'eight';
    if (eightBallOnEight(s, by)) return b.id === 8;
    return g === want;
  });
  const pool = targets.length > 0 ? targets : s.balls.filter((b) => b.id !== 0);
  let best = pool[0]!;
  let bd = Infinity;
  for (const b of pool) {
    const d = (b.x - cue.x) ** 2 + (b.y - cue.y) ** 2;
    if (d < bd) {
      bd = d;
      best = b;
    }
  }
  return angleTo(cue, best);
};

describeEngine(E, {
  playerCounts: [2],
  cfg: { maxShots: 24 },
  maxSteps: 60,
  numRuns: 12,
  candidates: (s, by): EightBallAction[] => {
    const aim = aimAtNearest(s, by);
    const call = eightBallOnEight(s, by) ? { call: { pocket: s.seq % 6 } } : {};
    const place = s.hand === 'none' ? {} : { place: { x: 4000 + (s.seq % 5) * 100, y: 3000 } };
    return [
      shot(aim, 400, { ...call, ...place }),
      shot(aim, 900, { spinY: 50, ...call }),
      shot((aim + 7000) % 36000, 600, { ...call }),
      shot((aim + 31) % 36000, 1000, { spinX: -40, ...call }),
    ];
  },
  illegal: () => [shot(36000), shot(0, 5000), { ...shot(0), spinX: 100, spinY: 100 }],
});
