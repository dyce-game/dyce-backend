import { ROOM_ACTOR } from '../party/common.ts';
import { describeEngine } from '../testing/engineHarness.ts';
import {
  imposterAccused,
  imposterActionSchema,
  imposterEngine,
  type ImposterAction,
  type ImposterState,
} from './engine.ts';

const E = imposterEngine;
const P6 = ['a', 'b', 'c', 'd', 'e', 'f'];
const tick = (ms: number): ImposterAction => ({ kind: 'tick', ms });

const run = (s: ImposterState, by: string, a: ImposterAction): ImposterState => {
  const v = E.validate(s, by, a);
  if (!v.ok) throw new Error(`illegal ${a.kind} by ${by}: ${v.code}`);
  return E.apply(s, by, a);
};

/** Everybody presses ready. */
const ready = (s: ImposterState): ImposterState =>
  s.players.reduce((acc, p) => run(acc, p, { kind: 'ready' }), s);

/** Every clue round, one word each. */
function clues(s: ImposterState): ImposterState {
  let n = s;
  while (n.phase === 'clue') n = run(n, E.currentPlayers(n)[0]!, { kind: 'clue', text: 'maybe' });
  return n;
}

const toVote = (s: ImposterState): ImposterState => clues(ready(s));

const crewOf = (s: ImposterState): string[] => s.players.filter((p) => !s.imposters.includes(p));

/** Everyone votes for `targets` except those who can't vote for themselves (they vote for others). */
function voteAll(
  s: ImposterState,
  pick: (by: string, s: ImposterState) => string[],
): ImposterState {
  let n = s;
  for (const p of s.players) n = run(n, p, { kind: 'vote', targets: pick(p, s) });
  return n;
}

/** Every player votes for the imposters (an imposter votes for crew). */
const voteForImposters = (s: ImposterState): ImposterState =>
  voteAll(s, (by) => {
    const n = s.imposters.length;
    const wanted = s.imposters.filter((i) => i !== by);
    const fill = s.players.filter((p) => p !== by && !wanted.includes(p));
    return [...wanted, ...fill].slice(0, n);
  });

describeEngine(E, {
  playerCounts: [4, 5, 6, 8, 10],
  cfg: {},
  maxSteps: 400,
  numRuns: 15,
  candidates: (s, by): ImposterAction[] => {
    const others = s.players.filter((p) => p !== by);
    const n = s.imposters.length;
    return [
      { kind: 'ready' },
      { kind: 'clue', text: 'spicy' },
      { kind: 'vote', targets: others.slice(0, n) },
      { kind: 'vote', targets: others.slice(-n) },
      { kind: 'guess', text: 'rice' },
      { kind: 'guess', text: s.word },
    ];
  },
  systemActions: () => [
    { by: ROOM_ACTOR, action: tick(1000) },
    { by: ROOM_ACTOR, action: tick(10_000) },
  ],
  illegal: (s, by): ImposterAction[] => [
    { kind: 'tick', ms: 1000 },
    { kind: 'vote', targets: [by] },
    { kind: 'clue', text: '' },
  ],
});

describe('imposter setup', () => {
  it('picks 1 imposter up to 7 players and 2 from 8, and a word from the packs', () => {
    expect(E.init(P6, 1n, {}).imposters).toHaveLength(1);
    expect(E.init([...P6, 'g'], 1n, {}).imposters).toHaveLength(1);
    expect(E.init([...P6, 'g', 'h'], 1n, {}).imposters).toHaveLength(2);
    expect(E.init(P6, 1n, { imposters: 2 }).imposters).toHaveLength(2);
    const s = E.init(P6, 1n, { packs: ['naija'] });
    expect(s.word.length).toBeGreaterThan(2);
    expect(s.packLabel).toBe('Naija');
    expect(s.phase).toBe('reveal');
  });

  it('is deterministic, and different seeds give different tables', () => {
    expect(E.init(P6, 5n, {})).toEqual(E.init(P6, 5n, {}));
    const seen = new Set(
      Array.from({ length: 20 }, (_, i) => E.init(P6, BigInt(i), {}).imposters[0]),
    );
    expect(seen.size).toBeGreaterThan(2);
  });

  it('rejects bad tables and settings', () => {
    expect(() => E.init(['a', 'b', 'c'], 1n, {})).toThrow();
    expect(() => E.init([...P6, 'g', 'h', 'i', 'j', 'k'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'a', 'b', 'c'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'b', 'c', 'd'], 1n, { imposters: 2 })).toThrow();
    expect(() => E.init(P6, 1n, { imposters: 3 })).toThrow();
    expect(() => E.init(P6, 1n, { clueRounds: 0 })).toThrow();
    expect(() => E.init(P6, 1n, { packs: ['nope'] })).toThrow();
  });
});

describe('imposter reveal and clues', () => {
  it('moves to clues when everyone is ready, or when the timer runs out', () => {
    let s = E.init(P6, 3n, {});
    s = run(s, 'a', { kind: 'ready' });
    expect(E.validate(s, 'a', { kind: 'ready' })).toEqual({ ok: false, code: 'already_ready' });
    expect(E.currentPlayers(s)).toEqual(['b', 'c', 'd', 'e', 'f']);
    expect(ready(E.init(P6, 3n, {})).phase).toBe('clue');
    let t = E.init(P6, 3n, {});
    t = run(t, ROOM_ACTOR, tick(9_999));
    expect(t.phase).toBe('reveal');
    t = run(t, ROOM_ACTOR, tick(1));
    expect(t.phase).toBe('clue');
    expect(t.timeLeftMs).toBe(20_000);
  });

  it('gives each player a clue in the seeded order, once per round, then moves to the vote', () => {
    let s = ready(E.init(P6, 3n, {}));
    const order: string[] = [];
    while (s.phase === 'clue') {
      const speaker = E.currentPlayers(s)[0]!;
      order.push(speaker);
      const other = s.players.find((p) => p !== speaker)!;
      expect(E.validate(s, other, { kind: 'clue', text: 'x' })).toEqual({
        ok: false,
        code: 'not_your_turn',
      });
      s = run(s, speaker, { kind: 'clue', text: `clue ${order.length}` });
    }
    expect(order).toHaveLength(12);
    expect(order.slice(0, 6)).toEqual(order.slice(6));
    expect(new Set(order.slice(0, 6)).size).toBe(6);
    expect(s.phase).toBe('vote');
    expect(s.clues.map((c) => c.round)).toEqual([1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2]);
    expect(s.timeLeftMs).toBe(45_000);
  });

  it('checks the clue text: not empty, at most 3 words, no profanity, trimmed', () => {
    const s = ready(E.init(P6, 3n, {}));
    const speaker = E.currentPlayers(s)[0]!;
    expect(E.validate(s, speaker, { kind: 'clue', text: '   ' })).toEqual({
      ok: false,
      code: 'empty_clue',
    });
    expect(E.validate(s, speaker, { kind: 'clue', text: 'one two three four' })).toEqual({
      ok: false,
      code: 'clue_too_long',
    });
    expect(E.validate(s, speaker, { kind: 'clue', text: 'what the fuck' })).toEqual({
      ok: false,
      code: 'not_allowed',
    });
    const n = run(s, speaker, { kind: 'clue', text: '  smoky   street ' });
    expect(n.clues[0]?.text).toBe('smoky street');
  });

  it('a speaker who runs out of time is skipped with an empty clue', () => {
    let s = ready(E.init(P6, 3n, {}));
    const first = E.currentPlayers(s)[0]!;
    s = run(s, ROOM_ACTOR, tick(19_000));
    expect(E.currentPlayers(s)).toEqual([first]);
    s = run(s, ROOM_ACTOR, tick(1_000));
    expect(s.clues).toEqual([{ round: 1, by: first, text: null }]);
    expect(E.currentPlayers(s)[0]).not.toBe(first);
    expect(s.timeLeftMs).toBe(20_000);
  });

  it('rejects actions in the wrong phase and from strangers; ticks only from the room', () => {
    const s = E.init(P6, 3n, {});
    expect(E.validate(s, 'a', { kind: 'clue', text: 'x' })).toEqual({
      ok: false,
      code: 'wrong_phase',
    });
    expect(E.validate(s, 'a', { kind: 'vote', targets: ['b'] })).toEqual({
      ok: false,
      code: 'wrong_phase',
    });
    expect(E.validate(s, 'zed', { kind: 'ready' })).toEqual({ ok: false, code: 'not_a_player' });
    expect(E.validate(s, 'a', tick(1))).toEqual({ ok: false, code: 'room_only' });
    expect(E.validate(s, ROOM_ACTOR, tick(1))).toEqual({ ok: true });
  });
});

describe('imposter vote', () => {
  it('validates targets', () => {
    const s = toVote(E.init(P6, 4n, {}));
    expect(s.phase).toBe('vote');
    expect(E.validate(s, 'a', { kind: 'vote', targets: ['a'] })).toEqual({
      ok: false,
      code: 'cannot_vote_self',
    });
    expect(E.validate(s, 'a', { kind: 'vote', targets: ['zed'] })).toEqual({
      ok: false,
      code: 'unknown_target',
    });
    expect(E.validate(s, 'a', { kind: 'vote', targets: ['b', 'c'] })).toEqual({
      ok: false,
      code: 'wrong_target_count',
    });
    const two = toVote(E.init(P6, 4n, { imposters: 2 }));
    expect(E.validate(two, 'a', { kind: 'vote', targets: ['b', 'b'] })).toEqual({
      ok: false,
      code: 'duplicate_target',
    });
    const v = run(s, 'a', { kind: 'vote', targets: ['b'] });
    expect(E.validate(v, 'a', { kind: 'vote', targets: ['c'] })).toEqual({
      ok: false,
      code: 'already_voted',
    });
    expect(E.currentPlayers(v)).toEqual(['b', 'c', 'd', 'e', 'f']);
  });

  it('accuses the top N, and a tie across the cut accuses only those above it', () => {
    const t = (o: Record<string, number>) => o;
    const players = ['a', 'b', 'c', 'd', 'e'];
    expect(imposterAccused(t({ a: 3, b: 1 }), players, 1)).toEqual(['a']);
    expect(imposterAccused(t({ a: 2, b: 2 }), players, 1)).toEqual([]);
    expect(imposterAccused(t({ a: 3, b: 2, c: 2 }), players, 2)).toEqual(['a']);
    expect(imposterAccused(t({ a: 3, b: 2, c: 1 }), players, 2)).toEqual(['a', 'b']);
    expect(imposterAccused(t({ a: 2, b: 2 }), players, 2)).toEqual(['a', 'b']);
    expect(imposterAccused({}, players, 1)).toEqual([]);
  });

  it('resolves when the last vote arrives, or when time runs out (missing votes count for nothing)', () => {
    const s0 = toVote(E.init(P6, 4n, {}));
    const imp = s0.imposters[0]!;
    const s = voteForImposters(s0);
    expect(s.accused).toEqual([imp]);
    expect(s.phase).toBe('guess');

    let t = toVote(E.init(P6, 4n, {}));
    for (const p of crewOf(t).slice(0, 3)) t = run(t, p, { kind: 'vote', targets: [imp] });
    expect(t.phase).toBe('vote');
    t = run(t, ROOM_ACTOR, tick(10_000));
    t = run(t, ROOM_ACTOR, tick(10_000));
    t = run(t, ROOM_ACTOR, tick(10_000));
    t = run(t, ROOM_ACTOR, tick(10_000));
    t = run(t, ROOM_ACTOR, tick(5_000));
    expect(t.accused).toEqual([imp]);
    expect(t.phase).toBe('guess');
  });
});

describe('imposter outcomes', () => {
  it('imposter caught and guesses wrong → crew win; the crew side shares first place', () => {
    const s0 = toVote(E.init(P6, 6n, {}));
    const imp = s0.imposters[0]!;
    let s = voteForImposters(s0);
    expect(E.currentPlayers(s)).toEqual([imp]);
    expect(E.validate(s, crewOf(s)[0]!, { kind: 'guess', text: s.word })).toEqual({
      ok: false,
      code: 'not_an_imposter',
    });
    s = run(s, imp, { kind: 'guess', text: 'definitely not it' });
    expect(E.isTerminal(s)).toBe(true);
    expect(s.winner).toBe('crew');
    expect(E.currentPlayers(s)).toEqual([]);
    expect(E.result(s)).toEqual({ placements: [crewOf(s), [imp]], draw: false });
  });

  it('a correct guess (any case, spacing or punctuation) steals the round → imposter wins', () => {
    const s0 = toVote(E.init(P6, 6n, {}));
    const imp = s0.imposters[0]!;
    const noisy = `  ${s0.word.toUpperCase().replace(/ /g, '  ')}! `;
    const s = run(voteForImposters(s0), imp, { kind: 'guess', text: noisy });
    expect(s.winner).toBe('imposters');
    expect(E.result(s)).toEqual({ placements: [[imp], crewOf(s)], draw: false });
  });

  it('running out of time before guessing counts as a wrong guess', () => {
    let s = voteForImposters(toVote(E.init(P6, 6n, {})));
    s = run(s, ROOM_ACTOR, tick(10_000));
    s = run(s, ROOM_ACTOR, tick(10_000));
    expect(s.winner).toBe('crew');
  });

  it('a crew member accused instead, or a tie, or no votes → imposters win without a guess', () => {
    const s0 = toVote(E.init(P6, 6n, {}));
    const crew = crewOf(s0);
    const wrong = voteAll(s0, (by) => [crew.find((c) => c !== by)!]);
    expect(wrong.winner).toBe('imposters');
    const tied = voteAll(s0, (by, st) => {
      const [x, y] = [st.players[0]!, st.players[1]!];
      return [by === x ? y : by === y ? x : st.players.indexOf(by) % 2 === 0 ? x : y];
    });
    expect(tied.winner).toBe('imposters');
    let silent = s0;
    for (let i = 0; i < 5; i++) silent = run(silent, ROOM_ACTOR, tick(10_000));
    expect(silent.winner).toBe('imposters');
    expect(E.result(silent).placements[0]).toEqual(s0.imposters);
  });

  it('two imposters: both must be accused; then either one stealing the word wins it', () => {
    const s0 = toVote(E.init(P6, 7n, { imposters: 2 }));
    const [i1, i2] = s0.imposters as [string, string];
    const caught = voteForImposters(s0);
    expect(caught.phase).toBe('guess');
    expect([...caught.accused].sort()).toEqual([i1, i2].sort());
    expect(E.currentPlayers(caught).sort()).toEqual([i1, i2].sort());
    let g = run(caught, i1, { kind: 'guess', text: 'nope' });
    expect(g.phase).toBe('guess');
    expect(E.currentPlayers(g)).toEqual([i2]);
    const crewWin = run(g, i2, { kind: 'guess', text: 'nada' });
    expect(crewWin.winner).toBe('crew');
    g = run(caught, i1, { kind: 'guess', text: 'nope' });
    expect(run(g, i2, { kind: 'guess', text: caught.word }).winner).toBe('imposters');

    // Only one imposter among the two accused, with a crew member beside them → imposters win.
    const [c0, c1] = crewOf(s0) as [string, string];
    const half = voteAll(s0, (by) => (by === i1 ? [i2, c0] : by === c0 ? [i1, c1] : [i1, c0]));
    expect(half.winner).toBe('imposters');
  });

  it('nothing can be done once the game is over', () => {
    const caught = voteForImposters(toVote(E.init(P6, 6n, {})));
    const s = run(caught, E.currentPlayers(caught)[0]!, { kind: 'guess', text: 'x' });
    expect(E.validate(s, 'a', { kind: 'ready' })).toEqual({ ok: false, code: 'game_over' });
    expect(E.validate(s, ROOM_ACTOR, tick(1))).toEqual({ ok: false, code: 'game_over' });
  });
});

describe('imposter views hide secrets', () => {
  type V = {
    role: string | null;
    word: string | null;
    partners: string[];
    imposters?: string[];
    votes?: Record<string, string[]>;
    voted: string[];
    myVote: string[] | null;
  };
  const s = E.init([...P6, 'g', 'h'], 21n, {});
  const imps = s.imposters;
  const crew = s.players.filter((p) => !imps.includes(p));

  it('crew see the word; imposters and spectators do not; nobody sees the imposter list', () => {
    for (const p of crew) {
      const v = E.view(s, p) as V;
      expect(v.role).toBe('crew');
      expect(v.word).toBe(s.word);
      expect(v.imposters).toBeUndefined();
      expect(v.partners).toEqual([]);
    }
    for (const p of imps) {
      const v = E.view(s, p) as V;
      expect(v.role).toBe('imposter');
      expect(v.word).toBeNull();
      expect(v.partners).toEqual(imps.filter((x) => x !== p));
      expect(v.imposters).toBeUndefined();
      expect(JSON.stringify(v)).not.toContain(s.word);
    }
    const sp = E.view(s, 'spectator') as V;
    expect(sp.role).toBeNull();
    expect(sp.word).toBeNull();
    expect(JSON.stringify(sp)).not.toContain(s.word);
  });

  it('never carries the RNG state or the raw imposter field', () => {
    for (const viewer of [...s.players, 'spectator']) {
      const json = JSON.stringify(E.view(s, viewer));
      expect(json).not.toContain('"rng"');
      expect(json).not.toContain('"imposters"');
    }
  });

  it('keeps votes private until the voting is over', () => {
    let t = toVote(E.init(P6, 4n, {}));
    t = run(t, 'a', { kind: 'vote', targets: ['b'] });
    const va = E.view(t, 'a') as V;
    const vb = E.view(t, 'b') as V;
    expect(va.myVote).toEqual(['b']);
    expect(vb.myVote).toBeNull();
    expect(vb.voted).toEqual(['a']);
    expect(vb.votes).toBeUndefined();
    expect(JSON.stringify(E.view(t, 'c'))).not.toContain('"b"]');
    const done = voteForImposters(toVote(E.init(P6, 4n, {})));
    expect((E.view(done, 'a') as V).votes).toBeDefined();
  });

  it('shows everything once the game is over', () => {
    const s0 = toVote(E.init(P6, 6n, {}));
    const over = run(voteForImposters(s0), s0.imposters[0]!, { kind: 'guess', text: 'zzz' });
    for (const viewer of [...over.players, 'spectator']) {
      const v = E.view(over, viewer) as V;
      expect(v.word).toBe(over.word);
      expect(v.imposters).toEqual(over.imposters);
    }
  });
});

describe('imposter wire schema', () => {
  it('accepts player actions and ticks, rejects junk', () => {
    const ok = [
      { kind: 'ready' },
      { kind: 'clue', text: 'hot' },
      { kind: 'vote', targets: ['x'] },
      { kind: 'guess', text: 'suya' },
      { kind: 'tick', ms: 1000 },
    ];
    for (const a of ok) expect(imposterActionSchema.safeParse(a).success).toBe(true);
    const bad = [
      { kind: 'clue', text: '' },
      { kind: 'clue', text: 'x'.repeat(61) },
      { kind: 'vote', targets: [] },
      { kind: 'vote', targets: ['a', 'b', 'c'] },
      { kind: 'tick', ms: 0 },
      { kind: 'tick', ms: 99_999 },
      { kind: 'tick', ms: 1.5 },
      { kind: 'kick' },
    ];
    for (const a of bad) expect(imposterActionSchema.safeParse(a).success).toBe(false);
  });
});

describe('imposter fixed-seed scenario', () => {
  it('plays a scripted game to the same end state every time', () => {
    const play = () => {
      let s = E.init(P6, 2026n, {});
      s = ready(s);
      s = clues(s);
      s = voteForImposters(s);
      s = run(s, s.imposters[0]!, { kind: 'guess', text: 'fish' });
      return s;
    };
    const a = play();
    const b = play();
    expect(a).toEqual(b);
    expect(a.winner).toBe('crew');
    expect(E.result(a).placements.flat().sort()).toEqual(P6);
  });
});
