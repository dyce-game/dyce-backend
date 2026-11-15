/**
 * Cup Pong ball physics (docs/ARCHITECTURE.md §6). The client sends INPUT ONLY (`aim`, `power`, both
 * integers); this module turns an input + the cups still standing into an outcome. Client and server run
 * the same code, and the server's answer is final.
 *
 * Determinism rules, so the result is bit-identical in Node, Deno and Hermes:
 *  - fixed timestep 1/120 s, semi-implicit Euler, a fixed order of operations;
 *  - only + − × ÷ and sqrt (all correctly rounded by IEEE-754); NO sin, cos, pow, exp, hypot — the launch
 *    direction comes from literal constants and a slope, never from an angle function;
 *  - no Date, no Math.random; the per-throw "release jitter" is added by the engine from the seeded RNG
 *    BEFORE calling this, so everything here is a pure function of its arguments.
 *
 * Units: metres and seconds in the sim; cup positions are integer millimetres in the state.
 * Frame: the thrower stands at z = 0 looking down +z; x is to their right; y is up from the table top.
 * Cups are always described in the THROWER's frame (the defender's cups at the far end).
 */
export const DT = 1 / 120;
export const GRAVITY = 9.81;

export const TABLE_LENGTH = 2.44;
export const TABLE_HALF_WIDTH = 0.305;
export const BALL_RADIUS = 0.02;

export const CUP_HEIGHT = 0.12;
export const CUP_RIM_RADIUS = 0.0475;
/** The ball counts as in the cup if it crosses the rim plane within this distance of the cup axis. */
export const CUP_SINK_RADIUS = 0.0425;
/** Cups collide as cylinders of this radius (plus the ball's) below rim height. */
export const CUP_WALL_RADIUS = 0.0475;

export const RELEASE_X = 0;
export const RELEASE_Y = 0.3;
export const RELEASE_Z = 0.15;

// Input ranges (what the app quantises a flick into).
export const AIM_MAX = 500; // ±500 → slope ±0.2 (≈ ±11°)
export const POWER_MAX = 1000;
const AIM_SLOPE_PER_UNIT = 0.0004;
const SPEED_MIN = 1.5; // m/s at power 0
const SPEED_PER_POWER = 0.00525; // → 6.75 m/s at power 1000
// Launch elevation fixed at 52°: cos/sin as literals (no trig at runtime).
const COS_ELEV = 0.6156614753256583;
const SIN_ELEV = 0.7880107536067219;

const TABLE_RESTITUTION = 0.75;
const TABLE_FRICTION = 0.92;
const CUP_RESTITUTION = 0.4;
const RIM_UP = 0.35;
const RIM_PUSH = 0.7;
const MAX_BOUNCES = 3;
const MAX_STEPS = 1200; // 10 s: far longer than any throw
const TRACE_EVERY = 4; // 30 Hz keyframes for renderers

export type CupPos = { id: number; x: number; z: number }; // x, z in integer millimetres

export type ThrowInput = { aim: number; power: number };

export type ThrowOutcome = {
  /** id of the cup the ball dropped into, or null for a miss. */
  sunk: number | null;
  /** How many times the ball hit the table before it ended. */
  bounces: number;
  /** Rim touches that did not drop in. */
  rimHits: number;
  /** Whole millimetres where the throw ended (for splash / roll-out animation). */
  endX: number;
  endZ: number;
  steps: number;
};

export type ThrowSim = { outcome: ThrowOutcome; trace: [number, number, number][] };

/** Launch speed for a power value (m/s). Exposed so tests and the aim guide use the same curve. */
export const launchSpeed = (power: number): number => SPEED_MIN + power * SPEED_PER_POWER;

const mm = (v: number): number => Math.round(v * 1000);

/**
 * Simulate one throw. `cups` are the defender's standing cups. Pure: same arguments → same result.
 * Pass `withTrace` to get ~30 Hz keyframes (millimetres) for animation; the outcome never depends on it.
 */
export function simulateThrow(
  cups: readonly CupPos[],
  input: ThrowInput,
  withTrace = false,
): ThrowSim {
  const speed = launchSpeed(input.power);
  const slope = input.aim * AIM_SLOPE_PER_UNIT;
  const horiz = speed * COS_ELEV;
  const dirNorm = Math.sqrt(1 + slope * slope);
  let vz = horiz / dirNorm;
  let vx = vz * slope;
  let vy = speed * SIN_ELEV;

  let x = RELEASE_X;
  let y = RELEASE_Y;
  let z = RELEASE_Z;

  const trace: [number, number, number][] = [];
  if (withTrace) trace.push([mm(x), mm(y), mm(z)]);

  let bounces = 0;
  let rimHits = 0;
  let sunk: number | null = null;
  let steps = 0;

  for (; steps < MAX_STEPS; steps++) {
    const px = x;
    const py = y;
    const pz = z;
    vy -= GRAVITY * DT;
    x += vx * DT;
    y += vy * DT;
    z += vz * DT;

    // Table top.
    const overTable =
      x >= -TABLE_HALF_WIDTH && x <= TABLE_HALF_WIDTH && z >= 0 && z <= TABLE_LENGTH;
    if (overTable && vy < 0 && y < BALL_RADIUS) {
      y = BALL_RADIUS;
      vy = -vy * TABLE_RESTITUTION;
      vx *= TABLE_FRICTION;
      vz *= TABLE_FRICTION;
      bounces++;
      if (bounces > MAX_BOUNCES) {
        if (withTrace) trace.push([mm(x), mm(y), mm(z)]);
        break;
      }
    }

    // Cups, in a fixed order.
    let done = false;
    for (let i = 0; i < cups.length; i++) {
      const cup = cups[i] as CupPos;
      const cx = cup.x / 1000;
      const cz = cup.z / 1000;

      // Crossing the rim plane on the way down: drops in, clips the rim, or passes by.
      if (vy < 0 && py >= CUP_HEIGHT && y < CUP_HEIGHT) {
        const t = (py - CUP_HEIGHT) / (py - y);
        const ix = px + (x - px) * t;
        const iz = pz + (z - pz) * t;
        const ddx = ix - cx;
        const ddz = iz - cz;
        const d = Math.sqrt(ddx * ddx + ddz * ddz);
        if (d <= CUP_SINK_RADIUS) {
          sunk = cup.id;
          x = ix;
          y = CUP_HEIGHT;
          z = iz;
          done = true;
          break;
        }
        if (d <= CUP_RIM_RADIUS + BALL_RADIUS) {
          // Clipped the rim: pop back up and away from the cup axis.
          rimHits++;
          const nx = d > 0 ? ddx / d : 0;
          const nz = d > 0 ? ddz / d : 1;
          y = CUP_HEIGHT + 0.0005;
          vy = -vy * RIM_UP;
          vx = vx * 0.5 + nx * RIM_PUSH;
          vz = vz * 0.5 + nz * RIM_PUSH;
          continue;
        }
      }

      // Cup wall below the rim (bounce shots that hit the side).
      if (y < CUP_HEIGHT) {
        const dx = x - cx;
        const dz = z - cz;
        const reach = CUP_WALL_RADIUS + BALL_RADIUS;
        const d2 = dx * dx + dz * dz;
        if (d2 < reach * reach) {
          const d = Math.sqrt(d2);
          const nx = d > 0 ? dx / d : 0;
          const nz = d > 0 ? dz / d : -1;
          x = cx + nx * reach;
          z = cz + nz * reach;
          const vn = vx * nx + vz * nz;
          if (vn < 0) {
            vx -= (1 + CUP_RESTITUTION) * vn * nx;
            vz -= (1 + CUP_RESTITUTION) * vn * nz;
          }
        }
      }
    }

    if (withTrace && (steps + 1) % TRACE_EVERY === 0) trace.push([mm(x), mm(y), mm(z)]);
    if (done) {
      if (withTrace) trace.push([mm(x), mm(y), mm(z)]);
      break;
    }

    // Gone: past the far end, off the sides, or fell below the table.
    if (y < -0.8 || z > TABLE_LENGTH + 1 || z < -1 || x > 1.5 || x < -1.5) break;
  }

  return {
    outcome: { sunk, bounces, rimHits, endX: mm(x), endZ: mm(z), steps },
    trace,
  };
}
