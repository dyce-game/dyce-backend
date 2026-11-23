import { Rng } from '../rng.ts';
import { describeEngine } from '../testing/engineHarness.ts';
import {
  AYO_DEFAULT_MAX_PLIES,
  ayoActionSchema,
  ayoEngine as E,
  ayoLegalPits,
  ayoOpposite,
  ayoPitOwner,
  type AyoAction,
  type AyoCfg,
  type AyoState,
} from './engine.ts';

const sow = (pit: number): AyoAction => ({ kind: 'sow', pit });

/** A hand-built position. `pits` lists 12 counts; unspecified fields come from a fresh game. */
function mk(pits: number[], over: Partial<AyoState> = {}, cfg: AyoCfg = {}): AyoState {
  if (pits.length !== 12) throw new Error('need 12 pits');
  return { ...E.init(['a', 'b'], 1n, cfg), pits, ...over };
}

const seedsIn = (s: AyoState): number =>
  s.pits.reduce((x, y) => x + y, 0) + s.stores[0]! + s.stores[1]!;

for (const variant of ['ayo', 'kalah'] as const) {
  describeEngine(E, {
    playerCounts: [2],
    cfg: { variant },
    maxSteps: 3000,
    numRuns: 20,
    candidates: (s) => ayoLegalPits(s).map(sow),
    illegal: (s, by): AyoAction[] => {
      const out: AyoAction[] = [sow(-1), sow(12), sow(3.5)];
      if (E.isTerminal(s)) return [sow(0), sow(6)];
      const other = s.players[s.turn] === by ? ((1 - s.turn) as 0 | 1) : s.turn;
      out.push(sow(other * 6)); // somebody else's pit
      for (let i = 0; i < 12; i++) if (s.pits[i] === 0) out.push(sow(i));
      return out;
    },
  });
}

describe('ayo: setup', () => {
  it('48 seeds in 12 pits, the first player moves, config is checked', () => {
    const s = E.init(['a', 'b'], 1n, {});
    expect(s.variant).toBe('ayo');
    expect(s.pits).toEqual(new Array(12).fill(4));
    expect(E.currentPlayers(s)).toEqual(['a']);
    expect(ayoLegalPits(s)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(() => E.init(['a'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'a'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'b'], 1n, { seeds: 2 })).toThrow();
    expect(() => E.init(['a', 'b'], 1n, { variant: 'oware' as 'ayo' })).toThrow();
    expect(() => E.init(['a', 'b'], 1n, { maxPlies: 3 })).toThrow();
    expect(E.init(['a', 'b'], 1n, { seeds: 3 }).pits[0]).toBe(3);
  });

  it('pit geometry: rows of six, opposite pits sum to 11', () => {
    expect(ayoPitOwner(0)).toBe(0);
    expect(ayoPitOwner(5)).toBe(0);
    expect(ayoPitOwner(6)).toBe(1);
    expect(ayoPitOwner(11)).toBe(1);
    expect(ayoOpposite(0)).toBe(11);
    expect(ayoOpposite(5)).toBe(6);
  });

  it('rejects the wrong player, strangers, foreign, empty and unknown pits', () => {
    const s = mk([0, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4]);
    expect(E.validate(s, 'b', sow(1))).toEqual({ ok: false, code: 'not_your_turn' });
    expect(E.validate(s, 'zed', sow(1))).toEqual({ ok: false, code: 'not_a_player' });
    expect(E.validate(s, 'a', sow(7))).toEqual({ ok: false, code: 'not_your_pit' });
    expect(E.validate(s, 'a', sow(0))).toEqual({ ok: false, code: 'empty_pit' });
    expect(E.validate(s, 'a', sow(12))).toEqual({ ok: false, code: 'no_such_pit' });
    expect(E.validate(s, 'a', sow(-1))).toEqual({ ok: false, code: 'no_such_pit' });
    expect(E.validate(s, 'a', sow(1)).ok).toBe(true);
  });
});

describe('ayo: Ayo Olopon rules', () => {
  it('sows one seed per pit counter-clockwise, and a landing in an occupied pit relays', () => {
    // pit 0 has 2 seeds, pit 2 has 1: the last seed lands in pit 2 (now 2), which is lifted and
    // sown into 3 and 4; pit 4 was empty on the mover's own side, opposite pit 7 holds 5: captured.
    const s0 = mk([2, 0, 1, 0, 0, 0, 0, 5, 0, 0, 0, 1]);
    const s1 = E.apply(s0, 'a', sow(0));
    expect(s1.last?.laps).toEqual([
      { from: 0, path: [1, 2] },
      { from: 2, path: [3, 4] },
    ]);
    expect(s1.pits).toEqual([0, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1]);
    expect(s1.stores).toEqual([5, 0]);
    expect(s1.last?.captured).toBe(5);
    expect(s1.last?.capturedFrom).toBe(7);
    expect(seedsIn(s1)).toBe(seedsIn(s0));
    expect(E.currentPlayers(s1)).toEqual(['b']);
  });

  it('ending in an empty pit on your own side captures the seeds opposite', () => {
    const s0 = mk([2, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 1]);
    const s1 = E.apply(s0, 'a', sow(0));
    expect(s1.stores).toEqual([3, 0]);
    expect(s1.pits).toEqual([0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it('an empty pit opposite means no capture; the turn simply ends', () => {
    const s0 = mk([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    const s1 = E.apply(s0, 'a', sow(0));
    expect(s1.stores).toEqual([0, 0]);
    expect(s1.last?.captured).toBe(0);
    expect(s1.last?.capturedFrom).toBeNull();
  });

  it('ending in an empty pit on the opponent side does not capture', () => {
    const s0 = mk([0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 1]);
    const s1 = E.apply(s0, 'a', sow(5));
    expect(s1.pits.slice(6, 8)).toEqual([1, 1]);
    expect(s1.stores).toEqual([0, 0]);
  });

  it('a pit of twelve or more skips the pit it was lifted from', () => {
    const s0 = mk([12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const s1 = E.apply(s0, 'a', sow(0));
    expect(s1.last?.laps[0]).toEqual({ from: 0, path: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 1] });
    expect(seedsIn(s1)).toBe(12);
  });

  it('wins as soon as a store reaches 25 and the game is over', () => {
    const s0 = mk([2, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 1], { stores: [22, 0] });
    const s1 = E.apply(s0, 'a', sow(0));
    expect(s1.stores[0]).toBe(25);
    expect(s1.winner).toBe('a');
    expect(s1.endReason).toBe('target');
    expect(E.isTerminal(s1)).toBe(true);
    expect(E.currentPlayers(s1)).toEqual([]);
    expect(E.result(s1)).toEqual({ placements: [['a'], ['b']], draw: false });
    expect(E.validate(s1, 'b', sow(11))).toEqual({ ok: false, code: 'game_over' });
  });

  it('when the player to move has no seeds the game ends and each side keeps its own row', () => {
    const s0 = mk([2, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0]);
    const s1 = E.apply(s0, 'a', sow(0));
    // a captured pit 9 (3), leaving b with nothing; a also keeps the two seeds still on its row
    expect(E.isTerminal(s1)).toBe(true);
    expect(s1.endReason).toBe('out_of_seeds');
    expect(s1.stores).toEqual([5, 0]);
    expect(s1.pits).toEqual(new Array(12).fill(0));
    expect(s1.winner).toBe('a');
  });

  it('at the move limit each side keeps its own row; equal totals are a draw', () => {
    const t = mk([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1], { stores: [3, 3], plies: 9, maxPlies: 10 });
    const t1 = E.apply(t, 'a', sow(5)); // lands in pit 6 (empty, opponent side): the turn ends
    expect(t1.endReason).toBe('max_plies');
    expect(t1.stores).toEqual([3, 5]);
    expect(t1.winner).toBe('b');
    const u = mk([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0], { stores: [4, 3], plies: 9, maxPlies: 10 });
    const u1 = E.apply(u, 'a', sow(5)); // the seed ends on b's row, so b keeps it: 4 against 4
    expect(u1.stores).toEqual([4, 4]);
    expect(u1.draw).toBe(true);
    expect(E.result(u1)).toEqual({ placements: [['a', 'b']], draw: true });
  });

  it('resigning gives the win to the opponent at any time', () => {
    const s = E.apply(E.init(['a', 'b'], 1n, {}), 'b', { kind: 'resign' });
    expect(s.winner).toBe('a');
    expect(s.endReason).toBe('resign');
  });

  it('never drops or invents a seed, and every game ends, over many random games', () => {
    for (const variant of ['ayo', 'kalah'] as const) {
      for (let seed = 1; seed <= 60; seed++) {
        const rng = new Rng(BigInt(seed));
        let s = E.init(['a', 'b'], BigInt(seed), { variant });
        let steps = 0;
        while (!E.isTerminal(s)) {
          const legal = ayoLegalPits(s);
          expect(legal.length).toBeGreaterThan(0);
          s = E.apply(s, E.currentPlayers(s)[0]!, sow(legal[rng.int(legal.length)]!));
          expect(seedsIn(s)).toBe(48);
          expect(++steps).toBeLessThanOrEqual(AYO_DEFAULT_MAX_PLIES + 5);
        }
      }
    }
  });
});

describe('mancala: Kalah rules', () => {
  const kalah = (pits: number[], over: Partial<AyoState> = {}): AyoState =>
    mk(pits, over, { variant: 'kalah' });

  it('a last seed in your own store gives another turn', () => {
    const s0 = E.init(['a', 'b'], 1n, { variant: 'kalah' });
    const s1 = E.apply(s0, 'a', sow(2));
    expect(s1.pits.slice(0, 6)).toEqual([4, 4, 0, 5, 5, 5]);
    expect(s1.stores).toEqual([1, 0]);
    expect(E.currentPlayers(s1)).toEqual(['a']);
    expect(s1.last?.extraTurn).toBe(true);
    expect(s1.last?.laps[0]?.path).toEqual([3, 4, 5, -1]);
  });

  it('a lap skips the opponent store and does not skip the pit it started from', () => {
    const s0 = kalah([4, 4, 4, 4, 4, 10, 4, 4, 4, 4, 4, 4]);
    const s1 = E.apply(s0, 'a', sow(5));
    // store, 6..11, then (skipping b's store) pits 0, 1 and 2
    expect(s1.stores).toEqual([1, 0]);
    expect(s1.pits).toEqual([5, 5, 5, 4, 4, 0, 5, 5, 5, 5, 5, 5]);
    expect(seedsIn(s1)).toBe(seedsIn(s0));
  });

  it('player two drops into their own store and then crosses to the first row, skipping the other store', () => {
    const s0 = kalah([4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 3], { turn: 1 });
    const s1 = E.apply(s0, 'b', sow(11));
    expect(s1.stores).toEqual([0, 1]);
    expect(s1.pits.slice(0, 2)).toEqual([5, 5]);
    expect(s1.last?.laps[0]?.path).toEqual([-1, 0, 1]);
    expect(E.currentPlayers(s1)).toEqual(['a']);
  });

  it('a last seed in an empty pit of yours captures the opposite pit plus that seed', () => {
    const s0 = kalah([1, 0, 4, 4, 4, 4, 4, 4, 4, 4, 5, 4]);
    const s1 = E.apply(s0, 'a', sow(0));
    expect(s1.stores).toEqual([6, 0]); // 5 opposite + the capturing seed
    expect(s1.pits[1]).toBe(0);
    expect(s1.pits[10]).toBe(0);
    expect(s1.last?.captured).toBe(6);
    expect(s1.last?.capturedFrom).toBe(10);
    expect(E.currentPlayers(s1)).toEqual(['b']);
  });

  it('no capture when the opposite pit is empty', () => {
    const s0 = kalah([1, 0, 4, 4, 4, 4, 4, 4, 4, 4, 0, 4]);
    const s1 = E.apply(s0, 'a', sow(0));
    expect(s1.stores).toEqual([0, 0]);
    expect(s1.pits[1]).toBe(1);
  });

  it('landing in an empty pit on the opponent side does nothing special', () => {
    const s0 = kalah([4, 4, 4, 4, 4, 2, 0, 4, 4, 4, 4, 4]);
    const s1 = E.apply(s0, 'a', sow(5));
    expect(s1.stores).toEqual([1, 0]);
    expect(s1.pits[6]).toBe(1);
    expect(E.currentPlayers(s1)).toEqual(['b']);
  });

  it('when one side runs out the other player banks what is left on their row', () => {
    const s0 = kalah([0, 0, 0, 0, 0, 1, 3, 0, 2, 0, 0, 1], { stores: [20, 15] });
    const s1 = E.apply(s0, 'a', sow(5)); // straight into the store: extra turn, but a's row is empty
    expect(E.isTerminal(s1)).toBe(true);
    expect(s1.endReason).toBe('out_of_seeds');
    expect(s1.stores).toEqual([21, 21]);
    expect(s1.draw).toBe(true);
  });

  it('first to 25 ends the game early', () => {
    const s0 = kalah([0, 0, 0, 0, 0, 1, 3, 3, 3, 3, 3, 3], { stores: [24, 0] });
    const s1 = E.apply(s0, 'a', sow(5));
    expect(s1.stores[0]).toBe(25);
    expect(s1.winner).toBe('a');
    expect(s1.endReason).toBe('target');
  });
});

describe('ayo: wire format, view, immutability', () => {
  it('validates wire actions with zod', () => {
    expect(ayoActionSchema.safeParse(sow(0)).success).toBe(true);
    expect(ayoActionSchema.safeParse(sow(11)).success).toBe(true);
    expect(ayoActionSchema.safeParse({ kind: 'resign' }).success).toBe(true);
    expect(ayoActionSchema.safeParse(sow(12)).success).toBe(false);
    expect(ayoActionSchema.safeParse(sow(-1)).success).toBe(false);
    expect(ayoActionSchema.safeParse({ kind: 'sow', pit: 1.5 }).success).toBe(false);
    expect(ayoActionSchema.safeParse({ kind: 'steal' }).success).toBe(false);
  });

  it('has no hidden information: every viewer gets the same board and the mover legal pits', () => {
    const s = E.init(['a', 'b'], 1n, {});
    const va = E.view(s, 'a') as Record<string, unknown>;
    expect(va).toEqual(E.view(s, 'b'));
    expect(va).toEqual(E.view(s, 'spectator'));
    expect(va.legal).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('apply does not mutate the input', () => {
    const s = E.init(['a', 'b'], 1n, {});
    const before = JSON.stringify(s);
    E.apply(s, 'a', sow(3));
    expect(JSON.stringify(s)).toBe(before);
  });

  it('is deterministic: the same moves always end in the same state', () => {
    const play = (): AyoState => {
      let s = E.init(['a', 'b'], 77n, {});
      for (let i = 0; i < 40 && !E.isTerminal(s); i++) {
        const legal = ayoLegalPits(s);
        s = E.apply(s, E.currentPlayers(s)[0]!, sow(legal[i % legal.length]!));
      }
      return s;
    };
    expect(play()).toEqual(play());
  });
});
