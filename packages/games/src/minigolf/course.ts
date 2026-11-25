/**
 * The Mini Golf course: nine hand-made holes (docs/DECISIONS.md ADR-032). Units are centimetres, the
 * playfield is 400 wide and 800 tall, x to the right and y DOWN the screen (like a canvas), tee near the
 * bottom, cup near the top. Every wall is at least 12 cm thick so the ball (at most 6 m/s, 5 cm a step)
 * can never skip through one.
 *
 * Each match mirrors some holes left-to-right, chosen from the seed, so the same nine holes do not always
 * play the same way round. `miniGolfHole(i, mirrored)` returns the geometry the renderer draws and the
 * physics uses.
 */
export const FIELD_W = 400;
export const FIELD_H = 800;
export const HOLES = 9;
export const MAX_STROKES = 6;

export type Rect = { x: number; y: number; w: number; h: number };
export type Circle = { x: number; y: number; r: number };
export type Point = { x: number; y: number };

export type HoleDef = {
  par: number;
  tee: Point;
  cup: Point;
  /** Solid walls (axis-aligned rectangles) in addition to the field edge. */
  walls: Rect[];
  /** Round bumpers: solid, springier than walls. */
  bumpers: Circle[];
  /** Sand: the ball slows down hard while its centre is inside. */
  sand: Rect[];
};

const hole = (h: HoleDef): HoleDef => h;

export const MINI_GOLF_COURSE: readonly HoleDef[] = [
  // 1. Straight
  hole({
    par: 2,
    tee: { x: 200, y: 700 },
    cup: { x: 200, y: 120 },
    walls: [],
    bumpers: [],
    sand: [],
  }),
  // 2. A block in the way
  hole({
    par: 3,
    tee: { x: 200, y: 700 },
    cup: { x: 200, y: 120 },
    walls: [{ x: 130, y: 390, w: 140, h: 30 }],
    bumpers: [],
    sand: [],
  }),
  // 3. Dogleg: a shelf from the left, go round the right end
  hole({
    par: 3,
    tee: { x: 80, y: 700 },
    cup: { x: 80, y: 120 },
    walls: [{ x: 0, y: 380, w: 280, h: 30 }],
    bumpers: [],
    sand: [],
  }),
  // 4. Two bumpers
  hole({
    par: 3,
    tee: { x: 200, y: 700 },
    cup: { x: 200, y: 120 },
    walls: [],
    bumpers: [
      { x: 140, y: 400, r: 22 },
      { x: 260, y: 400, r: 22 },
    ],
    sand: [],
  }),
  // 5. A sand belt across the fairway
  hole({
    par: 3,
    tee: { x: 200, y: 700 },
    cup: { x: 200, y: 120 },
    walls: [],
    bumpers: [],
    sand: [{ x: 0, y: 350, w: 400, h: 120 }],
  }),
  // 6. S-bend: right gap, then left gap
  hole({
    par: 4,
    tee: { x: 200, y: 700 },
    cup: { x: 200, y: 120 },
    walls: [
      { x: 0, y: 520, w: 280, h: 30 },
      { x: 120, y: 320, w: 280, h: 30 },
    ],
    bumpers: [],
    sand: [],
  }),
  // 7. Cup in an alcove, a bumper on the way
  hole({
    par: 3,
    tee: { x: 300, y: 700 },
    cup: { x: 60, y: 110 },
    walls: [{ x: 110, y: 40, w: 30, h: 220 }],
    bumpers: [{ x: 200, y: 450, r: 25 }],
    sand: [],
  }),
  // 8. A corridor with a sand patch
  hole({
    par: 3,
    tee: { x: 200, y: 720 },
    cup: { x: 200, y: 110 },
    walls: [
      { x: 0, y: 180, w: 150, h: 420 },
      { x: 250, y: 180, w: 150, h: 420 },
    ],
    bumpers: [],
    sand: [{ x: 150, y: 380, w: 100, h: 60 }],
  }),
  // 9. Finale: a gate and a bumper field
  hole({
    par: 4,
    tee: { x: 200, y: 720 },
    cup: { x: 200, y: 100 },
    walls: [
      { x: 0, y: 560, w: 160, h: 25 },
      { x: 240, y: 560, w: 160, h: 25 },
    ],
    bumpers: [
      { x: 100, y: 300, r: 20 },
      { x: 300, y: 300, r: 20 },
      { x: 200, y: 400, r: 25 },
    ],
    sand: [],
  }),
];

/** Hole `index` (0-8), flipped left-to-right when `mirrored`. */
export function miniGolfHole(index: number, mirrored: boolean): HoleDef {
  const h = MINI_GOLF_COURSE[index];
  if (!h) throw new RangeError(`No hole ${index}`);
  if (!mirrored) return h;
  const mx = (x: number): number => FIELD_W - x;
  const mr = (r: Rect): Rect => ({ x: FIELD_W - r.x - r.w, y: r.y, w: r.w, h: r.h });
  return {
    par: h.par,
    tee: { x: mx(h.tee.x), y: h.tee.y },
    cup: { x: mx(h.cup.x), y: h.cup.y },
    walls: h.walls.map(mr),
    bumpers: h.bumpers.map((b) => ({ x: mx(b.x), y: b.y, r: b.r })),
    sand: h.sand.map(mr),
  };
}
