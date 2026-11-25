import { ROOM_ACTOR } from '../party/common.ts';
import { describeEngine } from '../testing/engineHarness.ts';
import {
  defaultWolves,
  werewolfActionSchema,
  werewolfEngine,
  type WerewolfAction,
  type WerewolfRole,
  type WerewolfState,
} from './engine.ts';

const E = werewolfEngine;
const P7 = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
const tick = (ms: number): WerewolfAction => ({ kind: 'tick', ms });

const run = (s: WerewolfState, by: string, a: WerewolfAction): WerewolfState => {
  const v = E.validate(s, by, a);
  if (!v.ok) throw new Error(`illegal ${a.kind} by ${by}: ${v.code}`);
  return E.apply(s, by, a);
};

const who = (s: WerewolfState, role: WerewolfRole): string[] =>
  s.players.filter((p) => s.roles[p] === role);
const alive = (s: WerewolfState): string[] => s.players.filter((p) => !s.dead.includes(p));

/** Run the night: every living wolf names `victim`, the seer inspects `look`, the doctor saves `save`. */
function night(
  s: WerewolfState,
  o: { victim?: string; look?: string; save?: string },
): WerewolfState {
  let n = s;
  for (const w of who(s, 'werewolf')) {
    if (!n.dead.includes(w) && o.victim !== undefined)
      n = run(n, w, { kind: 'kill', target: o.victim });
  }
  const seer = who(s, 'seer')[0]!;
  if (!n.dead.includes(seer) && o.look !== undefined)
    n = run(n, seer, { kind: 'inspect', target: o.look });
  const doc = who(s, 'doctor')[0]!;
  if (!n.dead.includes(doc) && o.save !== undefined)
    n = run(n, doc, { kind: 'protect', target: o.save });
  return n;
}

/** Everybody alive readies, then everybody votes for `target` (the target abstains). */
function dayAndVote(s: WerewolfState, target: string | null): WerewolfState {
  let n = s;
  for (const p of alive(s)) n = run(n, p, { kind: 'ready' });
  for (const p of alive(s)) n = run(n, p, { kind: 'vote', target: p === target ? null : target });
  return n;
}

describeEngine(E, {
  playerCounts: [5, 6, 7, 9, 12],
  cfg: { maxNights: 4 },
  maxSteps: 1500,
  numRuns: 15,
  candidates: (s, by): WerewolfAction[] => {
    const others = s.players.filter((p) => p !== by);
    const out: WerewolfAction[] = [{ kind: 'ready' }, { kind: 'vote', target: null }];
    for (const t of others) {
      out.push(
        { kind: 'kill', target: t },
        { kind: 'inspect', target: t },
        { kind: 'protect', target: t },
      );
      out.push({ kind: 'vote', target: t });
    }
    out.push({ kind: 'protect', target: by });
    return out;
  },
  systemActions: () => [
    { by: ROOM_ACTOR, action: tick(1000) },
    { by: ROOM_ACTOR, action: tick(10_000) },
  ],
  illegal: (s, by): WerewolfAction[] => [
    { kind: 'tick', ms: 1000 },
    { kind: 'vote', target: by },
    { kind: 'kill', target: 'nobody' },
  ],
});

describe('werewolf setup', () => {
  it('deals the right roles for every table size', () => {
    for (let n = 5; n <= 12; n++) {
      const players = Array.from({ length: n }, (_, i) => `p${i}`);
      const s = E.init(players, BigInt(n), {});
      expect(who(s, 'werewolf')).toHaveLength(defaultWolves(n));
      expect(who(s, 'seer')).toHaveLength(1);
      expect(who(s, 'doctor')).toHaveLength(1);
      expect(who(s, 'villager')).toHaveLength(n - defaultWolves(n) - 2);
      expect(s.phase).toBe('night');
      expect(s.night).toBe(1);
    }
    expect([5, 6, 7, 9, 10, 12].map(defaultWolves)).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it('is deterministic, and different seeds deal different roles', () => {
    expect(E.init(P7, 5n, {})).toEqual(E.init(P7, 5n, {}));
    const seers = new Set(
      Array.from({ length: 20 }, (_, i) => who(E.init(P7, BigInt(i), {}), 'seer')[0]),
    );
    expect(seers.size).toBeGreaterThan(2);
  });

  it('rejects bad tables and settings', () => {
    expect(() => E.init(['a', 'b', 'c', 'd'], 1n, {})).toThrow();
    expect(() =>
      E.init(
        Array.from({ length: 13 }, (_, i) => `p${i}`),
        1n,
        {},
      ),
    ).toThrow();
    expect(() => E.init(['a', 'a', 'b', 'c', 'd'], 1n, {})).toThrow();
    expect(() => E.init(P7, 1n, { wolves: 0 })).toThrow();
    expect(() => E.init(P7, 1n, { wolves: 4 })).toThrow();
    expect(() => E.init(P7, 1n, { maxNights: 0 })).toThrow();
  });
});

describe('werewolf night', () => {
  const s0 = E.init(P7, 11n, {});
  const [w1, w2] = who(s0, 'werewolf') as [string, string];
  const seer = who(s0, 'seer')[0]!;
  const doc = who(s0, 'doctor')[0]!;
  const vill = who(s0, 'villager');

  it('only living actors may act, each with their own action, on a valid target', () => {
    expect(E.currentPlayers(s0).sort()).toEqual([w1, w2, seer, doc].sort());
    expect(E.validate(s0, vill[0]!, { kind: 'kill', target: vill[1]! })).toEqual({
      ok: false,
      code: 'wrong_role',
    });
    expect(E.validate(s0, seer, { kind: 'kill', target: vill[1]! })).toEqual({
      ok: false,
      code: 'wrong_role',
    });
    expect(E.validate(s0, w1, { kind: 'inspect', target: vill[1]! })).toEqual({
      ok: false,
      code: 'wrong_role',
    });
    expect(E.validate(s0, w1, { kind: 'kill', target: w2 })).toEqual({
      ok: false,
      code: 'invalid_target',
    });
    expect(E.validate(s0, w1, { kind: 'kill', target: 'zed' })).toEqual({
      ok: false,
      code: 'invalid_target',
    });
    expect(E.validate(s0, seer, { kind: 'inspect', target: seer })).toEqual({
      ok: false,
      code: 'invalid_target',
    });
    expect(E.validate(s0, doc, { kind: 'protect', target: doc }).ok).toBe(true);
    expect(E.validate(s0, 'zed', { kind: 'ready' })).toEqual({ ok: false, code: 'not_a_player' });
    expect(E.validate(s0, w1, { kind: 'ready' })).toEqual({ ok: false, code: 'wrong_phase' });
    expect(E.validate(s0, w1, { kind: 'vote', target: null })).toEqual({
      ok: false,
      code: 'wrong_phase',
    });
  });

  it('actions are final', () => {
    const n = run(s0, w1, { kind: 'kill', target: vill[0]! });
    expect(E.validate(n, w1, { kind: 'kill', target: vill[1]! })).toEqual({
      ok: false,
      code: 'already_acted',
    });
    expect(E.currentPlayers(n)).not.toContain(w1);
  });

  it('the night ends when every living actor has acted: the target dies and the role is revealed', () => {
    const n = night(s0, { victim: vill[0]!, look: w1, save: vill[1]! });
    expect(n.phase).toBe('day');
    expect(n.dead).toEqual([vill[0]]);
    expect(n.log).toEqual([{ kind: 'night', night: 1, killed: vill[0], role: 'villager' }]);
    expect(n.seerLog).toEqual([{ night: 1, target: w1, werewolf: true }]);
    expect(n.kills).toEqual({});
    expect(n.timeLeftMs).toBe(60_000);
  });

  it('the doctor saves the victim; nobody dies, and the log does not say why', () => {
    const n = night(s0, { victim: vill[0]!, look: vill[1]!, save: vill[0]! });
    expect(n.dead).toEqual([]);
    expect(n.log).toEqual([{ kind: 'night', night: 1, killed: null, role: null }]);
    expect(n.seerLog[0]).toEqual({ night: 1, target: vill[1], werewolf: false });
  });

  it('the doctor may save themselves; the seer can be killed', () => {
    const n = night(s0, { victim: doc, look: vill[0]!, save: doc });
    expect(n.dead).toEqual([]);
    const m = night(s0, { victim: seer, look: vill[0]!, save: vill[1]! });
    expect(m.dead).toEqual([seer]);
    expect(m.log[0]).toMatchObject({ killed: seer, role: 'seer' });
  });

  it('wolves split: the seeded RNG breaks the tie the same way every time', () => {
    const split = () => {
      let n = run(s0, w1, { kind: 'kill', target: vill[0]! });
      n = run(n, w2, { kind: 'kill', target: vill[1]! });
      n = run(n, seer, { kind: 'inspect', target: vill[2]! });
      return run(n, doc, { kind: 'protect', target: vill[2]! });
    };
    const a = split();
    expect(a.dead).toHaveLength(1);
    expect([vill[0], vill[1]]).toContain(a.dead[0]);
    expect(split()).toEqual(a);
  });

  it('a night with no action at all passes without a death when time runs out', () => {
    let n = run(s0, ROOM_ACTOR, tick(10_000));
    n = run(n, ROOM_ACTOR, tick(10_000));
    expect(n.phase).toBe('night');
    n = run(n, ROOM_ACTOR, tick(10_000));
    expect(n.phase).toBe('day');
    expect(n.dead).toEqual([]);
    expect(n.log[0]).toEqual({ kind: 'night', night: 1, killed: null, role: null });
  });

  it('wolves who act in time still kill when the others run out of time', () => {
    let n = run(s0, w1, { kind: 'kill', target: vill[0]! });
    for (let i = 0; i < 3; i++) n = run(n, ROOM_ACTOR, tick(10_000));
    expect(n.dead).toEqual([vill[0]]);
  });
});

describe('werewolf day and vote', () => {
  const day = (): WerewolfState => {
    const s0 = E.init(P7, 11n, {});
    return night(s0, {
      victim: who(s0, 'villager')[0]!,
      look: who(s0, 'villager')[1]!,
      save: who(s0, 'seer')[0]!,
    });
  };

  it('the dead cannot act, everyone else may press ready, and the day ends when all have', () => {
    const s = day();
    const dead = s.dead[0]!;
    expect(E.validate(s, dead, { kind: 'ready' })).toEqual({ ok: false, code: 'you_are_dead' });
    expect(E.currentPlayers(s)).toEqual(alive(s));
    let n = s;
    for (const p of alive(s).slice(0, -1)) n = run(n, p, { kind: 'ready' });
    expect(n.phase).toBe('day');
    expect(E.validate(n, alive(s)[0]!, { kind: 'ready' })).toEqual({
      ok: false,
      code: 'already_ready',
    });
    n = run(n, alive(s).at(-1)!, { kind: 'ready' });
    expect(n.phase).toBe('vote');
    expect(n.timeLeftMs).toBe(30_000);
  });

  it('the day also ends on the timer', () => {
    let n = day();
    for (let i = 0; i < 6; i++) n = run(n, ROOM_ACTOR, tick(10_000));
    expect(n.phase).toBe('vote');
  });

  it('a strict plurality is lynched and the role revealed; then it is night again', () => {
    const s = day();
    const wolf = who(s, 'werewolf')[0]!;
    const n = dayAndVote(s, wolf);
    expect(n.dead).toContain(wolf);
    const entry = n.log.at(-1)!;
    expect(entry).toMatchObject({ kind: 'lynch', lynched: wolf, role: 'werewolf' });
    expect(Object.keys((entry as { votes: object }).votes).sort()).toEqual(alive(s).sort());
    expect(n.phase).toBe('night');
    expect(n.night).toBe(2);
    expect(n.votes).toEqual({});
  });

  it('a tie, or nothing but abstentions, lynches nobody', () => {
    const s = day();
    const [x, y] = alive(s) as [string, string, ...string[]];
    let n = s;
    for (const p of alive(s)) n = run(n, p, { kind: 'ready' });
    const living = alive(s);
    living.forEach((p, i) => {
      const target = i % 2 === 0 ? (p === x ? y : x) : p === y ? x : y;
      n = run(n, p, { kind: 'vote', target });
    });
    expect(n.log.at(-1)).toMatchObject({ kind: 'lynch', lynched: null, role: null });
    expect(n.night).toBe(2);

    let m = s;
    for (const p of alive(s)) m = run(m, p, { kind: 'ready' });
    for (const p of alive(s)) m = run(m, p, { kind: 'vote', target: null });
    expect(m.log.at(-1)).toMatchObject({ lynched: null });
  });

  it('validates votes: not yourself, not the dead, once only; missing votes count as abstentions on timeout', () => {
    let s = day();
    for (const p of alive(s)) s = run(s, p, { kind: 'ready' });
    const [a1, a2] = alive(s) as [string, string];
    const dead = s.dead[0]!;
    expect(E.validate(s, a1, { kind: 'vote', target: a1 })).toEqual({
      ok: false,
      code: 'cannot_vote_self',
    });
    expect(E.validate(s, a1, { kind: 'vote', target: dead })).toEqual({
      ok: false,
      code: 'invalid_target',
    });
    expect(E.validate(s, dead, { kind: 'vote', target: a1 })).toEqual({
      ok: false,
      code: 'you_are_dead',
    });
    s = run(s, a1, { kind: 'vote', target: a2 });
    expect(E.validate(s, a1, { kind: 'vote', target: null })).toEqual({
      ok: false,
      code: 'already_voted',
    });
    s = run(s, ROOM_ACTOR, tick(10_000));
    s = run(s, ROOM_ACTOR, tick(10_000));
    s = run(s, ROOM_ACTOR, tick(10_000));
    // One vote against a2 is a strict plurality of one: a2 is lynched.
    expect(s.dead).toContain(a2);
  });
});

describe('werewolf endings', () => {
  it('villagers win when the last werewolf is lynched; the whole village shares first place', () => {
    const s0 = E.init(['a', 'b', 'c', 'd', 'e'], 3n, {});
    const wolf = who(s0, 'werewolf')[0]!;
    const victim = who(s0, 'villager')[0]!;
    const s = dayAndVote(night(s0, { victim, look: wolf, save: who(s0, 'seer')[0]! }), wolf);
    expect(E.isTerminal(s)).toBe(true);
    expect(s.winner).toBe('villagers');
    expect(E.currentPlayers(s)).toEqual([]);
    const villagers = s0.players.filter((p) => p !== wolf);
    expect(E.result(s)).toEqual({ placements: [villagers, [wolf]], draw: false });
    expect(E.validate(s, 'a', { kind: 'ready' })).toEqual({ ok: false, code: 'game_over' });
  });

  it('werewolves win at parity: one wolf, five players, two nights of kills', () => {
    const s0 = E.init(['a', 'b', 'c', 'd', 'e'], 3n, {});
    const wolf = who(s0, 'werewolf')[0]!;
    const others = s0.players.filter((p) => p !== wolf);
    let s = night(s0, { victim: others[0]!, look: wolf, save: others[1]! });
    s = dayAndVote(s, null); // nobody lynched
    expect(s.phase).toBe('night');
    const rest = alive(s).filter((p) => p !== wolf);
    s = night(s, { victim: rest[0]!, look: wolf, save: rest[1]! });
    // 3 left: wolf + 2 others, not yet parity (wolf 1 < 2). Next night's kill makes 1 v 1.
    expect(s.phase).toBe('day');
    s = dayAndVote(s, null);
    const rest2 = alive(s).filter((p) => p !== wolf);
    s = night(s, { victim: rest2[0]!, look: wolf, save: rest2[1] ?? rest2[0]! });
    expect(s.winner).toBe('werewolves');
    expect(E.result(s).placements[0]).toEqual([wolf]);
    expect(E.result(s).placements[1]).toEqual(s0.players.filter((p) => p !== wolf));
  });

  it('a night kill that makes wolves equal the rest ends the game before the day', () => {
    const s0 = E.init(['a', 'b', 'c', 'd', 'e'], 3n, {});
    const wolf = who(s0, 'werewolf')[0]!;
    const rest = s0.players.filter((p) => p !== wolf);
    let s = night(s0, { victim: rest[0]!, look: wolf, save: rest[1]! });
    s = dayAndVote(s, rest[1]!); // the village lynches one of its own: 1 wolf v 2
    expect(s.phase).toBe('night');
    const left = alive(s).filter((p) => p !== wolf);
    expect(left).toHaveLength(2);
    s = night(s, { victim: left[0]!, look: wolf, save: left[1]! });
    expect(s.phase).toBe('over');
    expect(s.winner).toBe('werewolves');
  });

  it('is a draw (everyone refunded) after maxNights nights with no winner', () => {
    let s = E.init(P7, 4n, { maxNights: 2 });
    for (let i = 0; i < 2; i++) {
      expect(s.phase).toBe('night');
      s = night(s, {});
      for (let t = 0; t < 3; t++) s = run(s, ROOM_ACTOR, tick(10_000)); // night times out
      s = dayAndVote(s, null);
    }
    expect(s.phase).toBe('over');
    expect(s.winner).toBe('draw');
    expect(E.result(s)).toEqual({ placements: [P7], draw: true });
  });
});

describe('werewolf views hide secrets', () => {
  type V = {
    role: WerewolfRole | null;
    roles?: Record<string, WerewolfRole>;
    wolves?: string[];
    wolfTargets?: Record<string, string>;
    inspecting?: string | null;
    seerLog?: unknown[];
    protecting?: string | null;
    acted: boolean | null;
    revealed: Record<string, WerewolfRole>;
    voted: string[];
    myVote: string | null;
  };
  const s0 = E.init(P7, 11n, {});
  const [w1, w2] = who(s0, 'werewolf') as [string, string];
  const seer = who(s0, 'seer')[0]!;
  const doc = who(s0, 'doctor')[0]!;
  const vill = who(s0, 'villager');
  const half = run(
    run(run(s0, w1, { kind: 'kill', target: vill[0]! }), seer, { kind: 'inspect', target: w2 }),
    doc,
    {
      kind: 'protect',
      target: vill[0]!,
    },
  );

  it('everyone sees their own role and nobody else’s', () => {
    for (const p of P7) {
      const v = E.view(half, p) as V;
      expect(v.role).toBe(half.roles[p]);
      expect(v.roles).toBeUndefined();
    }
    const sp = E.view(half, 'spectator') as V;
    expect(sp.role).toBeNull();
    expect(sp.roles).toBeUndefined();
    expect(sp.acted).toBeNull();
  });

  it('only wolves see wolves and their targets; only the seer sees the log; only the doctor sees the save', () => {
    const vw = E.view(half, w2) as V;
    expect(vw.wolves).toEqual([w1, w2]);
    expect(vw.wolfTargets).toEqual({ [w1]: vill[0] });
    for (const p of [seer, doc, ...vill]) {
      const v = E.view(half, p) as V;
      expect(v.wolves).toBeUndefined();
      expect(v.wolfTargets).toBeUndefined();
    }
    expect((E.view(half, seer) as V).seerLog).toEqual([{ night: 1, target: w2, werewolf: true }]);
    expect((E.view(half, seer) as V).inspecting).toBe(w2);
    expect((E.view(half, doc) as V).protecting).toBe(vill[0]);
    for (const p of [w1, w2, doc, ...vill]) expect((E.view(half, p) as V).seerLog).toBeUndefined();
    for (const p of [w1, w2, seer, ...vill])
      expect((E.view(half, p) as V).protecting).toBeUndefined();
    for (const viewer of [vill[1]!, 'spectator']) {
      const json = JSON.stringify(E.view(half, viewer));
      expect(json).not.toContain('"role":"werewolf"');
      expect(json).not.toContain('"werewolf":true');
    }
  });

  it('says whether you have acted, and nothing about anyone else', () => {
    expect((E.view(half, w1) as V).acted).toBe(true);
    expect((E.view(half, w2) as V).acted).toBe(false);
    expect((E.view(half, seer) as V).acted).toBe(true);
    expect((E.view(half, vill[0]!) as V).acted).toBeNull();
  });

  it('never carries the RNG state or the raw role map or night choices', () => {
    for (const viewer of [...P7, 'spectator']) {
      const json = JSON.stringify(E.view(half, viewer));
      expect(json).not.toContain('"rng"');
      expect(json).not.toContain('"kills"');
    }
  });

  it('a death reveals only that player’s role; the dead then spectate with every role visible', () => {
    const n = night(s0, { victim: vill[0]!, look: vill[1]!, save: seer });
    const v = E.view(n, vill[1]!) as V;
    expect(v.revealed).toEqual({ [vill[0]!]: 'villager' });
    expect(v.roles).toBeUndefined();
    const dead = E.view(n, vill[0]!) as V;
    expect(dead.roles).toEqual(n.roles);
    expect(dead.acted).toBeNull();
  });

  it('votes stay hidden until the vote resolves', () => {
    let n = night(s0, { victim: vill[0]!, look: vill[1]!, save: seer });
    for (const p of alive(n)) n = run(n, p, { kind: 'ready' });
    n = run(n, w1, { kind: 'vote', target: vill[1]! });
    const v = E.view(n, vill[2]!) as V;
    expect(v.voted).toEqual([w1]);
    expect(v.myVote).toBeNull();
    expect((E.view(n, w1) as V).myVote).toBe(vill[1]);
    expect(JSON.stringify(E.view(n, vill[2]!))).not.toContain('"votes"');
  });

  it('shows every role to everyone when the game is over', () => {
    const s5 = E.init(['a', 'b', 'c', 'd', 'e'], 3n, {});
    const wolf = who(s5, 'werewolf')[0]!;
    const over = dayAndVote(
      night(s5, { victim: who(s5, 'villager')[0]!, look: wolf, save: who(s5, 'seer')[0]! }),
      wolf,
    );
    for (const viewer of [...s5.players, 'spectator']) {
      expect((E.view(over, viewer) as V).roles).toEqual(over.roles);
    }
  });
});

describe('werewolf wire schema', () => {
  it('accepts actions and ticks, rejects junk', () => {
    const ok = [
      { kind: 'kill', target: 'x' },
      { kind: 'inspect', target: 'x' },
      { kind: 'protect', target: 'x' },
      { kind: 'ready' },
      { kind: 'vote', target: null },
      { kind: 'vote', target: 'x' },
      { kind: 'tick', ms: 500 },
    ];
    for (const a of ok) expect(werewolfActionSchema.safeParse(a).success).toBe(true);
    const bad = [
      { kind: 'kill' },
      { kind: 'vote' },
      { kind: 'kill', target: '' },
      { kind: 'tick', ms: -1 },
      { kind: 'eat' },
    ];
    for (const a of bad) expect(werewolfActionSchema.safeParse(a).success).toBe(false);
  });
});

describe('werewolf fixed-seed scenario', () => {
  it('plays a scripted game to the same end state every time', () => {
    const play = () => {
      const s0 = E.init(['a', 'b', 'c', 'd', 'e', 'f'], 2026n, {});
      const wolf = who(s0, 'werewolf')[0]!;
      const villagers = s0.players.filter((p) => p !== wolf);
      let s = night(s0, { victim: villagers[0]!, look: wolf, save: villagers[1]! });
      s = dayAndVote(s, wolf);
      return s;
    };
    const a = play();
    expect(a).toEqual(play());
    expect(a.winner).toBe('villagers');
    expect(E.result(a).placements.flat().sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});
