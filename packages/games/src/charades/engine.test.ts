import { ROOM_ACTOR } from '../party/common.ts';
import { CHARADES_PACKS } from '../party/words.ts';
import { describeEngine } from '../testing/engineHarness.ts';
import {
  charadesActionSchema,
  charadesEngine,
  type CharadesAction,
  type CharadesState,
} from './engine.ts';

const E = charadesEngine;
const P3 = ['a', 'b', 'c'];
const P6 = ['a', 'b', 'c', 'd', 'e', 'f'];
const tick = (ms: number): CharadesAction => ({ kind: 'tick', ms });

const run = (s: CharadesState, by: string, a: CharadesAction): CharadesState => {
  const v = E.validate(s, by, a);
  if (!v.ok) throw new Error(`illegal ${a.kind} by ${by}: ${v.code}`);
  return E.apply(s, by, a);
};
const actor = (s: CharadesState): string => E.currentPlayers(s)[0]!;
const start = (s: CharadesState): CharadesState => run(s, actor(s), { kind: 'start' });
const teamOf = (s: CharadesState, p: string): number => s.teams.findIndex((t) => t.includes(p));
/** The actor's teammate (or, in solo play, any other player). */
const mate = (s: CharadesState, by: string): string =>
  s.solo ? s.players.find((p) => p !== by)! : s.teams[teamOf(s, by)]!.find((p) => p !== by)!;

/** Play a whole turn: `n` got_its, then let the clock run out (if the cards are not used up first). */
function turnWith(s: CharadesState, n: number): CharadesState {
  let x = start(s);
  const by = actor(x);
  for (let i = 0; i < n && x.phase === 'acting'; i++) {
    x = run(x, by, { kind: 'got_it', guesser: x.mode === 'act' ? mate(x, by) : undefined });
  }
  while (x.phase === 'acting') x = run(x, ROOM_ACTOR, tick(10_000));
  return x;
}

describeEngine(E, {
  playerCounts: [3, 4, 5, 6, 10],
  cfg: { rounds: 1, cardsPerTurn: 5 },
  maxSteps: 1500,
  numRuns: 12,
  candidates: (s, by): CharadesAction[] => {
    const out: CharadesAction[] = [{ kind: 'start' }, { kind: 'skip' }, { kind: 'got_it' }];
    for (const g of s.players) if (g !== by) out.push({ kind: 'got_it', guesser: g });
    return out;
  },
  systemActions: () => [
    { by: ROOM_ACTOR, action: tick(1000) },
    { by: ROOM_ACTOR, action: tick(10_000) },
  ],
  illegal: (s, by): CharadesAction[] => [
    { kind: 'tick', ms: 5 },
    { kind: 'got_it', guesser: by },
    { kind: 'got_it', guesser: 'zed' },
  ],
});

describe('charades setup', () => {
  it('3 players are their own teams; 4+ play in two teams', () => {
    const solo = E.init(P3, 1n, {});
    expect(solo.solo).toBe(true);
    expect(solo.teams).toHaveLength(3);
    expect(solo.schedule).toHaveLength(6); // everyone twice
    const s = E.init(P6, 1n, {});
    expect(s.solo).toBe(false);
    expect(s.teams.map((t) => t.length)).toEqual([3, 3]);
    expect([...s.teams.flat()].sort()).toEqual(P6);
    expect(s.schedule).toHaveLength(12);
    expect(s.phase).toBe('ready');
    expect(s.scores).toEqual([0, 0]);
    expect(E.init(P6, 1n, { solo: true }).teams).toHaveLength(6);
    expect(E.init(P6, 1n, { teams: 3 }).teams.map((t) => t.length)).toEqual([2, 2, 2]);
  });

  it('every team gets the same number of turns and players take turns in their team', () => {
    const s = E.init(['a', 'b', 'c', 'd', 'e'], 2n, { rounds: 2 });
    expect(s.teams.map((t) => t.length).sort()).toEqual([2, 3]);
    expect(s.schedule).toHaveLength(12); // 2 rounds x 3 (biggest team) x 2 teams
    const perTeam = s.teams.map((t) => s.schedule.filter((p) => t.includes(p)).length);
    expect(perTeam).toEqual([6, 6]);
    // Turns alternate between the teams.
    s.schedule.forEach((p, i) => expect(teamOf(s, p)).toBe(i % 2));
    for (const t of s.teams) {
      const counts = t.map((p) => s.schedule.filter((x) => x === p).length);
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(2);
    }
  });

  it('is deterministic; seeds give different teams', () => {
    expect(E.init(P6, 3n, {})).toEqual(E.init(P6, 3n, {}));
    const seen = new Set(
      Array.from({ length: 12 }, (_, i) => E.init(P6, BigInt(i), {}).teams[0]!.join('')),
    );
    expect(seen.size).toBeGreaterThan(3);
  });

  it('rejects bad tables and settings', () => {
    expect(() => E.init(['a', 'b'], 1n, {})).toThrow();
    expect(() =>
      E.init(
        Array.from({ length: 11 }, (_, i) => `p${i}`),
        1n,
        {},
      ),
    ).toThrow();
    expect(() => E.init(['a', 'a', 'b'], 1n, {})).toThrow();
    expect(() => E.init(P6, 1n, { teams: 4 })).toThrow();
    expect(() => E.init(P6, 1n, { teams: 1 })).toThrow();
    expect(() => E.init(P6, 1n, { rounds: 0 })).toThrow();
    expect(() => E.init(P6, 1n, { cardsPerTurn: 0 })).toThrow();
    expect(() => E.init(P6, 1n, { maxSkips: 31 })).toThrow();
    expect(() => E.init(P6, 1n, { packs: ['nope'] })).toThrow();
    expect(() => E.init(P6, 1n, { mode: 'dance' as never })).toThrow();
  });
});

describe('charades a turn', () => {
  const s0 = E.init(P6, 7n, {});

  it('only the player in the hot seat may start; the ready timer forfeits a turn nobody starts', () => {
    const other = P6.find((p) => p !== actor(s0))!;
    expect(E.validate(s0, other, { kind: 'start' })).toEqual({ ok: false, code: 'not_your_turn' });
    expect(E.validate(s0, actor(s0), { kind: 'got_it' })).toEqual({
      ok: false,
      code: 'not_started',
    });
    expect(E.validate(s0, actor(s0), { kind: 'skip' })).toEqual({ ok: false, code: 'not_started' });
    const first = actor(s0);
    let s = run(s0, ROOM_ACTOR, tick(19_999));
    expect(s.turn).toBe(0);
    s = run(s, ROOM_ACTOR, tick(1));
    expect(s.turn).toBe(1);
    expect(s.phase).toBe('ready');
    expect(s.last).toMatchObject({ kind: 'forfeit', by: first });
    expect(s.scores).toEqual([0, 0]);
  });

  it('starting deals a card and a clock; got_it scores for the actor’s team and draws the next card', () => {
    let s = start(s0);
    const by = actor(s);
    expect(s.phase).toBe('acting');
    expect(s.timeLeftMs).toBe(60_000);
    expect(s.card).not.toBeNull();
    expect(E.validate(s, by, { kind: 'start' })).toEqual({ ok: false, code: 'already_started' });
    const first = s.card!;
    s = run(s, by, { kind: 'got_it', guesser: mate(s, by) });
    expect(s.scores[teamOf(s, by)]).toBe(1);
    expect(s.scores[1 - teamOf(s, by)]).toBe(0);
    expect(s.resolved).toBe(1);
    expect(s.card).not.toEqual(first);
    expect(s.last).toMatchObject({ kind: 'got_it', by, text: first.t });
  });

  it('the guesser must be a teammate; naming one is optional in team play', () => {
    const s = start(s0);
    const by = actor(s);
    const rival = s.players.find((p) => teamOf(s, p) !== teamOf(s, by))!;
    expect(E.validate(s, by, { kind: 'got_it', guesser: rival })).toEqual({
      ok: false,
      code: 'invalid_guesser',
    });
    expect(E.validate(s, by, { kind: 'got_it', guesser: by })).toEqual({
      ok: false,
      code: 'invalid_guesser',
    });
    expect(E.validate(s, by, { kind: 'got_it', guesser: 'zed' })).toEqual({
      ok: false,
      code: 'invalid_guesser',
    });
    expect(E.validate(s, by, { kind: 'got_it' }).ok).toBe(true);
  });

  it('solo play: the guesser is required and scores a point too', () => {
    let s = start(E.init(P3, 5n, {}));
    const by = actor(s);
    expect(E.validate(s, by, { kind: 'got_it' })).toEqual({ ok: false, code: 'guesser_required' });
    const g = P3.find((p) => p !== by)!;
    s = run(s, by, { kind: 'got_it', guesser: g });
    expect(s.scores[teamOf(s, by)]).toBe(1);
    expect(s.scores[teamOf(s, g)]).toBe(1);
  });

  it('skips are limited per turn and score nothing', () => {
    let s = start(s0);
    const by = actor(s);
    for (let i = 0; i < 3; i++) s = run(s, by, { kind: 'skip' });
    expect(s.skipsLeft).toBe(0);
    expect(E.validate(s, by, { kind: 'skip' })).toEqual({ ok: false, code: 'no_skips_left' });
    expect(s.scores).toEqual([0, 0]);
    expect(s.resolved).toBe(3);
    expect(s.last?.kind).toBe('skip');
  });

  it('the turn ends when the clock runs out, or when the cards for the turn are used up', () => {
    let s = start(s0);
    const first = actor(s);
    s = run(s, ROOM_ACTOR, tick(10_000));
    expect(s.timeLeftMs).toBe(50_000);
    for (let i = 0; i < 5; i++) s = run(s, ROOM_ACTOR, tick(10_000));
    expect(s.turn).toBe(1);
    expect(s.phase).toBe('ready');
    expect(s.last).toMatchObject({ kind: 'time_up', by: first });
    expect(s.card).toBeNull();

    let t = start(E.init(P6, 7n, { cardsPerTurn: 2 }));
    const by = actor(t);
    t = run(t, by, { kind: 'got_it' });
    expect(t.turn).toBe(0);
    t = run(t, by, { kind: 'got_it' });
    expect(t.turn).toBe(1);
    expect(t.phase).toBe('ready');
    expect(t.scores[teamOf(t, by)]).toBe(2);
  });

  it('never shows the same card twice in a turn, and recycles the deck when it runs out', () => {
    let s = start(E.init(P6, 9n, { cardsPerTurn: 30, maxSkips: 30 }));
    const by = actor(s);
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      expect(seen.has(s.card!.t)).toBe(false);
      seen.add(s.card!.t);
      s = run(s, by, { kind: 'skip' });
      if (s.turn !== 0) break;
    }
    // A tiny pack forces the used cards back into the deck.
    const total = CHARADES_PACKS['jobs']!.prompts.length;
    let r = E.init(P3, 9n, { packs: ['jobs'], cardsPerTurn: 30, maxSkips: 30, rounds: 1 });
    r = start(r);
    for (let i = 0; i < total + 5; i++) r = run(r, actor(r), { kind: 'skip' });
    expect(r.deck.length + r.used.length).toBe(total);
  });

  it('wrong actors, strangers and ticks from seats are rejected', () => {
    const s = start(s0);
    const other = P6.find((p) => p !== actor(s))!;
    expect(E.validate(s, other, { kind: 'got_it' })).toEqual({ ok: false, code: 'not_your_turn' });
    expect(E.validate(s, 'zed', { kind: 'skip' })).toEqual({ ok: false, code: 'not_a_player' });
    expect(E.validate(s, other, tick(5))).toEqual({ ok: false, code: 'room_only' });
  });
});

describe('charades end and placements', () => {
  it('plays every scheduled turn, then the highest team wins; equal scores share a placement', () => {
    let s = E.init(P6, 4n, { rounds: 1 });
    expect(s.schedule).toHaveLength(6);
    for (let i = 0; i < 6; i++) {
      expect(E.isTerminal(s)).toBe(false);
      s = turnWith(s, teamOf(s, actor(s)) === 0 ? 2 : 1);
    }
    expect(E.isTerminal(s)).toBe(true);
    expect(s.phase).toBe('over');
    expect(E.currentPlayers(s)).toEqual([]);
    expect(s.scores).toEqual([6, 3]);
    expect(E.result(s).placements.map((g) => [...g].sort())).toEqual(
      s.teams.map((t) => [...t].sort()),
    );
    expect(E.validate(s, 'a', { kind: 'start' })).toEqual({ ok: false, code: 'game_over' });
    expect(E.validate(s, ROOM_ACTOR, tick(1))).toEqual({ ok: false, code: 'game_over' });
  });

  it('a tie is a draw; an unfinished game has no result', () => {
    let s = E.init(P6, 4n, { rounds: 1 });
    expect(E.result(s)).toEqual({ placements: [], draw: false });
    for (let i = 0; i < 6; i++) s = turnWith(s, 1);
    expect(s.scores).toEqual([3, 3]);
    expect(E.result(s).draw).toBe(true);
    expect(E.result(s).placements).toHaveLength(1);
    expect(E.result(s).placements[0]!.sort()).toEqual(P6);
  });

  it('solo placements rank every player', () => {
    let s = E.init(P3, 4n, { rounds: 1 });
    for (let i = 0; i < 3; i++) s = turnWith(s, i + 1);
    const res = E.result(s);
    expect(res.placements.flat().sort()).toEqual(P3);
    expect(res.draw).toBe(false);
  });
});

describe('charades views hide the card', () => {
  type V = {
    word: string | null;
    category: string | null;
    cardNo: number | null;
    skipsLeft: number | null;
  };

  it('act mode: only the actor sees the card; the category is public', () => {
    const s = start(E.init(P6, 8n, {}));
    const by = actor(s);
    for (const p of P6) {
      const v = E.view(s, p) as V;
      expect(v.word).toBe(p === by ? s.card!.t : null);
      expect(v.category).toBe(s.card!.c);
    }
    const sp = E.view(s, 'spectator') as V;
    expect(sp.word).toBeNull();
    expect(sp.category).toBe(s.card!.c);
    expect(E.view(s, by)).toMatchObject({ cardNo: 1, skipsLeft: 3 });
    for (const viewer of [...P6, 'spectator']) {
      const json = JSON.stringify(E.view(s, viewer));
      expect(json).not.toContain('"rng"');
      expect(json).not.toContain('"deck"');
      if (viewer !== by) expect(json).not.toContain(s.card!.t);
    }
  });

  it('heads-up: the holder cannot see the card; the other players can; spectators cannot', () => {
    const s = start(E.init(P6, 8n, { mode: 'headsup' }));
    const by = actor(s);
    for (const p of P6) expect((E.view(s, p) as V).word).toBe(p === by ? null : s.card!.t);
    expect((E.view(s, 'spectator') as V).word).toBeNull();
    expect(JSON.stringify(E.view(s, by))).not.toContain(s.card!.t);
    expect(E.validate(s, by, { kind: 'got_it', guesser: 'b' })).toEqual({
      ok: false,
      code: 'guesser_not_allowed',
    });
    const n = run(s, by, { kind: 'got_it' });
    expect(n.scores[teamOf(n, by)]).toBe(1);
  });

  it('nobody sees a card before the turn starts', () => {
    const s = E.init(P6, 8n, {});
    for (const p of P6) expect((E.view(s, p) as V).word).toBeNull();
    expect((E.view(s, 'a') as V).cardNo).toBeNull();
  });
});

describe('charades wire schema', () => {
  it('accepts actions and ticks, rejects junk', () => {
    for (const a of [
      { kind: 'start' },
      { kind: 'got_it' },
      { kind: 'got_it', guesser: 'x' },
      { kind: 'skip' },
      { kind: 'tick', ms: 250 },
    ]) {
      expect(charadesActionSchema.safeParse(a).success).toBe(true);
    }
    for (const a of [
      { kind: 'got_it', guesser: '' },
      { kind: 'tick', ms: 0 },
      { kind: 'peek' },
      {},
    ]) {
      expect(charadesActionSchema.safeParse(a).success).toBe(false);
    }
  });
});

describe('charades fixed-seed scenario', () => {
  it('plays a scripted game to the same end state every time', () => {
    const play = () => {
      let s = E.init(P6, 2026n, { rounds: 1 });
      for (let i = 0; !E.isTerminal(s) && i < 50; i++) s = turnWith(s, (i % 3) + 1);
      return s;
    };
    const a = play();
    expect(a).toEqual(play());
    expect(E.isTerminal(a)).toBe(true);
    expect(a.scores.reduce((x, y) => x + y, 0)).toBe(1 + 2 + 3 + 1 + 2 + 3);
  });
});
