import fc from 'fast-check';
import { seedRng } from '../rng.ts';
import { describeEngine } from '../testing/engineHarness.ts';
import {
  WHOT_SHAPES,
  whotActionSchema,
  whotAutoAction,
  whotCanPlay,
  whotDeck,
  whotEngine,
  whotLegalActions,
  type WhotAction,
  type WhotCard,
  type WhotState,
} from './engine.ts';

const c = (shape: WhotCard['shape'], n: number): WhotCard => ({ shape, n });
const WHOT = c('whot', 20);

/** A hand-built state: `a` is to play, three players unless `players` says otherwise. */
function mk(over: Partial<WhotState> & { hands?: Record<string, WhotCard[]> }): WhotState {
  const players = over.players ?? ['a', 'b', 'c'];
  const hands = over.hands ?? {};
  const full: Record<string, WhotCard[]> = {};
  for (const p of players) full[p] = hands[p] ?? [c('star', 1), c('star', 2), c('star', 3)];
  return {
    players,
    market: Array.from({ length: 20 }, (_, i) => c('cross', [1, 2, 3, 5, 7, 10, 11, 13][i % 8]!)),
    pile: [c('circle', 4)],
    turn: 0,
    requested: null,
    pending: null,
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

const play = (card: WhotCard, extra: Partial<Extract<WhotAction, { kind: 'play' }>> = {}) =>
  ({ kind: 'play', card, ...extra }) as WhotAction;

const total = (s: WhotState): number =>
  Object.values(s.hands).reduce((n, h) => n + h.length, 0) + s.market.length + s.pile.length;

const E = whotEngine;

describeEngine(E, {
  playerCounts: [2, 3, 4, 5, 6],
  cfg: {},
  maxSteps: 8000,
  numRuns: 12,
  // Realistic policy: play when you can (always making the call), draw only when stuck. Random
  // voluntary draws and missed calls make games thousands of moves long; those paths have unit tests.
  candidates: (s, by) => {
    const plays = whotLegalActions(s, by).filter((a) => a.kind === 'play' && a.call !== false);
    return plays.length > 0 ? plays : [{ kind: 'draw' }];
  },
  illegal: (s, by): WhotAction[] => {
    const out: WhotAction[] = [{ kind: 'play', card: c('circle', 99) }];
    if (s.endReason !== null || s.players[s.turn] !== by) out.push({ kind: 'draw' });
    return out;
  },
});

describe('whot deck and deal', () => {
  it('has the standard 54 cards', () => {
    const deck = whotDeck();
    expect(deck).toHaveLength(54);
    expect(deck.filter((x) => x.shape === 'whot')).toHaveLength(5);
    expect(deck.filter((x) => x.shape === 'circle')).toHaveLength(12);
    expect(deck.filter((x) => x.shape === 'triangle')).toHaveLength(12);
    expect(deck.filter((x) => x.shape === 'cross')).toHaveLength(9);
    expect(deck.filter((x) => x.shape === 'square')).toHaveLength(9);
    expect(deck.filter((x) => x.shape === 'star')).toHaveLength(7);
  });

  it('deals 6 (2–4 players) or 5 (5–6) and starts on an ordinary card', () => {
    for (let n = 2; n <= 6; n++) {
      const players = Array.from({ length: n }, (_, i) => `p${i}`);
      for (let seed = 0n; seed < 30n; seed++) {
        const s = E.init(players, seed, {});
        const size = n <= 4 ? 6 : 5;
        for (const p of players) expect(s.hands[p]).toHaveLength(size);
        expect(total(s)).toBe(54);
        const top = s.pile[0]!;
        expect([1, 2, 5, 8, 14, 20]).not.toContain(top.n);
        expect(s.pile).toHaveLength(1);
        expect(s.turn).toBeLessThan(n);
      }
    }
  });

  it('rejects bad player counts, duplicates and hand sizes', () => {
    expect(() => E.init(['a'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'a'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'b'], 1n, { handSize: 0 })).toThrow();
  });

  it('same seed → same deal; different seed → different deal', () => {
    const a = E.init(['a', 'b'], 9n, {});
    const b = E.init(['a', 'b'], 9n, {});
    const d = E.init(['a', 'b'], 10n, {});
    expect(a).toEqual(b);
    expect(a.hands).not.toEqual(d.hands);
  });
});

describe('whot basic plays', () => {
  it('matches by shape or by number', () => {
    expect(whotCanPlay(c('circle', 9), c('circle', 4), null, null)).toBe(true);
    expect(whotCanPlay(c('star', 4), c('circle', 4), null, null)).toBe(true);
    expect(whotCanPlay(c('star', 3), c('circle', 4), null, null)).toBe(false);
    expect(whotCanPlay(WHOT, c('circle', 4), null, null)).toBe(true);
  });

  it('moves a legal card to the pile and passes the turn', () => {
    const s = mk({ hands: { a: [c('circle', 10), c('star', 3), c('star', 2)] } });
    const n = E.apply(s, 'a', play(c('circle', 10)));
    expect(n.pile.at(-1)).toEqual(c('circle', 10));
    expect(n.hands.a).toHaveLength(2);
    expect(E.currentPlayers(n)).toEqual(['b']);
    expect(total(n)).toBe(total(s));
  });

  it('rejects out of turn, cards you do not hold, unplayable cards and finished games', () => {
    const s = mk({ hands: { a: [c('circle', 10), c('star', 3), c('star', 2)] } });
    expect(E.validate(s, 'b', { kind: 'draw' })).toEqual({ ok: false, code: 'not_your_turn' });
    expect(E.validate(s, 'a', play(c('triangle', 10)))).toEqual({
      ok: false,
      code: 'card_not_in_hand',
    });
    expect(E.validate(s, 'a', play(c('star', 3)))).toEqual({
      ok: false,
      code: 'card_not_playable',
    });
    const over = mk({ endReason: 'out', winner: 'b' });
    expect(E.validate(over, 'a', { kind: 'draw' })).toEqual({ ok: false, code: 'game_over' });
    expect(E.currentPlayers(over)).toEqual([]);
  });

  it('drawing takes one card and passes the turn', () => {
    const s = mk({});
    const n = E.apply(s, 'a', { kind: 'draw' });
    expect(n.hands.a).toHaveLength(4);
    expect(n.market).toHaveLength(19);
    expect(E.currentPlayers(n)).toEqual(['b']);
    expect(n.last).toMatchObject({ kind: 'draw', by: 'a', drew: 1 });
  });

  it('apply never mutates the input state', () => {
    const s = mk({ hands: { a: [c('circle', 10), c('star', 3), c('star', 2)] } });
    const before = JSON.stringify(s);
    E.apply(s, 'a', play(c('circle', 10)));
    E.apply(s, 'a', { kind: 'draw' });
    expect(JSON.stringify(s)).toBe(before);
  });

  it('turn order wraps', () => {
    let s = mk({ hands: { a: [c('circle', 10), c('star', 3), c('star', 2)] } });
    s = E.apply(s, 'a', { kind: 'draw' });
    s = E.apply(s, 'b', { kind: 'draw' });
    s = E.apply(s, 'c', { kind: 'draw' });
    expect(E.currentPlayers(s)).toEqual(['a']);
  });
});

describe('whot special cards', () => {
  it('1 Hold On: the same player plays again', () => {
    const s = mk({
      pile: [c('circle', 4)],
      hands: { a: [c('circle', 1), c('star', 3), c('star', 2)] },
    });
    const n = E.apply(s, 'a', play(c('circle', 1)));
    expect(E.currentPlayers(n)).toEqual(['a']);
    expect(n.last?.effect).toBe('hold_on');
  });

  it('2 Pick Two: next player picks two when they cannot defend', () => {
    const s = mk({ hands: { a: [c('circle', 2), c('star', 3), c('star', 5)] } });
    const n = E.apply(s, 'a', play(c('circle', 2)));
    expect(n.pending).toEqual({ n: 2, total: 2 });
    expect(E.currentPlayers(n)).toEqual(['b']);
    // b cannot play anything but a 2 now
    expect(E.validate(n, 'b', play(c('star', 1)))).toEqual({
      ok: false,
      code: 'must_defend_or_draw',
    });
    const d = E.apply(n, 'b', { kind: 'draw' });
    expect(d.hands.b).toHaveLength(5);
    expect(d.pending).toBeNull();
    expect(E.currentPlayers(d)).toEqual(['c']);
  });

  it('2 on 2 stacks the penalty and passes it on; 5 on 5 as well', () => {
    let s = mk({
      hands: {
        a: [c('circle', 2), c('star', 3), c('star', 7)],
        b: [c('triangle', 2), c('star', 1), c('star', 7)],
      },
    });
    s = E.apply(s, 'a', play(c('circle', 2)));
    s = E.apply(s, 'b', play(c('triangle', 2)));
    expect(s.pending).toEqual({ n: 2, total: 4 });
    expect(E.currentPlayers(s)).toEqual(['c']);
    const d = E.apply(s, 'c', { kind: 'draw' });
    expect(d.hands.c).toHaveLength(7);

    let t = mk({
      pile: [c('cross', 5)],
      hands: { a: [c('circle', 5), c('star', 3), c('star', 7)], b: [c('star', 5), c('star', 1)] },
    });
    t = E.apply(t, 'a', play(c('circle', 5)));
    expect(t.pending).toEqual({ n: 5, total: 3 });
    t = E.apply(t, 'b', play(c('star', 5)));
    expect(t.pending).toEqual({ n: 5, total: 6 });
  });

  it('a Whot cannot defend against a pending pick; a 5 cannot defend a 2', () => {
    const s = mk({
      pending: { n: 2, total: 2 },
      hands: { a: [WHOT, c('circle', 5), c('circle', 9)] },
    });
    expect(E.validate(s, 'a', play(WHOT, { shape: 'star' })).ok).toBe(false);
    expect(E.validate(s, 'a', play(c('circle', 5))).ok).toBe(false);
  });

  it('8 Suspension skips the next player (and in a 2-player game plays again)', () => {
    const s3 = mk({ hands: { a: [c('circle', 8), c('star', 3), c('star', 2)] } });
    const n3 = E.apply(s3, 'a', play(c('circle', 8)));
    expect(E.currentPlayers(n3)).toEqual(['c']);
    const s2 = mk({
      players: ['a', 'b'],
      hands: { a: [c('circle', 8), c('star', 3), c('star', 2)] },
    });
    const n2 = E.apply(s2, 'a', play(c('circle', 8)));
    expect(E.currentPlayers(n2)).toEqual(['a']);
  });

  it('14 General Market: everyone else picks one and the player goes again', () => {
    const s = mk({
      pile: [c('circle', 4)],
      hands: { a: [c('circle', 14), c('star', 3), c('star', 2)] },
    });
    const n = E.apply(s, 'a', play(c('circle', 14)));
    expect(n.hands.a).toHaveLength(2);
    expect(n.hands.b).toHaveLength(4);
    expect(n.hands.c).toHaveLength(4);
    expect(n.last?.marketed).toEqual(['b', 'c']);
    expect(E.currentPlayers(n)).toEqual(['a']);
  });

  it('20 Whot: needs a shape, and the next player must follow it', () => {
    const s = mk({ hands: { a: [WHOT, c('star', 3), c('star', 2)] } });
    expect(E.validate(s, 'a', play(WHOT))).toEqual({ ok: false, code: 'shape_required' });
    expect(E.validate(s, 'a', play(c('star', 3), { shape: 'star' })).ok).toBe(false);
    const n = E.apply(s, 'a', play(WHOT, { shape: 'cross' }));
    expect(n.requested).toBe('cross');
    expect(n.last).toMatchObject({ effect: 'whot', requested: 'cross' });
    // b holds a number-20 look-alike? No: only the shape counts now.
    const withHands = { ...n, hands: { ...n.hands, b: [c('circle', 20), c('cross', 1), WHOT] } };
    expect(E.validate(withHands, 'b', play(c('circle', 20))).ok).toBe(false);
    expect(E.validate(withHands, 'b', play(c('cross', 1))).ok).toBe(true);
    expect(E.validate(withHands, 'b', play(WHOT, { shape: 'star' })).ok).toBe(true);
    // the request clears once a normal card is played
    const after = E.apply(withHands, 'b', play(c('cross', 1)));
    expect(after.requested).toBeNull();
  });

  it('the request survives a draw', () => {
    let s = mk({ hands: { a: [WHOT, c('star', 3), c('star', 2)] } });
    s = E.apply(s, 'a', play(WHOT, { shape: 'square' }));
    s = E.apply(s, 'b', { kind: 'draw' });
    expect(s.requested).toBe('square');
  });
});

describe('whot last card, check up and winning', () => {
  it('forgetting "last card" costs two cards', () => {
    const s = mk({ hands: { a: [c('circle', 10), c('star', 3)] } });
    const n = E.apply(s, 'a', play(c('circle', 10)));
    expect(n.hands.a).toHaveLength(3);
    expect(n.last?.missedCall).toBe('last_card');
    expect(n.last?.drew).toBe(2);
    const ok = E.apply(s, 'a', play(c('circle', 10), { call: true }));
    expect(ok.hands.a).toHaveLength(1);
    expect(ok.last?.missedCall).toBeNull();
  });

  it('going out with "check up" wins and ends the game', () => {
    const s = mk({ hands: { a: [c('circle', 10)], b: [c('star', 7)], c: [c('star', 2), WHOT] } });
    const n = E.apply(s, 'a', play(c('circle', 10), { call: true }));
    expect(E.isTerminal(n)).toBe(true);
    expect(n.winner).toBe('a');
    expect(E.currentPlayers(n)).toEqual([]);
    const res = E.result(n);
    expect(res.placements).toEqual([['a'], ['b'], ['c']]); // b holds 7, c holds 22
    expect(res.draw).toBe(false);
  });

  it('going out without "check up" is not a win: draw two and carry on', () => {
    const s = mk({ hands: { a: [c('circle', 10)] } });
    const n = E.apply(s, 'a', play(c('circle', 10)));
    expect(E.isTerminal(n)).toBe(false);
    expect(n.hands.a).toHaveLength(2);
    expect(n.last?.missedCall).toBe('check_up');
  });

  it('you can win on a special card (its effect is moot)', () => {
    const s = mk({ hands: { a: [c('circle', 2)] } });
    const n = E.apply(s, 'a', play(c('circle', 2), { call: true }));
    expect(n.winner).toBe('a');
    expect(n.pending).toBeNull();
  });

  it('losers with equal hand points share a placement', () => {
    const s = mk({
      winner: 'a',
      endReason: 'out',
      hands: { a: [], b: [c('star', 7)], c: [c('cross', 7)] },
    });
    expect(E.result(s)).toEqual({ placements: [['a'], ['b', 'c']], draw: false });
  });
});

describe('whot empty market', () => {
  it('reshuffles the discard pile (keeping the top card) when the market runs out', () => {
    const s = mk({
      market: [],
      pile: [c('square', 1), c('square', 2), c('square', 3), c('circle', 4)],
    });
    const n = E.apply(s, 'a', { kind: 'draw' });
    expect(n.hands.a).toHaveLength(4);
    expect(n.pile).toEqual([c('circle', 4)]);
    expect(n.market).toHaveLength(2);
    expect(total(n)).toBe(total(s));
    // deterministic
    expect(E.apply(s, 'a', { kind: 'draw' })).toEqual(n);
  });

  it('a pick that cannot be fully served gives what exists', () => {
    const s = mk({ market: [c('star', 4)], pile: [c('circle', 4)], pending: { n: 2, total: 6 } });
    const n = E.apply(s, 'a', { kind: 'draw' });
    expect(n.hands.a).toHaveLength(4);
    expect(n.pending).toBeNull();
  });

  it('ends as "blocked" when nobody can draw, ranking by hand points', () => {
    let s = mk({
      market: [],
      pile: [c('circle', 4)],
      hands: { a: [c('star', 1)], b: [c('star', 2)], c: [c('star', 3)] },
    });
    for (const p of ['a', 'b', 'c']) {
      expect(E.isTerminal(s)).toBe(false);
      s = E.apply(s, p, { kind: 'draw' });
    }
    expect(s.endReason).toBe('blocked');
    expect(s.winner).toBeNull();
    expect(E.result(s)).toEqual({ placements: [['a'], ['b'], ['c']], draw: false });
  });

  it('a blocked game with equal best points is a draw', () => {
    const s = mk({
      market: [],
      endReason: 'blocked',
      hands: { a: [c('star', 2)], b: [c('cross', 2)], c: [c('star', 3)] },
    });
    expect(E.result(s)).toEqual({ placements: [['a', 'b'], ['c']], draw: true });
  });
});

describe('whot views hide secrets', () => {
  const s = E.init(['a', 'b', 'c'], 11n, {});
  type V = {
    hand: WhotCard[];
    counts: Record<string, number>;
    hands?: unknown;
    rng?: unknown;
    market?: unknown;
  };

  it('shows a player only their own cards, other hands as counts', () => {
    const v = E.view(s, 'a') as V;
    expect(v.hand).toEqual(s.hands.a);
    expect(v.counts).toEqual({ a: 6, b: 6, c: 6 });
    expect(v.hands).toBeUndefined();
    expect(JSON.stringify(v)).not.toContain(JSON.stringify(s.hands.b));
  });

  it('never exposes the market order or the RNG state, to anyone', () => {
    for (const viewer of ['a', 'b', 'c', 'spectator'] as const) {
      const v = E.view(s, viewer) as V & { marketCount: number };
      expect(v).not.toHaveProperty('rng');
      expect(v).not.toHaveProperty('market');
      expect(v.marketCount).toBe(s.market.length);
      const text = JSON.stringify(v);
      expect(text).not.toContain(JSON.stringify(s.market.slice(0, 3)));
      expect(text).not.toContain(JSON.stringify(s.rng));
    }
  });

  it('spectators see no cards in hand', () => {
    const v = E.view(s, 'spectator') as V;
    expect(v.hand).toEqual([]);
    expect(v.hands).toBeUndefined();
  });

  it('reveals all hands and points once the game is over, still not the market', () => {
    const over = mk({
      winner: 'a',
      endReason: 'out',
      hands: { a: [], b: [c('star', 7)], c: [WHOT] },
    });
    const v = E.view(over, 'spectator') as V & { points: Record<string, number> };
    expect(v.hands).toBeDefined();
    expect(v.points).toEqual({ a: 0, b: 7, c: 20 });
    expect(v).not.toHaveProperty('market');
    expect(v).not.toHaveProperty('rng');
  });
});

describe('whot wire schema and helpers', () => {
  it('accepts well-formed actions and rejects junk', () => {
    expect(whotActionSchema.safeParse({ kind: 'draw' }).success).toBe(true);
    expect(
      whotActionSchema.safeParse({
        kind: 'play',
        card: { shape: 'whot', n: 20 },
        shape: 'star',
        call: true,
      }).success,
    ).toBe(true);
    expect(
      whotActionSchema.safeParse({ kind: 'play', card: { shape: 'moon', n: 3 } }).success,
    ).toBe(false);
    expect(
      whotActionSchema.safeParse({ kind: 'play', card: { shape: 'star', n: 99 } }).success,
    ).toBe(false);
    expect(
      whotActionSchema.safeParse({ kind: 'play', card: { shape: 'star', n: 3 }, shape: 'whot' })
        .success,
    ).toBe(false);
    expect(whotActionSchema.safeParse({ kind: 'cheat' }).success).toBe(false);
  });

  it('whotAutoAction always returns a legal action', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 100000n }),
        fc.integer({ min: 2, max: 6 }),
        (seed, n) => {
          const players = Array.from({ length: n }, (_, i) => `p${i}`);
          let s = E.init(players, seed, {});
          for (let i = 0; i < 400 && !E.isTerminal(s); i++) {
            const by = E.currentPlayers(s)[0]!;
            const a = whotAutoAction(s, by);
            if (!E.validate(s, by, a).ok)
              throw new Error(`auto action illegal: ${JSON.stringify(a)}`);
            s = E.apply(s, by, a);
          }
          // the auto player always calls, so a full game ends with a winner
          return E.isTerminal(s) ? s.winner !== null || s.endReason === 'blocked' : true;
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe('whot properties', () => {
  it('conserves the 54 cards through any legal play', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
        fc.integer({ min: 2, max: 6 }),
        fc.array(fc.nat(1000), { minLength: 300, maxLength: 300 }),
        (seed, n, picks) => {
          const players = Array.from({ length: n }, (_, i) => `p${i}`);
          let s = E.init(players, seed, {});
          for (let i = 0; i < picks.length && !E.isTerminal(s); i++) {
            const by = E.currentPlayers(s)[0]!;
            const legal = whotLegalActions(s, by);
            s = E.apply(s, by, legal[picks[i]! % legal.length]!);
            if (total(s) !== 54) throw new Error('cards were created or lost');
            if (WHOT_SHAPES.length !== 5) throw new Error('shapes');
          }
          return true;
        },
      ),
      { numRuns: 40 },
    );
  });
});
