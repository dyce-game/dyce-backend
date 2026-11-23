import { z } from 'zod';
import type { GameEngine, GameResult, PlayerId, ValidateResult } from '../contract.ts';
import { nextInt, seedRng, type RngState } from '../rng.ts';

/**
 * Sea Battle (Battleship, ADR-035): 10 x 10 grid, two players, hidden fleets.
 *
 * Phase 1, placing: both players place the whole fleet at the same time with one `place` action
 * (ships may touch, never overlap, must fit on the board). Nobody sees the other's layout. Phase 2,
 * battle: players take turns firing at a cell of the other grid; hit, miss and "sunk" (with which
 * ship) are public, a hit gives no extra shot. In the optional **salvo** variant (`cfg.salvo`) you
 * fire one shot per ship you still have afloat, all at once. The first player to sink the whole
 * fleet wins. Who fires first comes from the match seed. The fleets are revealed to everyone only
 * when the game is over, and every ship is revealed once it is sunk.
 *
 * Cells are numbered `r * size + c`. A ship is `{ id, len, r, c, dir }` starting at (r, c) and running
 * right (`h`) or down (`v`).
 */
export type SeaBattleCfg = { salvo?: boolean };

export const SEA_SIZE = 10;
export const SEA_FLEET: readonly { id: string; len: number }[] = [
  { id: 'carrier', len: 5 },
  { id: 'battleship', len: 4 },
  { id: 'cruiser', len: 3 },
  { id: 'submarine', len: 3 },
  { id: 'destroyer', len: 2 },
];

export type SeaShip = { id: string; len: number; r: number; c: number; dir: 'h' | 'v' };
export type SeaShipPlacement = { r: number; c: number; dir: 'h' | 'v' };
export type SeaShotResult = 'miss' | 'hit' | 'sunk';

export type SeaBattleState = {
  players: PlayerId[];
  size: number;
  salvo: boolean;
  /** Secret: fleets[seat] is null until that seat has placed. Only `view()` may show it. */
  fleets: (SeaShip[] | null)[];
  /** shots[seat] = cells fired BY that seat at the other grid, in order. */
  shots: number[][];
  phase: 'placing' | 'battle' | 'over';
  /** Index of whoever fires next (meaningful in the battle phase). */
  turn: 0 | 1;
  winner: PlayerId | null;
  endReason: 'sunk' | 'resign' | null;
  last: {
    by: PlayerId;
    shots: { cell: number; result: SeaShotResult; ship: string | null }[];
  } | null;
  seq: number;
};

export type SeaBattleAction =
  | { kind: 'place'; ships: SeaShipPlacement[] }
  | { kind: 'fire'; shots: { r: number; c: number }[] }
  | { kind: 'resign' };

export const seaBattleActionSchema: z.ZodType<SeaBattleAction> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('place'),
    ships: z
      .array(
        z.object({
          r: z
            .number()
            .int()
            .min(0)
            .max(SEA_SIZE - 1),
          c: z
            .number()
            .int()
            .min(0)
            .max(SEA_SIZE - 1),
          dir: z.enum(['h', 'v']),
        }),
      )
      .length(SEA_FLEET.length),
  }),
  z.object({
    kind: z.literal('fire'),
    shots: z
      .array(
        z.object({
          r: z
            .number()
            .int()
            .min(0)
            .max(SEA_SIZE - 1),
          c: z
            .number()
            .int()
            .min(0)
            .max(SEA_SIZE - 1),
        }),
      )
      .min(1)
      .max(SEA_FLEET.length),
  }),
  z.object({ kind: z.literal('resign') }),
]);

/** Cells (r * size + c) a ship covers. */
export function seaShipCells(ship: SeaShipPlacement & { len: number }, size = SEA_SIZE): number[] {
  const out: number[] = [];
  for (let i = 0; i < ship.len; i++) {
    out.push(ship.dir === 'h' ? ship.r * size + ship.c + i : (ship.r + i) * size + ship.c);
  }
  return out;
}

export type SeaPlacementCheck = { ok: true; ships: SeaShip[] } | { ok: false; code: string };

/** Check a full-fleet placement and turn it into ships. */
export function seaBattleCheckPlacement(
  placements: readonly SeaShipPlacement[],
  size = SEA_SIZE,
): SeaPlacementCheck {
  if (placements.length !== SEA_FLEET.length) return { ok: false, code: 'wrong_fleet' };
  const taken = new Set<number>();
  const ships: SeaShip[] = [];
  for (let i = 0; i < SEA_FLEET.length; i++) {
    const spec = SEA_FLEET[i]!;
    const p = placements[i]!;
    if (!Number.isInteger(p.r) || !Number.isInteger(p.c) || (p.dir !== 'h' && p.dir !== 'v')) {
      return { ok: false, code: 'bad_ship' };
    }
    const endR = p.dir === 'v' ? p.r + spec.len - 1 : p.r;
    const endC = p.dir === 'h' ? p.c + spec.len - 1 : p.c;
    if (p.r < 0 || p.c < 0 || endR >= size || endC >= size)
      return { ok: false, code: 'out_of_bounds' };
    const ship: SeaShip = { id: spec.id, len: spec.len, r: p.r, c: p.c, dir: p.dir };
    for (const cell of seaShipCells(ship, size)) {
      if (taken.has(cell)) return { ok: false, code: 'overlap' };
      taken.add(cell);
    }
    ships.push(ship);
  }
  return { ok: true, ships };
}

/**
 * A random legal layout from a seeded state, for a "randomise" button. It is a helper for clients
 * and bots, not part of the rules: the engine never calls it, so a client may seed it however it likes.
 */
export function seaBattleRandomPlacement(rngState: RngState, size = SEA_SIZE): SeaShipPlacement[] {
  let rng = rngState;
  const taken = new Set<number>();
  const out: SeaShipPlacement[] = [];
  for (const spec of SEA_FLEET) {
    for (;;) {
      let dirN: number;
      let r: number;
      let c: number;
      [dirN, rng] = nextInt(rng, 2);
      [r, rng] = nextInt(rng, size);
      [c, rng] = nextInt(rng, size);
      const dir: 'h' | 'v' = dirN === 0 ? 'h' : 'v';
      const ship = { r, c, dir, len: spec.len };
      if ((dir === 'h' ? c + spec.len : r + spec.len) > size) continue;
      const cells = seaShipCells(ship, size);
      if (cells.some((x) => taken.has(x))) continue;
      cells.forEach((x) => taken.add(x));
      out.push({ r, c, dir });
      break;
    }
  }
  return out;
}

const seatOf = (s: SeaBattleState, p: PlayerId): number => s.players.indexOf(p);

/** Ships of `fleet` completely covered by `fired` cells. */
function sunkShips(fleet: SeaShip[], fired: readonly number[], size: number): SeaShip[] {
  const set = new Set(fired);
  return fleet.filter((sh) => seaShipCells(sh, size).every((c) => set.has(c)));
}

/** How many shots the player in `seat` fires this turn. */
export function seaBattleShotsAllowed(s: SeaBattleState, seat: number): number {
  if (!s.salvo) return 1;
  const mine = s.fleets[seat];
  if (!mine) return 1;
  const afloat = mine.length - sunkShips(mine, s.shots[1 - seat]!, s.size).length;
  const free = s.size * s.size - s.shots[seat]!.length;
  return Math.max(1, Math.min(afloat, free));
}

export const seaBattleEngine: GameEngine<SeaBattleState, SeaBattleAction, SeaBattleCfg> = {
  slug: 'sea-battle',
  actionSchema: seaBattleActionSchema,
  timers: { turnMs: 24 * 60 * 60 * 1000 },

  init(players, seed, cfg) {
    if (players.length !== 2) throw new Error('Sea Battle needs exactly 2 players');
    if (players[0] === players[1]) throw new Error('Duplicate players');
    const [first] = nextInt(seedRng(seed), 2);
    return {
      players: [...players],
      size: SEA_SIZE,
      salvo: cfg.salvo ?? false,
      fleets: [null, null],
      shots: [[], []],
      phase: 'placing',
      turn: first as 0 | 1,
      winner: null,
      endReason: null,
      last: null,
      seq: 0,
    };
  },

  currentPlayers(s) {
    if (s.phase === 'over') return [];
    if (s.phase === 'placing') return s.players.filter((_, i) => s.fleets[i] === null);
    return [s.players[s.turn]!];
  },

  validate(s, by, a): ValidateResult {
    if (s.phase === 'over') return { ok: false, code: 'game_over' };
    const seat = seatOf(s, by);
    if (seat < 0) return { ok: false, code: 'not_a_player' };
    if (a.kind === 'resign') return { ok: true };
    if (a.kind === 'place') {
      if (s.phase !== 'placing') return { ok: false, code: 'not_placing' };
      if (s.fleets[seat] !== null) return { ok: false, code: 'already_placed' };
      const check = seaBattleCheckPlacement(a.ships, s.size);
      return check.ok ? { ok: true } : { ok: false, code: check.code };
    }
    // fire
    if (s.phase !== 'battle') return { ok: false, code: 'still_placing' };
    if (seat !== s.turn) return { ok: false, code: 'not_your_turn' };
    const expected = seaBattleShotsAllowed(s, seat);
    if (a.shots.length !== expected) return { ok: false, code: 'wrong_shot_count' };
    const seen = new Set<number>(s.shots[seat]);
    for (const sh of a.shots) {
      if (!Number.isInteger(sh.r) || !Number.isInteger(sh.c))
        return { ok: false, code: 'out_of_bounds' };
      if (sh.r < 0 || sh.c < 0 || sh.r >= s.size || sh.c >= s.size) {
        return { ok: false, code: 'out_of_bounds' };
      }
      const cell = sh.r * s.size + sh.c;
      if (seen.has(cell)) return { ok: false, code: 'already_fired' };
      seen.add(cell);
    }
    return { ok: true };
  },

  apply(s, by, a) {
    const seat = seatOf(s, by);
    if (a.kind === 'resign') {
      const other = s.players.find((p) => p !== by)!;
      return { ...s, phase: 'over', winner: other, endReason: 'resign', seq: s.seq + 1 };
    }
    if (a.kind === 'place') {
      const check = seaBattleCheckPlacement(a.ships, s.size);
      if (!check.ok) throw new Error(check.code);
      const fleets = s.fleets.slice();
      fleets[seat] = check.ships;
      return {
        ...s,
        fleets,
        phase: fleets.every((f) => f !== null) ? 'battle' : 'placing',
        seq: s.seq + 1,
      };
    }

    const opp = 1 - seat;
    const enemyFleet = s.fleets[opp]!;
    const fired = [...s.shots[seat]!];
    const results: { cell: number; result: SeaShotResult; ship: string | null }[] = [];
    for (const sh of a.shots) {
      const cell = sh.r * s.size + sh.c;
      fired.push(cell);
      const ship = enemyFleet.find((f) => seaShipCells(f, s.size).includes(cell));
      if (!ship) {
        results.push({ cell, result: 'miss', ship: null });
        continue;
      }
      const sunk = seaShipCells(ship, s.size).every((c) => fired.includes(c));
      results.push({ cell, result: sunk ? 'sunk' : 'hit', ship: sunk ? ship.id : null });
    }
    const shots = s.shots.map((x) => x.slice());
    shots[seat] = fired;
    const allSunk = sunkShips(enemyFleet, fired, s.size).length === enemyFleet.length;
    return {
      ...s,
      shots,
      turn: allSunk ? s.turn : ((1 - s.turn) as 0 | 1),
      phase: allSunk ? 'over' : 'battle',
      winner: allSunk ? by : null,
      endReason: allSunk ? 'sunk' : null,
      last: { by, shots: results },
      seq: s.seq + 1,
    };
  },

  isTerminal(s) {
    return s.phase === 'over';
  },

  result(s): GameResult {
    if (s.winner === null) return { placements: [], draw: false };
    return { placements: [[s.winner], s.players.filter((p) => p !== s.winner)], draw: false };
  },

  view(s, viewer) {
    const over = s.phase === 'over';
    // boards[pid] is the grid OWNED by pid: shots fired at it, ships it has lost, and (to its owner,
    // or to everyone once the game is over) where its ships are. The fleets never leave otherwise.
    const boards: Record<string, unknown> = {};
    s.players.forEach((pid, seat) => {
      const fleet = s.fleets[seat];
      const incoming = s.shots[1 - seat]!;
      const sunk = fleet ? sunkShips(fleet, incoming, s.size) : [];
      const sunkIds = new Set(sunk.map((x) => x.id));
      const hits = fleet
        ? incoming.map((cell) => {
            const ship = fleet.find((f) => seaShipCells(f, s.size).includes(cell));
            const result: SeaShotResult = !ship ? 'miss' : sunkIds.has(ship.id) ? 'sunk' : 'hit';
            return { cell, result };
          })
        : [];
      const showShips = fleet !== null && (viewer === pid || over);
      boards[pid] = {
        shots: hits,
        sunk,
        shipsLeft: fleet ? fleet.length - sunk.length : SEA_FLEET.length,
        ships: showShips ? fleet : null,
      };
    });
    const placed: Record<string, boolean> = {};
    s.players.forEach((pid, seat) => (placed[pid] = s.fleets[seat] !== null));
    return {
      players: s.players,
      size: s.size,
      salvo: s.salvo,
      fleetSpec: SEA_FLEET,
      phase: s.phase,
      turn: s.phase === 'battle' ? s.players[s.turn]! : null,
      shotsAllowed: s.phase === 'battle' ? seaBattleShotsAllowed(s, s.turn) : 0,
      placed,
      boards,
      last: s.last,
      winner: s.winner,
      endReason: s.endReason,
      seq: s.seq,
    };
  },
};
