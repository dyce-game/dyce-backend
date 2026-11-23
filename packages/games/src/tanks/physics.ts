import { cosDeg, sinDeg } from './detmath.ts';

/**
 * Tanks shell physics and terrain (docs/ARCHITECTURE.md §6). The client sends INPUT ONLY (`angle`, `power`,
 * `weapon`, all integers); this module turns an input + the terrain + the wind into an outcome. Client and
 * server run the same code, and the server's answer is final.
 *
 * Determinism rules, so the result is bit-identical in Node, Deno and Hermes:
 *  - fixed timestep 1/120 s, semi-implicit Euler, a fixed order of operations;
 *  - only + - x / sqrt and floor (all exact): the launch direction comes from the Taylor-series table in
 *    detmath.ts (whole degrees), never from Math.sin/cos; no pow, exp, atan, hypot;
 *  - no Date, no Math.random: wind comes from the seeded RNG in the engine, there is no jitter.
 *
 * World: 800 wide, 500 high (units), x to the right, y UP, ground at y = terrain height. The terrain is a
 * HEIGHTMAP of 200 integer columns, 4 units wide. A blast carves the columns it covers DOWN to the bottom
 * of its circle (overhangs and caves are not modelled), then tanks settle onto the new ground.
 */
export const WORLD_W = 800;
export const WORLD_H = 500;
export const COLS = 200;
export const COL_W = 4;
export const DT = 1 / 120;
export const GRAVITY = 100;
/** Wind is an integer -10..10; it pushes sideways by this many units/s² per step of wind. */
export const WIND_ACCEL = 1.2;
export const WIND_MAX = 10;
export const SPEED_PER_POWER = 3;
export const POWER_MAX = 100;
export const ANGLE_MAX = 180;
export const TANK_RADIUS = 12;
/** A tank's centre sits this high above the ground under it. */
export const TANK_LIFT = 8;
export const MUZZLE = 14;
export const TANK_HP = 100;
const MAX_STEPS = 2400; // 20 s: far longer than any shell in flight
const TRACE_EVERY = 4; // 30 Hz keyframes for renderers
const TRIPLE_SPREAD = 4; // degrees either side

export type Weapon = 'shell' | 'heavy' | 'triple';

export type WeaponSpec = {
  /** Blast radius, units. */
  radius: number;
  /** Damage at the very centre; falls off linearly to 0 at radius + tank radius. */
  damage: number;
  /** Shells fired at once (a triple fires three). */
  shells: number;
  /** How many a player may use in a game; null = unlimited. */
  ammo: number | null;
};

export const WEAPONS: Readonly<Record<Weapon, WeaponSpec>> = {
  shell: { radius: 24, damage: 40, shells: 1, ammo: null },
  heavy: { radius: 40, damage: 70, shells: 1, ammo: 2 },
  triple: { radius: 20, damage: 30, shells: 3, ammo: 2 },
};

export type ImpactKind = 'ground' | 'tank' | 'out';

export type Impact = {
  kind: ImpactKind;
  /** Integer world coordinates of the blast (x, y), or where the shell left the world. */
  x: number;
  y: number;
  /** Damage dealt to each tank by this impact. */
  damage: [number, number];
};

export type ShotSim = {
  terrain: number[];
  hp: [number, number];
  impacts: Impact[];
  /** One ~30 Hz keyframe list per shell, integer world coordinates, when requested. */
  traces: [number, number][][];
};

/** Height of the ground under world x (clamped to the world). */
export function groundAt(terrain: readonly number[], x: number): number {
  const col = Math.floor(x / COL_W);
  const c = col < 0 ? 0 : col >= COLS ? COLS - 1 : col;
  return terrain[c] as number;
}

/** Where a tank's centre is, given its column. */
export const tankCentre = (terrain: readonly number[], col: number): { x: number; y: number } => ({
  x: col * COL_W + COL_W / 2,
  y: (terrain[col] as number) + TANK_LIFT,
});

/** Carve a blast of `radius` at (cx, cy) out of the heightmap. Returns a new array. */
export function carve(
  terrain: readonly number[],
  cx: number,
  cy: number,
  radius: number,
): number[] {
  const out = terrain.slice();
  const first = Math.max(0, Math.floor((cx - radius) / COL_W));
  const last = Math.min(COLS - 1, Math.floor((cx + radius) / COL_W));
  for (let col = first; col <= last; col++) {
    const dx = col * COL_W + COL_W / 2 - cx;
    if (dx <= -radius || dx >= radius) continue;
    const half = Math.sqrt(radius * radius - dx * dx);
    const low = Math.floor(cy - half);
    if ((out[col] as number) > low) out[col] = low < 0 ? 0 : low;
  }
  return out;
}

/**
 * Fire one shot: `shooter` (0 or 1) at `angle` degrees (0 = right, 90 = up, 180 = left) and `power`, in
 * `wind`, with `weapon`. Shells fly one after the other; each blast reshapes the ground before the next
 * shell flies. Pure: same arguments → same result. Pass `withTrace` for keyframes (never affects the outcome).
 */
export function simulateShot(
  terrain: readonly number[],
  tankCols: readonly [number, number],
  hp: readonly [number, number],
  shooter: 0 | 1,
  wind: number,
  weapon: Weapon,
  angle: number,
  power: number,
  withTrace = false,
): ShotSim {
  const spec = WEAPONS[weapon];
  let ground = terrain.slice();
  const hpNow: [number, number] = [hp[0], hp[1]];
  const impacts: Impact[] = [];
  const traces: [number, number][][] = [];
  const angles: number[] =
    spec.shells === 1
      ? [angle]
      : [Math.max(0, angle - TRIPLE_SPREAD), angle, Math.min(ANGLE_MAX, angle + TRIPLE_SPREAD)];
  const speed = power * SPEED_PER_POWER;
  const ax = wind * WIND_ACCEL;

  for (const a of angles) {
    const origin = tankCentre(ground, tankCols[shooter]);
    const c = cosDeg(a);
    const s = sinDeg(a);
    let x = origin.x + c * MUZZLE;
    let y = origin.y + s * MUZZLE;
    let vx = c * speed;
    let vy = s * speed;
    const trace: [number, number][] = [];
    if (withTrace) trace.push([Math.round(x), Math.round(y)]);

    let kind: ImpactKind = 'out';
    for (let step = 0; step < MAX_STEPS; step++) {
      vx += ax * DT;
      vy -= GRAVITY * DT;
      x += vx * DT;
      y += vy * DT;
      if (x < 0 || x >= WORLD_W) break; // flew off the side
      let hit = false;
      for (let t = 0; t < 2; t++) {
        const tc = tankCentre(ground, tankCols[t as 0 | 1]);
        const dx = x - tc.x;
        const dy = y - tc.y;
        if (dx * dx + dy * dy < TANK_RADIUS * TANK_RADIUS) {
          hit = true;
          kind = 'tank';
          break;
        }
      }
      if (!hit && y <= groundAt(ground, x)) {
        hit = true;
        kind = 'ground';
      }
      if (withTrace && !hit && (step + 1) % TRACE_EVERY === 0)
        trace.push([Math.round(x), Math.round(y)]);
      if (hit) break;
    }

    const ix = Math.round(x);
    const iy = Math.round(y);
    const damage: [number, number] = [0, 0];
    if (kind !== 'out') {
      for (let t = 0; t < 2; t++) {
        const tc = tankCentre(ground, tankCols[t as 0 | 1]);
        const dx = tc.x - ix;
        const dy = tc.y - iy;
        const d = Math.sqrt(dx * dx + dy * dy);
        const reach = spec.radius + TANK_RADIUS;
        if (d < reach) damage[t] = Math.floor((spec.damage * (reach - d)) / reach);
      }
      hpNow[0] -= damage[0];
      hpNow[1] -= damage[1];
      ground = carve(ground, ix, iy, spec.radius);
    }
    if (withTrace) {
      trace.push([ix, iy]);
      traces.push(trace);
    }
    impacts.push({ kind, x: ix, y: iy, damage });
    if (hpNow[0] <= 0 || hpNow[1] <= 0) break; // a tank is gone: no more shells
  }

  return { terrain: ground, hp: hpNow, impacts, traces };
}
