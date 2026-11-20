import { ROOM_ACTOR } from '../party/common.ts';
import { describeEngine } from '../testing/engineHarness.ts';
import {
  DOODLE_MAX_POINTS,
  DOODLE_MAX_STROKES,
  doodleActionSchema,
  doodleGuessEngine,
  doodleGuessPoints,
  doodleHintsShown,
  type DoodleAction,
  type DoodleState,
} from './engine.ts';

const E = doodleGuessEngine;
const P4 = ['a', 'b', 'c', 'd'];
const tick = (ms: number): DoodleAction => ({ kind: 'tick', ms });
const dot = (n = 1): [number, number][] => Array.from({ length: n }, (_, i) => [i % 1000, 10]);

const run = (s: DoodleState, by: string, a: DoodleAction): DoodleState => {
  const v = E.validate(s, by, a);
  if (!v.ok) throw new Error(`illegal ${a.kind} by ${by}: ${v.code}`);
  return E.apply(s, by, a);
};
const drawer = (s: DoodleState): string => s.order[s.turn % s.order.length]!;
const guessers = (s: DoodleState): string[] => s.players.filter((p) => p !== drawer(s));
const choose = (s: DoodleState, i = 0): DoodleState =>
  run(s, drawer(s), { kind: 'choose', index: i });
/** Everyone guesses the word right, `ms` apart. */
function solveAll(s: DoodleState, ms = 0): DoodleState {
  let n = s;
  const word = n.word!;
  for (const g of guessers(s)) {
    if (ms > 0) n = run(n, ROOM_ACTOR, tick(ms));
    n = run(n, g, { kind: 'guess', text: word });
  }
  return n;
}

describeEngine(E, {
  playerCounts: [3, 4, 6, 8],
  cfg: { rounds: 1 },
  maxSteps: 1500,
  numRuns: 12,
  candidates: (s): DoodleAction[] => [
    { kind: 'choose', index: 1 },
    { kind: 'stroke', points: dot(3), color: 2, width: 3 },
    { kind: 'stroke', points: dot(2), color: 2, width: 3, cont: true },
    { kind: 'undo' },
    { kind: 'clear' },
    { kind: 'guess', text: 'rice' },
    { kind: 'guess', text: s.word ?? 'x' },
  ],
  systemActions: () => [
    { by: ROOM_ACTOR, action: tick(1000) },
    { by: ROOM_ACTOR, action: tick(10_000) },
  ],
  illegal: (): DoodleAction[] => [
    { kind: 'tick', ms: 1000 },
    { kind: 'choose', index: 5 as never },
    { kind: 'stroke', points: dot(DOODLE_MAX_POINTS + 1), color: 1, width: 1 },
  ],
});

describe('doodle guess setup', () => {
  it('starts with the first drawer choosing between 3 distinct words', () => {
    const s = E.init(P4, 3n, {});
    expect(s.phase).toBe('choose');
    expect(s.choices).toHaveLength(3);
    expect(new Set(s.choices).size).toBe(3);
    expect(E.currentPlayers(s)).toEqual([drawer(s)]);
    expect(s.timeLeftMs).toBe(10_000);
    expect([...s.order].sort()).toEqual(P4);
  });

  it('is deterministic; seeds change the order and the words', () => {
    expect(E.init(P4, 3n, {})).toEqual(E.init(P4, 3n, {}));
    const seen = new Set(
      Array.from({ length: 10 }, (_, i) => E.init(P4, BigInt(i), {}).choices.join()),
    );
    expect(seen.size).toBeGreaterThan(5);
  });

  it('rejects bad tables and settings', () => {
    expect(() => E.init(['a', 'b'], 1n, {})).toThrow();
    expect(() => E.init([...P4, 'e', 'f', 'g', 'h', 'i'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'a', 'b'], 1n, {})).toThrow();
    expect(() => E.init(P4, 1n, { rounds: 0 })).toThrow();
    expect(() => E.init(P4, 1n, { packs: ['nope'] })).toThrow();
  });
});

describe('doodle guess choosing and drawing', () => {
  it('only the drawer chooses; the pick becomes the word; time running out picks the first', () => {
    const s0 = E.init(P4, 3n, {});
    const other = guessers(s0)[0]!;
    expect(E.validate(s0, other, { kind: 'choose', index: 0 })).toEqual({
      ok: false,
      code: 'not_the_drawer',
    });
    expect(E.validate(s0, drawer(s0), { kind: 'guess', text: 'x' })).toEqual({
      ok: false,
      code: 'wrong_phase',
    });
    const s = choose(s0, 2);
    expect(s.word).toBe(s0.choices[2]);
    expect(s.phase).toBe('draw');
    expect(s.timeLeftMs).toBe(80_000);
    expect(s.choices).toEqual([]);
    const t = run(s0, ROOM_ACTOR, tick(10_000));
    expect(t.word).toBe(s0.choices[0]);
    expect(E.currentPlayers(s)).toEqual([drawer(s), ...guessers(s)]);
  });

  it('strokes are bounded point lists from the drawer only; cont extends the last stroke', () => {
    let s = choose(E.init(P4, 3n, {}));
    const d = drawer(s);
    const g = guessers(s)[0]!;
    expect(E.validate(s, g, { kind: 'stroke', points: dot(), color: 1, width: 1 })).toEqual({
      ok: false,
      code: 'not_the_drawer',
    });
    expect(
      E.validate(s, d, { kind: 'stroke', points: dot(), color: 1, width: 1, cont: true }),
    ).toEqual({
      ok: false,
      code: 'no_stroke_to_continue',
    });
    expect(E.validate(s, d, { kind: 'undo' })).toEqual({ ok: false, code: 'nothing_to_remove' });
    s = run(s, d, { kind: 'stroke', points: dot(3), color: 4, width: 2 });
    s = run(s, d, { kind: 'stroke', points: dot(2), color: 4, width: 2, cont: true });
    s = run(s, d, { kind: 'stroke', points: dot(1), color: 5, width: 1 });
    expect(s.strokes.map((x) => [x.id, x.pts.length])).toEqual([
      [1, 5],
      [2, 1],
    ]);
    expect(s.points).toBe(6);
    s = run(s, d, { kind: 'undo' });
    expect(s.strokes).toHaveLength(1);
    expect(s.points).toBe(5);
    s = run(s, d, { kind: 'clear' });
    expect(s.strokes).toEqual([]);
    expect(s.points).toBe(0);
  });

  it('caps the canvas', () => {
    let s = choose(E.init(P4, 3n, {}));
    const d = drawer(s);
    for (let i = 0; i < Math.floor(DOODLE_MAX_POINTS / 64); i++) {
      s = run(s, d, { kind: 'stroke', points: dot(64), color: 1, width: 1, cont: i > 0 });
    }
    expect(s.points).toBe(DOODLE_MAX_POINTS - (DOODLE_MAX_POINTS % 64));
    expect(
      E.validate(s, d, { kind: 'stroke', points: dot(64), color: 1, width: 1, cont: true }),
    ).toEqual({
      ok: false,
      code: 'canvas_full',
    });
    let t = choose(E.init(P4, 3n, {}));
    for (let i = 0; i < DOODLE_MAX_STROKES; i++) {
      t = run(t, drawer(t), { kind: 'stroke', points: dot(1), color: 1, width: 1 });
    }
    expect(
      E.validate(t, drawer(t), { kind: 'stroke', points: dot(1), color: 1, width: 1 }),
    ).toEqual({
      ok: false,
      code: 'canvas_full',
    });
  });
});

describe('doodle guess guessing and scoring', () => {
  it('a correct guess (any case, spacing, punctuation) scores by speed; the drawer earns half', () => {
    let s = choose(E.init(P4, 3n, {}));
    const d = drawer(s);
    const [g1, g2] = guessers(s) as [string, string, string];
    const word = s.word!;
    s = run(s, g1, { kind: 'guess', text: `  ${word.toUpperCase()}! ` });
    expect(s.scores[g1]).toBe(200);
    expect(s.scores[d]).toBe(100);
    expect(s.solvers).toEqual([g1]);
    expect(E.validate(s, g1, { kind: 'guess', text: word })).toEqual({
      ok: false,
      code: 'already_guessed',
    });
    s = run(s, ROOM_ACTOR, tick(40_000));
    s = run(s, g2, { kind: 'guess', text: word });
    expect(s.scores[g2]).toBe(50 + 75);
    expect(s.scores[d]).toBe(100 + 62);
    expect(s.feed.at(-1)).toMatchObject({ kind: 'correct', by: g2, points: 125 });
    expect(doodleGuessPoints(0, 80_000)).toBe(50);
    expect(doodleGuessPoints(80_000, 80_000)).toBe(200);
  });

  it('wrong guesses are shown, near misses only say "close", and the drawer cannot guess', () => {
    let s = choose(E.init(P4, 3n, { packs: ['naija'] }));
    const g = guessers(s)[0]!;
    const word = s.word!;
    s = run(s, g, { kind: 'guess', text: 'totally wrong' });
    expect(s.feed.at(-1)).toMatchObject({ kind: 'guess', by: g, text: 'totally wrong' });
    const near = word.slice(0, -1) + (word.endsWith('x') ? 'y' : 'x');
    s = run(s, g, { kind: 'guess', text: near });
    const last = s.feed.at(-1)!;
    expect(last).toMatchObject({ kind: 'close', by: g });
    expect(JSON.stringify(last)).not.toContain(near);
    expect(E.validate(s, drawer(s), { kind: 'guess', text: 'x' })).toEqual({
      ok: false,
      code: 'drawer_cannot_guess',
    });
    expect(E.validate(s, g, { kind: 'guess', text: 'what the fuck' })).toEqual({
      ok: false,
      code: 'not_allowed',
    });
    expect(E.validate(s, g, { kind: 'guess', text: 'x'.repeat(41) })).toEqual({
      ok: false,
      code: 'invalid_guess',
    });
    expect(E.validate(s, 'zed', { kind: 'guess', text: 'x' })).toEqual({
      ok: false,
      code: 'not_a_player',
    });
    expect(s.scores[g]).toBe(0);
  });

  it('the feed keeps only the last 30 entries', () => {
    let s = choose(E.init(P4, 3n, {}));
    const g = guessers(s)[0]!;
    for (let i = 0; i < 45; i++) s = run(s, g, { kind: 'guess', text: `nope ${i}` });
    expect(s.feed).toHaveLength(30);
    expect(s.feed.at(-1)).toMatchObject({ text: 'nope 44' });
  });
});

describe('doodle guess turns and the end', () => {
  it('the turn ends when all guessers have it, and the next drawer chooses; the word goes in the history', () => {
    const s0 = choose(E.init(P4, 3n, {}));
    const d0 = drawer(s0);
    const word = s0.word!;
    const s = solveAll(s0);
    expect(s.turn).toBe(1);
    expect(s.phase).toBe('choose');
    expect(drawer(s)).not.toBe(d0);
    expect(s.history).toEqual([{ drawer: d0, word, solvers: guessers(s0) }]);
    expect(s.strokes).toEqual([]);
    expect(s.feed).toEqual([]);
    expect(s.solvers).toEqual([]);
  });

  it('the turn ends when the clock runs out; nobody solving scores nothing', () => {
    let s = choose(E.init(P4, 3n, {}));
    for (let i = 0; i < 8; i++) s = run(s, ROOM_ACTOR, tick(10_000));
    expect(s.turn).toBe(1);
    expect(s.history[0]!.solvers).toEqual([]);
    expect(Object.values(s.scores).every((v) => v === 0)).toBe(true);
  });

  it('each player draws once per round; after the last turn the game is over with placements by score', () => {
    let s = E.init(P4, 3n, { rounds: 2 });
    const drawers: string[] = [];
    for (let t = 0; t < 8; t++) {
      expect(E.isTerminal(s)).toBe(false);
      drawers.push(drawer(s));
      s = choose(s);
      // Only the first guesser solves in turns 0..3; nobody in the rest.
      if (t < 4) s = run(s, guessers(s)[0]!, { kind: 'guess', text: s.word! });
      for (let i = 0; i < 8 && s.turn === t; i++) s = run(s, ROOM_ACTOR, tick(10_000));
    }
    expect(drawers.slice(0, 4)).toEqual(drawers.slice(4));
    expect(new Set(drawers).size).toBe(4);
    expect(E.isTerminal(s)).toBe(true);
    expect(s.phase).toBe('over');
    expect(E.currentPlayers(s)).toEqual([]);
    const res = E.result(s);
    expect(res.placements.flat().sort()).toEqual(P4);
    const top = res.placements[0]!;
    for (const p of top) expect(s.scores[p]).toBe(Math.max(...Object.values(s.scores)));
    expect(E.validate(s, 'a', { kind: 'guess', text: 'x' })).toEqual({
      ok: false,
      code: 'game_over',
    });
    expect(E.validate(s, ROOM_ACTOR, tick(1))).toEqual({ ok: false, code: 'game_over' });
  });

  it('equal scores share a placement; an unfinished game has no result', () => {
    const s0 = E.init(P4, 3n, { rounds: 1 });
    expect(E.result(s0)).toEqual({ placements: [], draw: false });
    let s = s0;
    for (let t = 0; t < 4; t++) {
      s = choose(s);
      for (let i = 0; i < 8 && s.turn === t; i++) s = run(s, ROOM_ACTOR, tick(10_000));
    }
    expect(E.result(s)).toEqual({ placements: [P4.slice().sort()], draw: true });
  });

  it('only the room may tick', () => {
    const s = E.init(P4, 3n, {});
    expect(E.validate(s, 'a', tick(1))).toEqual({ ok: false, code: 'room_only' });
  });
});

describe('doodle guess hints', () => {
  it('reveals up to a third of the letters, evenly over the clock', () => {
    expect(doodleHintsShown('jollof', 80_000, 80_000)).toBe(0);
    expect(doodleHintsShown('jollof', 50_000, 80_000)).toBe(1);
    expect(doodleHintsShown('jollof', 20_000, 80_000)).toBe(2);
    expect(doodleHintsShown('jollof', 0, 80_000)).toBe(2);
    expect(doodleHintsShown('egg', 0, 80_000)).toBe(1);
    expect(doodleHintsShown('ox', 0, 80_000)).toBe(0);
    expect(doodleHintsShown('a very long phrase here', 0, 80_000)).toBe(3);
  });
});

describe('doodle guess views hide the word', () => {
  type V = {
    word: string | null;
    mask: (string | null)[] | null;
    choices: string[];
    history: { word: string }[];
  };

  it('only the drawer sees the choices', () => {
    const s = E.init(P4, 3n, {});
    expect((E.view(s, drawer(s)) as V).choices).toEqual(s.choices);
    for (const p of [...guessers(s), 'spectator']) {
      const v = E.view(s, p);
      expect((v as V).choices).toEqual([]);
      for (const c of s.choices) expect(JSON.stringify(v)).not.toContain(c);
    }
  });

  it('the drawer and solvers see the word; others see a mask with only the hinted letters', () => {
    let s = choose(E.init(P4, 3n, { packs: ['naija'] }));
    const word = s.word!;
    const [g1, g2] = guessers(s) as [string, string, string];
    s = run(s, g1, { kind: 'guess', text: word });
    expect((E.view(s, drawer(s)) as V).word).toBe(word);
    expect((E.view(s, g1) as V).word).toBe(word);
    for (const viewer of [g2, 'spectator']) {
      const v = E.view(s, viewer) as V;
      expect(v.word).toBeNull();
      expect(v.mask).toHaveLength(word.length);
      expect(v.mask!.every((c) => c === null || c === ' ' || /[^a-z0-9]/i.test(c))).toBe(true);
      expect(JSON.stringify(v)).not.toContain(`"${word}"`);
    }
    // After time passes some letters show, never all.
    s = run(s, ROOM_ACTOR, tick(60_000));
    const m = (E.view(s, g2) as V).mask!;
    const shown = m.filter((c) => c !== null && /[a-z0-9]/i.test(c)).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(word.replace(/[^a-z0-9]/gi, '').length);
    s.revealOrder.slice(0, shown).forEach((i) => expect(m[i]).toBe(word[i]));
  });

  it('never carries the RNG, the deck, the reveal order or the pool', () => {
    const s = choose(E.init(P4, 3n, {}));
    for (const viewer of [...P4, 'spectator']) {
      const json = JSON.stringify(E.view(s, viewer));
      for (const k of ['"rng"', '"deck"', '"revealOrder"', '"pool"']) expect(json).not.toContain(k);
    }
  });

  it('past words are public once the turn is over', () => {
    const s0 = choose(E.init(P4, 3n, {}));
    const word = s0.word!;
    const s = solveAll(s0);
    expect((E.view(s, 'spectator') as V).history[0]!.word).toBe(word);
  });

  it('strokes are public', () => {
    let s = choose(E.init(P4, 3n, {}));
    s = run(s, drawer(s), { kind: 'stroke', points: dot(3), color: 2, width: 3 });
    expect((E.view(s, guessers(s)[0]!) as { strokes: unknown[] }).strokes).toHaveLength(1);
  });
});

describe('doodle guess wire schema', () => {
  it('accepts actions and ticks, rejects junk', () => {
    const ok = [
      { kind: 'choose', index: 2 },
      {
        kind: 'stroke',
        points: [
          [0, 0],
          [1000, 1000],
        ],
        color: 3,
        width: 4,
      },
      { kind: 'stroke', points: [[5, 5]], color: 0, width: 1, cont: true },
      { kind: 'undo' },
      { kind: 'clear' },
      { kind: 'guess', text: 'rice' },
      { kind: 'tick', ms: 1000 },
    ];
    for (const a of ok) expect(doodleActionSchema.safeParse(a).success).toBe(true);
    const bad = [
      { kind: 'choose', index: 3 },
      { kind: 'stroke', points: [], color: 1, width: 1 },
      { kind: 'stroke', points: [[1001, 0]], color: 1, width: 1 },
      { kind: 'stroke', points: [[0.5, 0]], color: 1, width: 1 },
      { kind: 'stroke', points: Array.from({ length: 65 }, () => [1, 1]), color: 1, width: 1 },
      { kind: 'stroke', points: [[1, 1]], color: 16, width: 1 },
      { kind: 'guess', text: '' },
      { kind: 'tick', ms: 0 },
      { kind: 'erase' },
    ];
    for (const a of bad) expect(doodleActionSchema.safeParse(a).success).toBe(false);
  });
});

describe('doodle guess fixed-seed scenario', () => {
  it('plays a scripted game to the same end state every time', () => {
    const play = () => {
      let s = E.init(P4, 2026n, { rounds: 1 });
      for (let t = 0; t < 4; t++) {
        s = choose(s, t % 3);
        s = run(s, drawer(s), { kind: 'stroke', points: dot(5), color: t, width: 2 });
        s = solveAll(s, 5_000);
      }
      return s;
    };
    const a = play();
    expect(a).toEqual(play());
    expect(E.isTerminal(a)).toBe(true);
    expect(a.history).toHaveLength(4);
    expect(E.result(a).placements.flat().sort()).toEqual(P4);
  });
});
