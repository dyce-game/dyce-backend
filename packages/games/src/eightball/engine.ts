import { z } from 'zod';
import type { GameEngine, GameResult, PlayerId, ValidateResult } from '../contract.ts';
import { nextU32, seedRng, shuffle, type RngState } from '../rng.ts';
import {
  ANGLE_MAX,
  BALL_R,
  DMM,
  POCKETS,
  POWER_MAX,
  SPIN_MAX,
  TABLE_L,
  TABLE_W,
  simulateShot,
  type PocketEvent,
  type TableBall,
} from './physics.ts';

/**
 * 8 Ball (2 players, async). Standard 8-ball with the house rules decided in backend ADR-034:
 *
 *  - 15 object balls racked from the seeded RNG (8 in the middle, a solid and a stripe in the back corners).
 *    `players[0]` breaks with the cue ball anywhere behind the head string.
 *  - The table is OPEN until a player legally pockets balls of one group (solids 1–7 / stripes 9–15) on a shot
 *    after the break; that player gets that group. Pocketing both groups in one shot keeps it open. The break
 *    never assigns groups.
 *  - You keep shooting while you legally pocket one of your balls (any ball on an open table). Otherwise the
 *    turn passes. Balls pocketed by a foul stay down, except the cue ball and the 8.
 *  - FOUL: cue ball pocketed, no ball touched, the first ball touched isn't yours (the 8 only once all your
 *    balls are down; on an open table anything but the 8), or nothing was pocketed and no ball reached a
 *    cushion after the first contact. A legal break must pocket a ball or send 4 object balls to a cushion.
 *    After a foul the opponent has BALL IN HAND anywhere on the table.
 *  - The 8: shot once all your balls are down, its pocket must be CALLED in the action (`call.pocket`); only the
 *    8 needs a call. Pocketing it legally wins. Pocketing it early, in the wrong pocket, or with a foul (a
 *    scratch included) loses. On the break the 8 goes down → re-rack (same breaker, unless they scratched).
 *  - `maxShots` (default 120 shots in all) ends the game: fewer own balls left wins, equal or open → draw.
 *
 * Input is only `{angle, power, spinX, spinY}` (+ `place` for ball in hand, + `call` for the 8): integers. The
 * server simulates with `physics.ts`; the result is final. The only randomness is the rack.
 */
export type EightBallCfg = { maxShots?: number };

export type EightBallGroup = 'solid' | 'stripe';

export const EIGHT_BALL_DEFAULT_MAX_SHOTS = 120;
/** Head string and foot spot, dmm. Ball in hand on the break must be at or behind the head string. */
export const EIGHT_BALL_HEAD_X = 5600;
const FOOT_X = 16800;
const CENTRE_Y = (TABLE_W / 2) * DMM;

export const eightBallGroupOf = (id: number): EightBallGroup | 'eight' | 'cue' =>
  id === 0 ? 'cue' : id === 8 ? 'eight' : id < 8 ? 'solid' : 'stripe';

export type EightBallFoul =
  'scratch' | 'no_contact' | 'wrong_first_contact' | 'no_rail' | 'bad_break';

export type EightBallEnd =
  'eight_pocketed' | 'eight_early' | 'eight_wrong_pocket' | 'eight_foul' | 'max_shots';

export type EightBallShotRecord = {
  seq: number;
  by: PlayerId;
  input: { angle: number; power: number; spinX: number; spinY: number };
  /** The table before the shot (cue ball where it was struck from): enough to replay the shot. */
  from: TableBall[];
  firstContact: number | null;
  pocketed: PocketEvent[];
  fouls: EightBallFoul[];
  railAfterContact: number;
  wasBreak: boolean;
  /** The table was re-racked because the 8 went down on the break. */
  reRack: boolean;
  /** The shooter keeps the table. */
  keepsTurn: boolean;
  steps: number;
};

export type EightBallState = {
  players: [PlayerId, PlayerId];
  maxShots: number;
  /** Balls on the table, by id, integer dmm (0.1 mm). Always includes the cue ball (id 0). */
  balls: TableBall[];
  /** Object balls pocketed so far, in order. */
  pocketed: number[];
  /** null = open table. */
  groups: Record<PlayerId, EightBallGroup> | null;
  turn: 0 | 1;
  /** Where the cue ball may be placed: not at all, behind the head string (break), or anywhere (after a foul). */
  hand: 'none' | 'kitchen' | 'anywhere';
  /** The next shot is the break. */
  breaking: boolean;
  shots: number;
  over: boolean;
  winner: PlayerId | null;
  end: EightBallEnd | null;
  last: EightBallShotRecord | null;
  seq: number;
  rng: RngState;
};

export type EightBallAction = {
  kind: 'shoot';
  angle: number;
  power: number;
  spinX: number;
  spinY: number;
  /** Where to put the cue ball first (dmm). Only with ball in hand; optional (it shoots from where it is). */
  place?: { x: number; y: number };
  /** The pocket (0–5) the 8 is called to. Required for the 8-ball shot, ignored otherwise. */
  call?: { pocket: number };
};

const dmmAxis = z
  .number()
  .int()
  .min(0)
  .max(TABLE_L * DMM);
export const eightBallActionSchema: z.ZodType<EightBallAction> = z.object({
  kind: z.literal('shoot'),
  angle: z
    .number()
    .int()
    .min(0)
    .max(ANGLE_MAX - 1),
  power: z.number().int().min(0).max(POWER_MAX),
  spinX: z.number().int().min(-SPIN_MAX).max(SPIN_MAX),
  spinY: z.number().int().min(-SPIN_MAX).max(SPIN_MAX),
  place: z.object({ x: dmmAxis, y: dmmAxis }).optional(),
  call: z.object({ pocket: z.number().int().min(0).max(5) }).optional(),
});

// ---------------------------------------------------------------------------------------------
// Rack and placement (integer dmm)

const ROW_STEP = 500; // along x, between rows
const COL_STEP = 286; // along y, between ball centres in a row (touching = 285, a hair of gap)

/** Slot positions of the triangle, row by row from the apex. */
const RACK_SLOTS: { x: number; y: number }[] = (() => {
  const out: { x: number; y: number }[] = [];
  for (let row = 0; row < 5; row++) {
    for (let i = 0; i <= row; i++) {
      out.push({ x: FOOT_X + row * ROW_STEP, y: CENTRE_Y + (2 * i - row) * COL_STEP });
    }
  }
  return out;
})();
const SLOT_EIGHT = 4; // middle of the third row
const SLOT_CORNERS: [number, number] = [10, 14]; // back-row corners

/** A fresh rack plus the cue ball on the head spot, and the advanced RNG. */
function rackBalls(rng: RngState): [TableBall[], RngState] {
  const others = [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15];
  const [mixed, r1] = shuffle(rng, others);
  const [flip, r2] = nextU32(r1);
  // One solid and one stripe in the two back corners; the rest in shuffled order.
  const solid = mixed.find((id) => id < 8) as number;
  const stripe = mixed.find((id) => id > 8) as number;
  const rest = mixed.filter((id) => id !== solid && id !== stripe);
  const corners = flip % 2 === 0 ? [solid, stripe] : [stripe, solid];
  const slotBall: number[] = new Array<number>(15).fill(0);
  slotBall[SLOT_EIGHT] = 8;
  slotBall[SLOT_CORNERS[0]] = corners[0] as number;
  slotBall[SLOT_CORNERS[1]] = corners[1] as number;
  let k = 0;
  for (let slot = 0; slot < 15; slot++) {
    if (slotBall[slot] === 0) slotBall[slot] = rest[k++] as number;
  }
  const balls: TableBall[] = [{ id: 0, x: EIGHT_BALL_HEAD_X, y: CENTRE_Y }];
  slotBall.forEach((id, slot) => {
    const p = RACK_SLOTS[slot] as { x: number; y: number };
    balls.push({ id, x: p.x, y: p.y });
  });
  return [balls.sort((a, b) => a.id - b.id), r2];
}

/** Is (x, y) a legal place for the cue ball, given the other balls? (dmm) */
export function eightBallCanPlace(
  others: readonly TableBall[],
  x: number,
  y: number,
  hand: 'kitchen' | 'anywhere',
): boolean {
  const lo = BALL_R * DMM;
  if (x < lo || x > (TABLE_L - BALL_R) * DMM) return false;
  if (y < lo || y > (TABLE_W - BALL_R) * DMM) return false;
  if (hand === 'kitchen' && x > EIGHT_BALL_HEAD_X) return false;
  for (const p of POCKETS) {
    const dx = x - p.x * DMM;
    const dy = y - p.y * DMM;
    const r = (p.r + 1) * DMM;
    if (dx * dx + dy * dy < r * r) return false;
  }
  const min = 2 * BALL_R * DMM + DMM; // a millimetre of clearance
  for (const b of others) {
    if (b.id === 0) continue;
    const dx = x - b.x;
    const dy = y - b.y;
    if (dx * dx + dy * dy < min * min) return false;
  }
  return true;
}

/** Where the cue ball goes after a scratch: the head spot, or the nearest free spot to it. Deterministic. */
function defaultCueSpot(others: readonly TableBall[]): { x: number; y: number } {
  if (eightBallCanPlace(others, EIGHT_BALL_HEAD_X, CENTRE_Y, 'anywhere')) {
    return { x: EIGHT_BALL_HEAD_X, y: CENTRE_Y };
  }
  const cands: { x: number; y: number; d: number }[] = [];
  for (let x = 700; x <= 21700; x += 500) {
    for (let y = 700; y <= 10500; y += 500) {
      const dx = x - EIGHT_BALL_HEAD_X;
      const dy = y - CENTRE_Y;
      cands.push({ x, y, d: dx * dx + dy * dy });
    }
  }
  cands.sort((a, b) => a.d - b.d || a.x - b.x || a.y - b.y);
  for (const c of cands) {
    if (eightBallCanPlace(others, c.x, c.y, 'anywhere')) return { x: c.x, y: c.y };
  }
  return { x: EIGHT_BALL_HEAD_X, y: CENTRE_Y };
}

// ---------------------------------------------------------------------------------------------
// Engine

const other = (s: EightBallState, p: PlayerId): PlayerId =>
  s.players[0] === p ? s.players[1] : s.players[0];

/** Balls of `group` still on the table. */
const left = (balls: readonly TableBall[], group: EightBallGroup): number =>
  balls.filter((b) => eightBallGroupOf(b.id) === group).length;

/** The group this player must be shooting at, or null on an open table. */
export const eightBallGroupOfPlayer = (s: EightBallState, p: PlayerId): EightBallGroup | null =>
  s.groups?.[p] ?? null;

/** Is this player now on the 8 (their group is assigned and all of it is down)? */
export const eightBallOnEight = (s: EightBallState, p: PlayerId): boolean => {
  const g = eightBallGroupOfPlayer(s, p);
  return g !== null && left(s.balls, g) === 0;
};

function settleByCount(s: EightBallState): EightBallState {
  const [a, b] = s.players;
  let winner: PlayerId | null = null;
  if (s.groups) {
    const la = left(s.balls, s.groups[a] as EightBallGroup);
    const lb = left(s.balls, s.groups[b] as EightBallGroup);
    if (la !== lb) winner = la < lb ? a : b;
  }
  return { ...s, over: true, winner, end: 'max_shots', hand: 'none' };
}

export const eightBallEngine: GameEngine<EightBallState, EightBallAction, EightBallCfg> = {
  slug: 'eight-ball',
  actionSchema: eightBallActionSchema,
  timers: { turnMs: 90_000 },

  init(players, seed, cfg) {
    if (players.length !== 2) throw new Error('8 Ball is a two-player game');
    if (players[0] === players[1]) throw new Error('Duplicate players');
    const maxShots = cfg?.maxShots ?? EIGHT_BALL_DEFAULT_MAX_SHOTS;
    if (!Number.isInteger(maxShots) || maxShots < 10 || maxShots > 400) {
      throw new Error('Invalid maxShots');
    }
    const [balls, rng] = rackBalls(seedRng(seed));
    const [a, b] = players as [PlayerId, PlayerId];
    return {
      players: [a, b],
      maxShots,
      balls,
      pocketed: [],
      groups: null,
      turn: 0,
      hand: 'kitchen',
      breaking: true,
      shots: 0,
      over: false,
      winner: null,
      end: null,
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
    if (!Number.isInteger(a.angle) || a.angle < 0 || a.angle >= ANGLE_MAX) {
      return { ok: false, code: 'bad_angle' };
    }
    if (!Number.isInteger(a.power) || a.power < 0 || a.power > POWER_MAX) {
      return { ok: false, code: 'bad_power' };
    }
    if (
      !Number.isInteger(a.spinX) ||
      !Number.isInteger(a.spinY) ||
      a.spinX * a.spinX + a.spinY * a.spinY > SPIN_MAX * SPIN_MAX
    ) {
      return { ok: false, code: 'bad_spin' };
    }
    if (a.place !== undefined) {
      if (s.hand === 'none') return { ok: false, code: 'no_ball_in_hand' };
      if (
        !Number.isInteger(a.place.x) ||
        !Number.isInteger(a.place.y) ||
        !eightBallCanPlace(s.balls, a.place.x, a.place.y, s.hand)
      ) {
        return { ok: false, code: 'bad_placement' };
      }
    }
    if (eightBallOnEight(s, by)) {
      if (a.call === undefined) return { ok: false, code: 'call_required' };
      if (!Number.isInteger(a.call.pocket) || a.call.pocket < 0 || a.call.pocket > 5) {
        return { ok: false, code: 'bad_call' };
      }
    }
    return { ok: true };
  },

  apply(s, by, a) {
    const me = by;
    const foe = other(s, by);
    const wasBreak = s.breaking;
    const myGroup = eightBallGroupOfPlayer(s, me);
    const onEight = eightBallOnEight(s, me);

    // Put the cue ball where the shooter wants it, then shoot.
    const from: TableBall[] = s.balls.map((b) =>
      b.id === 0 && a.place ? { id: 0, x: a.place.x, y: a.place.y } : { ...b },
    );
    const input = { angle: a.angle, power: a.power, spinX: a.spinX, spinY: a.spinY };
    const { outcome } = simulateShot(from, input);

    const potted = outcome.pocketed.filter((p) => p.id !== 0);
    const eight = outcome.pocketed.find((p) => p.id === 8);
    const fouls: EightBallFoul[] = [];
    if (outcome.cuePocketed) fouls.push('scratch');
    if (outcome.firstContact === null) {
      fouls.push('no_contact');
    } else {
      if (!wasBreak) {
        const fc = outcome.firstContact;
        const legalFirst = onEight
          ? fc === 8
          : myGroup !== null
            ? eightBallGroupOf(fc) === myGroup
            : fc !== 8;
        if (!legalFirst) fouls.push('wrong_first_contact');
        if (potted.length === 0 && outcome.railAfterContact === 0) fouls.push('no_rail');
      }
    }
    if (wasBreak && potted.length === 0 && outcome.objectBallsOnRail < 4) fouls.push('bad_break');

    const next: EightBallState = {
      ...s,
      balls: outcome.balls,
      pocketed: [...s.pocketed, ...potted.map((p) => p.id)],
      shots: s.shots + 1,
      seq: s.seq + 1,
      breaking: false,
    };
    const record: EightBallShotRecord = {
      seq: next.seq,
      by: me,
      input,
      from,
      firstContact: outcome.firstContact,
      pocketed: outcome.pocketed,
      fouls,
      railAfterContact: outcome.railAfterContact,
      wasBreak,
      reRack: false,
      keepsTurn: false,
      steps: outcome.steps,
    };

    // The 8 on the break: re-rack. Same breaker, unless they scratched too.
    if (wasBreak && eight) {
      const [balls, rng] = rackBalls(s.rng);
      const breaker = fouls.includes('scratch') ? foe : me;
      record.reRack = true;
      record.keepsTurn = breaker === me;
      return {
        ...next,
        balls,
        rng,
        pocketed: [],
        groups: null,
        turn: breaker === s.players[0] ? 0 : 1,
        hand: 'kitchen',
        breaking: true,
        last: record,
      };
    }

    // The 8 anywhere else ends the game.
    if (eight) {
      const calledRight = a.call !== undefined && a.call.pocket === eight.pocket;
      const legal = fouls.length === 0 && onEight && calledRight;
      const end: EightBallEnd = legal
        ? 'eight_pocketed'
        : !onEight
          ? 'eight_early'
          : fouls.length > 0
            ? 'eight_foul'
            : 'eight_wrong_pocket';
      return {
        ...next,
        over: true,
        winner: legal ? me : foe,
        end,
        hand: 'none',
        last: record,
      };
    }

    // Groups: the first legal pocketing of one group on an open table, after the break.
    let groups = s.groups;
    if (groups === null && !wasBreak && fouls.length === 0 && potted.length > 0) {
      const types = new Set(potted.map((p) => eightBallGroupOf(p.id)));
      if (types.size === 1) {
        const mine = [...types][0] as EightBallGroup;
        const theirs: EightBallGroup = mine === 'solid' ? 'stripe' : 'solid';
        groups = { [me]: mine, [foe]: theirs };
      }
    }
    next.groups = groups;

    const mineNow = groups?.[me] ?? null;
    const keepsTurn =
      fouls.length === 0 &&
      potted.length > 0 &&
      (mineNow === null || potted.some((p) => eightBallGroupOf(p.id) === mineNow));
    record.keepsTurn = keepsTurn;
    next.last = record;

    // A scratched cue ball comes back on the table for the next shooter to place.
    if (outcome.cuePocketed) {
      const spot = defaultCueSpot(next.balls);
      next.balls = [{ id: 0, x: spot.x, y: spot.y }, ...next.balls].sort((p, q) => p.id - q.id);
    }
    if (keepsTurn) {
      next.hand = 'none';
    } else {
      next.turn = s.turn === 0 ? 1 : 0;
      next.hand = fouls.length > 0 ? 'anywhere' : 'none';
    }

    if (next.shots >= next.maxShots) return settleByCount(next);
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
    // The whole table is public; only the RNG state (which makes the next rack) is not.
    const { rng: _rng, ...visible } = s;
    return visible;
  },
};
