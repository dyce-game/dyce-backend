import { z } from 'zod';
import type { GameEngine, GameResult, PlayerId, ValidateResult } from '../contract.ts';
import { nextInt, seedRng } from '../rng.ts';
import { HOLES, MAX_STROKES, MINI_GOLF_COURSE, miniGolfHole } from './course.ts';
import { AIM_MAX, POWER_MAX, simulatePutt, type PuttInput } from './physics.ts';

/**
 * Mini Golf (2-4 players, async). Nine top-down holes, stroke play: fewest strokes over the nine wins, equal
 * is a draw. A hole ends for a player when they hole out, or when their sixth stroke is played (the hole
 * then scores 6). Rules decided here are in docs/DECISIONS.md (ADR-032).
 *
 *  - A turn is a player's WHOLE hole: they keep putting until they hole out or reach six strokes, then the
 *    next player (seat order) plays the same hole; when everyone is done the next hole starts. Balls do not
 *    collide with each other, so order changes nothing about the physics, and a chat game does not have
 *    to wait for an opponent between every stroke.
 *  - Input is only `{dx, dy, power}` (integers). The direction is the vector (dx, dy), normalised with a
 *    sqrt, never an angle. There is no jitter: the same putt from the same spot always does the same thing.
 *  - Because the physics is exact, a stroke could be copied. So until you finish a hole yourself, `view()`
 *    shows you only your own putts on it; once you are done (or the hole is over) everyone's are visible.
 *  - Holes are hand-made (course.ts); the seed decides which of them are mirrored left-to-right.
 */
export type MiniGolfCfg = object;

export type MiniGolfPutt = {
  seq: number;
  hole: number;
  by: PlayerId;
  /** 1-based stroke number on this hole for this player. */
  stroke: number;
  /** Where the ball started and ended, integer millimetres. */
  from: { x: number; y: number };
  to: { x: number; y: number };
  input: PuttInput;
  sunk: boolean;
  bounces: number;
};

export type MiniGolfState = {
  players: PlayerId[];
  /** Per hole: is it played mirrored? (from the seed) */
  mirror: boolean[];
  /** Current hole, 0-8. Equals HOLES when the game is over. */
  hole: number;
  /** Index into `players` of whoever is playing the hole now. */
  turn: number;
  /** Current-hole ball positions, integer millimetres. */
  ball: Record<PlayerId, { x: number; y: number }>;
  /** Current-hole stroke counts and whether each player has finished the hole. */
  strokes: Record<PlayerId, number>;
  done: Record<PlayerId, boolean>;
  sunk: Record<PlayerId, boolean>;
  /** Putts played on the current hole, in order. */
  log: MiniGolfPutt[];
  /** Strokes per completed hole, per player. */
  card: Record<PlayerId, number[]>;
  /** The most recent putt (for animation). It may belong to a hole that just finished. */
  last: MiniGolfPutt | null;
  over: boolean;
  seq: number;
};

export type MiniGolfAction = { kind: 'putt'; dx: number; dy: number; power: number };

export const miniGolfActionSchema: z.ZodType<MiniGolfAction> = z.object({
  kind: z.literal('putt'),
  dx: z.number().int().min(-AIM_MAX).max(AIM_MAX),
  dy: z.number().int().min(-AIM_MAX).max(AIM_MAX),
  power: z.number().int().min(1).max(POWER_MAX),
});

const teeMm = (hole: number, mirror: boolean[]): { x: number; y: number } => {
  const h = miniGolfHole(hole, mirror[hole] === true);
  return { x: Math.round(h.tee.x * 10), y: Math.round(h.tee.y * 10) };
};

function startHole(s: MiniGolfState, hole: number): MiniGolfState {
  const tee = teeMm(hole, s.mirror);
  return {
    ...s,
    hole,
    turn: 0,
    ball: Object.fromEntries(s.players.map((p) => [p, { ...tee }])),
    strokes: Object.fromEntries(s.players.map((p) => [p, 0])),
    done: Object.fromEntries(s.players.map((p) => [p, false])),
    sunk: Object.fromEntries(s.players.map((p) => [p, false])),
    log: [],
  };
}

/** A player's total over the completed holes. */
export const miniGolfTotal = (s: MiniGolfState, p: PlayerId): number =>
  (s.card[p] ?? []).reduce((a, b) => a + b, 0);

/** Par for each hole (the course is fixed; mirroring does not change it). */
export const MINI_GOLF_PARS: readonly number[] = MINI_GOLF_COURSE.map((h) => h.par);

export const miniGolfEngine: GameEngine<MiniGolfState, MiniGolfAction, MiniGolfCfg> = {
  slug: 'mini-golf',
  actionSchema: miniGolfActionSchema,
  timers: { turnMs: 60_000 },

  init(players, seed) {
    if (players.length < 2 || players.length > 4) throw new Error('Mini Golf needs 2 to 4 players');
    if (new Set(players).size !== players.length) throw new Error('Duplicate players');
    let rng = seedRng(seed);
    const mirror: boolean[] = [];
    for (let i = 0; i < HOLES; i++) {
      let m: number;
      [m, rng] = nextInt(rng, 2);
      mirror.push(m === 1);
    }
    const base: MiniGolfState = {
      players: [...players],
      mirror,
      hole: 0,
      turn: 0,
      ball: {},
      strokes: {},
      done: {},
      sunk: {},
      log: [],
      card: Object.fromEntries(players.map((p) => [p, []])),
      last: null,
      over: false,
      seq: 0,
    };
    return startHole(base, 0);
  },

  currentPlayers(s) {
    return s.over ? [] : [s.players[s.turn] as PlayerId];
  },

  validate(s, by, a): ValidateResult {
    if (s.over) return { ok: false, code: 'game_over' };
    if (s.players[s.turn] !== by) return { ok: false, code: 'not_your_turn' };
    if (
      !Number.isInteger(a.dx) ||
      !Number.isInteger(a.dy) ||
      Math.abs(a.dx) > AIM_MAX ||
      Math.abs(a.dy) > AIM_MAX
    ) {
      return { ok: false, code: 'bad_aim' };
    }
    if (a.dx === 0 && a.dy === 0) return { ok: false, code: 'no_direction' };
    if (!Number.isInteger(a.power) || a.power < 1 || a.power > POWER_MAX) {
      return { ok: false, code: 'bad_power' };
    }
    return { ok: true };
  },

  apply(s, by, a) {
    const from = s.ball[by] as { x: number; y: number };
    const hole = miniGolfHole(s.hole, s.mirror[s.hole] === true);
    const input: PuttInput = { dx: a.dx, dy: a.dy, power: a.power };
    const { outcome } = simulatePutt(hole, from.x, from.y, input);
    const stroke = (s.strokes[by] ?? 0) + 1;
    const finished = outcome.sunk || stroke >= MAX_STROKES;
    const putt: MiniGolfPutt = {
      seq: s.seq + 1,
      hole: s.hole,
      by,
      stroke,
      from: { x: from.x, y: from.y },
      to: { x: outcome.endX, y: outcome.endY },
      input,
      sunk: outcome.sunk,
      bounces: outcome.bounces,
    };
    let next: MiniGolfState = {
      ...s,
      ball: { ...s.ball, [by]: putt.to },
      strokes: { ...s.strokes, [by]: stroke },
      done: { ...s.done, [by]: finished },
      sunk: { ...s.sunk, [by]: outcome.sunk },
      log: [...s.log, putt],
      last: putt,
      seq: s.seq + 1,
    };
    if (!finished) return next;

    // The mover is done: the next player who has not finished plays, or the hole is complete.
    const n = s.players.length;
    for (let k = 1; k <= n; k++) {
      const i = (s.turn + k) % n;
      if (!next.done[s.players[i] as PlayerId]) {
        return { ...next, turn: i };
      }
    }
    next = {
      ...next,
      card: Object.fromEntries(
        s.players.map((p) => [p, [...(s.card[p] ?? []), next.strokes[p] as number]]),
      ),
    };
    if (s.hole + 1 >= HOLES) return { ...next, hole: HOLES, over: true };
    return startHole(next, s.hole + 1);
  },

  isTerminal(s) {
    return s.over;
  },

  result(s): GameResult {
    if (!s.over) return { placements: [], draw: false };
    const groups = new Map<number, PlayerId[]>();
    for (const p of s.players) {
      const t = miniGolfTotal(s, p);
      groups.set(t, [...(groups.get(t) ?? []), p]);
    }
    // Fewest strokes first.
    const placements = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, ps]) => ps);
    return { placements, draw: (placements[0]?.length ?? 0) > 1 };
  },

  view(s, viewer) {
    const me = viewer === 'spectator' ? null : viewer;
    const iAmDone = me !== null && s.done[me] === true;
    const canSee = (p: MiniGolfPutt): boolean =>
      s.over || p.hole < s.hole || p.by === me || iAmDone;
    const lastVisible = s.last !== null && canSee(s.last);
    return {
      players: s.players,
      mirror: s.mirror,
      pars: MINI_GOLF_PARS,
      hole: s.hole,
      holes: HOLES,
      maxStrokes: MAX_STROKES,
      turn: s.over ? null : s.players[s.turn],
      over: s.over,
      // Only the viewer's own ball; the others' positions come with their putts once visible.
      ball: me !== null && !s.over ? { [me]: s.ball[me] } : {},
      // Stroke counts of players who have finished the hole, and your own live count.
      strokes: Object.fromEntries(
        s.players.map((p) => [p, s.done[p] === true || p === me ? (s.strokes[p] ?? 0) : null]),
      ),
      done: s.done,
      sunk: Object.fromEntries(
        s.players.map((p) => [p, s.done[p] === true ? s.sunk[p] === true : null]),
      ),
      log: s.log.filter(canSee),
      card: s.card,
      totals: Object.fromEntries(s.players.map((p) => [p, miniGolfTotal(s, p)])),
      last: lastVisible ? s.last : null,
    };
  },
};

/**
 * The putt to play for a player who ran out of time (or a bot): straight at the cup with the power that
 * would just reach it on grass. Always legal while the game is running; the ball may still miss.
 */
export function miniGolfAutoAction(
  s: MiniGolfState,
  by: PlayerId = s.players[s.turn] as PlayerId,
): MiniGolfAction {
  const ball = s.ball[by] as { x: number; y: number };
  const hole = miniGolfHole(s.hole, s.mirror[s.hole] === true);
  const dx = Math.round(hole.cup.x * 10 - ball.x);
  const dy = Math.round(hole.cup.y * 10 - ball.y);
  if (dx === 0 && dy === 0) return { kind: 'putt', dx: 0, dy: -1, power: 1 };
  const k = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / AIM_MAX);
  const cm = Math.sqrt(dx * dx + dy * dy) / 10;
  // v = sqrt(2 * decel * distance), decel 90 cm/s², then back to power units.
  const power = Math.max(1, Math.min(POWER_MAX, Math.round(Math.sqrt(2 * 90 * cm) / 0.6)));
  return { kind: 'putt', dx: Math.round(dx / k), dy: Math.round(dy / k), power };
}
