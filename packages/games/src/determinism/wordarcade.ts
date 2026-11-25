import { hashState } from '../hash.ts';
import { anagramsDictionary, anagramsEngine, solveAnagrams } from '../anagrams/engine.ts';
import { FILLER_COLOURS, fillerEngine, fillerGain } from '../filler/engine.ts';
import { miniGolfEngine, type MiniGolfAction } from '../minigolf/engine.ts';
import { miniGolfHole } from '../minigolf/course.ts';
import { tanksEngine, type TanksAction } from '../tanks/engine.ts';
import type { Weapon } from '../tanks/physics.ts';
import { wordTilesEngine, wordTilesPlays, wordTilesWordSet } from '../wordtiles/engine.ts';
import { WORD_TILES_WORDS } from '../wordtiles/words.ts';
import type { WordTilesAction } from '../wordtiles/engine.ts';

/**
 * Phase 4 word and arcade scenarios for the cross-runtime determinism check (ARCHITECTURE §6). Kept in its
 * own file; `scenario.ts` adds these to its report. Same rules as there: no Intl, no Date, no Math.random.
 * Mini Golf and Tanks run the full fixed-timestep physics, so their hashes are the outcome hashes.
 */

/** Anagrams: seeded letters + solver + two scripted submissions (every 2nd / every 3rd word). */
function anagramsGame(seed: bigint): string {
  let s = anagramsEngine.init(['a', 'b'], seed, {});
  const words = solveAnagrams(s.letters, anagramsDictionary);
  s = anagramsEngine.apply(s, 'a', { kind: 'start' });
  s = anagramsEngine.apply(s, 'a', { kind: 'submit', words: words.filter((_, i) => i % 2 === 0) });
  s = anagramsEngine.apply(s, 'b', { kind: 'start' });
  s = anagramsEngine.apply(s, 'b', {
    kind: 'submit',
    words: [...words, 'ZZZZ'].filter((_, i) => i % 3 !== 1),
  });
  return hashState({ s, words });
}

/** Filler: both players take the colour that wins the most cells (lowest colour on a tie), to the end. */
function fillerGame(seed: bigint): string {
  let s = fillerEngine.init(['a', 'b'], seed, {});
  for (let i = 0; i < 200 && !fillerEngine.isTerminal(s); i++) {
    const by = fillerEngine.currentPlayers(s)[0] as string;
    let best = -1;
    let bestGain = -1;
    for (let c = 0; c < FILLER_COLOURS; c++) {
      if (!fillerEngine.validate(s, by, { kind: 'pick', colour: c }).ok) continue;
      const g = fillerGain(s, s.turn, c);
      if (g > bestGain) {
        best = c;
        bestGain = g;
      }
    }
    s = fillerEngine.apply(s, by, { kind: 'pick', colour: best });
  }
  return hashState(s);
}

/** Word Tiles: three players take the best play from a short word list (else exchange or pass), 30 turns. */
const TILE_WORDS: readonly string[] = WORD_TILES_WORDS.filter(
  (w, i) => w.length <= 4 && i % 6 === 0,
);
function wordTilesGame(seed: bigint): string {
  let s = wordTilesEngine.init(['a', 'b', 'c'], seed, {});
  for (let i = 0; i < 30 && !wordTilesEngine.isTerminal(s); i++) {
    const by = wordTilesEngine.currentPlayers(s)[0] as string;
    const best = wordTilesPlays(s, by, TILE_WORDS, wordTilesWordSet, 1)[0];
    let act: WordTilesAction;
    if (best) act = { kind: 'play', tiles: best.tiles };
    else if (i % 4 === 3 && s.bag.length >= 7)
      act = { kind: 'exchange', letters: (s.racks[by] as string[]).slice(0, 3) };
    else act = { kind: 'pass' };
    s = wordTilesEngine.apply(s, by, act);
  }
  return hashState(s);
}

/** Mini Golf: three players aim every putt at the cup with a power from the distance, plus a small drift. */
function miniGolfGame(seed: bigint): string {
  let s = miniGolfEngine.init(['a', 'b', 'c'], seed, {});
  for (let i = 0; i < 400 && !miniGolfEngine.isTerminal(s); i++) {
    const by = miniGolfEngine.currentPlayers(s)[0] as string;
    const ball = s.ball[by] as { x: number; y: number };
    const h = miniGolfHole(s.hole, s.mirror[s.hole] === true);
    const dx = Math.round(h.cup.x * 10 - ball.x);
    const dy = Math.round(h.cup.y * 10 - ball.y);
    const k = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 1000));
    const dist = Math.sqrt(dx * dx + dy * dy) / 10; // cm
    const power = Math.max(
      1,
      Math.min(1000, Math.round(Math.sqrt(2 * 90 * dist) / 0.6) + ((i * 7) % 41) - 20),
    );
    const act: MiniGolfAction = {
      kind: 'putt',
      dx: Math.round(dx / k) + ((i * 5) % 7) - 3,
      dy: Math.round(dy / k),
      power,
    };
    s = miniGolfEngine.apply(s, by, act);
  }
  return hashState(s);
}

/** Tanks: scripted angles, powers and weapons for both tanks until someone is down or the shots run out. */
function tanksGame(seed: bigint): string {
  let s = tanksEngine.init(['a', 'b'], seed, {});
  const weapons: Weapon[] = ['shell', 'heavy', 'triple', 'shell'];
  for (let i = 0; i < 80 && !tanksEngine.isTerminal(s); i++) {
    const by = tanksEngine.currentPlayers(s)[0] as string;
    const mine = by === s.players[0];
    let weapon = weapons[i % 4] as Weapon;
    if (weapon !== 'shell' && (s.ammo[by]?.[weapon] ?? 0) <= 0) weapon = 'shell';
    const spread = (i * 7) % 45;
    const act: TanksAction = {
      kind: 'fire',
      angle: mine ? 30 + spread : 150 - spread,
      power: 40 + ((i * 13) % 61),
      weapon,
    };
    s = tanksEngine.apply(s, by, act);
  }
  return hashState(s);
}

export function computeWordArcadeReport(seeds: readonly bigint[]): Record<string, string> {
  const report: Record<string, string> = {};
  for (const seed of seeds) report[`anagrams:${seed.toString()}`] = anagramsGame(seed);
  for (const seed of seeds) report[`filler:${seed.toString()}`] = fillerGame(seed);
  for (const seed of seeds) report[`wordtiles:${seed.toString()}`] = wordTilesGame(seed);
  for (const seed of seeds) report[`minigolf:${seed.toString()}`] = miniGolfGame(seed);
  for (const seed of seeds) report[`tanks:${seed.toString()}`] = tanksGame(seed);
  return report;
}
