import { z } from 'zod';
import type { GameResult, PlayerId, ValidateResult } from '../contract.ts';

/**
 * Helpers shared by the Phase 3 party engines (Doodle Guess, Imposter, Werewolf, Charades) and Crazy
 * Cards. Pure: no clock, no Math.random.
 *
 * TIME. These engines never read a clock. The room server sends `{ kind: 'tick', ms }` with
 * `by = ROOM_ACTOR` for the real time that passed (any slice from 1 ms to MAX_TICK_MS; once a second
 * is typical) and the engine counts its own phase timers down. A client can never send a tick: the
 * room must reject any action whose `kind` is `tick` from a seat (see `isRoomOnlyAction`), and the
 * engines refuse a tick unless `by === ROOM_ACTOR`.
 */
export const ROOM_ACTOR: PlayerId = '$room';
export const MAX_TICK_MS = 10_000;

export type TickAction = { kind: 'tick'; ms: number };

export const tickSchema = z.object({
  kind: z.literal('tick'),
  ms: z.number().int().min(1).max(MAX_TICK_MS),
});

export const isRoomOnlyAction = (a: { kind: string }): boolean => a.kind === 'tick';

export const NOT_PLAYER: ValidateResult = { ok: false, code: 'not_a_player' };
export const GAME_OVER: ValidateResult = { ok: false, code: 'game_over' };

export function assertPlayers(players: readonly PlayerId[], min: number, max: number): void {
  if (players.length < min || players.length > max) {
    throw new Error(`Needs ${min} to ${max} players`);
  }
  if (new Set(players).size !== players.length) throw new Error('Duplicate players');
  if (players.includes(ROOM_ACTOR)) throw new Error('Reserved player id');
}

/** Placements for a points game: highest first, equal scores share a placement. */
export function placementsByScore(
  players: readonly PlayerId[],
  score: (p: PlayerId) => number,
): GameResult {
  const groups = new Map<number, PlayerId[]>();
  for (const p of players) {
    const v = score(p);
    groups.set(v, [...(groups.get(v) ?? []), p]);
  }
  const placements = [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([, ps]) => ps);
  return { placements, draw: placements.length === 1 };
}

/** Two-sided result: the winning side shares first place, the others share second (Pool: ADR-023). */
export function sideResult(winners: readonly PlayerId[], losers: readonly PlayerId[]): GameResult {
  const placements: PlayerId[][] = [[...winners]];
  if (losers.length > 0) placements.push([...losers]);
  return { placements, draw: false };
}

// ---------------------------------------------------------------------------------------------
// Text

/** Lower-case letters and digits only, so "Fried  Rice!" matches "fried rice". */
export function normaliseText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** True when `a` and `b` differ by at most one insertion, deletion or substitution (and are not equal). */
export function oneEditApart(a: string, b: string): boolean {
  if (a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  const [longer, shorter] = a.length > b.length ? [a, b] : [b, a];
  return longer.slice(i + 1) === shorter.slice(i);
}

/**
 * A small profanity check for word packs and for text players type into a shared screen (clues, guesses).
 * Whole-token matches for short words (so "class" is fine), prefix matches for the stems. It is a
 * safety net, not moderation: reports and chat moderation stay in the trust-and-safety work.
 */
const BLOCK_TOKENS: readonly string[] = [
  'sex',
  'dick',
  'cock',
  'anus',
  'rape',
  'porn',
  'slut',
  'whore',
  'tits',
  'cum',
  'ashawo',
  'oloshi',
];
const BLOCK_STEMS: readonly string[] = [
  'fuck',
  'shit',
  'bitch',
  'cunt',
  'pussy',
  'nigg',
  'fagg',
  'penis',
  'vagina',
  'bastard',
  'asshole',
  'wanker',
];

export function isCleanText(text: string): boolean {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
  for (const t of tokens) {
    if (BLOCK_TOKENS.includes(t)) return false;
    for (const stem of BLOCK_STEMS) if (t.startsWith(stem)) return false;
  }
  return true;
}

/** Trim and collapse spaces; the shape every free-text action goes through. */
export function tidyText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
