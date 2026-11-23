import { sinCosCenti } from '../physics/angles.ts';

/**
 * 8 Ball table physics (docs/ARCHITECTURE.md §6). The client sends INPUT ONLY (cue angle, power and spin, all
 * integers); this module turns an input plus the balls on the table into the final positions and what
 * happened. Client and server run the same code and the server's answer is final.
 *
 * Determinism rules, as Cup Pong: a fixed timestep (1/480 s, i.e. four sub-steps of the 1/120 s tick, so a
 * 5 m/s ball moves ~10 mm per step and cannot tunnel through another), a fixed order of operations (balls by
 * id, pairs i<j), and only + − × ÷ and sqrt, which IEEE-754 rounds identically everywhere. The cue direction
 * comes from `physics/angles.ts` (an integer-centidegree sine/cosine built from those same operations), never
 * from `Math.sin`. No Date, no Math.random: pool has no random element once the rack is made.
 *
 * Units: the state keeps positions as integer tenths of a millimetre ("dmm"); the simulation works in
 * millimetres and seconds and hands integers back. Frame: x along the long side (0 … 2240), y across
 * (0 … 1120), origin at a corner pocket; angle 0 is +x, counter-clockwise.
 *
 * Spin is a simplified model, not a full rolling-ball simulation (ADR-034): top/back spin changes the cue
 * ball's path after its first contact with an object ball (follow rolls on, draw comes back), side spin
 * kicks the cue ball along the cushion on its next rail contact. Both fade after use.
 */
export const DT = 1 / 480;
/** Table playing surface, mm, cushion to cushion (a 7-foot table). */
export const TABLE_L = 2240;
export const TABLE_W = 1120;
export const BALL_R = 28.5;
export const DMM = 10;

export const POWER_MAX = 1000;
export const ANGLE_MAX = 36000;
export const SPIN_MAX = 100;

const SPEED_MIN = 200; // mm/s at power 0
const SPEED_PER_POWER = 5; // → 5.2 m/s at power 1000
const DECEL = 650; // mm/s², rolling resistance
const STOP_SPEED = 8; // mm/s: below this a ball is at rest
const E_BALL = 0.96;
const E_CUSHION = 0.72;
const CUSHION_TANGENT = 0.96;
const K_TOP = 0.55;
const K_SIDE = 0.35;
const SIDE_FADE = 0.6;
const MAX_STEPS = 7200; // 15 s
const TRACE_EVERY = 16; // 30 Hz keyframes for renderers

const CORNER_POCKET_R = 70;
const SIDE_POCKET_R = 58;

/** Pocket centres in mm: 0 bottom-left, 1 bottom-middle, 2 bottom-right, 3 top-left, 4 top-middle, 5 top-right. */
export const POCKETS: readonly { x: number; y: number; r: number }[] = [
  { x: 0, y: 0, r: CORNER_POCKET_R },
  { x: TABLE_L / 2, y: 0, r: SIDE_POCKET_R },
  { x: TABLE_L, y: 0, r: CORNER_POCKET_R },
  { x: 0, y: TABLE_W, r: CORNER_POCKET_R },
  { x: TABLE_L / 2, y: TABLE_W, r: SIDE_POCKET_R },
  { x: TABLE_L, y: TABLE_W, r: CORNER_POCKET_R },
];

export type TableBall = { id: number; x: number; y: number }; // dmm

export type ShotInput = {
  /** Cue direction in centidegrees, 0 … 35999 (0 = +x, counter-clockwise). */
  angle: number;
  power: number;
  /** Where the tip strikes the cue ball: spinX −100 … 100 (right is +), spinY −100 … 100 (top/follow is +). */
  spinX: number;
  spinY: number;
};

export type PocketEvent = { id: number; pocket: number };

export type ShotOutcome = {
  /** Balls still on the table after the shot, by id, integer dmm. The cue ball is absent if it was pocketed. */
  balls: TableBall[];
  pocketed: PocketEvent[];
  cuePocketed: boolean;
  /** First ball the cue ball touched (null if it touched none). */
  firstContact: number | null;
  /** Cushion contacts by any ball after the first contact. */
  railAfterContact: number;
  /** Distinct object balls that touched a cushion at any time (for the break rule). */
  objectBallsOnRail: number;
  steps: number;
};

export type ShotSim = {
  outcome: ShotOutcome;
  /** ~30 Hz keyframes: for each, `[id, x, y]` of the balls on the table, in dmm. */
  trace: [number, number, number][][];
};

/** Cue ball speed for a power value (mm/s). Exposed so tests and the aim guide use the same curve. */
export const cueSpeed = (power: number): number => SPEED_MIN + power * SPEED_PER_POWER;

const dmm = (v: number): number => Math.round(v * DMM);

/**
 * Simulate one shot. `balls` are the balls on the table (must include id 0, the cue ball, at its start
 * position). Pure: same arguments → same result. `withTrace` adds keyframes; the outcome never depends on it.
 */
export function simulateShot(
  balls: readonly TableBall[],
  input: ShotInput,
  withTrace = false,
): ShotSim {
  const order = [...balls].sort((p, q) => p.id - q.id);
  const n = order.length;
  const ids: number[] = order.map((b) => b.id);
  const x: number[] = order.map((b) => b.x / DMM);
  const y: number[] = order.map((b) => b.y / DMM);
  const vx: number[] = order.map(() => 0);
  const vy: number[] = order.map(() => 0);
  const alive: boolean[] = order.map(() => true);
  const onRail: boolean[] = order.map(() => false);
  const cue = ids.indexOf(0);
  if (cue < 0) throw new Error('simulateShot: no cue ball');

  const [s, c] = sinCosCenti(input.angle);
  const speed = cueSpeed(input.power);
  vx[cue] = c * speed;
  vy[cue] = s * speed;
  let top = input.spinY / SPIN_MAX;
  let side = input.spinX / SPIN_MAX;

  const pocketed: PocketEvent[] = [];
  let firstContact: number | null = null;
  let railAfterContact = 0;
  const trace: [number, number, number][][] = [];
  const snap = (): void => {
    const frame: [number, number, number][] = [];
    for (let i = 0; i < n; i++) {
      if (alive[i]) frame.push([ids[i] as number, dmm(x[i] as number), dmm(y[i] as number)]);
    }
    trace.push(frame);
  };
  if (withTrace) snap();

  const D = 2 * BALL_R;
  const D2 = D * D;
  const xMax = TABLE_L - BALL_R;
  const yMax = TABLE_W - BALL_R;

  let steps = 0;
  for (; steps < MAX_STEPS; steps++) {
    // 1. Rolling resistance, then move.
    let moving = false;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      const sp2 = (vx[i] as number) * (vx[i] as number) + (vy[i] as number) * (vy[i] as number);
      if (sp2 === 0) continue;
      const sp = Math.sqrt(sp2);
      const ns = sp - DECEL * DT;
      if (ns < STOP_SPEED) {
        vx[i] = 0;
        vy[i] = 0;
        continue;
      }
      const f = ns / sp;
      vx[i] = (vx[i] as number) * f;
      vy[i] = (vy[i] as number) * f;
      moving = true;
    }
    if (!moving) break;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      x[i] = (x[i] as number) + (vx[i] as number) * DT;
      y[i] = (y[i] as number) + (vy[i] as number) * DT;
    }

    // 2. Pockets.
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      for (let p = 0; p < 6; p++) {
        const pk = POCKETS[p] as { x: number; y: number; r: number };
        const ex = (x[i] as number) - pk.x;
        const ey = (y[i] as number) - pk.y;
        if (ex * ex + ey * ey < pk.r * pk.r) {
          alive[i] = false;
          vx[i] = 0;
          vy[i] = 0;
          pocketed.push({ id: ids[i] as number, pocket: p });
          break;
        }
      }
    }

    // 3. Ball against ball, pairs in id order. Contact is found exactly (back to the instant of touching),
    //    the impulse is applied there, and the pair is moved forward again with its new velocities.
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (!alive[j]) continue;
        const ivx = vx[i] as number;
        const ivy = vy[i] as number;
        const jvx = vx[j] as number;
        const jvy = vy[j] as number;
        if (ivx === 0 && ivy === 0 && jvx === 0 && jvy === 0) continue;
        const dx = (x[j] as number) - (x[i] as number);
        if (dx >= D || dx <= -D) continue;
        const dy = (y[j] as number) - (y[i] as number);
        const d2 = dx * dx + dy * dy;
        if (d2 >= D2) continue;
        const rvx = jvx - ivx;
        const rvy = jvy - ivy;
        const approach = dx * rvx + dy * rvy;
        if (approach >= 0) continue; // overlapping but already separating
        const vv = rvx * rvx + rvy * rvy;
        const disc = approach * approach - vv * (d2 - D2);
        let tau = (approach + Math.sqrt(disc < 0 ? 0 : disc)) / vv;
        if (tau < 0) tau = 0;
        if (tau > DT) tau = DT;

        const cix = (x[i] as number) - ivx * tau;
        const ciy = (y[i] as number) - ivy * tau;
        const cjx = (x[j] as number) - jvx * tau;
        const cjy = (y[j] as number) - jvy * tau;
        const nx0 = cjx - cix;
        const ny0 = cjy - ciy;
        const len = Math.sqrt(nx0 * nx0 + ny0 * ny0);
        const nx = nx0 / len;
        const ny = ny0 / len;
        const vn = rvx * nx + rvy * ny; // negative
        const imp = (-(1 + E_BALL) * vn) / 2;

        // The cue ball's heading before the hit, for the spin effect.
        const cueIsI = i === cue;
        const cueIsJ = j === cue;
        let dirX = 0;
        let dirY = 0;
        if (cueIsI || cueIsJ) {
          const cvx = cueIsI ? ivx : jvx;
          const cvy = cueIsI ? ivy : jvy;
          const csp = Math.sqrt(cvx * cvx + cvy * cvy);
          if (csp > 0) {
            dirX = cvx / csp;
            dirY = cvy / csp;
          }
          if (firstContact === null) firstContact = ids[cueIsI ? j : i] as number;
        }

        vx[i] = ivx - imp * nx;
        vy[i] = ivy - imp * ny;
        vx[j] = jvx + imp * nx;
        vy[j] = jvy + imp * ny;

        if ((cueIsI || cueIsJ) && top !== 0) {
          const kick = top * K_TOP * -vn;
          vx[cue] = (vx[cue] as number) + dirX * kick;
          vy[cue] = (vy[cue] as number) + dirY * kick;
          top = 0;
        }

        x[i] = cix + (vx[i] as number) * tau;
        y[i] = ciy + (vy[i] as number) * tau;
        x[j] = cjx + (vx[j] as number) * tau;
        y[j] = cjy + (vy[j] as number) * tau;
      }
    }

    // 4. Cushions. Reflect the position about the line the ball centre may not cross.
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      let hit = false;
      // Outward normal of the wall just hit and the speed into it, for the side-spin kick.
      let nxo = 0;
      let nyo = 0;
      let into = 0;
      if ((x[i] as number) < BALL_R) {
        x[i] = 2 * BALL_R - (x[i] as number);
        if ((vx[i] as number) < 0) {
          into = -(vx[i] as number);
          vx[i] = into * E_CUSHION;
          vy[i] = (vy[i] as number) * CUSHION_TANGENT;
          hit = true;
          nxo = -1;
        }
      } else if ((x[i] as number) > xMax) {
        x[i] = 2 * xMax - (x[i] as number);
        if ((vx[i] as number) > 0) {
          into = vx[i] as number;
          vx[i] = -into * E_CUSHION;
          vy[i] = (vy[i] as number) * CUSHION_TANGENT;
          hit = true;
          nxo = 1;
        }
      }
      if ((y[i] as number) < BALL_R) {
        y[i] = 2 * BALL_R - (y[i] as number);
        if ((vy[i] as number) < 0) {
          into = -(vy[i] as number);
          vy[i] = into * E_CUSHION;
          vx[i] = (vx[i] as number) * CUSHION_TANGENT;
          hit = true;
          nxo = 0;
          nyo = -1;
        }
      } else if ((y[i] as number) > yMax) {
        y[i] = 2 * yMax - (y[i] as number);
        if ((vy[i] as number) > 0) {
          into = vy[i] as number;
          vy[i] = -into * E_CUSHION;
          vx[i] = (vx[i] as number) * CUSHION_TANGENT;
          hit = true;
          nxo = 0;
          nyo = 1;
        }
      }
      if (hit) {
        onRail[i] = true;
        if (firstContact !== null) railAfterContact++;
        if (i === cue && side !== 0) {
          // Friction at the cushion turns spin into a sideways kick: Δv = −K·side·|v_in|·(ẑ × outward normal).
          vx[i] = (vx[i] as number) + K_SIDE * side * into * nyo;
          vy[i] = (vy[i] as number) - K_SIDE * side * into * nxo;
          side = side * SIDE_FADE;
        }
      }
    }

    if (withTrace && (steps + 1) % TRACE_EVERY === 0) snap();
  }

  // Everything is at rest (or the time limit hit: freeze whatever is left).
  const out: TableBall[] = [];
  let objectBallsOnRail = 0;
  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue;
    const id = ids[i] as number;
    if (id !== 0 && onRail[i]) objectBallsOnRail++;
    out.push({
      id,
      x: Math.min(Math.max(dmm(x[i] as number), BALL_R * DMM), xMax * DMM),
      y: Math.min(Math.max(dmm(y[i] as number), BALL_R * DMM), yMax * DMM),
    });
  }
  // A ball that sank counted as being on the rail only if it touched one first; recount over all balls.
  for (let i = 0; i < n; i++) if (!alive[i] && ids[i] !== 0 && onRail[i]) objectBallsOnRail++;
  if (withTrace) snap();

  return {
    outcome: {
      balls: out,
      pocketed,
      cuePocketed: pocketed.some((p) => p.id === 0),
      firstContact,
      railAfterContact,
      objectBallsOnRail,
      steps,
    },
    trace,
  };
}
