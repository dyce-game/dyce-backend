import { z } from 'zod';
import type { GameEngine, GameResult, PlayerId, ValidateResult } from '../contract.ts';
import { nextInt, seedRng, type RngState } from '../rng.ts';

/**
 * Ludo, 2-4 players (ADR-035). The die is rolled by the engine from the match's seeded RNG, so a
 * client can never choose its roll; a turn is `roll`, then (if any token can move) `move`.
 *
 * Board geometry (the renderer's contract). A ring of 52 squares, numbered 0..51 going round the
 * board. Seat `i` has a start square `starts[i]`: 0 and 26 for two players, 0, 13, 26 (and 39) for
 * three or four. A token's `progress` is: -1 in the yard; 0..50 squares walked from its own start
 * square (so the absolute square is `(start + progress) % 52`; each colour skips the one ring square
 * just behind its start, where its home column branches off); 51..55 the home column (5 squares,
 * private to the player); 56 home. Home column and home squares are never shared or captured.
 *
 * Rules: a 6 brings a token out of the yard onto your start square. Rolling a 6 moves again after
 * you have moved, but a third 6 in a row passes the turn without a move. You may move any one token
 * by the full roll (a roll that no token can use passes the turn); a token must reach home by exact
 * count. Landing on a square holding opponent tokens sends them all back to the yard unless it is a
 * safe square (the four start squares 0, 13, 26, 39 and the four stars 8, 21, 34, 47), where
 * everyone may share. Your own tokens may stack. First player to bring every token home wins; with
 * `rankAll` the game plays on until one player is left, otherwise the others are ranked by progress.
 * `resign` takes a player out (their place is last, later leavers above earlier ones).
 */
export type LudoCfg = { tokens?: number; rankAll?: boolean };

export const LUDO_RING = 52;
export const LUDO_HOME = 56;
export const LUDO_LAST_RING_PROGRESS = 50;
export const LUDO_SAFE: readonly number[] = [0, 13, 26, 39, 8, 21, 34, 47];

export type LudoLast =
  | { kind: 'roll'; by: PlayerId; dice: number }
  | {
      kind: 'move';
      by: PlayerId;
      dice: number;
      token: number;
      from: number;
      to: number;
      /** Opponent tokens sent back to the yard by this move. */
      captured: { player: PlayerId; token: number }[];
    }
  | { kind: 'pass'; by: PlayerId; dice: number; reason: 'no_move' | 'three_sixes' };

export type LudoState = {
  players: PlayerId[];
  tokensEach: number;
  rankAll: boolean;
  /** Start square of each seat. */
  starts: number[];
  /** tokens[seat][token] = progress, see above. */
  tokens: number[][];
  turn: number;
  phase: 'roll' | 'move';
  /** The roll waiting to be used (phase 'move'), else null. */
  dice: number | null;
  /** Consecutive sixes rolled this turn. */
  sixes: number;
  finished: PlayerId[];
  out: PlayerId[];
  over: boolean;
  last: LudoLast | null;
  seq: number;
  rng: RngState;
};

export type LudoAction = { kind: 'roll' } | { kind: 'move'; token: number } | { kind: 'resign' };

export const ludoActionSchema: z.ZodType<LudoAction> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('roll') }),
  z.object({ kind: z.literal('move'), token: z.number().int().min(0).max(3) }),
  z.object({ kind: z.literal('resign') }),
]);

/** The ring square a token on the loop stands on, or null in the yard, the home column or home. */
export function ludoRingSquare(start: number, progress: number): number | null {
  if (progress < 0 || progress > LUDO_LAST_RING_PROGRESS) return null;
  return (start + progress) % LUDO_RING;
}

const seatStarts = (n: number): number[] =>
  n === 2 ? [0, 26] : n === 3 ? [0, 13, 26] : [0, 13, 26, 39];

/** Where the token would end up with `dice`, or null if it can't move. */
export function ludoTarget(progress: number, dice: number): number | null {
  if (progress === -1) return dice === 6 ? 0 : null;
  if (progress >= LUDO_HOME) return null;
  const to = progress + dice;
  return to <= LUDO_HOME ? to : null;
}

/** Tokens of `seat` that can move with `dice`. */
export function ludoMovableTokens(s: LudoState, seat: number, dice: number): number[] {
  const out: number[] = [];
  const mine = s.tokens[seat]!;
  for (let t = 0; t < mine.length; t++) if (ludoTarget(mine[t]!, dice) !== null) out.push(t);
  return out;
}

const seatOf = (s: LudoState, p: PlayerId): number => s.players.indexOf(p);
const isActive = (s: LudoState, p: PlayerId): boolean =>
  !s.out.includes(p) && !s.finished.includes(p);

/** Seat of the next player still in the game after `from`, or -1 if none. */
function nextSeat(s: LudoState, from: number): number {
  for (let i = 1; i <= s.players.length; i++) {
    const seat = (from + i) % s.players.length;
    if (isActive(s, s.players[seat]!)) return seat;
  }
  return -1;
}

function updateOver(s: LudoState): boolean {
  const remaining = s.players.filter((p) => isActive(s, p)).length;
  if (s.rankAll) return remaining <= 1;
  return s.finished.length >= 1 || remaining <= 1;
}

const progressScore = (tokens: number[]): number =>
  tokens.reduce((a, p) => a + (p < 0 ? 0 : p + 1), 0);

/**
 * What to play when a player's turn times out or a bot sits in: roll, then move the token that
 * captures, else gets home, else leaves the yard, else is furthest along (lowest index on ties).
 */
export function ludoAutoAction(s: LudoState, by: PlayerId): LudoAction {
  const seat = seatOf(s, by);
  if (s.phase === 'roll' || s.dice === null || seat < 0) return { kind: 'roll' };
  const dice = s.dice;
  let best = -1;
  let bestScore = -1;
  for (const t of ludoMovableTokens(s, seat, dice)) {
    const from = s.tokens[seat]![t]!;
    const to = ludoTarget(from, dice)!;
    const square = ludoRingSquare(s.starts[seat]!, to);
    let captures = false;
    if (square !== null && !LUDO_SAFE.includes(square)) {
      captures = s.players.some(
        (p, j) =>
          j !== seat &&
          !s.out.includes(p) &&
          s.tokens[j]!.some((q) => ludoRingSquare(s.starts[j]!, q) === square),
      );
    }
    const score = captures ? 1000 : to === LUDO_HOME ? 900 : from === -1 ? 800 : to + 1;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return { kind: 'move', token: best };
}

export const ludoEngine: GameEngine<LudoState, LudoAction, LudoCfg> = {
  slug: 'ludo',
  actionSchema: ludoActionSchema,
  timers: { turnMs: 24 * 60 * 60 * 1000 },

  init(players, seed, cfg) {
    if (players.length < 2 || players.length > 4) throw new Error('Ludo needs 2 to 4 players');
    if (new Set(players).size !== players.length) throw new Error('Duplicate players');
    const tokensEach = cfg.tokens ?? 4;
    if (!Number.isInteger(tokensEach) || tokensEach < 1 || tokensEach > 4) {
      throw new Error('tokens must be 1..4');
    }
    return {
      players: [...players],
      tokensEach,
      rankAll: cfg.rankAll ?? false,
      starts: seatStarts(players.length),
      tokens: players.map(() => new Array<number>(tokensEach).fill(-1)),
      turn: 0,
      phase: 'roll',
      dice: null,
      sixes: 0,
      finished: [],
      out: [],
      over: false,
      last: null,
      seq: 0,
      rng: seedRng(seed),
    };
  },

  currentPlayers(s) {
    if (s.over) return [];
    return [s.players[s.turn]!];
  },

  validate(s, by, a): ValidateResult {
    if (s.over) return { ok: false, code: 'game_over' };
    const seat = seatOf(s, by);
    if (seat < 0) return { ok: false, code: 'not_a_player' };
    if (a.kind === 'resign') {
      return isActive(s, by) ? { ok: true } : { ok: false, code: 'not_in_game' };
    }
    if (seat !== s.turn) return { ok: false, code: 'not_your_turn' };
    if (a.kind === 'roll') {
      return s.phase === 'roll' ? { ok: true } : { ok: false, code: 'must_move' };
    }
    if (s.phase !== 'move' || s.dice === null) return { ok: false, code: 'must_roll' };
    if (!Number.isInteger(a.token) || a.token < 0 || a.token >= s.tokensEach) {
      return { ok: false, code: 'no_such_token' };
    }
    if (ludoTarget(s.tokens[seat]![a.token]!, s.dice) === null) {
      return { ok: false, code: 'cannot_move' };
    }
    return { ok: true };
  },

  apply(s, by, a) {
    const seat = seatOf(s, by);
    const next: LudoState = { ...s, seq: s.seq + 1 };

    if (a.kind === 'resign') {
      next.out = [...s.out, by];
      if (updateOver(next)) {
        next.over = true;
        next.phase = 'roll';
        next.dice = null;
      } else if (seat === s.turn) {
        next.turn = nextSeat(next, seat);
        next.phase = 'roll';
        next.dice = null;
        next.sixes = 0;
      }
      return next;
    }

    if (a.kind === 'roll') {
      const [r, rng] = nextInt(s.rng, 6);
      const dice = r + 1;
      next.rng = rng;
      const sixes = dice === 6 ? s.sixes + 1 : 0;
      if (sixes >= 3) {
        next.turn = nextSeat(next, seat);
        next.sixes = 0;
        next.dice = null;
        next.last = { kind: 'pass', by, dice, reason: 'three_sixes' };
        return next;
      }
      if (ludoMovableTokens(s, seat, dice).length === 0) {
        next.turn = nextSeat(next, seat);
        next.sixes = 0;
        next.dice = null;
        next.last = { kind: 'pass', by, dice, reason: 'no_move' };
        return next;
      }
      next.phase = 'move';
      next.dice = dice;
      next.sixes = sixes;
      next.last = { kind: 'roll', by, dice };
      return next;
    }

    // move
    const dice = s.dice!;
    const from = s.tokens[seat]![a.token]!;
    const to = ludoTarget(from, dice)!;
    next.tokens = s.tokens.map((row) => row.slice());
    next.tokens[seat]![a.token] = to;

    const captured: { player: PlayerId; token: number }[] = [];
    const square = ludoRingSquare(s.starts[seat]!, to);
    if (square !== null && !LUDO_SAFE.includes(square)) {
      for (let j = 0; j < s.players.length; j++) {
        if (j === seat || s.out.includes(s.players[j]!)) continue;
        for (let t = 0; t < s.tokensEach; t++) {
          if (ludoRingSquare(s.starts[j]!, next.tokens[j]![t]!) === square) {
            next.tokens[j]![t] = -1;
            captured.push({ player: s.players[j]!, token: t });
          }
        }
      }
    }
    next.last = { kind: 'move', by, dice, token: a.token, from, to, captured };
    next.dice = null;
    next.phase = 'roll';

    if (next.tokens[seat]!.every((p) => p === LUDO_HOME)) next.finished = [...s.finished, by];
    if (updateOver(next)) {
      next.over = true;
      return next;
    }
    if (dice === 6 && !next.finished.includes(by)) {
      // another roll for the same player; `sixes` is kept
    } else {
      next.turn = nextSeat(next, seat);
      next.sixes = 0;
    }
    return next;
  },

  isTerminal(s) {
    return s.over;
  },

  result(s): GameResult {
    if (!s.over) return { placements: [], draw: false };
    const placements: PlayerId[][] = s.finished.map((p) => [p]);
    const rest = s.players.filter((p) => isActive(s, p));
    const groups = new Map<number, PlayerId[]>();
    for (const p of rest) {
      const sc = progressScore(s.tokens[seatOf(s, p)]!);
      groups.set(sc, [...(groups.get(sc) ?? []), p]);
    }
    // With a single player left (everyone else resigned) they win outright, whatever their progress.
    for (const [, ps] of [...groups.entries()].sort((x, y) => y[0] - x[0])) placements.push(ps);
    for (const p of [...s.out].reverse()) placements.push([p]);
    return { placements, draw: false };
  },

  view(s) {
    // The die is the server's: never expose the RNG state, which would let a client predict rolls.
    const { rng: _rng, ...visible } = s;
    const legal =
      !s.over && s.phase === 'move' && s.dice !== null ? ludoMovableTokens(s, s.turn, s.dice) : [];
    return { ...visible, legal };
  },
};
