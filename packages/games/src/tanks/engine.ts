import { z } from 'zod';
import type { GameEngine, GameResult, PlayerId, ValidateResult } from '../contract.ts';
import { nextInt, seedRng, type RngState } from '../rng.ts';
import {
  ANGLE_MAX,
  COLS,
  POWER_MAX,
  TANK_HP,
  WEAPONS,
  WIND_MAX,
  simulateShot,
  type Impact,
  type Weapon,
} from './physics.ts';

/**
 * Tanks (2 players, async). Two tanks on seeded, destructible ground. On your turn you choose an angle
 * (0 = right, 90 = up, 180 = left), a power and a weapon; the server flies the shell(s) with the wind of
 * that turn, blows a crater, hurts any tank near it, and passes the turn. Rules decided here are in
 * docs/DECISIONS.md (ADR-033).
 *
 *  - 100 hit points each. Damage falls off with distance from the blast; a direct hit does most of it.
 *    Your own shell can hurt you.
 *  - Weapons: `shell` (unlimited), `heavy` (2 each, bigger blast, more damage), `triple` (2 each, three
 *    small shells a few degrees apart).
 *  - Wind is an integer -10..10, drawn from the seed each turn and shown to the player whose turn it is
 *    (it is public in `view`).
 *  - The first tank at 0 hp loses. Both at 0 hp from one shot (a triple, or a blast between them) is a draw.
 *    After `maxShots` each, the tank with more hp wins; equal hp is a draw.
 *  - Input is only `{angle, power, weapon}` (integers). There is no jitter, so a replay is exact.
 *
 * Nothing but the RNG is hidden, so `view` is the state without `rng`.
 */
export type TanksCfg = {
  /** Shots each before the game is decided on hit points. Default 12. */
  maxShots?: number;
};

export type TanksState = {
  players: [PlayerId, PlayerId];
  /** 200 integer column heights; the ground. Changes as craters are carved. */
  terrain: number[];
  /** The column each tank sits on (they do not move, only fall when the ground goes). */
  tankCols: [number, number];
  hp: [number, number];
  /** Special shots left per player. */
  ammo: Record<PlayerId, { heavy: number; triple: number }>;
  /** Wind for the turn in progress, integer -10..10 (positive pushes right). */
  wind: number;
  /** Index into `players` of whoever fires next. */
  turn: 0 | 1;
  shots: [number, number];
  maxShots: number;
  over: boolean;
  winner: PlayerId | null;
  /** The last shot, for renderers: replay it with `simulateShot` on the previous state or just animate it. */
  last: {
    seq: number;
    by: PlayerId;
    angle: number;
    power: number;
    weapon: Weapon;
    /** The wind it was fired in. */
    wind: number;
    impacts: Impact[];
  } | null;
  seq: number;
  /** SECRET: seeds the winds. */
  rng: RngState;
};

export type TanksAction = { kind: 'fire'; angle: number; power: number; weapon: Weapon };

export const tanksActionSchema: z.ZodType<TanksAction> = z.object({
  kind: z.literal('fire'),
  angle: z.number().int().min(0).max(ANGLE_MAX),
  power: z.number().int().min(1).max(POWER_MAX),
  weapon: z.enum(['shell', 'heavy', 'triple']),
});

export const TANKS_COLS: readonly [number, number] = [25, 175];

const CONTROL_SPACING = 25;
const PAD = 5; // columns either side of a tank that are levelled flat

/** The seeded ground: smooth hills between random control heights, with a flat pad under each tank. */
export function generateTanksTerrain(rng: RngState): [number[], RngState] {
  const points = COLS / CONTROL_SPACING + 1;
  const heights: number[] = [];
  let r = rng;
  for (let i = 0; i < points; i++) {
    let h: number;
    [h, r] = nextInt(r, 171);
    heights.push(90 + h);
  }
  const terrain: number[] = [];
  for (let col = 0; col < COLS; col++) {
    const seg = Math.floor(col / CONTROL_SPACING);
    const t = (col - seg * CONTROL_SPACING) / CONTROL_SPACING;
    const smooth = t * t * (3 - 2 * t);
    const a = heights[seg] as number;
    const b = heights[seg + 1] as number;
    terrain.push(Math.floor(a + (b - a) * smooth + 0.5));
  }
  for (const tc of TANKS_COLS) {
    const base = terrain[tc] as number;
    for (let c = tc - PAD; c <= tc + PAD; c++) terrain[c] = base;
  }
  return [terrain, r];
}

const drawWind = (rng: RngState): [number, RngState] => {
  const [v, next] = nextInt(rng, 2 * WIND_MAX + 1);
  return [v - WIND_MAX, next];
};

export const tanksEngine: GameEngine<TanksState, TanksAction, TanksCfg> = {
  slug: 'tanks',
  actionSchema: tanksActionSchema,
  timers: { turnMs: 60_000 },

  init(players, seed, cfg) {
    if (players.length !== 2) throw new Error('Tanks is a two-player game');
    if (players[0] === players[1]) throw new Error('Duplicate players');
    const maxShots = cfg?.maxShots ?? 12;
    if (!Number.isInteger(maxShots) || maxShots < 1 || maxShots > 50) {
      throw new Error('Invalid maxShots');
    }
    const [a, b] = players as [PlayerId, PlayerId];
    const [terrain, r1] = generateTanksTerrain(seedRng(seed));
    const [wind, rng] = drawWind(r1);
    const heavy = WEAPONS.heavy.ammo as number;
    const triple = WEAPONS.triple.ammo as number;
    return {
      players: [a, b],
      terrain,
      tankCols: [TANKS_COLS[0], TANKS_COLS[1]],
      hp: [TANK_HP, TANK_HP],
      ammo: { [a]: { heavy, triple }, [b]: { heavy, triple } },
      wind,
      turn: 0,
      shots: [0, 0],
      maxShots,
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
    if (!Number.isInteger(a.angle) || a.angle < 0 || a.angle > ANGLE_MAX) {
      return { ok: false, code: 'bad_angle' };
    }
    if (!Number.isInteger(a.power) || a.power < 1 || a.power > POWER_MAX) {
      return { ok: false, code: 'bad_power' };
    }
    if (a.weapon !== 'shell' && a.weapon !== 'heavy' && a.weapon !== 'triple') {
      return { ok: false, code: 'bad_weapon' };
    }
    if (a.weapon !== 'shell' && (s.ammo[by]?.[a.weapon] ?? 0) <= 0) {
      return { ok: false, code: 'no_ammo' };
    }
    return { ok: true };
  },

  apply(s, by, a) {
    const turn = s.turn;
    const sim = simulateShot(s.terrain, s.tankCols, s.hp, turn, s.wind, a.weapon, a.angle, a.power);
    const shots: [number, number] = [s.shots[0], s.shots[1]];
    shots[turn] += 1;
    const mine = { ...(s.ammo[by] as { heavy: number; triple: number }) };
    if (a.weapon !== 'shell') mine[a.weapon] -= 1;
    const ammo = { ...s.ammo, [by]: mine };
    const [wind, rng] = drawWind(s.rng);

    const next: TanksState = {
      ...s,
      terrain: sim.terrain,
      hp: sim.hp,
      ammo,
      shots,
      wind,
      rng,
      turn: turn === 0 ? 1 : 0,
      seq: s.seq + 1,
      last: {
        seq: s.seq + 1,
        by,
        angle: a.angle,
        power: a.power,
        weapon: a.weapon,
        wind: s.wind,
        impacts: sim.impacts,
      },
    };
    const dead0 = sim.hp[0] <= 0;
    const dead1 = sim.hp[1] <= 0;
    if (dead0 || dead1) {
      next.over = true;
      next.winner = dead0 && dead1 ? null : dead0 ? s.players[1] : s.players[0];
    } else if (shots[0] >= s.maxShots && shots[1] >= s.maxShots) {
      next.over = true;
      next.winner =
        sim.hp[0] === sim.hp[1] ? null : sim.hp[0] > sim.hp[1] ? s.players[0] : s.players[1];
    }
    return next;
  },

  isTerminal(s) {
    return s.over;
  },

  result(s): GameResult {
    if (!s.over) return { placements: [], draw: false };
    if (s.winner === null) return { placements: [[s.players[0], s.players[1]]], draw: true };
    const loser = s.players[0] === s.winner ? s.players[1] : s.players[0];
    return { placements: [[s.winner], [loser]], draw: false };
  },

  view(s) {
    const { rng: _rng, ...rest } = s;
    void _rng;
    return rest;
  },
};

/**
 * A harmless shell for a player who ran out of time (or a bot): fired away from the opponent at the first
 * angle and power that leaves the shooter unhurt (usually a shot that leaves the map or lands far off), else
 * the lowest-damage shell. Always legal while the game is running.
 */
export function tanksAutoAction(s: TanksState): TanksAction {
  const away = s.turn === 0 ? [180, 170, 160, 150, 140] : [0, 10, 20, 30, 40];
  let best: TanksAction = { kind: 'fire', angle: away[0] as number, power: 100, weapon: 'shell' };
  let bestSelf = Infinity;
  for (const angle of away) {
    for (const power of [100, 80, 60, 40]) {
      const sim = simulateShot(s.terrain, s.tankCols, s.hp, s.turn, s.wind, 'shell', angle, power);
      const self = s.hp[s.turn] - sim.hp[s.turn];
      if (self < bestSelf) {
        bestSelf = self;
        best = { kind: 'fire', angle, power, weapon: 'shell' };
      }
      if (self === 0) return best;
    }
  }
  return best;
}
