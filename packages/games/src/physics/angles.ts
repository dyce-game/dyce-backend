/**
 * Deterministic sine/cosine for physics engines that need an angle input (8 Ball cue direction, the Darts
 * board). `Math.sin` / `Math.cos` are NOT bit-identical across V8, JavaScriptCore and Hermes, so engines
 * must not call them. Here the angle is an INTEGER number of centidegrees (0.01°); it is reduced to
 * [0°, 45°] with integer arithmetic and the Taylor series is evaluated with only + − × ÷, which IEEE-754
 * rounds identically everywhere (the same rule Cup Pong's physics follows).
 */
export const FULL_TURN_CENTI = 36000;
const QUARTER = 9000;
const EIGHTH = 4500;
/** π / 18000: radians per centidegree. A literal, so there is no runtime π arithmetic. */
const RAD_PER_CENTI = 0.00017453292519943296;

/** sin(x) for |x| <= pi/4 (Taylor to x^15: error < 1e-16), Horner form. */
function sinSmall(x: number): number {
  const x2 = x * x;
  let t = 1 - x2 / 210;
  t = 1 - (x2 / 156) * t;
  t = 1 - (x2 / 110) * t;
  t = 1 - (x2 / 72) * t;
  t = 1 - (x2 / 42) * t;
  t = 1 - (x2 / 20) * t;
  t = 1 - (x2 / 6) * t;
  return x * t;
}

/** cos(x) for |x| ≤ π/4 (Taylor, 8 terms: error < 1e-15). */
function cosSmall(x: number): number {
  const x2 = x * x;
  return (
    1 -
    (x2 / 2) *
      (1 -
        (x2 / 12) *
          (1 - (x2 / 30) * (1 - (x2 / 56) * (1 - (x2 / 90) * (1 - (x2 / 132) * (1 - x2 / 182))))))
  );
}

/** Reduce any integer centidegree angle to [0, 36000). */
export function wrapCenti(centi: number): number {
  const m = centi % FULL_TURN_CENTI;
  return m < 0 ? m + FULL_TURN_CENTI : m;
}

/**
 * [sin, cos] of an angle in integer centidegrees, measured counter-clockwise (the usual maths
 * convention). Exact at multiples of 90°.
 */
export function sinCosCenti(centi: number): [number, number] {
  const a = wrapCenti(Math.trunc(centi));
  const quadrant = Math.floor(a / QUARTER);
  const rem = a - quadrant * QUARTER; // 0 .. 8999
  let s: number;
  let c: number;
  if (rem === 0) {
    s = 0;
    c = 1;
  } else if (rem <= EIGHTH) {
    const x = rem * RAD_PER_CENTI;
    s = sinSmall(x);
    c = cosSmall(x);
  } else {
    const x = (QUARTER - rem) * RAD_PER_CENTI;
    s = cosSmall(x);
    c = sinSmall(x);
  }
  switch (quadrant) {
    case 0:
      return [s, c];
    case 1:
      return [c, -s];
    case 2:
      return [-s, -c];
    default:
      return [-c, s];
  }
}
