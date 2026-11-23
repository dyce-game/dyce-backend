import { FIELD_H, FIELD_W, type HoleDef } from './course.ts';

/**
 * Mini Golf ball physics (docs/ARCHITECTURE.md §6). The client sends INPUT ONLY (`dx`, `dy`, `power`, all
 * integers); this module turns an input + the hole into an outcome. Client and server run the same code,
 * and the server's answer is final.
 *
 * Determinism rules, so the result is bit-identical in Node, Deno and Hermes:
 *  - fixed timestep 1/120 s, a fixed order of operations (friction, move, edge, walls, bumpers, cup);
 *  - only + - x / and sqrt (all correctly rounded by IEEE-754); NO sin, cos, pow, atan or hypot — the
 *    direction is the integer vector (dx, dy) normalised with sqrt, never an angle;
 *  - no Date, no Math.random, no jitter: the same input from the same spot always gives the same result,
 *    which is why other players' strokes on a hole stay hidden until you have played it (see the engine).
 *
 * Units: centimetres and seconds in the sim; ball positions are integer millimetres in the state.
 */
export const DT = 1 / 120;
export const BALL_R = 2.1;
export const CUP_R = 5.4;
/** Slower than this (cm/s) while over the cup and the ball drops in; faster rolls across it. */
export const CUP_CAPTURE_SPEED = 240;
export const POWER_MAX = 1000;
export const AIM_MAX = 1000;
/** cm/s of launch speed per unit of power: 1000 → 6 m/s. */
export const SPEED_PER_POWER = 0.6;

const ROLL_DECEL = 90; // cm/s², on grass
const SAND_DECEL = 420; // cm/s², in sand
const STOP_SPEED = 3; // cm/s: below this the ball stops
const WALL_RESTITUTION = 0.78;
const BUMPER_RESTITUTION = 0.92;
const MAX_STEPS = 3600; // 30 s: far longer than any putt
const TRACE_EVERY = 4; // 30 Hz keyframes for renderers

export type PuttInput = { dx: number; dy: number; power: number };

export type PuttOutcome = {
  sunk: boolean;
  /** Where the ball ended, integer millimetres (the cup centre if sunk). */
  endX: number;
  endY: number;
  /** Wall and bumper hits (for sound and a sanity bound). */
  bounces: number;
  steps: number;
};

export type PuttSim = { outcome: PuttOutcome; trace: [number, number][] };

/** Launch speed for a power value (cm/s). */
export const puttSpeed = (power: number): number => power * SPEED_PER_POWER;

const mm = (v: number): number => Math.round(v * 10);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

function inRect(x: number, y: number, r: { x: number; y: number; w: number; h: number }): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/**
 * Simulate one putt from (fromX, fromY) in millimetres. Pure: same arguments → same result. Pass
 * `withTrace` to get ~30 Hz keyframes (millimetres) for animation; the outcome never depends on it.
 */
export function simulatePutt(
  hole: HoleDef,
  fromX: number,
  fromY: number,
  input: PuttInput,
  withTrace = false,
): PuttSim {
  const norm = Math.sqrt(input.dx * input.dx + input.dy * input.dy);
  const speed0 = puttSpeed(input.power);
  let vx = norm > 0 ? (input.dx / norm) * speed0 : 0;
  let vy = norm > 0 ? (input.dy / norm) * speed0 : 0;
  let x = fromX / 10;
  let y = fromY / 10;

  const trace: [number, number][] = [];
  if (withTrace) trace.push([mm(x), mm(y)]);

  let bounces = 0;
  let sunk = false;
  let steps = 0;

  for (; steps < MAX_STEPS; steps++) {
    // Friction: a fixed deceleration along the direction of travel, harder in sand.
    const speed = Math.sqrt(vx * vx + vy * vy);
    let decel = ROLL_DECEL;
    for (let i = 0; i < hole.sand.length; i++) {
      if (inRect(x, y, hole.sand[i] as (typeof hole.sand)[number])) {
        decel = SAND_DECEL;
        break;
      }
    }
    const slower = speed - decel * DT;
    if (slower <= STOP_SPEED) {
      vx = 0;
      vy = 0;
      if (withTrace) trace.push([mm(x), mm(y)]);
      break;
    }
    const scale = slower / speed;
    vx *= scale;
    vy *= scale;
    x += vx * DT;
    y += vy * DT;

    // Field edge.
    if (x < BALL_R) {
      x = BALL_R;
      if (vx < 0) vx = -vx * WALL_RESTITUTION;
      bounces++;
    } else if (x > FIELD_W - BALL_R) {
      x = FIELD_W - BALL_R;
      if (vx > 0) vx = -vx * WALL_RESTITUTION;
      bounces++;
    }
    if (y < BALL_R) {
      y = BALL_R;
      if (vy < 0) vy = -vy * WALL_RESTITUTION;
      bounces++;
    } else if (y > FIELD_H - BALL_R) {
      y = FIELD_H - BALL_R;
      if (vy > 0) vy = -vy * WALL_RESTITUTION;
      bounces++;
    }

    // Walls (rectangles), in order.
    for (let i = 0; i < hole.walls.length; i++) {
      const w = hole.walls[i] as (typeof hole.walls)[number];
      const cx = clamp(x, w.x, w.x + w.w);
      const cy = clamp(y, w.y, w.y + w.h);
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 >= BALL_R * BALL_R) continue;
      let nx: number;
      let ny: number;
      if (d2 > 0) {
        const d = Math.sqrt(d2);
        nx = dx / d;
        ny = dy / d;
        x = cx + nx * BALL_R;
        y = cy + ny * BALL_R;
      } else {
        // The centre is inside the wall (cannot happen at these speeds): leave by the nearest face.
        const left = x - w.x;
        const right = w.x + w.w - x;
        const top = y - w.y;
        const bottom = w.y + w.h - y;
        const m = Math.min(left, right, top, bottom);
        if (m === left) {
          nx = -1;
          ny = 0;
          x = w.x - BALL_R;
        } else if (m === right) {
          nx = 1;
          ny = 0;
          x = w.x + w.w + BALL_R;
        } else if (m === top) {
          nx = 0;
          ny = -1;
          y = w.y - BALL_R;
        } else {
          nx = 0;
          ny = 1;
          y = w.y + w.h + BALL_R;
        }
      }
      const vn = vx * nx + vy * ny;
      if (vn < 0) {
        vx -= (1 + WALL_RESTITUTION) * vn * nx;
        vy -= (1 + WALL_RESTITUTION) * vn * ny;
      }
      bounces++;
    }

    // Bumpers (circles), in order.
    for (let i = 0; i < hole.bumpers.length; i++) {
      const b = hole.bumpers[i] as (typeof hole.bumpers)[number];
      const dx = x - b.x;
      const dy = y - b.y;
      const reach = b.r + BALL_R;
      const d2 = dx * dx + dy * dy;
      if (d2 >= reach * reach) continue;
      const d = Math.sqrt(d2);
      const nx = d > 0 ? dx / d : 0;
      const ny = d > 0 ? dy / d : 1;
      x = b.x + nx * reach;
      y = b.y + ny * reach;
      const vn = vx * nx + vy * ny;
      if (vn < 0) {
        vx -= (1 + BUMPER_RESTITUTION) * vn * nx;
        vy -= (1 + BUMPER_RESTITUTION) * vn * ny;
      }
      bounces++;
    }

    // The cup: slow enough over it and the ball drops.
    const cdx = x - hole.cup.x;
    const cdy = y - hole.cup.y;
    if (cdx * cdx + cdy * cdy < CUP_R * CUP_R && Math.sqrt(vx * vx + vy * vy) < CUP_CAPTURE_SPEED) {
      sunk = true;
      x = hole.cup.x;
      y = hole.cup.y;
      if (withTrace) trace.push([mm(x), mm(y)]);
      break;
    }

    if (withTrace && (steps + 1) % TRACE_EVERY === 0) trace.push([mm(x), mm(y)]);
  }

  return {
    outcome: { sunk, endX: mm(x), endY: mm(y), bounces, steps },
    trace,
  };
}
