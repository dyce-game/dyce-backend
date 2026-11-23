/**
 * Archery arrow flight (docs/ARCHITECTURE.md §6). The client sends INPUT ONLY (`aimX`, `aimY`, `draw`,
 * integers); this module turns that input plus the end's wind into where the arrow lands on the target
 * face. Client and server run the same code and the server's answer is final.
 *
 * Determinism rules (same as Cup Pong): fixed timestep 1/120 s, semi-implicit Euler, a fixed order of
 * operations, only + − × ÷ and sqrt, no trig, no Date, no Math.random. The hand tremor at release is drawn
 * from the seeded RNG by the engine BEFORE this is called, so everything here is a pure function.
 *
 * Model: the archer stands at the origin, the target face is the plane z = DISTANCE metres away and its
 * centre is at the height of the archer's sight line (x right, y up, both measured from the centre). The sight
 * is calibrated for a FULL draw: the arrow is launched high enough to hit the aim point at full-draw speed
 * in still air. A short draw is slower, so it drops short; wind pushes the arrow sideways in proportion to
 * how long it is in the air.
 */
export const DT = 1 / 120;
export const GRAVITY = 9.81;
export const DISTANCE = 30;

export const DRAW_MAX = 1000;
/** Aim limits in mm on the target face (the face is 800 mm across; this leaves room to aim off for wind). */
export const AIM_MAX = 1200;
const SPEED_FULL = 66; // m/s at full draw
const SPEED_MIN = 30; // m/s at draw 0
const SPEED_PER_DRAW = (SPEED_FULL - SPEED_MIN) / DRAW_MAX;
/** Sideways acceleration per m/s of wind (1/s): 8 m/s of wind pushes a full-draw arrow ~25 cm off at 30 m. */
const WIND_PUSH = 0.3;
const MAX_STEPS = 600;

export type ArrowInput = { aimX: number; aimY: number; draw: number };

export type ArrowFlight = {
  /** Where the arrow reached the target plane, in whole millimetres from the centre (x right, y up). */
  x: number;
  y: number;
  /** Time of flight in whole milliseconds. */
  flightMs: number;
};

/** Arrow speed for a draw (m/s). Exposed so the aim guide and the tests use the same curve. */
export const arrowSpeed = (draw: number): number => SPEED_MIN + draw * SPEED_PER_DRAW;

const mm = (v: number): number => Math.round(v * 1000);

/**
 * Fly one arrow. `windDms` is the cross-wind in 0.1 m/s (positive blows to the archer's right). `tremor` is the
 * release wobble already added to the aim, in mm. Pure.
 */
export function flyArrow(
  input: ArrowInput,
  windDms: number,
  tremor: { x: number; y: number } = { x: 0, y: 0 },
): ArrowFlight {
  const wind = windDms / 10;
  const aimX = (input.aimX + tremor.x) / 1000;
  const aimY = (input.aimY + tremor.y) / 1000;

  // Sight calibration (see the header): slope to the aim point plus the lift that cancels the full-draw drop.
  // The 1 + V·dt/D factor corrects for the discrete integration (semi-implicit Euler drops slightly more).
  const lift =
    ((GRAVITY * DISTANCE) / (2 * SPEED_FULL * SPEED_FULL)) * (1 + (SPEED_FULL * DT) / DISTANCE);
  const sx = aimX / DISTANCE;
  const sy = aimY / DISTANCE + lift;

  const speed = arrowSpeed(input.draw);
  const norm = Math.sqrt(1 + sx * sx + sy * sy);
  const vz = speed / norm;
  let vx = vz * sx;
  let vy = vz * sy;

  let x = 0;
  let y = 0;
  let z = 0;
  let steps = 0;
  for (; steps < MAX_STEPS; steps++) {
    const pz = z;
    const px = x;
    const py = y;
    vy -= GRAVITY * DT;
    vx += WIND_PUSH * wind * DT;
    x += vx * DT;
    y += vy * DT;
    z += vz * DT;
    if (z >= DISTANCE) {
      const t = (DISTANCE - pz) / (z - pz);
      return {
        x: mm(px + (x - px) * t),
        y: mm(py + (y - py) * t),
        flightMs: Math.round((steps + t) * DT * 1000),
      };
    }
  }
  // Unreachable for legal input (vz ≥ 29 m/s); keeps the function total.
  return { x: mm(x), y: mm(y), flightMs: Math.round(steps * DT * 1000) };
}
