/**
 * Basketball shot physics (docs/ARCHITECTURE.md §6). The client sends INPUT ONLY (`aim`, `power`, both
 * integers, the quantised flick); this module turns an input plus the rack the shooter stands at into an
 * outcome. Client and server run the same code and the server's answer is final.
 *
 * Determinism rules, as Cup Pong: fixed timestep 1/120 s, semi-implicit Euler, a fixed order of operations,
 * only + − × ÷ and sqrt; NO sin/cos/pow/exp/hypot (the launch direction is built from a slope and a literal
 * elevation); no Date, no Math.random. The release wobble is added by the engine from the seeded RNG BEFORE
 * this is called.
 *
 * Frame (metres): the hoop centre is the origin of the floor plan (x right, z away from the shooters, so the
 * backboard is at +z); y is up from the floor. Shooters stand at z < 0. Rack positions are integer mm.
 */
export const DT = 1 / 120;
export const GRAVITY = 9.81;

export const BALL_RADIUS = 0.12;
export const RIM_HEIGHT = 3.048;
/** Rim ring radius (inside edge) and the tube it is made of. */
export const RIM_RADIUS = 0.2286;
const RIM_TUBE = 0.009;
/** Backboard: face plane at z, the board spans |x| ≤ half-width and BOARD_BOTTOM..BOARD_TOP in y. */
export const BOARD_Z = 0.38;
const BOARD_HALF_WIDTH = 0.9;
const BOARD_BOTTOM = 2.9;
const BOARD_TOP = 3.97;

export const RELEASE_HEIGHT = 2.1;

export const AIM_MAX = 500;
export const POWER_MAX = 1000;
const AIM_SLOPE_PER_UNIT = 0.0004;
const SPEED_MIN = 6.5; // m/s at power 0
const SPEED_PER_POWER = 0.0045; // → 11 m/s at power 1000
// Launch elevation fixed at 52°: cos/sin as literals (no trig at runtime).
const COS_ELEV = 0.6156614753256583;
const SIN_ELEV = 0.7880107536067219;

const RIM_RESTITUTION = 0.55;
const BOARD_RESTITUTION = 0.6;
const BOARD_TANGENT = 0.92;
const MAX_STEPS = 600; // 5 s
const TRACE_EVERY = 4; // 30 Hz keyframes for renderers

/** The five racks around the arc, integer mm (x, z) from the hoop centre: corner, wing, top, wing, corner. */
export const RACKS: readonly { x: number; z: number }[] = [
  { x: -6700, z: -1100 },
  { x: -4300, z: -5130 },
  { x: 0, z: -6750 },
  { x: 4300, z: -5130 },
  { x: 6700, z: -1100 },
];

export type ShotInput = { aim: number; power: number };

export type ShotOutcome = {
  made: boolean;
  /** Went in without touching the rim or the board. */
  swish: boolean;
  rimHits: number;
  boardHits: number;
  /** Whole millimetres (hoop-centred floor plan) where the ball was when the shot ended. */
  endX: number;
  endZ: number;
  steps: number;
};

export type ShotSim = { outcome: ShotOutcome; trace: [number, number, number][] };

/** Launch speed for a power value (m/s). Exposed so tests, bots and the aim guide use the same curve. */
export const launchSpeed = (power: number): number => SPEED_MIN + power * SPEED_PER_POWER;

const mm = (v: number): number => Math.round(v * 1000);

/**
 * Simulate one shot from `rack` (an index into RACKS). Pure: same arguments → same result. Pass `withTrace`
 * for ~30 Hz keyframes (mm: x, y, z) for animation; the outcome never depends on it.
 */
export function simulateShot(rack: number, input: ShotInput, withTrace = false): ShotSim {
  const spot = RACKS[rack] as { x: number; z: number };
  let x = spot.x / 1000;
  let z = spot.z / 1000;
  let y = RELEASE_HEIGHT;

  // Horizontal direction to the hoop, rotated by the aim slope (perpendicular = 90° counter-clockwise).
  const dist = Math.sqrt(x * x + z * z);
  const ux = -x / dist;
  const uz = -z / dist;
  const slope = input.aim * AIM_SLOPE_PER_UNIT;
  const dirNorm = Math.sqrt(1 + slope * slope);
  const dx = (ux - slope * uz) / dirNorm;
  const dz = (uz + slope * ux) / dirNorm;

  const speed = launchSpeed(input.power);
  const horiz = speed * COS_ELEV;
  let vx = horiz * dx;
  let vz = horiz * dz;
  let vy = speed * SIN_ELEV;

  const trace: [number, number, number][] = [];
  if (withTrace) trace.push([mm(x), mm(y), mm(z)]);

  let made = false;
  let rimHits = 0;
  let boardHits = 0;
  let steps = 0;

  for (; steps < MAX_STEPS; steps++) {
    const py = y;
    const px = x;
    const pz = z;
    vy -= GRAVITY * DT;
    x += vx * DT;
    y += vy * DT;
    z += vz * DT;

    // Backboard: the ball's front surface crosses the board plane inside the board's area.
    if (vz > 0 && pz + BALL_RADIUS <= BOARD_Z && z + BALL_RADIUS > BOARD_Z) {
      const t = (BOARD_Z - BALL_RADIUS - pz) / (z - pz);
      const hx = px + (x - px) * t;
      const hy = py + (y - py) * t;
      if (
        hx >= -BOARD_HALF_WIDTH - BALL_RADIUS &&
        hx <= BOARD_HALF_WIDTH + BALL_RADIUS &&
        hy >= BOARD_BOTTOM - BALL_RADIUS &&
        hy <= BOARD_TOP + BALL_RADIUS
      ) {
        z = BOARD_Z - BALL_RADIUS;
        vz = -vz * BOARD_RESTITUTION;
        vx *= BOARD_TANGENT;
        vy *= BOARD_TANGENT;
        boardHits++;
      }
    }

    // Rim: the nearest point on the ring to the ball centre, a sphere against a thin tube.
    const hd = Math.sqrt(x * x + z * z);
    const rx = hd > 0.000001 ? (x / hd) * RIM_RADIUS : RIM_RADIUS;
    const rz = hd > 0.000001 ? (z / hd) * RIM_RADIUS : 0;
    const ex = x - rx;
    const ey = y - RIM_HEIGHT;
    const ez = z - rz;
    const reach = BALL_RADIUS + RIM_TUBE;
    const e2 = ex * ex + ey * ey + ez * ez;
    if (e2 < reach * reach && e2 > 0) {
      const e = Math.sqrt(e2);
      const nx = ex / e;
      const ny = ey / e;
      const nz = ez / e;
      x = rx + nx * reach;
      y = RIM_HEIGHT + ny * reach;
      z = rz + nz * reach;
      const vn = vx * nx + vy * ny + vz * nz;
      if (vn < 0) {
        vx -= (1 + RIM_RESTITUTION) * vn * nx;
        vy -= (1 + RIM_RESTITUTION) * vn * ny;
        vz -= (1 + RIM_RESTITUTION) * vn * nz;
        rimHits++;
      }
    }

    // Through the hoop: the centre crosses the rim plane going down, inside the ring.
    if (vy < 0 && py >= RIM_HEIGHT && y < RIM_HEIGHT) {
      const t = (py - RIM_HEIGHT) / (py - y);
      const ix = px + (x - px) * t;
      const iz = pz + (z - pz) * t;
      if (ix * ix + iz * iz <= RIM_RADIUS * RIM_RADIUS) {
        made = true;
        x = ix;
        y = RIM_HEIGHT;
        z = iz;
        if (withTrace) trace.push([mm(x), mm(y), mm(z)]);
        break;
      }
    }

    if (withTrace && (steps + 1) % TRACE_EVERY === 0) trace.push([mm(x), mm(y), mm(z)]);

    // Over: it reached the floor, or flew far away.
    if (y < BALL_RADIUS || x > 14 || x < -14 || z > 4 || z < -14) {
      if (withTrace) trace.push([mm(x), mm(y), mm(z)]);
      break;
    }
  }

  return {
    outcome: {
      made,
      swish: made && rimHits === 0 && boardHits === 0,
      rimHits,
      boardHits,
      endX: mm(x),
      endZ: mm(z),
      steps,
    },
    trace,
  };
}
