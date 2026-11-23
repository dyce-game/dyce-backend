import { z } from 'zod';
import type { GameEngine, GameResult, PlayerId, ValidateResult } from '../contract.ts';

/**
 * Ayo / Mancala (ADR-035): one engine, two rule sets chosen at `init` with `cfg.variant`.
 *
 * Board: twelve pits in a ring, sown counter-clockwise (increasing index, wrapping). Pits 0..5 are
 * `players[0]`'s row (left to right from their seat) and pits 6..11 are `players[1]`'s (right to
 * left from theirs), so pit `i` faces pit `11 - i`. Each pit starts with `seeds` (4) seeds, 48 in all.
 * You may only lift from one of your own non-empty pits. `stores[i]` is what player `i` has won.
 *
 * **Ayo (Ayo Olopon, default).** Lift every seed from your pit and sow one per pit, skipping the pit
 * you lifted from. If the last seed lands in a pit that already held seeds, lift that whole pit
 * (including the seed just dropped) and keep sowing (relay). If it lands in an empty pit on your own
 * side, you capture the seeds in the opposite pit (if any) and the turn ends; in an empty pit on the
 * opponent's side the turn simply ends. First to 25 wins. When the player to move has no seeds on
 * their side the game ends and each player keeps the seeds on their own side. A relay chain is cut
 * after `AYO_MAX_RELAYS` laps, and a game is scored as above after `maxPlies` moves (default 400).
 *
 * **Kalah (Mancala).** Standard Kalah(6, n): a store sits after each player's row; sow
 * counter-clockwise, drop one in your own store when you pass it, skip the opponent's, and do not
 * skip the pit you lifted from. A last seed in your store is an extra turn. A last seed in an empty
 * pit of yours captures the opposite pit's seeds plus that seed into your store (nothing happens if
 * the opposite pit is empty). When one side has no seeds the other player's remaining seeds go to
 * their store. First to 25 wins.
 */
export type AyoVariant = 'ayo' | 'kalah';
export type AyoCfg = { variant?: AyoVariant; seeds?: number; maxPlies?: number };

export const AYO_PITS = 12;
export const AYO_DEFAULT_SEEDS = 4;
export const AYO_MAX_RELAYS = 200;
export const AYO_DEFAULT_MAX_PLIES = 400;

export type AyoLap = { from: number; path: number[] };

export type AyoState = {
  players: PlayerId[];
  variant: AyoVariant;
  seeds: number;
  maxPlies: number;
  pits: number[];
  stores: number[];
  turn: 0 | 1;
  plies: number;
  winner: PlayerId | null;
  draw: boolean;
  endReason: 'target' | 'out_of_seeds' | 'max_plies' | 'resign' | null;
  /** The last move for animation: every sowing lap (the first from the chosen pit, then relays). */
  last: {
    by: PlayerId;
    pit: number;
    laps: AyoLap[];
    captured: number;
    capturedFrom: number | null;
    extraTurn: boolean;
  } | null;
  seq: number;
};

export type AyoAction = { kind: 'sow'; pit: number } | { kind: 'resign' };

export const ayoActionSchema: z.ZodType<AyoAction> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('sow'),
    pit: z
      .number()
      .int()
      .min(0)
      .max(AYO_PITS - 1),
  }),
  z.object({ kind: z.literal('resign') }),
]);

/** Which player's row pit `i` belongs to. */
export const ayoPitOwner = (i: number): 0 | 1 => (i < 6 ? 0 : 1);
/** The pit facing pit `i`. */
export const ayoOpposite = (i: number): number => 11 - i;

const winTarget = (s: { seeds: number }): number => (s.seeds * AYO_PITS) / 2 + 1;

/** Pits `player` may lift from now. */
export function ayoLegalPits(s: AyoState, turn: 0 | 1 = s.turn): number[] {
  const out: number[] = [];
  for (let i = turn * 6; i < turn * 6 + 6; i++) if (s.pits[i]! > 0) out.push(i);
  return out;
}

type MoveOutcome = {
  pits: number[];
  stores: number[];
  laps: AyoLap[];
  captured: number;
  capturedFrom: number | null;
  extraTurn: boolean;
};

function sowAyo(pitsIn: number[], storesIn: number[], me: 0 | 1, pit: number): MoveOutcome {
  const pits = pitsIn.slice();
  const stores = storesIn.slice();
  const laps: AyoLap[] = [];
  let from = pit;
  let relays = 0;
  let captured = 0;
  let capturedFrom: number | null = null;
  for (;;) {
    let n = pits[from]!;
    pits[from] = 0;
    const path: number[] = [];
    let pos = from;
    while (n > 0) {
      pos = (pos + 1) % AYO_PITS;
      if (pos === from) continue; // never drop into the pit being lifted from
      pits[pos] = pits[pos]! + 1;
      path.push(pos);
      n--;
    }
    laps.push({ from, path });
    const landedInOccupied = pits[pos]! > 1;
    if (landedInOccupied && relays < AYO_MAX_RELAYS) {
      relays++;
      from = pos;
      continue;
    }
    if (!landedInOccupied && ayoPitOwner(pos) === me && pits[ayoOpposite(pos)]! > 0) {
      capturedFrom = ayoOpposite(pos);
      captured = pits[capturedFrom]!;
      pits[capturedFrom] = 0;
      stores[me] = stores[me]! + captured;
    }
    break;
  }
  return { pits, stores, laps, captured, capturedFrom, extraTurn: false };
}

function sowKalah(pitsIn: number[], storesIn: number[], me: 0 | 1, pit: number): MoveOutcome {
  // Ring of 14 slots: pits 0..5, store 0, pits 6..11, store 1.
  const ring = [...pitsIn.slice(0, 6), storesIn[0]!, ...pitsIn.slice(6), storesIn[1]!];
  const slotOfPit = (p: number): number => (p < 6 ? p : p + 1);
  const pitOfSlot = (sl: number): number => (sl < 6 ? sl : sl - 1);
  const myStore = me === 0 ? 6 : 13;
  const theirStore = me === 0 ? 13 : 6;
  const start = slotOfPit(pit);
  let n = ring[start]!;
  ring[start] = 0;
  let slot = start;
  const path: number[] = [];
  while (n > 0) {
    slot = (slot + 1) % 14;
    if (slot === theirStore) continue;
    ring[slot] = ring[slot]! + 1;
    path.push(slot === myStore ? -1 : pitOfSlot(slot)); // -1 marks the mover's store
    n--;
  }
  let captured = 0;
  let capturedFrom: number | null = null;
  const extraTurn = slot === myStore;
  if (
    !extraTurn &&
    slot !== theirStore &&
    ayoPitOwner(pitOfSlot(slot)) === me &&
    ring[slot] === 1
  ) {
    const oppPit = ayoOpposite(pitOfSlot(slot));
    const oppSlot = slotOfPit(oppPit);
    if (ring[oppSlot]! > 0) {
      capturedFrom = oppPit;
      captured = ring[oppSlot]! + 1;
      ring[myStore] = ring[myStore]! + captured;
      ring[oppSlot] = 0;
      ring[slot] = 0;
    }
  }
  return {
    pits: [...ring.slice(0, 6), ...ring.slice(7, 13)],
    stores: [ring[6]!, ring[13]!],
    laps: [{ from: pit, path }],
    captured,
    capturedFrom,
    extraTurn,
  };
}

const sideSeeds = (pits: number[], who: 0 | 1): number =>
  pits.slice(who * 6, who * 6 + 6).reduce((a, b) => a + b, 0);

export const ayoEngine: GameEngine<AyoState, AyoAction, AyoCfg> = {
  slug: 'ayo',
  actionSchema: ayoActionSchema,
  timers: { turnMs: 24 * 60 * 60 * 1000 },

  init(players, _seed, cfg) {
    if (players.length !== 2) throw new Error('Ayo needs exactly 2 players');
    if (players[0] === players[1]) throw new Error('Duplicate players');
    const variant = cfg.variant ?? 'ayo';
    if (variant !== 'ayo' && variant !== 'kalah') throw new Error('Unknown variant');
    const seeds = cfg.seeds ?? AYO_DEFAULT_SEEDS;
    if (!Number.isInteger(seeds) || seeds < 3 || seeds > 6) throw new Error('seeds must be 3..6');
    const maxPlies = cfg.maxPlies ?? AYO_DEFAULT_MAX_PLIES;
    if (!Number.isInteger(maxPlies) || maxPlies < 10) throw new Error('maxPlies must be >= 10');
    return {
      players: [...players],
      variant,
      seeds,
      maxPlies,
      pits: new Array<number>(AYO_PITS).fill(seeds),
      stores: [0, 0],
      turn: 0,
      plies: 0,
      winner: null,
      draw: false,
      endReason: null,
      last: null,
      seq: 0,
    };
  },

  currentPlayers(s) {
    if (s.winner !== null || s.draw) return [];
    return [s.players[s.turn]!];
  },

  validate(s, by, a): ValidateResult {
    if (s.winner !== null || s.draw) return { ok: false, code: 'game_over' };
    if (!s.players.includes(by)) return { ok: false, code: 'not_a_player' };
    if (a.kind === 'resign') return { ok: true };
    if (s.players[s.turn] !== by) return { ok: false, code: 'not_your_turn' };
    if (!Number.isInteger(a.pit) || a.pit < 0 || a.pit >= AYO_PITS) {
      return { ok: false, code: 'no_such_pit' };
    }
    if (ayoPitOwner(a.pit) !== s.turn) return { ok: false, code: 'not_your_pit' };
    if (s.pits[a.pit] === 0) return { ok: false, code: 'empty_pit' };
    return { ok: true };
  },

  apply(s, by, a) {
    if (a.kind === 'resign') {
      const other = s.players.find((p) => p !== by)!;
      return { ...s, winner: other, endReason: 'resign', seq: s.seq + 1 };
    }
    const me = s.turn;
    const out =
      s.variant === 'kalah'
        ? sowKalah(s.pits, s.stores, me, a.pit)
        : sowAyo(s.pits, s.stores, me, a.pit);
    const next: AyoState = {
      ...s,
      pits: out.pits,
      stores: out.stores,
      turn: out.extraTurn ? me : ((1 - me) as 0 | 1),
      plies: s.plies + 1,
      last: {
        by,
        pit: a.pit,
        laps: out.laps,
        captured: out.captured,
        capturedFrom: out.capturedFrom,
        extraTurn: out.extraTurn,
      },
      seq: s.seq + 1,
    };

    const target = winTarget(s);
    const settle = (reason: 'target' | 'out_of_seeds' | 'max_plies'): void => {
      // Everyone keeps the seeds still on their own row, then the totals decide.
      const totals = [
        next.stores[0]! + sideSeeds(next.pits, 0),
        next.stores[1]! + sideSeeds(next.pits, 1),
      ];
      next.endReason = reason;
      if (reason !== 'target') {
        next.stores = totals;
        next.pits = new Array<number>(AYO_PITS).fill(0);
      }
      const [t0, t1] = reason === 'target' ? next.stores : totals;
      if (t0! > t1!) next.winner = s.players[0]!;
      else if (t1! > t0!) next.winner = s.players[1]!;
      else next.draw = true;
    };

    if (next.stores[0]! >= target || next.stores[1]! >= target) settle('target');
    else if (s.variant === 'kalah') {
      if (sideSeeds(next.pits, 0) === 0 || sideSeeds(next.pits, 1) === 0) settle('out_of_seeds');
      else if (next.plies >= s.maxPlies) settle('max_plies');
    } else if (sideSeeds(next.pits, next.turn) === 0) settle('out_of_seeds');
    else if (next.plies >= s.maxPlies) settle('max_plies');
    return next;
  },

  isTerminal(s) {
    return s.winner !== null || s.draw;
  },

  result(s): GameResult {
    if (s.winner !== null) {
      return { placements: [[s.winner], s.players.filter((p) => p !== s.winner)], draw: false };
    }
    if (s.draw) return { placements: [[...s.players]], draw: true };
    return { placements: [], draw: false };
  },

  view(s) {
    return { ...s, legal: s.winner !== null || s.draw ? [] : ayoLegalPits(s) };
  },
};
