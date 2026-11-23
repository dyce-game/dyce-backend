import { z } from 'zod';
import type { GameEngine, GameResult, PlayerId, ValidateResult } from '../contract.ts';
import { nextInt, seedRng, type RngState } from '../rng.ts';
import { AIM_MAX, POWER_MAX, RACKS, simulateShot, type ShotInput } from './physics.ts';

/**
 * Basketball (2 players, async). Five racks of five shots, one rack a turn: round r, `players[0]` shoots rack
 * r (five flicks), then `players[1]` shoots the same rack. Rack r stands at a fixed spot around the three-point
 * arc (`RACKS`). Every make is 1 point; the LAST rack is the money-ball rack, where every ball is worth 2, so a
 * full card is 4 × 5 + 10 = 30. Input is only `{aim, power}` (the quantised flick); the server adds a small
 * release wobble from the seeded RNG (two draws per shot, always), simulates the shot with `physics.ts` and
 * scores it. Decisions are in docs/DECISIONS.md (ADR-034).
 *
 * Most points wins; equal points is a draw.
 */
export type BasketballCfg = {
  racks?: number;
  shotsPerRack?: number;
};

/** Release wobble in input units: the applied input = input + a uniform integer in [-J, J]. */
export const BASKETBALL_AIM_JITTER = 60;
export const BASKETBALL_POWER_JITTER = 20;
/** Points per make on the money-ball rack. */
export const BASKETBALL_MONEY_POINTS = 2;

export type BasketballShotRecord = {
  seq: number;
  by: PlayerId;
  /** Rack index 0-based (also the round). */
  rack: number;
  /** Shot number within the rack, 1-based. */
  shot: number;
  input: ShotInput;
  /** What was actually simulated (input + wobble), clamped to the legal range. */
  applied: ShotInput;
  made: boolean;
  swish: boolean;
  rimHits: number;
  boardHits: number;
  money: boolean;
  /** Points scored by this shot. */
  points: number;
  endX: number;
  endZ: number;
};

export type BasketballState = {
  players: [PlayerId, PlayerId];
  racks: number;
  shotsPerRack: number;
  /** Index into `players` of the current shooter. */
  turn: 0 | 1;
  /** Current rack / round, 0-based. */
  rack: number;
  shotsLeft: number;
  score: Record<PlayerId, number>;
  made: Record<PlayerId, number>;
  /** Every shot so far, per player (at most racks × shotsPerRack each). */
  shots: Record<PlayerId, BasketballShotRecord[]>;
  over: boolean;
  winner: PlayerId | null;
  last: BasketballShotRecord | null;
  seq: number;
  rng: RngState;
};

export type BasketballAction = { kind: 'shoot'; aim: number; power: number };

export const basketballActionSchema: z.ZodType<BasketballAction> = z.object({
  kind: z.literal('shoot'),
  aim: z.number().int().min(-AIM_MAX).max(AIM_MAX),
  power: z.number().int().min(0).max(POWER_MAX),
});

const other = (s: BasketballState, p: PlayerId): PlayerId =>
  s.players[0] === p ? s.players[1] : s.players[0];

/** Is this rack the money-ball rack? (Always the last one.) */
export const basketballIsMoneyRack = (rack: number, racks: number): boolean => rack === racks - 1;

export const basketballEngine: GameEngine<BasketballState, BasketballAction, BasketballCfg> = {
  slug: 'basketball',
  actionSchema: basketballActionSchema,
  timers: { turnMs: 60_000 },

  init(players, seed, cfg) {
    if (players.length !== 2) throw new Error('Basketball is a two-player game');
    if (players[0] === players[1]) throw new Error('Duplicate players');
    const racks = cfg?.racks ?? 5;
    const shotsPerRack = cfg?.shotsPerRack ?? 5;
    if (!Number.isInteger(racks) || racks < 1 || racks > RACKS.length) {
      throw new Error('Invalid racks');
    }
    if (!Number.isInteger(shotsPerRack) || shotsPerRack < 1 || shotsPerRack > 10) {
      throw new Error('Invalid shotsPerRack');
    }
    const [a, b] = players as [PlayerId, PlayerId];
    return {
      players: [a, b],
      racks,
      shotsPerRack,
      turn: 0,
      rack: 0,
      shotsLeft: shotsPerRack,
      score: { [a]: 0, [b]: 0 },
      made: { [a]: 0, [b]: 0 },
      shots: { [a]: [], [b]: [] },
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
    if (!Number.isInteger(a.aim) || a.aim < -AIM_MAX || a.aim > AIM_MAX) {
      return { ok: false, code: 'bad_aim' };
    }
    if (!Number.isInteger(a.power) || a.power < 0 || a.power > POWER_MAX) {
      return { ok: false, code: 'bad_power' };
    }
    return { ok: true };
  },

  apply(s, by, a) {
    const next: BasketballState = {
      ...s,
      score: { ...s.score },
      made: { ...s.made },
      shots: { ...s.shots },
      seq: s.seq + 1,
    };

    // Release wobble from the seeded RNG: two draws per shot, always, so replays stay aligned.
    const [aj, rng1] = nextInt(s.rng, 2 * BASKETBALL_AIM_JITTER + 1);
    const [pj, rng] = nextInt(rng1, 2 * BASKETBALL_POWER_JITTER + 1);
    const applied: ShotInput = {
      aim: Math.max(-AIM_MAX, Math.min(AIM_MAX, a.aim + aj - BASKETBALL_AIM_JITTER)),
      power: Math.max(0, Math.min(POWER_MAX, a.power + pj - BASKETBALL_POWER_JITTER)),
    };
    next.rng = rng;

    const { outcome } = simulateShot(s.rack, applied);
    const money = basketballIsMoneyRack(s.rack, s.racks);
    const points = outcome.made ? (money ? BASKETBALL_MONEY_POINTS : 1) : 0;
    const record: BasketballShotRecord = {
      seq: next.seq,
      by,
      rack: s.rack,
      shot: s.shotsPerRack - s.shotsLeft + 1,
      input: { aim: a.aim, power: a.power },
      applied,
      made: outcome.made,
      swish: outcome.swish,
      rimHits: outcome.rimHits,
      boardHits: outcome.boardHits,
      money,
      points,
      endX: outcome.endX,
      endZ: outcome.endZ,
    };
    next.shots[by] = [...(s.shots[by] ?? []), record];
    next.score[by] = (s.score[by] ?? 0) + points;
    if (outcome.made) next.made[by] = (s.made[by] ?? 0) + 1;
    next.last = record;
    next.shotsLeft = s.shotsLeft - 1;
    if (next.shotsLeft > 0) return next;

    next.shotsLeft = s.shotsPerRack;
    if (s.turn === 0) {
      next.turn = 1;
      return next;
    }
    // Both players have shot this rack.
    if (s.rack + 1 >= s.racks) {
      const [p, q] = s.players;
      const sp = next.score[p] ?? 0;
      const sq = next.score[q] ?? 0;
      return {
        ...next,
        over: true,
        winner: sp === sq ? null : sp > sq ? p : q,
        shotsLeft: 0,
      };
    }
    next.rack = s.rack + 1;
    next.turn = 0;
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
    // Everything on the court is public; only the RNG state (which sets the next wobble) is not.
    const { rng: _rng, ...visible } = s;
    return visible;
  },
};
