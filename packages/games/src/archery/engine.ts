import { z } from 'zod';
import type { GameEngine, GameResult, PlayerId, ValidateResult } from '../contract.ts';
import { nextInt, seedRng, type RngState } from '../rng.ts';
import { AIM_MAX, DRAW_MAX, flyArrow, type ArrowInput } from './physics.ts';

/**
 * Archery (2 players, async). Three ends of three arrows (configurable). In each end both archers shoot the
 * same wind, drawn once per end from the seeded RNG; the archer who shoots first alternates each end. Input is
 * only `{aimX, aimY, draw}` (integers): the aim point in mm on the target face and how far the string is drawn
 * (0–1000). The server adds a hand tremor from the seeded RNG (smaller the fuller the draw), flies the arrow
 * with `physics.ts`, and scores it on a 10-ring face. Decisions are in docs/DECISIONS.md (ADR-034).
 *
 *  - Rings: 10 (innermost) down to 1, 40 mm apart, the face is 800 mm across, anything outside scores 0.
 *    The inner 10 (within 20 mm) is an X: it scores 10 and counts as a tie-break.
 *  - The wind of an end is visible to both players for that end; future ends' winds are hidden by `view()`.
 *  - Most points wins; equal points → more Xs; still equal → draw.
 */
export type ArcheryCfg = {
  ends?: number;
  arrowsPerEnd?: number;
};

export const ARCHERY_RING_MM = 40;
export const ARCHERY_X_MM = 20;
export const ARCHERY_WIND_MAX_DMS = 80;

export type ArcheryArrowRecord = {
  seq: number;
  by: PlayerId;
  end: number;
  input: ArrowInput;
  /** The tremor that was added to the aim, in mm. */
  tremor: { x: number; y: number };
  /** Where the arrow landed on the target face, mm from the centre. */
  x: number;
  y: number;
  score: number;
  isX: boolean;
  /** The end's wind in 0.1 m/s (positive blows to the archer's right). */
  windDms: number;
  flightMs: number;
};

export type ArcheryState = {
  players: [PlayerId, PlayerId];
  ends: number;
  arrowsPerEnd: number;
  /** Wind for each end in 0.1 m/s. `view()` only reveals the current and past ends. */
  winds: number[];
  /** Index of the current end (0-based). */
  end: number;
  /** Index into `players` of the archer who shoots first this end. */
  starter: 0 | 1;
  /** Index into `players` of the current archer. */
  turn: 0 | 1;
  arrowsLeft: number;
  arrows: Record<PlayerId, ArcheryArrowRecord[]>;
  score: Record<PlayerId, number>;
  xs: Record<PlayerId, number>;
  over: boolean;
  winner: PlayerId | null;
  last: ArcheryArrowRecord | null;
  seq: number;
  rng: RngState;
};

export type ArcheryAction = { kind: 'shoot'; aimX: number; aimY: number; draw: number };

export const archeryActionSchema: z.ZodType<ArcheryAction> = z.object({
  kind: z.literal('shoot'),
  aimX: z.number().int().min(-AIM_MAX).max(AIM_MAX),
  aimY: z.number().int().min(-AIM_MAX).max(AIM_MAX),
  draw: z.number().int().min(0).max(DRAW_MAX),
});

/** Tremor half-range in mm for a draw: 6 mm at full draw up to 26 mm at no draw. */
export const archeryTremor = (draw: number): number => 6 + Math.floor((DRAW_MAX - draw) / 50);

/** Score a landing point (integer mm from the centre). Pure. */
export function archeryScore(x: number, y: number): { score: number; isX: boolean } {
  const d2 = x * x + y * y;
  if (d2 <= ARCHERY_X_MM * ARCHERY_X_MM) return { score: 10, isX: true };
  for (let n = 1; n <= 10; n++) {
    const r = ARCHERY_RING_MM * n;
    if (d2 <= r * r) return { score: 11 - n, isX: false };
  }
  return { score: 0, isX: false };
}

const other = (s: ArcheryState, p: PlayerId): PlayerId =>
  s.players[0] === p ? s.players[1] : s.players[0];

function settle(s: ArcheryState): ArcheryState {
  const [a, b] = s.players;
  const sa = s.score[a] ?? 0;
  const sb = s.score[b] ?? 0;
  const xa = s.xs[a] ?? 0;
  const xb = s.xs[b] ?? 0;
  let winner: PlayerId | null = null;
  if (sa !== sb) winner = sa > sb ? a : b;
  else if (xa !== xb) winner = xa > xb ? a : b;
  return { ...s, over: true, winner, arrowsLeft: 0 };
}

/** Two uniform draws in [0, w] summed, minus w: a triangular wobble on [-w, w]. Always two draws. */
function tri(rng: RngState, w: number): [number, RngState] {
  const [u, r1] = nextInt(rng, w + 1);
  const [v, r2] = nextInt(r1, w + 1);
  return [u + v - w, r2];
}

export const archeryEngine: GameEngine<ArcheryState, ArcheryAction, ArcheryCfg> = {
  slug: 'archery',
  actionSchema: archeryActionSchema,
  timers: { turnMs: 60_000 },

  init(players, seed, cfg) {
    if (players.length !== 2) throw new Error('Archery is a two-player game');
    if (players[0] === players[1]) throw new Error('Duplicate players');
    const ends = cfg?.ends ?? 3;
    const arrowsPerEnd = cfg?.arrowsPerEnd ?? 3;
    if (!Number.isInteger(ends) || ends < 1 || ends > 10) throw new Error('Invalid ends');
    if (!Number.isInteger(arrowsPerEnd) || arrowsPerEnd < 1 || arrowsPerEnd > 6) {
      throw new Error('Invalid arrowsPerEnd');
    }
    const [a, b] = players as [PlayerId, PlayerId];
    // All winds first, in a fixed order, so they never depend on how earlier arrows were shot.
    let rng = seedRng(seed);
    const winds: number[] = [];
    for (let i = 0; i < ends; i++) {
      const [w, next] = nextInt(rng, 2 * ARCHERY_WIND_MAX_DMS + 1);
      rng = next;
      winds.push(w - ARCHERY_WIND_MAX_DMS);
    }
    return {
      players: [a, b],
      ends,
      arrowsPerEnd,
      winds,
      end: 0,
      starter: 0,
      turn: 0,
      arrowsLeft: arrowsPerEnd,
      arrows: { [a]: [], [b]: [] },
      score: { [a]: 0, [b]: 0 },
      xs: { [a]: 0, [b]: 0 },
      over: false,
      winner: null,
      last: null,
      seq: 0,
      rng,
    };
  },

  currentPlayers(s) {
    return s.over ? [] : [s.players[s.turn]];
  },

  validate(s, by, a): ValidateResult {
    if (s.over) return { ok: false, code: 'game_over' };
    if (s.players[s.turn] !== by) return { ok: false, code: 'not_your_turn' };
    if (
      !Number.isInteger(a.aimX) ||
      !Number.isInteger(a.aimY) ||
      Math.abs(a.aimX) > AIM_MAX ||
      Math.abs(a.aimY) > AIM_MAX
    ) {
      return { ok: false, code: 'bad_aim' };
    }
    if (!Number.isInteger(a.draw) || a.draw < 0 || a.draw > DRAW_MAX) {
      return { ok: false, code: 'bad_draw' };
    }
    return { ok: true };
  },

  apply(s, by, a) {
    const next: ArcheryState = {
      ...s,
      arrows: { ...s.arrows },
      score: { ...s.score },
      xs: { ...s.xs },
      seq: s.seq + 1,
    };

    // Tremor: four draws per arrow, always.
    const w = archeryTremor(a.draw);
    const [tx, r1] = tri(s.rng, w);
    const [ty, rng] = tri(r1, w);
    next.rng = rng;

    const windDms = s.winds[s.end] as number;
    const flight = flyArrow({ aimX: a.aimX, aimY: a.aimY, draw: a.draw }, windDms, {
      x: tx,
      y: ty,
    });
    const { score, isX } = archeryScore(flight.x, flight.y);
    const record: ArcheryArrowRecord = {
      seq: next.seq,
      by,
      end: s.end,
      input: { aimX: a.aimX, aimY: a.aimY, draw: a.draw },
      tremor: { x: tx, y: ty },
      x: flight.x,
      y: flight.y,
      score,
      isX,
      windDms,
      flightMs: flight.flightMs,
    };
    next.arrows[by] = [...(s.arrows[by] ?? []), record];
    next.score[by] = (s.score[by] ?? 0) + score;
    if (isX) next.xs[by] = (s.xs[by] ?? 0) + 1;
    next.last = record;
    next.arrowsLeft = s.arrowsLeft - 1;
    if (next.arrowsLeft > 0) return next;

    // This archer's arrows for the end are done.
    const second = (1 - s.starter) as 0 | 1;
    if (s.turn === s.starter) {
      next.turn = second;
      next.arrowsLeft = s.arrowsPerEnd;
      return next;
    }
    // The end is over.
    if (s.end + 1 >= s.ends) return settle(next);
    next.end = s.end + 1;
    next.starter = (1 - s.starter) as 0 | 1;
    next.turn = next.starter;
    next.arrowsLeft = s.arrowsPerEnd;
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
    // Arrows and scores are public. Hidden: the RNG state, and the winds of ends not yet reached.
    const { rng: _rng, winds, ...visible } = s;
    return { ...visible, winds: winds.slice(0, s.over ? s.ends : s.end + 1) };
  },
};
