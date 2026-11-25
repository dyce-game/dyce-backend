import { seedRng } from '../rng.ts';
import { describeEngine } from '../testing/engineHarness.ts';
import {
  SEA_FLEET,
  SEA_SIZE,
  seaBattleActionSchema,
  seaBattleCheckPlacement,
  seaBattleEngine as E,
  seaBattleRandomPlacement,
  seaBattleShotsAllowed,
  seaShipCells,
  type SeaBattleAction,
  type SeaBattleState,
  type SeaShipPlacement,
} from './engine.ts';

/** Ships in rows 0, 2, 4, 6, 8 starting at column 0. */
const ROWS: SeaShipPlacement[] = [0, 2, 4, 6, 8].map((r) => ({ r, c: 0, dir: 'h' as const }));
/** Ships down columns 9, 7, 5, 3, 1 starting at row 0. */
const COLS: SeaShipPlacement[] = [9, 7, 5, 3, 1].map((c) => ({ r: 0, c, dir: 'v' as const }));

const place = (ships: SeaShipPlacement[]): SeaBattleAction => ({ kind: 'place', ships });
const fire = (...cells: [number, number][]): SeaBattleAction => ({
  kind: 'fire',
  shots: cells.map(([r, c]) => ({ r, c })),
});

/** Both players place (a: ROWS, b: COLS); `first` seat will fire first if given. */
function ready(cfg = {}, first: 0 | 1 = 0): SeaBattleState {
  let s = E.init(['a', 'b'], 1n, cfg);
  s = E.apply(s, 'a', place(ROWS));
  s = E.apply(s, 'b', place(COLS));
  return { ...s, turn: first };
}

const someRandom = (k: number): SeaBattleAction =>
  place(seaBattleRandomPlacement(seedRng(BigInt(k))));

function unshot(s: SeaBattleState, by: string): [number, number][] {
  const seat = s.players.indexOf(by);
  const out: [number, number][] = [];
  const done = new Set(s.shots[seat]);
  for (let r = 0; r < s.size; r++) {
    for (let c = 0; c < s.size; c++) if (!done.has(r * s.size + c)) out.push([r, c]);
  }
  return out;
}

for (const salvo of [false, true]) {
  describeEngine(E, {
    playerCounts: [2],
    cfg: { salvo },
    maxSteps: 600,
    numRuns: 12,
    candidates: (s, by) => {
      if (s.phase === 'placing') return [1, 2, 3, 4, 5, 6].map(someRandom);
      if (s.phase !== 'battle' || s.players[s.turn] !== by) return [];
      const k = seaBattleShotsAllowed(s, s.turn);
      const cells = unshot(s, by);
      return [0, 7, 13, 31].map((o) => {
        const start = o % Math.max(1, cells.length - k + 1);
        return fire(...cells.slice(start, start + k));
      });
    },
    illegal: (s, by): SeaBattleAction[] => {
      if (E.isTerminal(s)) return [fire([0, 0]), place(ROWS)];
      const out: SeaBattleAction[] = [fire([-1, 0]), fire([0, 10]), fire()];
      if (s.phase === 'placing') {
        out.push(fire([0, 0]));
        if (s.fleets[s.players.indexOf(by)] !== null) out.push(place(ROWS));
      } else {
        out.push(place(ROWS));
        if (s.players[s.turn] !== by) out.push(fire([0, 0]));
        else {
          const seat = s.players.indexOf(by);
          const done = s.shots[seat]![0];
          if (done !== undefined) out.push(fire([Math.floor(done / s.size), done % s.size]));
        }
      }
      return out;
    },
  });
}

describe('sea battle: placement', () => {
  const s0 = E.init(['a', 'b'], 1n, {});

  it('both players place at once; neither can see the other layout', () => {
    expect(E.currentPlayers(s0)).toEqual(['a', 'b']);
    const s1 = E.apply(s0, 'b', place(COLS));
    expect(E.currentPlayers(s1)).toEqual(['a']);
    expect(s1.phase).toBe('placing');
    const s2 = E.apply(s1, 'a', place(ROWS));
    expect(s2.phase).toBe('battle');
    expect(E.currentPlayers(s2)).toEqual([s2.players[s2.turn]]);
  });

  it('a seed decides who fires first, and both seats get a turn over many seeds', () => {
    const firsts = new Set<number>();
    for (let seed = 0n; seed < 40n; seed++) firsts.add(E.init(['a', 'b'], seed, {}).turn);
    expect(firsts).toEqual(new Set([0, 1]));
    expect(E.init(['a', 'b'], 5n, {}).turn).toBe(E.init(['a', 'b'], 5n, {}).turn);
  });

  it('fleet is carrier 5, battleship 4, cruiser 3, submarine 3, destroyer 2 on 10 x 10', () => {
    expect(SEA_SIZE).toBe(10);
    expect(SEA_FLEET.map((f) => f.len)).toEqual([5, 4, 3, 3, 2]);
  });

  it('rejects a wrong fleet, off-board, overlapping and bad ships with a reason', () => {
    expect(E.validate(s0, 'a', place(ROWS.slice(0, 4)))).toEqual({
      ok: false,
      code: 'wrong_fleet',
    });
    const off = ROWS.map((p, i) => (i === 0 ? { ...p, c: 6 } : p)); // carrier at col 6..10
    expect(E.validate(s0, 'a', place(off))).toEqual({ ok: false, code: 'out_of_bounds' });
    const offV = ROWS.map((p, i) => (i === 1 ? { r: 7, c: 0, dir: 'v' as const } : p)); // battleship rows 7..10
    expect(E.validate(s0, 'a', place(offV))).toEqual({ ok: false, code: 'out_of_bounds' });
    const neg = ROWS.map((p, i) => (i === 2 ? { ...p, r: -1 } : p));
    expect(E.validate(s0, 'a', place(neg))).toEqual({ ok: false, code: 'out_of_bounds' });
    const overlap = ROWS.map((p, i) => (i === 1 ? { ...p, r: 0 } : p));
    expect(E.validate(s0, 'a', place(overlap))).toEqual({ ok: false, code: 'overlap' });
    const frac = ROWS.map((p, i) => (i === 3 ? { ...p, r: 6.5 } : p));
    expect(E.validate(s0, 'a', place(frac))).toEqual({ ok: false, code: 'bad_ship' });
    expect(E.validate(s0, 'zed', place(ROWS))).toEqual({ ok: false, code: 'not_a_player' });
    expect(E.validate(s0, 'a', place(ROWS)).ok).toBe(true);
  });

  it('ships may touch each other, but you cannot place twice or fire before the battle', () => {
    const touching: SeaShipPlacement[] = [0, 1, 2, 3, 4].map((r) => ({
      r,
      c: 0,
      dir: 'h' as const,
    }));
    expect(E.validate(s0, 'a', place(touching)).ok).toBe(true);
    const s1 = E.apply(s0, 'a', place(ROWS));
    expect(E.validate(s1, 'a', place(ROWS))).toEqual({ ok: false, code: 'already_placed' });
    expect(E.validate(s1, 'a', fire([0, 0]))).toEqual({ ok: false, code: 'still_placing' });
    expect(E.validate(s1, 'b', fire([0, 0]))).toEqual({ ok: false, code: 'still_placing' });
  });

  it('cannot re-place once the battle has begun', () => {
    expect(E.validate(ready(), 'a', place(COLS))).toEqual({ ok: false, code: 'not_placing' });
  });

  it('random layouts are always legal, always the full fleet and differ between seeds', () => {
    const seen = new Set<string>();
    for (let k = 0; k < 200; k++) {
      const p = seaBattleRandomPlacement(seedRng(BigInt(k)));
      expect(seaBattleCheckPlacement(p).ok).toBe(true);
      seen.add(JSON.stringify(p));
    }
    expect(seen.size).toBeGreaterThan(150);
    expect(JSON.stringify(seaBattleRandomPlacement(seedRng(7n)))).toBe(
      JSON.stringify(seaBattleRandomPlacement(seedRng(7n))),
    );
  });

  it('ship cells run right for h and down for v', () => {
    expect(seaShipCells({ r: 2, c: 3, dir: 'h', len: 3 })).toEqual([23, 24, 25]);
    expect(seaShipCells({ r: 2, c: 3, dir: 'v', len: 3 })).toEqual([23, 33, 43]);
  });
});

describe('sea battle: firing', () => {
  it('only the player whose turn it is may fire, and the turn passes after any shot', () => {
    const s = ready({}, 0);
    expect(E.validate(s, 'b', fire([0, 0]))).toEqual({ ok: false, code: 'not_your_turn' });
    const s1 = E.apply(s, 'a', fire([0, 9])); // a hits b's carrier (column 9, row 0)
    expect(s1.last?.shots).toEqual([{ cell: 9, result: 'hit', ship: null }]);
    expect(E.currentPlayers(s1)).toEqual(['b']); // no extra shot for a hit
    const s2 = E.apply(s1, 'b', fire([5, 5])); // a's ships sit on even rows: row 5 is empty water
    expect(s2.last?.shots[0]).toEqual({ cell: 55, result: 'miss', ship: null });
    expect(E.currentPlayers(s2)).toEqual(['a']);
  });

  it('rejects repeated, off-board and miscounted shots', () => {
    const s = E.apply(ready(), 'a', fire([0, 0]));
    const s2 = E.apply(s, 'b', fire([1, 1]));
    expect(E.validate(s2, 'a', fire([0, 0]))).toEqual({ ok: false, code: 'already_fired' });
    expect(E.validate(s2, 'a', fire([10, 0]))).toEqual({ ok: false, code: 'out_of_bounds' });
    expect(E.validate(s2, 'a', fire([0, -1]))).toEqual({ ok: false, code: 'out_of_bounds' });
    expect(E.validate(s2, 'a', fire([0.5, 1]))).toEqual({ ok: false, code: 'out_of_bounds' });
    expect(E.validate(s2, 'a', fire([2, 2], [3, 3]))).toEqual({
      ok: false,
      code: 'wrong_shot_count',
    });
    expect(E.validate(s2, 'a', { kind: 'fire', shots: [] })).toEqual({
      ok: false,
      code: 'wrong_shot_count',
    });
    expect(E.validate(s2, 'a', fire([2, 2])).ok).toBe(true);
    // the other player's earlier shot at the same cell does not count against me
    expect(E.validate(s2, 'a', fire([1, 1])).ok).toBe(true);
  });

  it('reports a sunk ship once its last cell is hit', () => {
    // b's destroyer (length 2) is on column 1, rows 0-1.
    let s = ready({}, 0);
    s = E.apply(s, 'a', fire([0, 1]));
    expect(s.last?.shots[0]?.result).toBe('hit');
    s = E.apply(s, 'b', fire([5, 5]));
    s = E.apply(s, 'a', fire([1, 1]));
    expect(s.last?.shots[0]).toEqual({ cell: 11, result: 'sunk', ship: 'destroyer' });
    const view = E.view(s, 'a') as {
      boards: Record<string, { sunk: { id: string }[]; shipsLeft: number }>;
    };
    expect(view.boards.b!.sunk.map((x) => x.id)).toEqual(['destroyer']);
    expect(view.boards.b!.shipsLeft).toBe(4);
  });

  it('sinking the whole fleet wins and reveals every layout', () => {
    let s = ready({}, 0);
    const bCells = SEA_FLEET.flatMap((f, i) => seaShipCells({ ...COLS[i]!, len: f.len }));
    let miss = 0;
    for (const cell of bCells) {
      s = E.apply(s, 'a', fire([Math.floor(cell / 10), cell % 10]));
      if (E.isTerminal(s)) break;
      // b wastes a shot on a harmless cell in column 8 (empty in a's layout: rows hold ships from col 0..4)
      s = E.apply(s, 'b', fire([Math.floor(miss / 5) * 2 + 1, 5 + (miss % 5)]));
      miss++;
    }
    expect(E.isTerminal(s)).toBe(true);
    expect(s.winner).toBe('a');
    expect(s.endReason).toBe('sunk');
    expect(E.currentPlayers(s)).toEqual([]);
    expect(E.result(s)).toEqual({ placements: [['a'], ['b']], draw: false });
    expect(E.validate(s, 'b', fire([9, 9]))).toEqual({ ok: false, code: 'game_over' });
    const spectator = E.view(s, 'spectator') as {
      boards: Record<string, { ships: unknown[] | null }>;
    };
    expect(spectator.boards.a!.ships).toHaveLength(5);
    expect(spectator.boards.b!.ships).toHaveLength(5);
  });

  it('does not mutate its input', () => {
    const s = ready();
    const before = JSON.stringify(s);
    E.apply(s, 'a', fire([4, 4]));
    expect(JSON.stringify(s)).toBe(before);
  });

  it('resigning, even before both have placed, gives the win to the other player', () => {
    const s = E.apply(E.init(['a', 'b'], 1n, {}), 'a', { kind: 'resign' });
    expect(s.winner).toBe('b');
    expect(s.endReason).toBe('resign');
    expect(E.isTerminal(s)).toBe(true);
    const r = E.apply(ready(), 'b', { kind: 'resign' });
    expect(E.result(r).placements).toEqual([['a'], ['b']]);
  });
});

describe('sea battle: salvo variant', () => {
  it('you fire one shot per ship still afloat, all at once', () => {
    const s = ready({ salvo: true }, 0);
    expect(seaBattleShotsAllowed(s, 0)).toBe(5);
    expect(E.validate(s, 'a', fire([0, 0]))).toEqual({ ok: false, code: 'wrong_shot_count' });
    const five = fire([0, 0], [0, 1], [0, 2], [0, 3], [0, 4]);
    expect(E.validate(s, 'a', five).ok).toBe(true);
    // duplicates inside one salvo are refused
    expect(E.validate(s, 'a', fire([0, 0], [0, 0], [0, 2], [0, 3], [0, 4]))).toEqual({
      ok: false,
      code: 'already_fired',
    });
    const s1 = E.apply(s, 'a', five);
    expect(s1.last?.shots).toHaveLength(5);
    // b: destroyer on column 1, submarine on column 3; columns 0, 2 and 4 are empty at row 0
    expect(s1.last?.shots.map((x) => x.result)).toEqual(['miss', 'hit', 'miss', 'hit', 'miss']);
  });

  it('losing a ship costs a shot next turn', () => {
    let s = ready({ salvo: true }, 0);
    // a sinks b's destroyer with column 1 rows 0-1 plus three misses
    s = E.apply(s, 'a', fire([0, 1], [1, 1], [9, 9], [9, 8], [9, 7]));
    expect(s.last?.shots.some((x) => x.result === 'sunk')).toBe(true);
    // b has 5 ships, a lost none; a's second salvo is still 5, b's is 5
    expect(seaBattleShotsAllowed(s, 0)).toBe(5);
    // now b sinks a's destroyer (row 8, cols 0-1)
    s = E.apply(s, 'b', fire([8, 0], [8, 1], [5, 5], [5, 6], [5, 7]));
    expect(seaBattleShotsAllowed(s, 0)).toBe(4);
    expect(E.validate(s, 'a', fire([2, 2], [2, 3], [2, 4], [2, 5], [2, 6]))).toEqual({
      ok: false,
      code: 'wrong_shot_count',
    });
    expect(E.validate(s, 'a', fire([2, 2], [2, 3], [2, 4], [2, 5])).ok).toBe(true);
  });
});

describe('sea battle: hidden information', () => {
  const layoutA = JSON.stringify(ROWS);

  it('the opponent and spectators never see your ships while the game is on', () => {
    let s = ready({}, 0);
    s = E.apply(s, 'a', fire([0, 9])); // a hits b
    s = E.apply(s, 'b', fire([0, 0])); // b hits a's carrier at (0,0)
    for (const viewer of ['b', 'spectator'] as const) {
      const v = E.view(s, viewer) as { boards: Record<string, { ships: unknown }> };
      expect(v.boards.a!.ships).toBeNull();
    }
    const asA = E.view(s, 'a') as { boards: Record<string, { ships: { id: string }[] | null }> };
    expect(asA.boards.a!.ships?.map((x) => x.id)).toEqual(SEA_FLEET.map((f) => f.id));
    expect(asA.boards.b!.ships).toBeNull();
    // a hit does not reveal which ship it was, and the whole state is not leaked in any form
    const viewOfB = JSON.stringify(E.view(s, 'b'));
    expect(viewOfB).not.toContain('"fleets"');
    expect(viewOfB).not.toContain('"carrier","len":5,"r":0,"c":0');
    expect(s.last?.shots[0]?.ship).toBeNull();
    expect(JSON.stringify(E.view(s, 'a'))).not.toContain('"c":9,"dir":"v"');
  });

  it('before the battle a player only learns that the other has placed', () => {
    const s = E.apply(E.init(['a', 'b'], 1n, {}), 'a', place(ROWS));
    const v = E.view(s, 'b') as {
      placed: Record<string, boolean>;
      boards: Record<string, { ships: unknown }>;
    };
    expect(v.placed).toEqual({ a: true, b: false });
    expect(v.boards.a!.ships).toBeNull();
    expect(JSON.stringify(v)).not.toContain(layoutA.slice(1, 20));
    const own = E.view(s, 'a') as { boards: Record<string, { ships: unknown }> };
    expect(own.boards.a!.ships).not.toBeNull();
  });

  it('a sunk ship becomes public, an afloat one stays secret', () => {
    let s = ready({}, 0);
    s = E.apply(s, 'a', fire([0, 1]));
    s = E.apply(s, 'b', fire([7, 7]));
    s = E.apply(s, 'a', fire([1, 1])); // sunk destroyer
    const v = E.view(s, 'b') as {
      boards: Record<string, { sunk: { id: string; r: number; c: number }[]; ships: unknown }>;
    };
    expect(v.boards.b!.sunk).toEqual([{ id: 'destroyer', len: 2, r: 0, c: 1, dir: 'v' }]);
    expect(v.boards.b!.ships).not.toBeNull(); // b sees their own fleet
    const asSpectator = E.view(s, 'spectator') as { boards: Record<string, { ships: unknown }> };
    expect(asSpectator.boards.b!.ships).toBeNull();
  });

  it('views are plain JSON for every viewer', () => {
    const s = ready();
    for (const viewer of ['a', 'b', 'spectator'] as const) {
      expect(() => JSON.stringify(E.view(s, viewer))).not.toThrow();
    }
  });
});

describe('sea battle: wire format', () => {
  it('validates actions with zod', () => {
    expect(seaBattleActionSchema.safeParse(place(ROWS)).success).toBe(true);
    expect(seaBattleActionSchema.safeParse(place(ROWS.slice(0, 3))).success).toBe(false);
    expect(seaBattleActionSchema.safeParse(fire([3, 4])).success).toBe(true);
    expect(seaBattleActionSchema.safeParse(fire([3, 10])).success).toBe(false);
    expect(
      seaBattleActionSchema.safeParse(fire([0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5])).success,
    ).toBe(false);
    expect(seaBattleActionSchema.safeParse({ kind: 'fire', shots: [] }).success).toBe(false);
    expect(seaBattleActionSchema.safeParse({ kind: 'resign' }).success).toBe(true);
    expect(seaBattleActionSchema.safeParse({ kind: 'peek' }).success).toBe(false);
    expect(
      seaBattleActionSchema.safeParse(place(ROWS.map((p) => ({ ...p, dir: 'x' as 'h' })))).success,
    ).toBe(false);
  });

  it('is deterministic: same seed and moves give the same state', () => {
    const play = (): SeaBattleState => {
      let s = E.init(['a', 'b'], 11n, {});
      s = E.apply(s, 'a', place(ROWS));
      s = E.apply(s, 'b', place(COLS));
      for (let i = 0; i < 30 && !E.isTerminal(s); i++) {
        const by = E.currentPlayers(s)[0]!;
        s = E.apply(s, by, fire(unshot(s, by)[i % 7]!));
      }
      return s;
    };
    expect(play()).toEqual(play());
  });
});
