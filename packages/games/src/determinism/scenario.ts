import { hashState } from '../hash.ts';
import { pigEngine, type PigAction } from '../_example/engine.ts';
import { Rng } from '../rng.ts';
import { cupPongEngine, type CupPongAction } from '../cuppong/engine.ts';
import { ROOM_ACTOR } from '../party/common.ts';
import { crazyCardsAutoAction, crazyCardsEngine } from '../crazycards/engine.ts';
import { charadesEngine } from '../charades/engine.ts';
import { doodleGuessEngine } from '../doodleguess/engine.ts';
import { imposterEngine, type ImposterAction } from '../imposter/engine.ts';
import { werewolfEngine, type WerewolfAction } from '../werewolf/engine.ts';
import { whotAutoAction, whotEngine } from '../whot/engine.ts';
import { solveWordHuntBoard, wordHuntDictionary, wordHuntEngine } from '../wordhunt/engine.ts';
import { computeWordArcadeReport } from './wordarcade.ts';
import { computeBoardGamesReport } from './boardgames.ts';
import { computeSportsReport } from './sports.ts';

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

/** Crazy Cards: four players, the built-in auto policy, to the end (win or blocked). */
function crazyCardsGame(seed: bigint): string {
  let s = crazyCardsEngine.init(['a', 'b', 'c', 'd'], seed, {});
  for (let i = 0; i < 3000 && !crazyCardsEngine.isTerminal(s); i++) {
    const by = crazyCardsEngine.currentPlayers(s)[0]!;
    s = crazyCardsEngine.apply(s, by, crazyCardsAutoAction(s, by));
  }
  return hashState(s);
}

/** Imposter: six players, everyone ready, a clue each, everyone votes for the next two players, then timers run out. */
function imposterGame(seed: bigint): string {
  const players = ['a', 'b', 'c', 'd', 'e', 'f'];
  let s = imposterEngine.init(players, seed, {});
  for (let i = 0; i < 400 && !imposterEngine.isTerminal(s); i++) {
    const who = imposterEngine.currentPlayers(s);
    const by = who[i % who.length]!;
    const others = players.filter((p) => p !== by);
    const act: ImposterAction =
      s.phase === 'reveal'
        ? { kind: 'ready' }
        : s.phase === 'clue'
          ? ({ kind: 'clue', text: 'clue' + String(i) } as const)
          : s.phase === 'vote'
            ? { kind: 'vote', targets: [others[i % others.length]!] }
            : { kind: 'guess', text: 'rice' };
    s = imposterEngine.apply(s, by, act);
    if (i % 17 === 16) s = imposterEngine.apply(s, ROOM_ACTOR, { kind: 'tick', ms: 4000 });
  }
  return hashState(s);
}

/** Werewolf: seven players; wolves kill the next villager, the vote and the clock decide the rest. */
function werewolfGame(seed: bigint): string {
  const players = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  let s = werewolfEngine.init(players, seed, { maxNights: 6 });
  for (let i = 0; i < 600 && !werewolfEngine.isTerminal(s); i++) {
    const who = werewolfEngine.currentPlayers(s);
    const by = who[0]!;
    const alive = players.filter((p) => !s.dead.includes(p) && p !== by);
    const target = alive[i % alive.length]!;
    const role = s.roles[by];
    const act: WerewolfAction =
      s.phase === 'night'
        ? role === 'werewolf'
          ? { kind: 'kill', target }
          : role === 'seer'
            ? { kind: 'inspect', target }
            : { kind: 'protect', target }
        : s.phase === 'day'
          ? { kind: 'ready' }
          : { kind: 'vote', target: i % 3 === 0 ? null : target };
    if (werewolfEngine.validate(s, by, act).ok) s = werewolfEngine.apply(s, by, act);
    else s = werewolfEngine.apply(s, ROOM_ACTOR, { kind: 'tick', ms: 10_000 });
  }
  return hashState(s);
}

/** Charades: five players in two teams, every turn scores two cards and lets the clock run out. */
function charadesGame(seed: bigint): string {
  let s = charadesEngine.init(['a', 'b', 'c', 'd', 'e'], seed, { rounds: 1 });
  for (let i = 0; i < 500 && !charadesEngine.isTerminal(s); i++) {
    const by = charadesEngine.currentPlayers(s)[0]!;
    if (s.phase === 'ready') s = charadesEngine.apply(s, by, { kind: 'start' });
    else if (i % 3 === 0) s = charadesEngine.apply(s, by, { kind: 'skip' });
    else if (i % 3 === 1) s = charadesEngine.apply(s, by, { kind: 'got_it' });
    else s = charadesEngine.apply(s, ROOM_ACTOR, { kind: 'tick', ms: 7000 });
  }
  return hashState(s);
}

/** Doodle Guess: four players, strokes, a correct guess, a wrong one and clock ticks, to the end of one round. */
function doodleGame(seed: bigint): string {
  const players = ['a', 'b', 'c', 'd'];
  let s = doodleGuessEngine.init(players, seed, { rounds: 1 });
  for (let i = 0; i < 400 && !doodleGuessEngine.isTerminal(s); i++) {
    const drawer = s.order[s.turn % s.order.length]!;
    const guessers = players.filter((p) => p !== drawer && !s.solvers.includes(p));
    if (s.phase === 'choose')
      s = doodleGuessEngine.apply(s, drawer, { kind: 'choose', index: i % 3 });
    else if (i % 4 === 0) {
      s = doodleGuessEngine.apply(s, drawer, {
        kind: 'stroke',
        points: [
          [i % 1000, 5],
          [(i * 7) % 1000, 9],
        ],
        color: i % 16,
        width: 1 + (i % 8),
      });
    } else if (i % 4 === 1 && guessers.length > 0) {
      s = doodleGuessEngine.apply(s, guessers[0]!, { kind: 'guess', text: 'nothing' });
    } else if (i % 4 === 2 && guessers.length > 0) {
      s = doodleGuessEngine.apply(s, guessers[0]!, { kind: 'guess', text: s.word! });
    } else s = doodleGuessEngine.apply(s, ROOM_ACTOR, { kind: 'tick', ms: 9000 });
  }
  return hashState(s);
}

export function computeDeterminismReport(): Record<string, string> {
  const report: Record<string, string> = {};
  for (const seed of SCENARIO_SEEDS) report[`pig:${seed.toString()}`] = scriptedGame(seed);
  for (const seed of SCENARIO_SEEDS) report[`whot:${seed.toString()}`] = whotGame(seed);
  for (const seed of SCENARIO_SEEDS) report[`wordhunt:${seed.toString()}`] = wordHuntGame(seed);
  for (const seed of SCENARIO_SEEDS) report[`cuppong:${seed.toString()}`] = cupPongGame(seed);
  for (const seed of SCENARIO_SEEDS) report[`crazycards:${seed.toString()}`] = crazyCardsGame(seed);
  for (const seed of SCENARIO_SEEDS) report[`imposter:${seed.toString()}`] = imposterGame(seed);
  for (const seed of SCENARIO_SEEDS) report[`werewolf:${seed.toString()}`] = werewolfGame(seed);
  for (const seed of SCENARIO_SEEDS) report[`charades:${seed.toString()}`] = charadesGame(seed);
  for (const seed of SCENARIO_SEEDS) report[`doodle:${seed.toString()}`] = doodleGame(seed);
  Object.assign(report, computeWordArcadeReport(SCENARIO_SEEDS)); // anagrams, filler, wordtiles, minigolf, tanks
  Object.assign(report, computeBoardGamesReport(SCENARIO_SEEDS)); // chess, checkers, ayo, kalah, dots, ludo, sea battle
  Object.assign(report, computeSportsReport(SCENARIO_SEEDS)); // darts, archery, basketball, 8 ball
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
    'crazycards:1': 'f4aeea7c668d22bd',
    'crazycards:42': '216c0c46023a536e',
    'crazycards:3735928559': 'c9e53ba40480cb1f',
    'crazycards:9223372036854788153': '0513fe3a0d4b579d',
    'imposter:1': '9c5252f683627662',
    'imposter:42': 'fe02f8fa5b964eeb',
    'imposter:3735928559': '8993675fd9272c46',
    'imposter:9223372036854788153': 'de898936b3c0f93f',
    'werewolf:1': '0017e68ccf4b1d48',
    'werewolf:42': '0f693157d0422018',
    'werewolf:3735928559': 'da600aa68ee49732',
    'werewolf:9223372036854788153': '8b8bb92797bcbc00',
    'charades:1': 'd1d0a3f88cf7426a',
    'charades:42': 'f95743438eb4c990',
    'charades:3735928559': 'f1b0c3d9fb4a2973',
    'charades:9223372036854788153': '7efc42c11ee5040a',
    'doodle:1': 'a6eae6334f183b14',
    'doodle:42': 'f33bd2c4c94c617e',
    'doodle:3735928559': 'ec21abe0cca5d4ac',
    'doodle:9223372036854788153': 'e53d551476baa922',
    'anagrams:1': '6ea72182f6279b79',
    'anagrams:42': '353bbecf3cd79ee0',
    'anagrams:3735928559': '9e2b4f40a0309ac4',
    'anagrams:9223372036854788153': '95e4b5facdb32474',
    'filler:1': '98b3d818330174bb',
    'filler:42': '6c8dc11c877cc37d',
    'filler:3735928559': '3b8f409a56dcd783',
    'filler:9223372036854788153': 'aa41baa02ac34479',
    'wordtiles:1': '46434c1f9c3667c2',
    'wordtiles:42': '37e1544c82e52a86',
    'wordtiles:3735928559': '1f6316349e88d732',
    'wordtiles:9223372036854788153': 'd6fd72499289f64a',
    'minigolf:1': '46cfb582748f06de',
    'minigolf:42': '51899b993359c2cd',
    'minigolf:3735928559': 'c9a267b16e8b69e4',
    'minigolf:9223372036854788153': 'b64aeb907a2fae82',
    'tanks:1': '3f0b95158a51a691',
    'tanks:42': '574da40d04d0bd44',
    'tanks:3735928559': 'ba76fc769f02b3f5',
    'tanks:9223372036854788153': 'db7371e7b0c6e469',
    'chess:1': '509e315b35efd483',
    'chess:42': 'f666aa750426d22c',
    'chess:3735928559': 'a0e59b94a0e0fb91',
    'chess:9223372036854788153': 'ef01cb8c6b9a7aa6',
    'checkers:1': '2b8254fa5284a8fe',
    'checkers:42': 'dbeb32cdfaf0fb8b',
    'checkers:3735928559': '4a0b164ba96572ff',
    'checkers:9223372036854788153': '0e5c23901450fc1f',
    'ayo:1': 'c4118dcca7dca10f',
    'ayo:42': '28e81f01ca8192da',
    'ayo:3735928559': '9af7f7378b3cbc24',
    'ayo:9223372036854788153': '35be2978ddeaceea',
    'kalah:1': '4b264d2d5cbd0c9a',
    'kalah:42': '1c0343aaa736614f',
    'kalah:3735928559': 'd491edce3ee13798',
    'kalah:9223372036854788153': 'cad20be943b6e409',
    'dotsandboxes:1': '5dd81dbd65e6fd06',
    'dotsandboxes:42': '0d552c8128e87774',
    'dotsandboxes:3735928559': '1b394a2db4d1f725',
    'dotsandboxes:9223372036854788153': '4ee445438c0815c8',
    'ludo:1': '2b4433366b156194',
    'ludo:42': '54370a25152d98dc',
    'ludo:3735928559': '63c24501f7d13dde',
    'ludo:9223372036854788153': 'add99726fd8774f3',
    'seabattle:1': 'f9b64476fce1b925',
    'seabattle:42': 'f7bfbdbcc99e137e',
    'seabattle:3735928559': '776823f65bb80a5b',
    'seabattle:9223372036854788153': 'd81df12580c1e500',
    'seasalvo:1': 'b7f1692728902a47',
    'seasalvo:42': 'aa5b1ddeceb8b12e',
    'seasalvo:3735928559': 'bc54554507f1cafe',
    'seasalvo:9223372036854788153': 'c9e07ef60f9e4400',
    'darts:1': 'f98d5b7d0565fbf1',
    'darts:42': '79ab6cf8a6785e21',
    'darts:3735928559': 'c5150e8c2520ca43',
    'darts:9223372036854788153': 'ecdfe5c0221bdc1e',
    'archery:1': 'f9f15fb148a140ff',
    'archery:42': '97e0d4623b5cc985',
    'archery:3735928559': '26c2385310b0ace2',
    'archery:9223372036854788153': 'f09e6679880e1171',
    'basketball:1': 'ba1b54c5e9932906',
    'basketball:42': '5cec4643211e24cc',
    'basketball:3735928559': '33b7e80ba22ab25e',
    'basketball:9223372036854788153': 'd8bd47fb47ebeefb',
    'eightball:1': 'c0b0371a2de4503d',
    'eightball:42': 'b19501a27e9493ce',
    'eightball:3735928559': '0d8c09cc51fd7036',
    'eightball:9223372036854788153': '8fac094f13695b5a',
  } as Record<string, string>,
};

export function computeRngVector(seed: bigint, n: number): number[] {
  const r = new Rng(seed);
  return Array.from({ length: n }, () => r.u32());
}
