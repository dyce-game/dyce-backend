import type { GameEngine } from '@dyce/games';
import type { FinalOutcome } from './store.ts';

/**
 * Works out the final ranking of a live match, shared by turn rooms (`LiveMatch`) and party rooms
 * (`PartyMatch`): whoever is still in, by the engine's own order, then the forfeits (the last to forfeit
 * placed better than the first). A forfeited seat never takes money: it is removed from the engine's
 * groups and ranked last. When everybody walked away nobody wins and every seat is given its stake back.
 */
export function computeOutcome(
  engine: GameEngine<unknown, unknown, unknown>,
  state: unknown,
  seats: readonly { userId: string }[],
  forfeited: readonly string[],
): FinalOutcome {
  const out = new Set(forfeited);
  const active = seats.filter((s) => !out.has(s.userId));
  if (active.length === 0) {
    return { placements: [seats.map((s) => s.userId)], draw: true, forfeited: [...out] };
  }
  let groups: string[][];
  let draw = false;
  if (engine.isTerminal(state)) {
    const r = engine.result(state);
    groups = r.placements.map((g) => g.filter((id) => !out.has(id))).filter((g) => g.length > 0);
    draw = r.draw && groups.length > 0 && groups[0]!.length > 1 && groups.length === 1;
  } else {
    // Everyone else left: the one who stayed wins.
    groups = active.map((s) => [s.userId]);
  }
  const forfeitGroups = [...forfeited].reverse().map((id) => [id]);
  const ranked = new Set(groups.flat());
  const missing = active
    .map((s) => s.userId)
    .filter((id) => !ranked.has(id))
    .map((id) => [id]);
  return {
    placements: [...groups, ...missing, ...forfeitGroups],
    draw,
    forfeited: [...forfeited],
  };
}
