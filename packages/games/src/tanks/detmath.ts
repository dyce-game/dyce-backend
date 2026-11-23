/**
 * Deterministic trigonometry for whole degrees, for the physics games (docs/ARCHITECTURE.md §6).
 *
 * Math.sin and Math.cos are NOT guaranteed bit-identical across V8, Hermes and Deno. A Taylor series that
 * uses only + - x / is: IEEE-754 makes each of those correctly rounded, so every runtime gives the same
 * bits. The tables are built once from that series, in a fixed order.
 */
const RAD_PER_DEG = 0.017453292519943295; // pi / 180, as a literal

/** sin of `deg` degrees, 0 <= deg <= 90, from the series x - x^3/3! + x^5/5! - ... (11 terms). */
function sinSeries(deg: number): number {
  const x = deg * RAD_PER_DEG;
  const x2 = x * x;
  let term = x;
  let sum = x;
  for (let k = 1; k <= 10; k++) {
    term = (-term * x2) / (2 * k * (2 * k + 1));
    sum += term;
  }
  return sum;
}

const SIN_TABLE: number[] = [];
const COS_TABLE: number[] = [];
for (let d = 0; d <= 180; d++) {
  const base = d <= 90 ? d : 180 - d;
  SIN_TABLE.push(sinSeries(base));
  const c = sinSeries(90 - base);
  COS_TABLE.push(d <= 90 ? c : -c);
}

/** sin of a whole number of degrees, 0-180. */
export const sinDeg = (deg: number): number => SIN_TABLE[deg] as number;
/** cos of a whole number of degrees, 0-180. */
export const cosDeg = (deg: number): number => COS_TABLE[deg] as number;
