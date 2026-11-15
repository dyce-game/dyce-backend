import { hashState } from '../hash.ts';
import { pigEngine, type PigAction } from '../_example/engine.ts';
import { Rng } from '../rng.ts';
import { cupPongEngine, type CupPongAction } from '../cuppong/engine.ts';
import { whotAutoAction, whotEngine } from '../whot/engine.ts';
import { solveWordHuntBoard, wordHuntDictionary, wordHuntEngine } from '../wordhunt/engine.ts';

/**
 * Cross-runtime determinism scenario (docs/ARCHITECTURE.md §6).
 * Runs the same scripted games and returns hashes. It must give identical output in
 * Node (jest + `pnpm test:determinism`), Deno, and Hermes (the app's `_dev/determinism` screen).
 * This file uses only language features available in all three: no Intl, no Date, no Math.random.
 */
export const SCENARIO_SEEDS: readonly bigint[] = [1n, 42n, 0xdeadbeefn, (1n << 63n) + 12345n];

function scriptedGame(seed: bigint): string {
  const cfg = { target: 40 };
  let s = pigEngine.init(['a', 'b', 'c'], seed, cfg);
  for (let i = 0; i < 5000 && !pigEngine.isTerminal(s); i++) {
    const by = pigEngine.currentPlayers(s)[0]!;
    // Deterministic policy: hold at 12+, otherwise roll.
    const act: PigAction = s.turnPoints >= 12 ? { kind: 'hold' } : { kind: 'roll' };
    s = pigEngine.apply(s, by, act);
  }
  return hashState(s);
}

/** Whot!: three players, the built-in auto policy, to the end (win or blocked). */
function whotGame(seed: bigint): string {
  let s = whotEngine.init(['a', 'b', 'c'], seed, {});
  for (let i = 0; i < 2000 && !whotEngine.isTerminal(s); i++) {
    const by = whotEngine.currentPlayers(s)[0]!;
    s = whotEngine.apply(s, by, whotAutoAction(s, by));
  }
  return hashState(s);
}

/** Word Hunt: board generation + solver + two scripted submissions (every 2nd / every 3rd word). */
function wordHuntGame(seed: bigint): string {
  let s = wordHuntEngine.init(['a', 'b'], seed, {});
  const words = solveWordHuntBoard(s.board, wordHuntDictionary);
  s = wordHuntEngine.apply(s, 'a', { kind: 'start' });
  s = wordHuntEngine.apply(s, 'a', {
    kind: 'submit',
    words: words.filter((_, i) => i % 2 === 0),
  });
  s = wordHuntEngine.apply(s, 'b', { kind: 'start' });
  s = wordHuntEngine.apply(s, 'b', {
    kind: 'submit',
    words: [...words, 'ZZZ'].filter((_, i) => i % 3 !== 1),
  });
  return hashState({ s, words });
}

/** Cup Pong: the full physics path. Scripted inputs sweep aim and power around the cups, to the end. */
function cupPongGame(seed: bigint): string {
  let s = cupPongEngine.init(['a', 'b'], seed, {});
  for (let i = 0; i < 500 && !cupPongEngine.isTerminal(s); i++) {
    const by = cupPongEngine.currentPlayers(s)[0]!;
    const act: CupPongAction = {
      kind: 'throw',
      aim: ((i * 37) % 141) - 70,
      power: 500 + ((i * 13) % 110),
    };
    s = cupPongEngine.apply(s, by, act);
  }
  return hashState(s);
}

export function computeDeterminismReport(): Record<string, string> {
  const report: Record<string, string> = {};
  for (const seed of SCENARIO_SEEDS) report[`pig:${seed.toString()}`] = scriptedGame(seed);
  for (const seed of SCENARIO_SEEDS) report[`whot:${seed.toString()}`] = whotGame(seed);
  for (const seed of SCENARIO_SEEDS) report[`wordhunt:${seed.toString()}`] = wordHuntGame(seed);
  for (const seed of SCENARIO_SEEDS) report[`cuppong:${seed.toString()}`] = cupPongGame(seed);
  return report;
}

/** Golden values. Regenerate deliberately with `pnpm -F @dyce/games determinism -- --print`. */
export const GOLDEN = {
  rngSeed: 123456789n,
  rngVector: [
    525828425, 3007259908, 2366513248, 2649385779, 292938192, 155462125, 220534550, 1356111692,
  ] as number[],
  report: {
    'pig:1': 'e85ede84e530469d',
    'pig:42': 'b292546cf6772a21',
    'pig:3735928559': '5086355e279f71d6',
    'pig:9223372036854788153': 'd6bcfd691ba4618e',
    'whot:1': 'd36edea35e2f0631',
    'whot:42': '1c3236e86f012405',
    'whot:3735928559': 'ee9347b8d513539d',
    'whot:9223372036854788153': '036e63f10cd453fd',
    'wordhunt:1': '84ea43ea0fc8a562',
    'wordhunt:42': '24c00326f290ed56',
    'wordhunt:3735928559': 'f1c8d5f6be0d672b',
    'wordhunt:9223372036854788153': '29f8e26b8dee45f1',
    'cuppong:1': '7ed63110e9a8165a',
    'cuppong:42': 'd2d39bb5f7b8515f',
    'cuppong:3735928559': 'e9db003242099f94',
    'cuppong:9223372036854788153': 'feb68c780ff20ed4',
  } as Record<string, string>,
};

export function computeRngVector(seed: bigint, n: number): number[] {
  const r = new Rng(seed);
  return Array.from({ length: n }, () => r.u32());
}
