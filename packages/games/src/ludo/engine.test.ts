import { nextInt, seedRng } from '../rng.ts';
import { describeEngine } from '../testing/engineHarness.ts';
import {
  LUDO_HOME,
  LUDO_SAFE,
  ludoActionSchema,
  ludoAutoAction,
  ludoEngine as E,
  ludoMovableTokens,
  ludoRingSquare,
  ludoTarget,
  type LudoAction,
  type LudoCfg,
  type LudoState,
} from './engine.ts';

const roll: LudoAction = { kind: 'roll' };
const move = (token: number): LudoAction => ({ kind: 'move', token });

/** A seed whose first die is `d`. */
function seedFor(d: number): bigint {
  for (let seed = 0n; seed < 500n; seed++) {
    if (nextInt(seedRng(seed), 6)[0] + 1 === d) return seed;
  }
  throw new Error('no seed');
}

/** A hand-built position where the next roll will be `d`. */
function mk(
  tokens: number[][],
  d: number,
  over: Partial<LudoState> = {},
  cfg: LudoCfg = {},
  players: string[] = ['a', 'b'],
): LudoState {
  const base = E.init(players, seedFor(d), { tokens: tokens[0]!.length, ...cfg });
  return { ...base, tokens, ...over };
}

const play = (s: LudoState, by: string, ...acts: LudoAction[]): LudoState =>
  acts.reduce((cur, a) => {
    const v = E.validate(cur, by, a);
    if (!v.ok) throw new Error(`setup move rejected: ${JSON.stringify(a)} ${v.code}`);
    return E.apply(cur, by, a);
  }, s);

describeEngine(E, {
  playerCounts: [2, 3, 4],
  cfg: { tokens: 2 },
  maxSteps: 20000,
  numRuns: 25,
  candidates: (s, by) => {
    if (s.players[s.turn] !== by) return [];
    return s.phase === 'roll' ? [roll] : [0, 1, 2, 3].map(move);
  },
  illegal: (s, by): LudoAction[] => {
    if (E.isTerminal(s)) return [roll, move(0)];
    const out: LudoAction[] = [move(9), move(-1), move(1.5)];
    if (s.players[s.turn] !== by) out.push(roll, move(0));
    else out.push(s.phase === 'roll' ? move(0) : roll);
    return out;
  },
});

describeEngine(E, {
  playerCounts: [3, 4],
  cfg: { tokens: 1, rankAll: true },
  maxSteps: 20000,
  numRuns: 20,
  candidates: (s, by) => {
    if (s.players[s.turn] !== by) return [];
    return s.phase === 'roll' ? [roll] : [move(0)];
  },
});

describe('ludo: setup', () => {
  it('two to four players, four yard tokens each, seats spread round the ring', () => {
    const s2 = E.init(['a', 'b'], 1n, {});
    expect(s2.tokens).toEqual([new Array(4).fill(-1), new Array(4).fill(-1)]);
    expect(s2.starts).toEqual([0, 26]);
    expect(E.init(['a', 'b', 'c'], 1n, {}).starts).toEqual([0, 13, 26]);
    expect(E.init(['a', 'b', 'c', 'd'], 1n, {}).starts).toEqual([0, 13, 26, 39]);
    expect(E.currentPlayers(s2)).toEqual(['a']);
    expect(s2.phase).toBe('roll');
  });

  it('rejects bad player counts, duplicates and config', () => {
    expect(() => E.init(['a'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'b', 'c', 'd', 'e'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'a'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'b'], 1n, { tokens: 0 })).toThrow();
    expect(() => E.init(['a', 'b'], 1n, { tokens: 5 })).toThrow();
    expect(E.init(['a', 'b'], 1n, { tokens: 2 }).tokens[0]).toHaveLength(2);
  });

  it('the dice come from the seeded RNG, in order, and never from the client', () => {
    const seed = 424242n;
    let s = E.init(['a', 'b'], seed, {});
    let rng = seedRng(seed);
    for (let i = 0; i < 40 && !E.isTerminal(s); i++) {
      const by = E.currentPlayers(s)[0]!;
      const act: LudoAction =
        s.phase === 'roll' ? roll : move((E.view(s, by) as { legal: number[] }).legal[0]!);
      const before = s;
      s = E.apply(s, by, act);
      if (act.kind === 'roll') {
        const [r, next] = nextInt(rng, 6);
        rng = next;
        expect(s.last && 'dice' in s.last ? s.last.dice : -1).toBe(r + 1);
        expect(before.phase).toBe('roll');
      }
    }
  });
});

describe('ludo: turn flow', () => {
  it('rejects out of turn, strangers, a move before a roll and a roll before a move', () => {
    const s0 = mk(
      [
        [-1, -1, -1, -1],
        [-1, -1, -1, -1],
      ],
      6,
    );
    expect(E.validate(s0, 'b', roll)).toEqual({ ok: false, code: 'not_your_turn' });
    expect(E.validate(s0, 'zed', roll)).toEqual({ ok: false, code: 'not_a_player' });
    expect(E.validate(s0, 'a', move(0))).toEqual({ ok: false, code: 'must_roll' });
    const s1 = E.apply(s0, 'a', roll);
    expect(s1.phase).toBe('move');
    expect(E.validate(s1, 'a', roll)).toEqual({ ok: false, code: 'must_move' });
    expect(E.validate(s1, 'a', move(7))).toEqual({ ok: false, code: 'no_such_token' });
  });

  it('a roll nothing can use passes the turn on the spot', () => {
    const s0 = mk(
      [
        [-1, -1, -1, -1],
        [-1, -1, -1, -1],
      ],
      4,
    );
    const s1 = E.apply(s0, 'a', roll);
    expect(s1.last).toEqual({ kind: 'pass', by: 'a', dice: 4, reason: 'no_move' });
    expect(E.currentPlayers(s1)).toEqual(['b']);
    expect(s1.phase).toBe('roll');
    expect(s1.dice).toBeNull();
  });

  it('a six leaves the yard onto the start square and earns another roll', () => {
    const s0 = mk(
      [
        [-1, -1, -1, -1],
        [-1, -1, -1, -1],
      ],
      6,
    );
    const s1 = play(s0, 'a', roll);
    expect(s1.dice).toBe(6);
    expect(E.view(s1, 'a')).toMatchObject({ legal: [0, 1, 2, 3] });
    const s2 = E.apply(s1, 'a', move(2));
    expect(s2.tokens[0]).toEqual([-1, -1, 0, -1]);
    expect(E.currentPlayers(s2)).toEqual(['a']);
    expect(s2.phase).toBe('roll');
    expect(s2.sixes).toBe(1);
  });

  it('a token in the yard cannot move on anything but a six', () => {
    const s0 = mk(
      [
        [-1, 20, -1, -1],
        [-1, -1, -1, -1],
      ],
      3,
    );
    const s1 = E.apply(s0, 'a', roll);
    expect(E.validate(s1, 'a', move(0))).toEqual({ ok: false, code: 'cannot_move' });
    expect(E.validate(s1, 'a', move(1)).ok).toBe(true);
    const s2 = E.apply(s1, 'a', move(1));
    expect(s2.tokens[0]![1]).toBe(23);
    expect(E.currentPlayers(s2)).toEqual(['b']); // not a six: the turn passes
  });

  it('three sixes in a row pass the turn without a move', () => {
    const s0 = mk(
      [
        [5, -1, -1, -1],
        [-1, -1, -1, -1],
      ],
      6,
      { sixes: 2 },
    );
    const s1 = E.apply(s0, 'a', roll);
    expect(s1.last).toEqual({ kind: 'pass', by: 'a', dice: 6, reason: 'three_sixes' });
    expect(s1.tokens[0]).toEqual([5, -1, -1, -1]);
    expect(E.currentPlayers(s1)).toEqual(['b']);
    expect(s1.sixes).toBe(0);
  });

  it('does not mutate its input', () => {
    const s0 = mk(
      [
        [-1, -1, -1, -1],
        [-1, -1, -1, -1],
      ],
      6,
    );
    const before = JSON.stringify(s0);
    const s1 = E.apply(s0, 'a', roll);
    E.apply(s1, 'a', move(0));
    expect(JSON.stringify(s0)).toBe(before);
  });
});

describe('ludo: movement, captures and home', () => {
  it('ring squares follow the seat start; the home column is off the ring', () => {
    expect(ludoRingSquare(26, 0)).toBe(26);
    expect(ludoRingSquare(26, 30)).toBe(4);
    expect(ludoRingSquare(0, 50)).toBe(50);
    expect(ludoRingSquare(0, 51)).toBeNull();
    expect(ludoRingSquare(0, LUDO_HOME)).toBeNull();
    expect(ludoRingSquare(0, -1)).toBeNull();
  });

  it('exact count to get home: overshooting is not a move', () => {
    expect(ludoTarget(54, 2)).toBe(LUDO_HOME);
    expect(ludoTarget(54, 3)).toBeNull();
    expect(ludoTarget(LUDO_HOME, 1)).toBeNull();
    expect(ludoTarget(-1, 6)).toBe(0);
    expect(ludoTarget(-1, 5)).toBeNull();
    const s = mk(
      [
        [54, 10, -1, -1],
        [-1, -1, -1, -1],
      ],
      3,
    );
    expect(ludoMovableTokens(s, 0, 3)).toEqual([1]);
  });

  it('landing on a lone opponent token sends it back to the yard', () => {
    // a (start 0) at progress 10 moves 2 to abs 12; b (start 26) at progress 38 is on abs 12.
    const s0 = mk(
      [
        [10, -1, -1, -1],
        [38, -1, -1, -1],
      ],
      2,
    );
    const s2 = play(s0, 'a', roll, move(0));
    expect(s2.tokens[0]![0]).toBe(12);
    expect(s2.tokens[1]).toEqual([-1, -1, -1, -1]);
    expect(s2.last).toMatchObject({
      kind: 'move',
      captured: [{ player: 'b', token: 0 }],
    });
  });

  it('every opponent token on the square goes home to the yard', () => {
    const s0 = mk(
      [
        [10, -1, -1, -1],
        [38, 38, -1, -1],
      ],
      2,
    );
    const s2 = play(s0, 'a', roll, move(0));
    expect(s2.tokens[1]).toEqual([-1, -1, -1, -1]);
    expect((s2.last as { captured: unknown[] }).captured).toHaveLength(2);
  });

  it('safe squares (starts and stars) are never captured on and can be shared', () => {
    for (const sq of LUDO_SAFE) {
      // a at progress `sq - 2`, b standing on ring square sq (progress sq - 26 mod 52).
      const bp = (sq - 26 + 52) % 52;
      if (bp > 50) continue;
      const ap = sq - 2;
      if (ap < 0) continue;
      const s0 = mk(
        [
          [ap, -1, -1, -1],
          [bp, -1, -1, -1],
        ],
        2,
      );
      const s2 = play(s0, 'a', roll, move(0));
      expect(s2.tokens[0]![0]).toBe(ap + 2);
      expect(s2.tokens[1]![0]).toBe(bp);
    }
  });

  it('your own tokens stack and never capture each other', () => {
    const s0 = mk(
      [
        [10, 12, -1, -1],
        [-1, -1, -1, -1],
      ],
      2,
    );
    const s2 = play(s0, 'a', roll, move(0));
    expect(s2.tokens[0]).toEqual([12, 12, -1, -1]);
  });

  it('a token in the home column cannot be captured', () => {
    // b's token is at progress 51 (its home column); a lands on every ring square without effect.
    const s0 = mk(
      [
        [10, -1, -1, -1],
        [51, -1, -1, -1],
      ],
      2,
    );
    const s2 = play(s0, 'a', roll, move(0));
    expect(s2.tokens[1]![0]).toBe(51);
  });

  it('a capture earns no extra turn by itself', () => {
    const s0 = mk(
      [
        [10, -1, -1, -1],
        [38, -1, -1, -1],
      ],
      2,
    );
    const s2 = play(s0, 'a', roll, move(0));
    expect(E.currentPlayers(s2)).toEqual(['b']);
  });

  it('a six that captures also earns the usual extra roll', () => {
    const s0 = mk(
      [
        [10, -1, -1, -1],
        [42, -1, -1, -1],
      ],
      6,
    );
    // a: progress 10 + 6 = 16 -> abs 16; b token at progress 42 -> abs (26 + 42) % 52 = 16
    const s2 = play(s0, 'a', roll, move(0));
    expect(s2.tokens[1]![0]).toBe(-1);
    expect(E.currentPlayers(s2)).toEqual(['a']);
  });
});

describe('ludo: winning and placements', () => {
  it('the first player to bring every token home wins', () => {
    const s0 = mk([[55], [20]], 1, {}, { tokens: 1 });
    const s2 = play(s0, 'a', roll, move(0));
    expect(s2.tokens[0]).toEqual([LUDO_HOME]);
    expect(E.isTerminal(s2)).toBe(true);
    expect(E.currentPlayers(s2)).toEqual([]);
    expect(E.result(s2)).toEqual({ placements: [['a'], ['b']], draw: false });
    expect(E.validate(s2, 'b', roll)).toEqual({ ok: false, code: 'game_over' });
  });

  it('others are ranked by progress, ties share a place', () => {
    const s0 = mk([[55], [30], [10], [10]], 1, {}, { tokens: 1 }, ['a', 'b', 'c', 'd']);
    const s2 = play(s0, 'a', roll, move(0));
    expect(E.result(s2).placements).toEqual([['a'], ['b'], ['c', 'd']]);
  });

  it('with rankAll the game plays on until one player is left', () => {
    const s0 = mk([[55], [55], [10]], 1, {}, { tokens: 1, rankAll: true }, ['a', 'b', 'c']);
    const s1 = play(s0, 'a', roll, move(0));
    expect(E.isTerminal(s1)).toBe(false);
    expect(s1.finished).toEqual(['a']);
    expect(E.currentPlayers(s1)).toEqual(['b']); // finished players are skipped from now on
    const s2 = play(s1, 'b', roll);
    expect(s2.last).toMatchObject({ by: 'b' });
  });

  it('with rankAll, finishing second ends it and places the last player last', () => {
    const s0 = mk([[55], [55], [10]], 1, {}, { tokens: 1, rankAll: true }, ['a', 'b', 'c']);
    let s = play(s0, 'a', roll, move(0));
    // b's roll is whatever the seed gives, so put the game on a finishing roll for b
    s = { ...s, turn: 1, phase: 'roll', dice: null, sixes: 0, rng: seedRng(seedFor(1)) };
    s = play(s, 'b', roll, move(0));
    expect(E.isTerminal(s)).toBe(true);
    expect(E.result(s).placements).toEqual([['a'], ['b'], ['c']]);
  });

  it('skips finished players when passing the turn', () => {
    const s0 = mk([[55], [55], [10]], 1, {}, { tokens: 1, rankAll: true }, ['a', 'b', 'c']);
    const s1 = play(s0, 'a', roll, move(0));
    const s2 = { ...s1, turn: 1, rng: seedRng(seedFor(1)) };
    const s3 = play(s2, 'b', roll, move(0));
    expect(s3.finished).toEqual(['a', 'b']);
    expect(E.isTerminal(s3)).toBe(true);
  });
});

describe('ludo: resigning', () => {
  it('in a two player game the other player wins', () => {
    const s0 = E.init(['a', 'b'], 1n, {});
    const s1 = E.apply(s0, 'b', { kind: 'resign' });
    expect(E.isTerminal(s1)).toBe(true);
    expect(E.result(s1)).toEqual({ placements: [['a'], ['b']], draw: false });
    expect(E.validate(s1, 'a', { kind: 'resign' })).toEqual({ ok: false, code: 'game_over' });
  });

  it('in a bigger game the leaver is out, the turn passes on and they rank last', () => {
    const s0 = E.init(['a', 'b', 'c'], 1n, {});
    const s1 = E.apply(s0, 'a', { kind: 'resign' }); // a was to move
    expect(E.isTerminal(s1)).toBe(false);
    expect(E.currentPlayers(s1)).toEqual(['b']);
    expect(E.validate(s1, 'a', { kind: 'resign' })).toEqual({ ok: false, code: 'not_in_game' });
    expect(E.validate(s1, 'a', roll)).toEqual({ ok: false, code: 'not_your_turn' });
    const s2 = E.apply(s1, 'c', { kind: 'resign' }); // not c's turn; allowed
    expect(E.isTerminal(s2)).toBe(true);
    expect(E.result(s2).placements).toEqual([['b'], ['c'], ['a']]); // later leavers above earlier ones
  });

  it('a leaver never gets skipped back in, and their tokens are not capture targets', () => {
    const s0 = mk(
      [
        [10, -1],
        [-1, -1],
        [38, -1],
      ],
      2,
      {},
      { tokens: 2 },
      ['a', 'b', 'c'],
    );
    // c's token sits on ring square (26 + 38) % 52 = 12, which a would capture; once c is out, no capture
    const s1 = { ...s0, out: ['c'] };
    const s2 = play(s1, 'a', roll, move(0));
    expect(s2.tokens[2]![0]).toBe(38);
  });
});

describe('ludo: wire format and view', () => {
  it('validates wire actions with zod', () => {
    expect(ludoActionSchema.safeParse(roll).success).toBe(true);
    expect(ludoActionSchema.safeParse(move(3)).success).toBe(true);
    expect(ludoActionSchema.safeParse({ kind: 'resign' }).success).toBe(true);
    expect(ludoActionSchema.safeParse(move(4)).success).toBe(false);
    expect(ludoActionSchema.safeParse({ kind: 'roll', dice: 6 }).success).toBe(true); // extra keys are stripped, never read
    expect(ludoActionSchema.parse({ kind: 'roll', dice: 6 })).toEqual({ kind: 'roll' });
    expect(ludoActionSchema.safeParse({ kind: 'move', token: -1 }).success).toBe(false);
  });

  it('never reveals the RNG state to anyone (it would predict future rolls)', () => {
    const s = E.init(['a', 'b'], 1n, {});
    for (const v of ['a', 'b', 'spectator'] as const) {
      expect(E.view(s, v)).not.toHaveProperty('rng');
    }
    expect(JSON.stringify(E.view(s, 'a'))).not.toContain(JSON.stringify(s.rng));
  });

  it('the same seed and moves always give the same game', () => {
    const run = (): LudoState => {
      let s = E.init(['a', 'b', 'c'], 99n, {});
      for (let i = 0; i < 300 && !E.isTerminal(s); i++) {
        const by = E.currentPlayers(s)[0]!;
        const legal = (E.view(s, by) as { legal: number[] }).legal;
        s = E.apply(s, by, s.phase === 'roll' ? roll : move(legal[0]!));
      }
      return s;
    };
    expect(run()).toEqual(run());
  });
});

describe('ludo: auto play (timeouts and bots)', () => {
  it('rolls when it is time to roll', () => {
    expect(ludoAutoAction(E.init(['a', 'b'], 1n, {}), 'a')).toEqual({ kind: 'roll' });
  });

  it('prefers a capture, then going home, then leaving the yard, then the furthest token', () => {
    const capture = play(
      mk(
        [
          [10, 30, -1, -1],
          [38, -1, -1, -1],
        ],
        2,
      ),
      'a',
      roll,
    );
    expect(ludoAutoAction(capture, 'a')).toEqual({ kind: 'move', token: 0 });
    const home = play(
      mk(
        [
          [20, 54, -1, -1],
          [-1, -1, -1, -1],
        ],
        2,
      ),
      'a',
      roll,
    );
    expect(ludoAutoAction(home, 'a')).toEqual({ kind: 'move', token: 1 });
    const leave = play(
      mk(
        [
          [20, -1, -1, -1],
          [-1, -1, -1, -1],
        ],
        6,
      ),
      'a',
      roll,
    );
    expect(ludoAutoAction(leave, 'a')).toEqual({ kind: 'move', token: 1 });
    const far = play(
      mk(
        [
          [20, 30, 5, -1],
          [-1, -1, -1, -1],
        ],
        3,
      ),
      'a',
      roll,
    );
    expect(ludoAutoAction(far, 'a')).toEqual({ kind: 'move', token: 1 });
  });

  it('always produces a legal action, so a whole game can be auto-played', () => {
    for (let seed = 1n; seed <= 6n; seed++) {
      let s = E.init(['a', 'b', 'c'], seed, { tokens: 2 });
      for (let i = 0; i < 4000 && !E.isTerminal(s); i++) {
        const by = E.currentPlayers(s)[0]!;
        const act = ludoAutoAction(s, by);
        expect(E.validate(s, by, act).ok).toBe(true);
        s = E.apply(s, by, act);
      }
      expect(E.isTerminal(s)).toBe(true);
    }
  });
});
