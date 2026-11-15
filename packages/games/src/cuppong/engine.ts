import { z } from 'zod';
import type { GameEngine, GameResult, PlayerId, ValidateResult } from '../contract.ts';
import { nextInt, seedRng, type RngState } from '../rng.ts';
import { AIM_MAX, POWER_MAX, simulateThrow, type CupPos, type ThrowInput } from './physics.ts';

/**
 * Cup Pong (2 players, async). Each player owns 10 cups racked as a triangle (4-3-2-1, point towards
 * the thrower). On your turn you throw `ballsPerTurn` balls (default 3) at the other player's cups; a ball
 * that drops in removes that cup. Input is only `{aim, power}` (integers); the server re-simulates it,
 * after adding a small release wobble drawn from the seeded RNG, so a perfect replay still misses
 * sometimes. Rules decided here are in docs/DECISIONS.md (ADR-013).
 *
 *  - Equal turns: players[0] throws first each round, and if they clear the rack, players[1] still gets
 *    their turn. Both cleared → fewer balls used wins, equal → draw.
 *  - Re-rack: once per game, at the start of your own turn, with 2–6 cups left, your cups are pushed
 *    into a compact shape (costs no ball).
 *  - `maxRounds` (default 12) ends the game: most cups sunk wins, equal is a draw.
 */
export type CupPongCfg = {
  ballsPerTurn?: number;
  maxRounds?: number;
};

/** Release wobble, in input units: the applied input = input + a uniform integer in [-J, J]. */
export const CUP_PONG_AIM_JITTER = 70;
export const CUP_PONG_POWER_JITTER = 26;

export type CupPongThrowRecord = {
  seq: number;
  by: PlayerId;
  input: ThrowInput;
  /** What was actually simulated (input + wobble), clamped to the legal range. */
  applied: ThrowInput;
  /** Id of the cup that was sunk, or null. */
  sunk: number | null;
  bounces: number;
  rimHits: number;
  endX: number;
  endZ: number;
};

export type CupPongState = {
  players: [PlayerId, PlayerId];
  ballsPerTurn: number;
  maxRounds: number;
  /** Each player's OWN standing cups, positions in millimetres in the frame of whoever throws at them. */
  racks: Record<PlayerId, CupPos[]>;
  rerackUsed: Record<PlayerId, boolean>;
  /** Index into `players` of the current thrower. */
  turn: 0 | 1;
  round: number;
  ballsLeft: number;
  /** Balls thrown / cups sunk by each player. */
  thrown: Record<PlayerId, number>;
  sunk: Record<PlayerId, number>;
  /** Number of balls the player had thrown when they cleared the other rack (null if they have not). */
  clearedWith: Record<PlayerId, number | null>;
  over: boolean;
  winner: PlayerId | null;
  last: CupPongThrowRecord | null;
  seq: number;
  rng: RngState;
};

export type CupPongAction = { kind: 'throw'; aim: number; power: number } | { kind: 'rerack' };

export const cupPongActionSchema: z.ZodType<CupPongAction> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('throw'),
    aim: z.number().int().min(-AIM_MAX).max(AIM_MAX),
    power: z.number().int().min(0).max(POWER_MAX),
  }),
  z.object({ kind: z.literal('rerack') }),
]);

// ---------------------------------------------------------------------------------------------
// Racks (integer millimetres)

const CUP_SPACING = 100;
const ROW_SPACING = 87; // ≈ 100 × √3/2, rounded
const BACK_Z = 2370;

/** Rows from the back (far end) to the tip, as counts. */
const STANDARD_ROWS = [4, 3, 2, 1];
const RERACK_ROWS: Record<number, number[]> = {
  6: [3, 2, 1],
  5: [3, 2],
  4: [1, 2, 1],
  3: [2, 1],
  2: [2],
};

function layout(rows: readonly number[]): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  rows.forEach((count, r) => {
    for (let i = 0; i < count; i++) {
      out.push({ x: (2 * i - (count - 1)) * (CUP_SPACING / 2), z: BACK_Z - r * ROW_SPACING });
    }
  });
  return out;
}

/** A fresh 10-cup rack, ids 0..9 from the back-left to the tip. */
export function cupPongRack(): CupPos[] {
  return layout(STANDARD_ROWS).map((p, id) => ({ id, ...p }));
}

/** Can a rack with this many cups left be re-racked? */
export const cupPongCanRerack = (n: number): boolean => RERACK_ROWS[n] !== undefined;

function rerack(cups: readonly CupPos[]): CupPos[] {
  const rows = RERACK_ROWS[cups.length];
  if (!rows) return [...cups];
  const spots = layout(rows);
  // Keep ids in a stable order so renderers can slide each cup to its new spot.
  return [...cups]
    .sort((a, b) => a.id - b.id)
    .map((c, i) => ({
      id: c.id,
      x: (spots[i] as { x: number }).x,
      z: (spots[i] as { z: number }).z,
    }));
}

// ---------------------------------------------------------------------------------------------
// Engine

const other = (s: CupPongState, p: PlayerId): PlayerId =>
  s.players[0] === p ? s.players[1] : s.players[0];

function settle(s: CupPongState): CupPongState {
  const [a, b] = s.players;
  const left = (p: PlayerId): number => s.racks[p]?.length ?? 0;
  const aCleared = left(b) === 0; // a cleared b's cups
  const bCleared = left(a) === 0;
  let winner: PlayerId | null = null;
  if (aCleared && bCleared) {
    const ca = s.clearedWith[a] ?? Infinity;
    const cb = s.clearedWith[b] ?? Infinity;
    winner = ca < cb ? a : cb < ca ? b : null;
  } else if (aCleared) winner = a;
  else if (bCleared) winner = b;
  else if ((s.sunk[a] ?? 0) !== (s.sunk[b] ?? 0))
    winner = (s.sunk[a] ?? 0) > (s.sunk[b] ?? 0) ? a : b;
  return { ...s, over: true, winner, ballsLeft: 0 };
}

export const cupPongEngine: GameEngine<CupPongState, CupPongAction, CupPongCfg> = {
  slug: 'cup-pong',
  actionSchema: cupPongActionSchema,
  timers: { turnMs: 60_000 },

  init(players, seed, cfg) {
    if (players.length !== 2) throw new Error('Cup Pong is a two-player game');
    if (players[0] === players[1]) throw new Error('Duplicate players');
    const ballsPerTurn = cfg?.ballsPerTurn ?? 3;
    const maxRounds = cfg?.maxRounds ?? 12;
    if (!Number.isInteger(ballsPerTurn) || ballsPerTurn < 1 || ballsPerTurn > 6) {
      throw new Error('Invalid ballsPerTurn');
    }
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 50) {
      throw new Error('Invalid maxRounds');
    }
    const [a, b] = players as [PlayerId, PlayerId];
    return {
      players: [a, b],
      ballsPerTurn,
      maxRounds,
      racks: { [a]: cupPongRack(), [b]: cupPongRack() },
      rerackUsed: { [a]: false, [b]: false },
      turn: 0,
      round: 1,
      ballsLeft: ballsPerTurn,
      thrown: { [a]: 0, [b]: 0 },
      sunk: { [a]: 0, [b]: 0 },
      clearedWith: { [a]: null, [b]: null },
      over: false,
      winner: null,
      last: null,
      seq: 0,
      rng: seedRng(seed),
    };
  },

  currentPlayers(s) {
    return s.over ? [] : [s.players[s.turn]];
  },

  validate(s, by, a): ValidateResult {
    if (s.over) return { ok: false, code: 'game_over' };
    if (s.players[s.turn] !== by) return { ok: false, code: 'not_your_turn' };
    if (a.kind === 'rerack') {
      if (s.rerackUsed[by]) return { ok: false, code: 'rerack_used' };
      if (s.ballsLeft !== s.ballsPerTurn) return { ok: false, code: 'rerack_before_throwing' };
      if (!cupPongCanRerack(s.racks[by]?.length ?? 0))
        return { ok: false, code: 'rerack_not_allowed' };
      return { ok: true };
    }
    if (!Number.isInteger(a.aim) || a.aim < -AIM_MAX || a.aim > AIM_MAX) {
      return { ok: false, code: 'bad_aim' };
    }
    if (!Number.isInteger(a.power) || a.power < 0 || a.power > POWER_MAX) {
      return { ok: false, code: 'bad_power' };
    }
    return { ok: true };
  },

  apply(s, by, a) {
    const me = by;
    const foe = other(s, by);
    const next: CupPongState = {
      ...s,
      racks: { ...s.racks },
      rerackUsed: { ...s.rerackUsed },
      thrown: { ...s.thrown },
      sunk: { ...s.sunk },
      clearedWith: { ...s.clearedWith },
      seq: s.seq + 1,
    };

    if (a.kind === 'rerack') {
      next.racks[me] = rerack(s.racks[me] ?? []);
      next.rerackUsed[me] = true;
      return next;
    }

    // Release wobble from the seeded RNG: two draws per throw, always, so replays stay aligned.
    const [aj, rng1] = nextInt(s.rng, 2 * CUP_PONG_AIM_JITTER + 1);
    const [pj, rng] = nextInt(rng1, 2 * CUP_PONG_POWER_JITTER + 1);
    const applied: ThrowInput = {
      aim: Math.max(-AIM_MAX, Math.min(AIM_MAX, a.aim + aj - CUP_PONG_AIM_JITTER)),
      power: Math.max(0, Math.min(POWER_MAX, a.power + pj - CUP_PONG_POWER_JITTER)),
    };
    next.rng = rng;

    const target = s.racks[foe] ?? [];
    const { outcome } = simulateThrow(target, applied);
    next.thrown[me] = (s.thrown[me] ?? 0) + 1;
    if (outcome.sunk !== null) {
      next.racks[foe] = target.filter((c) => c.id !== outcome.sunk);
      next.sunk[me] = (s.sunk[me] ?? 0) + 1;
    }
    next.last = {
      seq: next.seq,
      by: me,
      input: { aim: a.aim, power: a.power },
      applied,
      sunk: outcome.sunk,
      bounces: outcome.bounces,
      rimHits: outcome.rimHits,
      endX: outcome.endX,
      endZ: outcome.endZ,
    };

    const cleared = (next.racks[foe] ?? []).length === 0;
    if (cleared && next.clearedWith[me] === null) next.clearedWith[me] = next.thrown[me] ?? 0;
    next.ballsLeft = s.ballsLeft - 1;

    // The turn ends when the balls run out, or when you have cleared everything (no point throwing on).
    if (next.ballsLeft > 0 && !cleared) return next;

    if (s.turn === 1) {
      // End of a round: the second thrower has had their turn too.
      const anyCleared =
        (next.racks[me] ?? []).length === 0 || (next.racks[foe] ?? []).length === 0;
      if (anyCleared || s.round >= s.maxRounds) return settle(next);
      next.round = s.round + 1;
      next.turn = 0;
    } else {
      next.turn = 1;
    }
    next.ballsLeft = s.ballsPerTurn;
    return next;
  },

  isTerminal(s) {
    return s.over;
  },

  result(s): GameResult {
    if (!s.over) return { placements: [], draw: false };
    if (s.winner === null) return { placements: [[s.players[0], s.players[1]]], draw: true };
    return { placements: [[s.winner], [other(s, s.winner)]], draw: false };
  },

  view(s) {
    // Everything on a Cup Pong table is public; only the RNG state (which sets the next wobble) is not.
    const { rng: _rng, ...visible } = s;
    return visible;
  },
};
