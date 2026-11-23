import { hashState } from '../hash.ts';
import { ayoEngine, ayoLegalPits } from '../ayo/engine.ts';
import { checkersEngine, checkersLegalMoves } from '../checkers/engine.ts';
import { chessEngine, chessLegalMoves } from '../chess/engine.ts';
import { dotsAndBoxesEngine, dotsOpenLines } from '../dotsandboxes/engine.ts';
import { ludoAutoAction, ludoEngine } from '../ludo/engine.ts';
import { seedRng } from '../rng.ts';
import {
  seaBattleEngine,
  seaBattleRandomPlacement,
  seaBattleShotsAllowed,
} from '../seabattle/engine.ts';

/**
 * Phase 4 board game scenarios for the cross-runtime determinism check (ARCHITECTURE §6). Kept in its own
 * file; `scenario.ts` adds these to its report. Same rules as there: no Intl, no Date, no Math.random.
 * Chess, Checkers, Ayo/Kalah and Dots & Boxes have no randomness, so the seed only picks which legal move a
 * scripted policy takes: the hashes then prove the move generators list moves in the same order everywhere.
 * Ludo uses the seeded dice, Sea Battle the seeded first shooter and layouts.
 */
const pick = (seed: bigint, i: number, n: number): number => (Number(seed % 9973n) + i * 7) % n;

/** Chess: 160 plies of a scripted policy (lowest index offset by the seed), ending early if the game does. */
function chessGame(seed: bigint): string {
  let s = chessEngine.init(['a', 'b'], seed, {});
  for (let i = 0; i < 160 && !chessEngine.isTerminal(s); i++) {
    const by = chessEngine.currentPlayers(s)[0]!;
    const legal = chessLegalMoves(s);
    const m = legal[pick(seed, i, legal.length)]!;
    s = chessEngine.apply(s, by, { kind: 'move', from: m.from, to: m.to, promotion: m.promotion });
  }
  return hashState(s);
}

function checkersGame(seed: bigint): string {
  let s = checkersEngine.init(['a', 'b'], seed, {});
  for (let i = 0; i < 160 && !checkersEngine.isTerminal(s); i++) {
    const by = checkersEngine.currentPlayers(s)[0]!;
    const legal = checkersLegalMoves(s.board, s.turn);
    s = checkersEngine.apply(s, by, {
      kind: 'move',
      path: legal[pick(seed, i, legal.length)]!.path,
    });
  }
  return hashState(s);
}

function ayoGame(seed: bigint, variant: 'ayo' | 'kalah'): string {
  let s = ayoEngine.init(['a', 'b'], seed, { variant });
  for (let i = 0; i < 300 && !ayoEngine.isTerminal(s); i++) {
    const by = ayoEngine.currentPlayers(s)[0]!;
    const legal = ayoLegalPits(s);
    s = ayoEngine.apply(s, by, { kind: 'sow', pit: legal[pick(seed, i, legal.length)]! });
  }
  return hashState(s);
}

function dotsGame(seed: bigint): string {
  let s = dotsAndBoxesEngine.init(['a', 'b'], seed, {});
  for (let i = 0; i < 100 && !dotsAndBoxesEngine.isTerminal(s); i++) {
    const by = dotsAndBoxesEngine.currentPlayers(s)[0]!;
    const open = dotsOpenLines(s);
    const l = open[pick(seed, i, open.length)]!;
    s = dotsAndBoxesEngine.apply(s, by, { kind: 'line', dir: l.dir, r: l.r, c: l.c });
  }
  return hashState(s);
}

/** Ludo: three players, the built-in auto policy, to the end. The dice come from the seeded RNG. */
function ludoGame(seed: bigint): string {
  let s = ludoEngine.init(['a', 'b', 'c'], seed, {});
  for (let i = 0; i < 6000 && !ludoEngine.isTerminal(s); i++) {
    const by = ludoEngine.currentPlayers(s)[0]!;
    s = ludoEngine.apply(s, by, ludoAutoAction(s, by));
  }
  return hashState(s);
}

/** Sea Battle: seeded layouts, then a scripted sweep of the grid (a salvo variant game too), to the end. */
function seaBattleGame(seed: bigint, salvo: boolean): string {
  let s = seaBattleEngine.init(['a', 'b'], seed, { salvo });
  s = seaBattleEngine.apply(s, 'a', {
    kind: 'place',
    ships: seaBattleRandomPlacement(seedRng(seed + 1n)),
  });
  s = seaBattleEngine.apply(s, 'b', {
    kind: 'place',
    ships: seaBattleRandomPlacement(seedRng(seed + 2n)),
  });
  for (let i = 0; i < 400 && !seaBattleEngine.isTerminal(s); i++) {
    const by = seaBattleEngine.currentPlayers(s)[0]!;
    const seat = s.players.indexOf(by);
    const done = new Set(s.shots[seat]);
    const free: number[] = [];
    // A fixed, seed-shifted scan order over the cells not yet fired at.
    for (let k = 0; k < 100; k++) {
      const cell = (k * 37 + Number(seed % 100n)) % 100;
      if (!done.has(cell)) free.push(cell);
    }
    const count = seaBattleShotsAllowed(s, seat);
    s = seaBattleEngine.apply(s, by, {
      kind: 'fire',
      shots: free.slice(0, count).map((c) => ({ r: Math.floor(c / 10), c: c % 10 })),
    });
  }
  return hashState(s);
}

export function computeBoardGamesReport(seeds: readonly bigint[]): Record<string, string> {
  const report: Record<string, string> = {};
  for (const seed of seeds) report[`chess:${seed.toString()}`] = chessGame(seed);
  for (const seed of seeds) report[`checkers:${seed.toString()}`] = checkersGame(seed);
  for (const seed of seeds) report[`ayo:${seed.toString()}`] = ayoGame(seed, 'ayo');
  for (const seed of seeds) report[`kalah:${seed.toString()}`] = ayoGame(seed, 'kalah');
  for (const seed of seeds) report[`dotsandboxes:${seed.toString()}`] = dotsGame(seed);
  for (const seed of seeds) report[`ludo:${seed.toString()}`] = ludoGame(seed);
  for (const seed of seeds) report[`seabattle:${seed.toString()}`] = seaBattleGame(seed, false);
  for (const seed of seeds) report[`seasalvo:${seed.toString()}`] = seaBattleGame(seed, true);
  return report;
}
