import { hashState } from '../hash.ts';
import { archeryEngine, type ArcheryAction } from '../archery/engine.ts';
import { basketballEngine, type BasketballAction } from '../basketball/engine.ts';
import { simulateShot as simulateBasketballShot } from '../basketball/physics.ts';
import { dartsEngine, dartsSegmentCentre, type DartsAction } from '../darts/engine.ts';
import {
  eightBallEngine,
  eightBallOnEight,
  type EightBallAction,
  type EightBallState,
} from '../eightball/engine.ts';
import { simulateShot as simulateEightBallShot } from '../eightball/physics.ts';

/**
 * Phase 4 sports / physics scenarios for the cross-runtime determinism check (ARCHITECTURE §6). Kept in its
 * own file; `scenario.ts` adds these to its report. Same rules as there: no Intl, no Date, no Math.random,
 * and no Math.sin/cos/atan2 either (the engines don't use them; neither do these scripts). Every game plays a
 * scripted policy through the real engine to the end (or a fixed step budget), and the physics engines also
 * hash a full animation trace, so the 30 Hz keyframes are held to the same bit-exactness as the outcome.
 */

/** Darts: both variants, a policy sweeping the trebles, the bull and the doubles, to the end. */
function dartsGame(seed: bigint): string {
  const out: string[] = [];
  for (const variant of ['501', 'clock'] as const) {
    let s = dartsEngine.init(['a', 'b'], seed, { variant, maxRounds: 30 });
    for (let i = 0; i < 400 && !dartsEngine.isTerminal(s); i++) {
      const by = dartsEngine.currentPlayers(s)[0]!;
      const mine = s.left[by]!;
      const act: DartsAction =
        variant === 'clock'
          ? { kind: 'throw', ...dartsSegmentCentre(Math.min(20, 22 - mine), 'single') }
          : i % 7 === 6
            ? { kind: 'throw', ...dartsSegmentCentre(0, 'dbull') }
            : mine <= 40 && mine % 2 === 0
              ? { kind: 'throw', ...dartsSegmentCentre(mine / 2, 'double') }
              : { kind: 'throw', ...dartsSegmentCentre(20 - (i % 3), 'triple') };
      s = dartsEngine.apply(s, by, act);
    }
    out.push(hashState(s));
  }
  return hashState(out);
}

/** Archery: three ends, aiming off for the wind by a rule of thumb, draws between 700 and 1000. */
function archeryGame(seed: bigint): string {
  let s = archeryEngine.init(['a', 'b'], seed, {});
  for (let i = 0; i < 100 && !archeryEngine.isTerminal(s); i++) {
    const by = archeryEngine.currentPlayers(s)[0]!;
    const act: ArcheryAction = {
      kind: 'shoot',
      aimX: ((i * 37) % 81) - 40 - s.winds[s.end]! * 3,
      aimY: ((i * 53) % 61) - 30,
      draw: 700 + ((i * 29) % 301),
    };
    s = archeryEngine.apply(s, by, act);
  }
  return hashState(s);
}

/** Basketball: all five racks, flicks sweeping aim and power around the sweet spot; plus one traced shot per rack. */
function basketballGame(seed: bigint): string {
  let s = basketballEngine.init(['a', 'b'], seed, {});
  for (let i = 0; i < 100 && !basketballEngine.isTerminal(s); i++) {
    const by = basketballEngine.currentPlayers(s)[0]!;
    const act: BasketballAction = {
      kind: 'shoot',
      aim: ((i * 29) % 81) - 40,
      power: 470 + ((i * 17) % 160),
    };
    s = basketballEngine.apply(s, by, act);
  }
  const traces: unknown[] = [];
  for (let rack = 0; rack < 5; rack++) {
    traces.push(simulateBasketballShot(rack, { aim: rack * 7 - 14, power: 500 + rack * 11 }, true));
  }
  return hashState({ s, traces });
}

/** A scripted 8 Ball shot: spread angles, mixed power and spin; places the cue / calls the 8 when the rules need it. */
function eightBallAction(s: EightBallState, by: string, i: number): EightBallAction {
  const base: EightBallAction = {
    kind: 'shoot',
    angle: (i * 4177 + 1311) % 36000,
    power: i === 0 ? 1000 : 300 + ((i * 131) % 600),
    spinX: ((i * 13) % 41) - 20,
    spinY: ((i * 29) % 61) - 30,
  };
  const withCall: EightBallAction = eightBallOnEight(s, by)
    ? { ...base, call: { pocket: i % 6 } }
    : base;
  if (s.hand === 'none') return withCall;
  const placed: EightBallAction = {
    ...withCall,
    place: { x: 2000 + ((i * 1900) % 3600), y: 2500 + ((i * 1100) % 6000) },
  };
  return eightBallEngine.validate(s, by, placed).ok ? placed : withCall;
}

/** 8 Ball: the break and up to 45 further shots with spin, ball in hand and the 8 call, plus a traced break. */
function eightBallGame(seed: bigint): string {
  let s = eightBallEngine.init(['a', 'b'], seed, { maxShots: 60 });
  for (let i = 0; i < 46 && !eightBallEngine.isTerminal(s); i++) {
    const by = eightBallEngine.currentPlayers(s)[0]!;
    s = eightBallEngine.apply(s, by, eightBallAction(s, by, i));
  }
  const rack = eightBallEngine.init(['a', 'b'], seed, {}).balls;
  const traced = simulateEightBallShot(rack, { angle: 0, power: 1000, spinX: 0, spinY: 0 }, true);
  return hashState({ s, traced });
}

export function computeSportsReport(seeds: readonly bigint[]): Record<string, string> {
  const report: Record<string, string> = {};
  for (const seed of seeds) report[`darts:${seed.toString()}`] = dartsGame(seed);
  for (const seed of seeds) report[`archery:${seed.toString()}`] = archeryGame(seed);
  for (const seed of seeds) report[`basketball:${seed.toString()}`] = basketballGame(seed);
  for (const seed of seeds) report[`eightball:${seed.toString()}`] = eightBallGame(seed);
  return report;
}
