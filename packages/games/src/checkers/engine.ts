import { z } from 'zod';
import type { GameEngine, GameResult, PlayerId, ValidateResult } from '../contract.ts';

/**
 * Checkers: 8x8 English draughts (rules decided here are in docs/DECISIONS.md, ADR-035).
 *
 * Twelve men each on the dark squares. Men move one square diagonally forward and capture by
 * jumping an adjacent enemy forward; kings do both in all four diagonal directions. **A capture is
 * forced**, and a jump continues for as long as another jump is available (any sequence is allowed,
 * the longest is not required). A man that reaches the far row is crowned and its move ends there.
 * Captured pieces leave the board when the move is complete, so a piece is never jumped twice.
 * You lose when it is your turn and you have no piece or no legal move. 40 moves each (80 plies)
 * with no capture and no man moved is a draw, and so is the third occurrence of a position.
 *
 * Squares are numbered 0..63, row by row from the top (row 0 = rank the second player starts on
 * the far side). `players[0]` moves first and starts at the bottom (rows 5-7, moving towards row 0).
 * Board characters: `a`/`A` = first player's man/king, `b`/`B` = second player's, `.` empty.
 */
export type CheckersCfg = Record<string, never>;

export type CheckersMove = { path: number[]; captured: number[] };

export type CheckersEndReason = 'no_moves' | 'resign' | 'forty_move' | 'repetition';

export type CheckersState = {
  players: PlayerId[];
  /** 64 characters, see above. */
  board: string;
  /** Index into players of whoever moves next. */
  turn: 0 | 1;
  /** Plies since the last capture or man move. */
  noProgress: number;
  /** Occurrence count of each position (board + side to move), for the repetition draw. */
  seen: Record<string, number>;
  winner: PlayerId | null;
  draw: boolean;
  endReason: CheckersEndReason | null;
  /** The last move, for animation. */
  last: { by: PlayerId; path: number[]; captured: number[]; crowned: boolean } | null;
  seq: number;
};

export type CheckersAction = { kind: 'move'; path: number[] } | { kind: 'resign' };

export const checkersActionSchema: z.ZodType<CheckersAction> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('move'),
    path: z.array(z.number().int().min(0).max(63)).min(2).max(24),
  }),
  z.object({ kind: z.literal('resign') }),
]);

export const CHECKERS_NO_PROGRESS_PLIES = 80;

export const checkersIsDarkSquare = (sq: number): boolean => ((sq >> 3) + (sq & 7)) % 2 === 1;

function initialBoard(): string {
  const out: string[] = [];
  for (let sq = 0; sq < 64; sq++) {
    const r = sq >> 3;
    if (!checkersIsDarkSquare(sq)) out.push('.');
    else if (r <= 2) out.push('b');
    else if (r >= 5) out.push('a');
    else out.push('.');
  }
  return out.join('');
}

const sideOf = (ch: string): 0 | 1 | -1 =>
  ch === 'a' || ch === 'A' ? 0 : ch === 'b' || ch === 'B' ? 1 : -1;
const isKingCh = (ch: string): boolean => ch === 'A' || ch === 'B';

const DIRS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

/** Directions a piece may move or jump in: kings all four, men only forwards. */
function dirsFor(side: 0 | 1, king: boolean): readonly (readonly [number, number])[] {
  if (king) return DIRS;
  return DIRS.filter(([dr]) => dr === (side === 0 ? -1 : 1));
}

const crownRow = (side: 0 | 1): number => (side === 0 ? 0 : 7);

function jumpsFrom(
  board: string[],
  sq: number,
  king: boolean,
  side: 0 | 1,
  path: number[],
  captured: number[],
): CheckersMove[] {
  const out: CheckersMove[] = [];
  const r = sq >> 3;
  const c = sq & 7;
  for (const [dr, dc] of dirsFor(side, king)) {
    const mr = r + dr;
    const mc = c + dc;
    const lr = r + 2 * dr;
    const lc = c + 2 * dc;
    if (lr < 0 || lr > 7 || lc < 0 || lc > 7) continue;
    const mid = mr * 8 + mc;
    const land = lr * 8 + lc;
    if (sideOf(board[mid]!) !== 1 - side) continue;
    if (captured.includes(mid)) continue;
    if (board[land] !== '.') continue;
    const nextPath = [...path, land];
    const nextCaptured = [...captured, mid];
    if (!king && lr === crownRow(side)) {
      out.push({ path: nextPath, captured: nextCaptured });
      continue;
    }
    const deeper = jumpsFrom(board, land, king, side, nextPath, nextCaptured);
    if (deeper.length === 0) out.push({ path: nextPath, captured: nextCaptured });
    else out.push(...deeper);
  }
  return out;
}

/** Every legal move for `side`: all jumps if any exist (forced capture), otherwise all simple moves. */
export function checkersLegalMoves(boardStr: string, side: 0 | 1): CheckersMove[] {
  const board = boardStr.split('');
  const jumps: CheckersMove[] = [];
  const steps: CheckersMove[] = [];
  for (let sq = 0; sq < 64; sq++) {
    const ch = board[sq]!;
    if (sideOf(ch) !== side) continue;
    const king = isKingCh(ch);
    board[sq] = '.'; // the moving piece may pass through its own start square
    jumps.push(...jumpsFrom(board, sq, king, side, [sq], []));
    if (jumps.length === 0) {
      const r = sq >> 3;
      const c = sq & 7;
      for (const [dr, dc] of dirsFor(side, king)) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr > 7 || nc < 0 || nc > 7) continue;
        const to = nr * 8 + nc;
        if (board[to] === '.') steps.push({ path: [sq, to], captured: [] });
      }
    }
    board[sq] = ch;
  }
  return jumps.length > 0 ? jumps : steps;
}

const samePath = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const positionKey = (board: string, turn: number): string => `${board}${turn}`;

function findMove(s: CheckersState, path: number[]): CheckersMove | undefined {
  return checkersLegalMoves(s.board, s.turn).find((m) => samePath(m.path, path));
}

export const checkersEngine: GameEngine<CheckersState, CheckersAction, CheckersCfg> = {
  slug: 'checkers',
  actionSchema: checkersActionSchema,
  timers: { turnMs: 24 * 60 * 60 * 1000 },

  init(players) {
    if (players.length !== 2) throw new Error('Checkers needs exactly 2 players');
    if (players[0] === players[1]) throw new Error('Duplicate players');
    const board = initialBoard();
    return {
      players: [...players],
      board,
      turn: 0,
      noProgress: 0,
      seen: { [positionKey(board, 0)]: 1 },
      winner: null,
      draw: false,
      endReason: null,
      last: null,
      seq: 0,
    };
  },

  currentPlayers(s) {
    if (s.winner !== null || s.draw) return [];
    return [s.players[s.turn]!];
  },

  validate(s, by, a): ValidateResult {
    if (s.winner !== null || s.draw) return { ok: false, code: 'game_over' };
    if (!s.players.includes(by)) return { ok: false, code: 'not_a_player' };
    if (a.kind === 'resign') return { ok: true };
    if (s.players[s.turn] !== by) return { ok: false, code: 'not_your_turn' };
    const moves = checkersLegalMoves(s.board, s.turn);
    if (moves.some((m) => samePath(m.path, a.path))) return { ok: true };
    const mustCapture = moves.length > 0 && moves[0]!.captured.length > 0;
    if (
      moves.some(
        (m) => m.path.length > a.path.length && samePath(m.path.slice(0, a.path.length), a.path),
      )
    ) {
      return { ok: false, code: 'incomplete_jump' };
    }
    const from = a.path[0]!;
    const own = sideOf(s.board[from] ?? '.') === s.turn;
    if (mustCapture && own) return { ok: false, code: 'must_capture' };
    return { ok: false, code: 'illegal_move' };
  },

  apply(s, by, a) {
    if (a.kind === 'resign') {
      const other = s.players.find((p) => p !== by)!;
      return { ...s, winner: other, endReason: 'resign', seq: s.seq + 1 };
    }
    const move = findMove(s, a.path)!;
    const board = s.board.split('');
    const from = move.path[0]!;
    const to = move.path[move.path.length - 1]!;
    const piece = board[from]!;
    board[from] = '.';
    for (const c of move.captured) board[c] = '.';
    let crowned = false;
    let placed = piece;
    if (!isKingCh(piece) && to >> 3 === crownRow(s.turn)) {
      placed = piece.toUpperCase();
      crowned = true;
    }
    board[to] = placed;
    const nextBoard = board.join('');
    const nextTurn = (1 - s.turn) as 0 | 1;
    const progressed = move.captured.length > 0 || !isKingCh(piece);
    const noProgress = progressed ? 0 : s.noProgress + 1;
    const key = positionKey(nextBoard, nextTurn);
    const seen = progressed ? { [key]: 1 } : { ...s.seen, [key]: (s.seen[key] ?? 0) + 1 };

    const next: CheckersState = {
      ...s,
      board: nextBoard,
      turn: nextTurn,
      noProgress,
      seen,
      last: { by, path: move.path, captured: move.captured, crowned },
      seq: s.seq + 1,
    };
    if (checkersLegalMoves(nextBoard, nextTurn).length === 0) {
      next.winner = by;
      next.endReason = 'no_moves';
    } else if ((seen[key] ?? 0) >= 3) {
      next.draw = true;
      next.endReason = 'repetition';
    } else if (noProgress >= CHECKERS_NO_PROGRESS_PLIES) {
      next.draw = true;
      next.endReason = 'forty_move';
    }
    return next;
  },

  isTerminal(s) {
    return s.winner !== null || s.draw;
  },

  result(s): GameResult {
    if (s.winner !== null) {
      return { placements: [[s.winner], s.players.filter((p) => p !== s.winner)], draw: false };
    }
    if (s.draw) return { placements: [[...s.players]], draw: true };
    return { placements: [], draw: false };
  },

  view(s) {
    // Perfect information: everything is public except the repetition bookkeeping.
    const { seen: _seen, ...visible } = s;
    const over = s.winner !== null || s.draw;
    return { ...visible, legal: over ? [] : checkersLegalMoves(s.board, s.turn) };
  },
};
