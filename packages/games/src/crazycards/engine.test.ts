import { seedRng } from '../rng.ts';
import { describeEngine } from '../testing/engineHarness.ts';
import {
  CRAZY_COLORS,
  crazyCanPlay,
  crazyCardPoints,
  crazyCardsActionSchema,
  crazyCardsAutoAction,
  crazyCardsDeck,
  crazyCardsEngine,
  crazyCardsLegalActions,
  type CrazyCard,
  type CrazyCardsAction,
  type CrazyCardsState,
  type CrazyValue,
} from './engine.ts';

const E = crazyCardsEngine;
const c = (color: CrazyCard['color'], value: CrazyValue): CrazyCard => ({ color, value });

/** A hand-built state: `a` is to play, three players unless `players` says otherwise. */
function mk(
  over: Partial<CrazyCardsState> & { hands?: Record<string, CrazyCard[]> },
): CrazyCardsState {
  const players = over.players ?? ['a', 'b', 'c'];
  const hands = over.hands ?? {};
  const full: Record<string, CrazyCard[]> = {};
  for (const p of players) full[p] = hands[p] ?? [c('blue', '1'), c('blue', '2'), c('blue', '3')];
  const pile = over.pile ?? [c('red', '4')];
  return {
    players,
    deck: Array.from({ length: 30 }, (_, i) => c('green', String((i % 9) + 1) as CrazyValue)),
    pile,
    turn: 0,
    dir: 1,
    color:
      pile[pile.length - 1]!.color === 'wild' ? 'red' : (pile[pile.length - 1]!.color as 'red'),
    drawn: null,
    stalled: 0,
    winner: null,
    endReason: null,
    last: null,
    seq: 0,
    rng: seedRng(5n),
    ...over,
    hands: full,
  };
}

const play = (card: CrazyCard, extra: Partial<Extract<CrazyCardsAction, { kind: 'play' }>> = {}) =>
  ({ kind: 'play', card, ...extra }) as CrazyCardsAction;

const total = (s: CrazyCardsState): number =>
  Object.values(s.hands).reduce((n, h) => n + h.length, 0) + s.deck.length + s.pile.length;

describeEngine(E, {
  playerCounts: [2, 3, 4, 5, 6],
  cfg: {},
  maxSteps: 8000,
  numRuns: 12,
  // Realistic policy: play when you can (always calling), otherwise draw and pass. Random voluntary draws
  // and missed calls make games thousands of moves long; those paths have unit tests.
  candidates: (s, by) => {
    const plays = crazyCardsLegalActions(s, by).filter(
      (a) => a.kind === 'play' && a.call !== false,
    );
    return plays.length > 0
      ? plays
      : crazyCardsLegalActions(s, by).filter((a) => a.kind !== 'play');
  },
  illegal: (s, by): CrazyCardsAction[] => {
    const out: CrazyCardsAction[] = [{ kind: 'play', card: c('red', '0'), color: 'blue' }];
    if (s.endReason !== null || s.players[s.turn] !== by) out.push({ kind: 'draw' });
    return out;
  },
});

describe('crazy cards deck and deal', () => {
  it('has the 108-card deck', () => {
    const deck = crazyCardsDeck();
    expect(deck).toHaveLength(108);
    for (const color of CRAZY_COLORS) {
      expect(deck.filter((x) => x.color === color)).toHaveLength(25);
      expect(deck.filter((x) => x.color === color && x.value === '0')).toHaveLength(1);
      expect(deck.filter((x) => x.color === color && x.value === '7')).toHaveLength(2);
      expect(deck.filter((x) => x.color === color && x.value === 'skip')).toHaveLength(2);
    }
    expect(deck.filter((x) => x.value === 'wild')).toHaveLength(4);
    expect(deck.filter((x) => x.value === 'draw_four')).toHaveLength(4);
  });

  it('deals 7 each and starts on a number card, with every card accounted for', () => {
    for (let n = 2; n <= 6; n++) {
      const players = Array.from({ length: n }, (_, i) => `p${i}`);
      for (let seed = 0n; seed < 30n; seed++) {
        const s = E.init(players, seed, {});
        for (const p of players) expect(s.hands[p]).toHaveLength(7);
        expect(total(s)).toBe(108);
        const top = s.pile[0]!;
        expect(top.color).not.toBe('wild');
        expect(top.value).toMatch(/^[0-9]$/);
        expect(s.color).toBe(top.color);
        expect(s.turn).toBeLessThan(n);
      }
    }
  });

  it('rejects bad player counts, duplicates, the reserved id and hand sizes', () => {
    expect(() => E.init(['a'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'a'], 1n, {})).toThrow();
    expect(() => E.init(['a', '$room'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'b'], 1n, { handSize: 0 })).toThrow();
  });

  it('same seed → same deal; different seed → different deal', () => {
    expect(E.init(['a', 'b'], 9n, {})).toEqual(E.init(['a', 'b'], 9n, {}));
    expect(E.init(['a', 'b'], 9n, {}).hands).not.toEqual(E.init(['a', 'b'], 10n, {}).hands);
  });
});

describe('crazy cards matching', () => {
  it('matches colour or value; wilds go on anything', () => {
    expect(crazyCanPlay(c('red', '9'), c('red', '4'), 'red')).toBe(true);
    expect(crazyCanPlay(c('blue', '4'), c('red', '4'), 'red')).toBe(true);
    expect(crazyCanPlay(c('blue', '5'), c('red', '4'), 'red')).toBe(false);
    expect(crazyCanPlay(c('blue', 'skip'), c('red', 'skip'), 'red')).toBe(true);
    expect(crazyCanPlay(c('wild', 'wild'), c('red', '4'), 'red')).toBe(true);
  });

  it('after a wild only the named colour (or a wild) is playable', () => {
    const s = mk({
      pile: [c('red', '4'), c('wild', 'wild')],
      color: 'green',
      hands: { a: [c('green', '7'), c('red', '9'), c('wild', 'draw_four')] },
    });
    expect(E.validate(s, 'a', play(c('green', '7'))).ok).toBe(true);
    expect(E.validate(s, 'a', play(c('red', '9')))).toEqual({
      ok: false,
      code: 'card_not_playable',
    });
    expect(E.validate(s, 'a', play(c('wild', 'draw_four'), { color: 'red' })).ok).toBe(true);
  });

  it('plays a card and moves the turn', () => {
    const s = mk({ hands: { a: [c('red', '9'), c('blue', '1'), c('blue', '2')] } });
    const n = E.apply(s, 'a', play(c('red', '9')));
    expect(n.hands.a).toHaveLength(2);
    expect(n.pile[n.pile.length - 1]).toEqual(c('red', '9'));
    expect(n.color).toBe('red');
    expect(E.currentPlayers(n)).toEqual(['b']);
    expect(n.last).toMatchObject({ seq: 1, by: 'a', kind: 'play', effect: null });
    expect(total(n)).toBe(total(s));
  });
});

describe('crazy cards special cards', () => {
  const hands = { a: [c('red', '5'), c('red', '6'), c('red', '7')] };

  it('skip: next player misses a turn', () => {
    const s = mk({ hands: { a: [c('red', 'skip'), ...hands.a] } });
    const n = E.apply(s, 'a', play(c('red', 'skip')));
    expect(E.currentPlayers(n)).toEqual(['c']);
    expect(n.last?.effect).toBe('skip');
  });

  it('reverse flips the direction (3 players) and acts as skip with 2', () => {
    const s = mk({ hands: { a: [c('red', 'reverse'), ...hands.a] } });
    const n = E.apply(s, 'a', play(c('red', 'reverse')));
    expect(n.dir).toBe(-1);
    expect(E.currentPlayers(n)).toEqual(['c']);
    const after = E.apply(n, 'c', { kind: 'draw' });
    expect(E.currentPlayers(after)).toEqual(['b']); // still going the new way round

    const two = mk({ players: ['a', 'b'], hands: { a: [c('red', 'reverse'), ...hands.a] } });
    const n2 = E.apply(two, 'a', play(c('red', 'reverse')));
    expect(E.currentPlayers(n2)).toEqual(['a']);
  });

  it('draw two: next player draws 2 and misses their turn', () => {
    const s = mk({ hands: { a: [c('red', 'draw_two'), ...hands.a] } });
    const n = E.apply(s, 'a', play(c('red', 'draw_two')));
    expect(n.hands.b).toHaveLength(5);
    expect(E.currentPlayers(n)).toEqual(['c']);
    expect(n.last).toMatchObject({ effect: 'draw_two', victim: 'b', victimDrew: 2 });
  });

  it('wild names a colour; wild draw four draws 4 and skips', () => {
    const s = mk({ hands: { a: [c('wild', 'draw_four'), c('wild', 'wild'), ...hands.a] } });
    expect(E.validate(s, 'a', play(c('wild', 'wild')))).toEqual({
      ok: false,
      code: 'color_required',
    });
    expect(E.validate(s, 'a', play(c('red', '5'), { color: 'blue' }))).toEqual({
      ok: false,
      code: 'color_not_allowed',
    });
    const n = E.apply(s, 'a', play(c('wild', 'draw_four'), { color: 'yellow' }));
    expect(n.color).toBe('yellow');
    expect(n.hands.b).toHaveLength(7);
    expect(E.currentPlayers(n)).toEqual(['c']);
    const w = E.apply(s, 'a', play(c('wild', 'wild'), { color: 'green' }));
    expect(w.color).toBe('green');
    expect(E.currentPlayers(w)).toEqual(['b']);
  });

  it('does not stack: a draw two just makes the next player draw', () => {
    const s = mk({
      pile: [c('red', 'draw_two')],
      hands: {
        a: [c('blue', 'draw_two'), c('red', '1'), c('red', '2')],
        b: [c('green', 'draw_two')],
      },
    });
    const n = E.apply(s, 'a', play(c('red', '1')));
    expect(E.validate(n, 'b', play(c('green', 'draw_two')))).toEqual({
      ok: false,
      code: 'card_not_playable',
    });
  });

  it('points: number = face, action = 20, wild = 50', () => {
    expect(crazyCardPoints(c('red', '7'))).toBe(7);
    expect(crazyCardPoints(c('red', 'skip'))).toBe(20);
    expect(crazyCardPoints(c('blue', 'draw_two'))).toBe(20);
    expect(crazyCardPoints(c('wild', 'draw_four'))).toBe(50);
  });
});

describe('crazy cards drawing and passing', () => {
  it('a playable drawn card may be played or passed; only that card may be played', () => {
    const s = mk({
      deck: [c('red', '8'), c('green', '1')],
      hands: { a: [c('blue', '1'), c('blue', '2'), c('green', '5')] },
    });
    expect(E.validate(s, 'a', { kind: 'pass' })).toEqual({ ok: false, code: 'draw_first' });
    const d = E.apply(s, 'a', { kind: 'draw' });
    expect(d.drawn).toEqual(c('red', '8'));
    expect(d.hands.a).toHaveLength(4);
    expect(E.currentPlayers(d)).toEqual(['a']);
    expect(E.validate(d, 'a', { kind: 'draw' })).toEqual({ ok: false, code: 'already_drew' });
    expect(E.validate(d, 'a', play(c('blue', '1')))).toEqual({
      ok: false,
      code: 'only_drawn_card',
    });
    expect(E.validate(d, 'a', play(c('red', '8'))).ok).toBe(true);
    const p = E.apply(d, 'a', { kind: 'pass' });
    expect(p.drawn).toBeNull();
    expect(E.currentPlayers(p)).toEqual(['b']);
    expect(p.hands.a).toHaveLength(4);
  });

  it('an unplayable drawn card passes the turn by itself', () => {
    const s = mk({
      deck: [c('green', '1')],
      hands: { a: [c('blue', '1'), c('blue', '2'), c('blue', '3')] },
    });
    const d = E.apply(s, 'a', { kind: 'draw' });
    expect(d.drawn).toBeNull();
    expect(E.currentPlayers(d)).toEqual(['b']);
    expect(d.last).toMatchObject({ kind: 'draw', drew: 1 });
  });

  it('reshuffles the discard pile (not the top card) when the deck runs out', () => {
    const s = mk({
      deck: [],
      pile: [c('red', '1'), c('red', '2'), c('blue', '3'), c('red', '4')],
    });
    const d = E.apply(s, 'a', { kind: 'draw' });
    expect(d.pile).toEqual([c('red', '4')]);
    expect(d.deck.length + d.hands.a!.length).toBe(3 + 3);
    expect(total(d)).toBe(total(s));
  });

  it('ends blocked when nobody can draw, ranking by points left', () => {
    let s = mk({
      deck: [],
      pile: [c('red', '4')],
      hands: { a: [c('blue', '1')], b: [c('blue', '9')], c: [c('blue', '9'), c('wild', 'wild')] },
    });
    for (const p of ['a', 'b', 'c']) {
      expect(E.isTerminal(s)).toBe(false);
      s = E.apply(s, p, { kind: 'draw' });
    }
    expect(E.isTerminal(s)).toBe(true);
    expect(s.endReason).toBe('blocked');
    expect(E.currentPlayers(s)).toEqual([]);
    expect(E.result(s)).toEqual({ placements: [['a'], ['b'], ['c']], draw: false });
  });
});

describe('crazy cards last card and winning', () => {
  it('leaving one card without the call costs 2 cards', () => {
    const s = mk({ hands: { a: [c('red', '9'), c('blue', '1')] } });
    const missed = E.apply(s, 'a', play(c('red', '9')));
    expect(missed.hands.a).toHaveLength(3);
    expect(missed.last).toMatchObject({ missedCall: true, drew: 2 });
    const called = E.apply(s, 'a', play(c('red', '9'), { call: true }));
    expect(called.hands.a).toHaveLength(1);
    expect(called.last?.missedCall).toBe(false);
  });

  it('going out wins immediately, with no call needed', () => {
    const s = mk({ hands: { a: [c('red', '9')], b: [c('blue', '5')], c: [c('blue', 'skip')] } });
    const n = E.apply(s, 'a', play(c('red', '9')));
    expect(E.isTerminal(n)).toBe(true);
    expect(n.winner).toBe('a');
    expect(n.endReason).toBe('out');
    expect(E.currentPlayers(n)).toEqual([]);
    // Others ranked by points left: b has 5, c has 20.
    expect(E.result(n)).toEqual({ placements: [['a'], ['b'], ['c']], draw: false });
    expect(E.validate(n, 'b', { kind: 'draw' })).toEqual({ ok: false, code: 'game_over' });
  });

  it('players with equal points share a placement', () => {
    const s = mk({ hands: { a: [c('red', '9')], b: [c('blue', '5')], c: [c('green', '5')] } });
    const n = E.apply(s, 'a', play(c('red', '9')));
    expect(E.result(n).placements).toEqual([['a'], ['b', 'c']]);
  });

  it('going out on a Draw Two still wins (the victim is not dealt cards)', () => {
    const s = mk({ hands: { a: [c('red', 'draw_two')] } });
    const n = E.apply(s, 'a', play(c('red', 'draw_two')));
    expect(n.winner).toBe('a');
    expect(n.hands.b).toHaveLength(3);
  });
});

describe('crazy cards validation', () => {
  const s = mk({ hands: { a: [c('red', '9'), c('blue', '5'), c('blue', '6')] } });
  it('rejects out-of-turn, missing and unplayable cards', () => {
    expect(E.validate(s, 'b', { kind: 'draw' })).toEqual({ ok: false, code: 'not_your_turn' });
    expect(E.validate(s, 'x', { kind: 'draw' })).toEqual({ ok: false, code: 'not_your_turn' });
    expect(E.validate(s, 'a', play(c('red', '1')))).toEqual({
      ok: false,
      code: 'card_not_in_hand',
    });
    expect(E.validate(s, 'a', play(c('blue', '5')))).toEqual({
      ok: false,
      code: 'card_not_playable',
    });
  });

  it('wire schema accepts good actions and rejects junk', () => {
    expect(crazyCardsActionSchema.safeParse({ kind: 'draw' }).success).toBe(true);
    expect(crazyCardsActionSchema.safeParse({ kind: 'pass' }).success).toBe(true);
    expect(
      crazyCardsActionSchema.safeParse({ kind: 'play', card: c('wild', 'wild'), color: 'red' })
        .success,
    ).toBe(true);
    expect(
      crazyCardsActionSchema.safeParse({ kind: 'play', card: { color: 'pink', value: '1' } })
        .success,
    ).toBe(false);
    expect(crazyCardsActionSchema.safeParse({ kind: 'tick', ms: 1 }).success).toBe(false);
    expect(
      crazyCardsActionSchema.safeParse({ kind: 'play', card: c('red', '1'), color: 'x' }).success,
    ).toBe(false);
  });
});

describe('crazy cards bot helper', () => {
  it('auto action is always valid, from the first move to the end', () => {
    for (const seed of [1n, 2n, 3n]) {
      let s = E.init(['a', 'b', 'c'], seed, {});
      for (let i = 0; i < 3000 && !E.isTerminal(s); i++) {
        const by = E.currentPlayers(s)[0]!;
        const act = crazyCardsAutoAction(s, by);
        expect(E.validate(s, by, act)).toEqual({ ok: true });
        s = E.apply(s, by, act);
      }
      expect(E.isTerminal(s)).toBe(true);
    }
  });

  it('a wild is named after the colour held most', () => {
    const s = mk({
      pile: [c('red', '4')],
      hands: { a: [c('wild', 'wild'), c('blue', '1'), c('blue', '2'), c('green', '3')] },
    });
    expect(crazyCardsAutoAction(s, 'a')).toEqual({
      kind: 'play',
      card: c('wild', 'wild'),
      color: 'blue',
      call: true,
    });
  });
});

describe('crazy cards views hide secrets', () => {
  const s = E.init(['a', 'b', 'c'], 77n, {});
  type V = Record<string, unknown> & { hand: CrazyCard[]; counts: Record<string, number> };

  it('shows you your own hand, others only counts', () => {
    const va = E.view(s, 'a') as V;
    expect(va.hand).toEqual(s.hands.a);
    expect(va.counts).toEqual({ a: 7, b: 7, c: 7 });
    expect(va.hands).toBeUndefined();
    const vb = E.view(s, 'b') as V;
    expect(vb.hand).toEqual(s.hands.b);
  });

  it('spectators see no cards', () => {
    expect((E.view(s, 'spectator') as V).hand).toEqual([]);
  });

  it('never carries the deck order, the RNG state or another hand', () => {
    for (const viewer of ['a', 'b', 'c', 'spectator'] as const) {
      const json = JSON.stringify(E.view(s, viewer));
      expect(json).not.toContain('"rng"');
      expect(json).not.toContain('"deck"');
      const view = E.view(s, viewer) as V & { deckCount: number };
      expect(view.deckCount).toBe(s.deck.length);
    }
  });

  it('shows the drawn card only to the player who drew it, and every hand once over', () => {
    const d = mk({
      deck: [c('red', '8')],
      hands: { a: [c('blue', '1'), c('blue', '2'), c('blue', '3')] },
    });
    const drawn = E.apply(d, 'a', { kind: 'draw' });
    expect((E.view(drawn, 'a') as V).drawn).toEqual(c('red', '8'));
    expect((E.view(drawn, 'b') as V).drawn).toBeNull();
    expect((E.view(drawn, 'spectator') as V).drawn).toBeNull();

    const end = E.apply(mk({ hands: { a: [c('red', '9')] } }), 'a', play(c('red', '9')));
    const v = E.view(end, 'b') as V & { points: Record<string, number> };
    expect(v.hands).toBeDefined();
    expect(v.points.a).toBe(0);
  });
});

describe('crazy cards fixed-seed scenario', () => {
  it('plays a whole game with the auto policy to a stable end state', () => {
    const run = () => {
      let s = E.init(['a', 'b', 'c', 'd'], 2026n, {});
      let steps = 0;
      for (; steps < 5000 && !E.isTerminal(s); steps++) {
        const by = E.currentPlayers(s)[0]!;
        s = E.apply(s, by, crazyCardsAutoAction(s, by));
      }
      return { s, steps };
    };
    const one = run();
    const two = run();
    expect(one.s).toEqual(two.s);
    expect(one.s.endReason).not.toBeNull();
    const res = E.result(one.s);
    expect(res.placements.flat().sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(total(one.s)).toBe(108);
  });
});
