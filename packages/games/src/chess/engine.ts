import { z } from 'zod';
import type { GameEngine, GameResult, PlayerId, ValidateResult } from '../contract.ts';

/**
 * Chess (ADR-035). A from-scratch rules engine (no dependency), full FIDE rules for play: castling,
 * en passant, promotion, check, checkmate, stalemate, and the automatic draws below.
 *
 * `players[0]` plays White and moves first. Squares are algebraic (`e4`). The board is a 64 character
 * string in FEN order (index 0 = a8 ... 63 = h1; uppercase White, lowercase Black, `.` empty).
 *
 * Draws that end the game by themselves (no claim needed): stalemate, insufficient material (bare
 * kings, a lone minor piece, or only bishops that all stand on one colour), the third occurrence of
 * the same position (same side to move, castling rights and en passant possibility), and 50 moves
 * (100 plies) without a pawn move or capture. Checkmate takes precedence over those. Offering draws is
 * not part of the engine; `resign` ends the game.
 */
export type ChessCfg = { fen?: string };

export const CHESS_START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export const CHESS_FIFTY_MOVE_PLIES = 100;

export type ChessEndReason =
  'checkmate' | 'stalemate' | 'insufficient_material' | 'repetition' | 'fifty_move' | 'resign';

export type ChessPromotion = 'q' | 'r' | 'b' | 'n';

export type ChessState = {
  players: PlayerId[];
  /** 64 chars, FEN order. */
  board: string;
  /** 0 = White to move, 1 = Black. */
  turn: 0 | 1;
  /** Subset of "KQkq" in that order, or "-". */
  castling: string;
  /** The square a pawn just skipped with a two-square move (FEN style), or null. */
  ep: string | null;
  halfmove: number;
  fullmove: number;
  /** Occurrence count per position, for threefold repetition. */
  seen: Record<string, number>;
  /** Moves so far in standard algebraic notation. */
  san: string[];
  last: {
    by: PlayerId;
    from: string;
    to: string;
    piece: string;
    captured: string | null;
    promotion: ChessPromotion | null;
    castle: 'K' | 'Q' | null;
    enPassant: boolean;
    san: string;
  } | null;
  /** The side to move is in check. */
  check: boolean;
  winner: PlayerId | null;
  draw: boolean;
  endReason: ChessEndReason | null;
  seq: number;
};

export type ChessAction =
  { kind: 'move'; from: string; to: string; promotion?: ChessPromotion } | { kind: 'resign' };

const SQUARE = z.string().regex(/^[a-h][1-8]$/);

export const chessActionSchema: z.ZodType<ChessAction> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('move'),
    from: SQUARE,
    to: SQUARE,
    promotion: z.enum(['q', 'r', 'b', 'n']).optional(),
  }),
  z.object({ kind: z.literal('resign') }),
]);

/* ------------------------------------------------------------------ internals */

// Piece codes: type 1..6 = P N B R Q K; +8 for Black. 0 = empty.
const PAWN = 1;
const KNIGHT = 2;
const BISHOP = 3;
const ROOK = 4;
const QUEEN = 5;
const KING = 6;

const F_DOUBLE = 1;
const F_EP = 2;
const F_KS = 4;
const F_QS = 8;

type Move = {
  from: number;
  to: number;
  piece: number;
  captured: number;
  promo: number;
  flag: number;
};
type Pos = { b: number[]; turn: 0 | 1; castle: number; ep: number };

const LETTERS = 'PNBRQK';
const codeOfChar = (ch: string): number => {
  const i = LETTERS.indexOf(ch.toUpperCase()) + 1;
  if (i === 0) return 0;
  return ch === ch.toUpperCase() ? i : i + 8;
};
const charOfCode = (c: number): string =>
  c === 0 ? '.' : c > 8 ? LETTERS[(c & 7) - 1]!.toLowerCase() : LETTERS[c - 1]!;
const colorOf = (c: number): 0 | 1 => (c >> 3) as 0 | 1;
const typeOf = (c: number): number => c & 7;

export const chessSquareName = (sq: number): string => 'abcdefgh'[sq & 7]! + String(8 - (sq >> 3));
const sqFrom = (name: string): number => (8 - Number(name[1])) * 8 + 'abcdefgh'.indexOf(name[0]!);

const KNIGHT_OFFS: readonly (readonly [number, number])[] = [
  [-2, -1],
  [-2, 1],
  [-1, -2],
  [-1, 2],
  [1, -2],
  [1, 2],
  [2, -1],
  [2, 1],
];
const KING_OFFS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];
const ORTHO: readonly (readonly [number, number])[] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];
const DIAG: readonly (readonly [number, number])[] = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

// Castling rights bits and which squares clear them when a piece moves from or to them.
const WK = 1;
const WQ = 2;
const BK = 4;
const BQ = 8;
const CASTLE_MASK: Record<number, number> = {
  60: WK | WQ,
  63: WK,
  56: WQ,
  4: BK | BQ,
  7: BK,
  0: BQ,
};

function attacked(b: readonly number[], sq: number, by: 0 | 1): boolean {
  const r = sq >> 3;
  const c = sq & 7;
  const base = by * 8;
  const pr = by === 0 ? r + 1 : r - 1;
  if (pr >= 0 && pr < 8) {
    if (c > 0 && b[pr * 8 + c - 1] === base + PAWN) return true;
    if (c < 7 && b[pr * 8 + c + 1] === base + PAWN) return true;
  }
  for (const [dr, dc] of KNIGHT_OFFS) {
    const nr = r + dr;
    const nc = c + dc;
    if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8 && b[nr * 8 + nc] === base + KNIGHT) return true;
  }
  for (const [dr, dc] of KING_OFFS) {
    const nr = r + dr;
    const nc = c + dc;
    if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8 && b[nr * 8 + nc] === base + KING) return true;
  }
  for (const [dr, dc] of ORTHO) {
    let nr = r + dr;
    let nc = c + dc;
    while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
      const p = b[nr * 8 + nc]!;
      if (p !== 0) {
        if (p === base + ROOK || p === base + QUEEN) return true;
        break;
      }
      nr += dr;
      nc += dc;
    }
  }
  for (const [dr, dc] of DIAG) {
    let nr = r + dr;
    let nc = c + dc;
    while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
      const p = b[nr * 8 + nc]!;
      if (p !== 0) {
        if (p === base + BISHOP || p === base + QUEEN) return true;
        break;
      }
      nr += dr;
      nc += dc;
    }
  }
  return false;
}

const kingSquare = (b: readonly number[], color: 0 | 1): number => b.indexOf(color * 8 + KING);

function pseudoMoves(pos: Pos): Move[] {
  const { b, turn } = pos;
  const out: Move[] = [];
  const enemy = (1 - turn) as 0 | 1;
  for (let from = 0; from < 64; from++) {
    const p = b[from]!;
    if (p === 0 || colorOf(p) !== turn) continue;
    const t = typeOf(p);
    const r = from >> 3;
    const c = from & 7;
    if (t === PAWN) {
      const dr = turn === 0 ? -1 : 1;
      const startRow = turn === 0 ? 6 : 1;
      const promoRow = turn === 0 ? 0 : 7;
      const r1 = r + dr;
      const pushPawn = (to: number, captured: number, flag: number): void => {
        if (r1 === promoRow) {
          for (const promo of [QUEEN, ROOK, BISHOP, KNIGHT]) {
            out.push({ from, to, piece: p, captured, promo, flag });
          }
        } else out.push({ from, to, piece: p, captured, promo: 0, flag });
      };
      const to1 = r1 * 8 + c;
      if (b[to1] === 0) {
        pushPawn(to1, 0, 0);
        const to2 = (r + 2 * dr) * 8 + c;
        if (r === startRow && b[to2] === 0) {
          out.push({ from, to: to2, piece: p, captured: 0, promo: 0, flag: F_DOUBLE });
        }
      }
      for (const dc of [-1, 1]) {
        const nc = c + dc;
        if (nc < 0 || nc > 7) continue;
        const to = r1 * 8 + nc;
        const target = b[to]!;
        if (target !== 0 && colorOf(target) === enemy) pushPawn(to, target, 0);
        else if (target === 0 && to === pos.ep) {
          out.push({ from, to, piece: p, captured: enemy * 8 + PAWN, promo: 0, flag: F_EP });
        }
      }
    } else if (t === KNIGHT || t === KING) {
      for (const [dr, dc] of t === KNIGHT ? KNIGHT_OFFS : KING_OFFS) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr > 7 || nc < 0 || nc > 7) continue;
        const to = nr * 8 + nc;
        const target = b[to]!;
        if (target === 0 || colorOf(target) === enemy) {
          out.push({ from, to, piece: p, captured: target, promo: 0, flag: 0 });
        }
      }
    } else {
      const dirs = t === BISHOP ? DIAG : t === ROOK ? ORTHO : [...ORTHO, ...DIAG];
      for (const [dr, dc] of dirs) {
        let nr = r + dr;
        let nc = c + dc;
        while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
          const to = nr * 8 + nc;
          const target = b[to]!;
          if (target === 0) out.push({ from, to, piece: p, captured: 0, promo: 0, flag: 0 });
          else {
            if (colorOf(target) === enemy)
              out.push({ from, to, piece: p, captured: target, promo: 0, flag: 0 });
            break;
          }
          nr += dr;
          nc += dc;
        }
      }
    }
  }
  // Castling: rights, empty squares between, and the king neither in, through nor into check.
  const king = turn === 0 ? 60 : 4;
  if (b[king] === turn * 8 + KING && !attacked(b, king, enemy)) {
    const rook = turn * 8 + ROOK;
    const ks = turn === 0 ? WK : BK;
    const qs = turn === 0 ? WQ : BQ;
    if (
      pos.castle & ks &&
      b[king + 3] === rook &&
      b[king + 1] === 0 &&
      b[king + 2] === 0 &&
      !attacked(b, king + 1, enemy) &&
      !attacked(b, king + 2, enemy)
    ) {
      out.push({ from: king, to: king + 2, piece: b[king]!, captured: 0, promo: 0, flag: F_KS });
    }
    if (
      pos.castle & qs &&
      b[king - 4] === rook &&
      b[king - 1] === 0 &&
      b[king - 2] === 0 &&
      b[king - 3] === 0 &&
      !attacked(b, king - 1, enemy) &&
      !attacked(b, king - 2, enemy)
    ) {
      out.push({ from: king, to: king - 2, piece: b[king]!, captured: 0, promo: 0, flag: F_QS });
    }
  }
  return out;
}

/** All fully legal moves. Mutates `pos.b` temporarily but always restores it. */
function legalMoves(pos: Pos): Move[] {
  const b = pos.b;
  const turn = pos.turn;
  const enemy = (1 - turn) as 0 | 1;
  const out: Move[] = [];
  const myKing = kingSquare(b, turn);
  for (const m of pseudoMoves(pos)) {
    const savedFrom = b[m.from]!;
    const savedTo = b[m.to]!;
    const epSq = m.flag & F_EP ? (m.from >> 3) * 8 + (m.to & 7) : -1;
    const savedEp = epSq >= 0 ? b[epSq]! : 0;
    b[m.to] = m.promo ? turn * 8 + m.promo : m.piece;
    b[m.from] = 0;
    if (epSq >= 0) b[epSq] = 0;
    const ksq = typeOf(m.piece) === KING ? m.to : myKing;
    const safe = !attacked(b, ksq, enemy);
    b[m.from] = savedFrom;
    b[m.to] = savedTo;
    if (epSq >= 0) b[epSq] = savedEp;
    if (safe) out.push(m);
  }
  return out;
}

function makeMove(pos: Pos, m: Move): Pos {
  const b = pos.b.slice();
  const turn = pos.turn;
  b[m.to] = m.promo ? turn * 8 + m.promo : m.piece;
  b[m.from] = 0;
  if (m.flag & F_EP) b[(m.from >> 3) * 8 + (m.to & 7)] = 0;
  if (m.flag & F_KS) {
    b[m.to + 1] = 0;
    b[m.to - 1] = turn * 8 + ROOK;
  }
  if (m.flag & F_QS) {
    b[m.to - 2] = 0;
    b[m.to + 1] = turn * 8 + ROOK;
  }
  const castle = pos.castle & ~(CASTLE_MASK[m.from] ?? 0) & ~(CASTLE_MASK[m.to] ?? 0);
  const ep = m.flag & F_DOUBLE ? (m.from + m.to) >> 1 : -1;
  return { b, turn: (1 - turn) as 0 | 1, castle, ep };
}

/* ------------------------------------------------------------------ FEN and state conversion */

const castleBits = (s: string): number =>
  (s.includes('K') ? WK : 0) |
  (s.includes('Q') ? WQ : 0) |
  (s.includes('k') ? BK : 0) |
  (s.includes('q') ? BQ : 0);
const castleString = (bits: number): string => {
  const out =
    (bits & WK ? 'K' : '') +
    (bits & WQ ? 'Q' : '') +
    (bits & BK ? 'k' : '') +
    (bits & BQ ? 'q' : '');
  return out === '' ? '-' : out;
};

type Parsed = { pos: Pos; halfmove: number; fullmove: number };

/** Parse and sanity-check a FEN. Throws on anything the engine could not play from. */
function parseFen(fen: string): Parsed {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4 || parts.length > 6) throw new Error('Invalid FEN: wrong number of fields');
  const [placement, active, castling, epField] = parts as [string, string, string, string];
  const ranks = placement.split('/');
  if (ranks.length !== 8) throw new Error('Invalid FEN: need 8 ranks');
  const b: number[] = [];
  for (const rank of ranks) {
    let n = 0;
    for (const ch of rank) {
      if (ch >= '1' && ch <= '8') {
        for (let i = 0; i < Number(ch); i++) b.push(0);
        n += Number(ch);
      } else {
        const code = codeOfChar(ch);
        if (code === 0) throw new Error('Invalid FEN: bad piece');
        b.push(code);
        n += 1;
      }
    }
    if (n !== 8) throw new Error('Invalid FEN: rank does not have 8 files');
  }
  if (active !== 'w' && active !== 'b') throw new Error('Invalid FEN: side to move');
  if (b.filter((x) => x === KING).length !== 1 || b.filter((x) => x === 8 + KING).length !== 1) {
    throw new Error('Invalid FEN: each side needs exactly one king');
  }
  for (let i = 0; i < 8; i++) {
    if (typeOf(b[i]!) === PAWN || typeOf(b[56 + i]!) === PAWN)
      throw new Error('Invalid FEN: pawn on the back rank');
  }
  if (!/^(-|[KQkq]+)$/.test(castling)) throw new Error('Invalid FEN: castling');
  // Drop rights that the pieces do not support rather than refuse the position.
  let castle = castleBits(castling);
  if (b[60] !== KING) castle &= ~(WK | WQ);
  if (b[4] !== 8 + KING) castle &= ~(BK | BQ);
  if (b[63] !== ROOK) castle &= ~WK;
  if (b[56] !== ROOK) castle &= ~WQ;
  if (b[7] !== 8 + ROOK) castle &= ~BK;
  if (b[0] !== 8 + ROOK) castle &= ~BQ;
  let ep = -1;
  if (epField !== '-') {
    if (!/^[a-h][36]$/.test(epField)) throw new Error('Invalid FEN: en passant square');
    ep = sqFrom(epField);
  }
  const turn: 0 | 1 = active === 'w' ? 0 : 1;
  if (ep >= 0) {
    // The skipped square must be behind an enemy pawn that has just moved two squares.
    const pawnSq = turn === 0 ? ep + 8 : ep - 8;
    if (b[ep] !== 0 || b[pawnSq] !== (1 - turn) * 8 + PAWN) ep = -1;
  }
  const halfmove = parts[4] === undefined ? 0 : Number(parts[4]);
  const fullmove = parts[5] === undefined ? 1 : Number(parts[5]);
  if (!Number.isInteger(halfmove) || halfmove < 0 || !Number.isInteger(fullmove) || fullmove < 1) {
    throw new Error('Invalid FEN: move counters');
  }
  const pos: Pos = { b, turn, castle, ep };
  // The side NOT to move must not be in check (it would be capturable).
  if (attacked(b, kingSquare(b, (1 - turn) as 0 | 1), turn))
    throw new Error('Invalid FEN: side not to move is in check');
  return { pos, halfmove, fullmove };
}

const boardString = (b: readonly number[]): string => b.map(charOfCode).join('');
const boardFromString = (s: string): number[] =>
  s.split('').map((ch) => (ch === '.' ? 0 : codeOfChar(ch)));

function toPos(s: ChessState): Pos {
  return {
    b: boardFromString(s.board),
    turn: s.turn,
    castle: s.castling === '-' ? 0 : castleBits(s.castling),
    ep: s.ep === null ? -1 : sqFrom(s.ep),
  };
}

/** FEN of a state. */
export function chessFen(s: ChessState): string {
  const rows: string[] = [];
  for (let r = 0; r < 8; r++) {
    let row = '';
    let empty = 0;
    for (let c = 0; c < 8; c++) {
      const ch = s.board[r * 8 + c]!;
      if (ch === '.') empty++;
      else {
        if (empty > 0) row += String(empty);
        empty = 0;
        row += ch;
      }
    }
    if (empty > 0) row += String(empty);
    rows.push(row);
  }
  return `${rows.join('/')} ${s.turn === 0 ? 'w' : 'b'} ${s.castling} ${s.ep ?? '-'} ${s.halfmove} ${s.fullmove}`;
}

/** Number of leaf positions `depth` plies from a FEN: the standard move generator test. */
export function chessPerft(fen: string, depth: number): number {
  const { pos } = parseFen(fen);
  const go = (p: Pos, d: number): number => {
    const moves = legalMoves(p);
    if (d === 1) return moves.length;
    let n = 0;
    for (const m of moves) n += go(makeMove(p, m), d - 1);
    return n;
  };
  return depth <= 0 ? 1 : go(pos, depth);
}

/* ------------------------------------------------------------------ rules helpers */

function insufficientMaterial(b: readonly number[]): boolean {
  const minors: { type: number; square: number }[] = [];
  for (let sq = 0; sq < 64; sq++) {
    const t = typeOf(b[sq]!);
    if (b[sq] === 0 || t === KING) continue;
    if (t !== KNIGHT && t !== BISHOP) return false; // pawn, rook or queen on the board
    minors.push({ type: t, square: sq });
  }
  if (minors.length <= 1) return true;
  // Only bishops, all on the same colour of square.
  if (minors.every((m) => m.type === BISHOP)) {
    const colour = (m: { square: number }): number => ((m.square >> 3) + (m.square & 7)) % 2;
    return minors.every((m) => colour(m) === colour(minors[0]!));
  }
  return false;
}

function positionKey(pos: Pos, legal: readonly Move[]): string {
  const epMatters = legal.some((m) => m.flag & F_EP);
  return `${boardString(pos.b)}${pos.turn}${castleString(pos.castle)}${epMatters ? chessSquareName(pos.ep) : '-'}`;
}

const promoLetter = (promo: number): ChessPromotion =>
  'qrbn'[[QUEEN, ROOK, BISHOP, KNIGHT].indexOf(promo)] as ChessPromotion;

function sanOf(m: Move, legal: readonly Move[], check: boolean, mate: boolean): string {
  let out: string;
  if (m.flag & F_KS) out = 'O-O';
  else if (m.flag & F_QS) out = 'O-O-O';
  else {
    const t = typeOf(m.piece);
    const to = chessSquareName(m.to);
    const capture = m.captured !== 0;
    if (t === PAWN) {
      out = (capture ? chessSquareName(m.from)[0] + 'x' : '') + to;
      if (m.promo) out += '=' + LETTERS[m.promo - 1]!;
    } else {
      let dis = '';
      const rivals = legal.filter((o) => o.piece === m.piece && o.to === m.to && o.from !== m.from);
      if (rivals.length > 0) {
        const sameFile = rivals.some((o) => (o.from & 7) === (m.from & 7));
        const sameRank = rivals.some((o) => o.from >> 3 === m.from >> 3);
        if (!sameFile) dis = chessSquareName(m.from)[0]!;
        else if (!sameRank) dis = chessSquareName(m.from)[1]!;
        else dis = chessSquareName(m.from);
      }
      out = LETTERS[t - 1]! + dis + (capture ? 'x' : '') + to;
    }
  }
  return out + (mate ? '#' : check ? '+' : '');
}

function findLegal(
  s: ChessState,
  from: string,
  to: string,
  promotion: ChessPromotion | undefined,
): Move | undefined {
  const pos = toPos(s);
  const f = sqFrom(from);
  const t = sqFrom(to);
  return legalMoves(pos).find(
    (m) =>
      m.from === f &&
      m.to === t &&
      (m.promo ? promoLetter(m.promo) === promotion : promotion === undefined),
  );
}

/** Every legal move for the side to move (one entry per promotion piece). */
export function chessLegalMoves(
  s: ChessState,
): { from: string; to: string; promotion?: ChessPromotion }[] {
  if (s.winner !== null || s.draw) return [];
  return legalMoves(toPos(s)).map((m) => ({
    from: chessSquareName(m.from),
    to: chessSquareName(m.to),
    ...(m.promo ? { promotion: promoLetter(m.promo) } : {}),
  }));
}

/* ------------------------------------------------------------------ the engine */

export const chessEngine: GameEngine<ChessState, ChessAction, ChessCfg> = {
  slug: 'chess',
  actionSchema: chessActionSchema,
  timers: { turnMs: 24 * 60 * 60 * 1000 },

  init(players, _seed, cfg) {
    if (players.length !== 2) throw new Error('Chess needs exactly 2 players');
    if (players[0] === players[1]) throw new Error('Duplicate players');
    const { pos, halfmove, fullmove } = parseFen(cfg.fen ?? CHESS_START_FEN);
    const legal = legalMoves(pos);
    const inCheck = attacked(pos.b, kingSquare(pos.b, pos.turn), (1 - pos.turn) as 0 | 1);
    const s: ChessState = {
      players: [...players],
      board: boardString(pos.b),
      turn: pos.turn,
      castling: castleString(pos.castle),
      ep: pos.ep >= 0 ? chessSquareName(pos.ep) : null,
      halfmove,
      fullmove,
      seen: { [positionKey(pos, legal)]: 1 },
      san: [],
      last: null,
      check: inCheck,
      winner: null,
      draw: false,
      endReason: null,
      seq: 0,
    };
    // A custom position may already be over.
    if (legal.length === 0) {
      if (inCheck) {
        s.winner = players[1 - pos.turn]!;
        s.endReason = 'checkmate';
      } else {
        s.draw = true;
        s.endReason = 'stalemate';
      }
    } else if (insufficientMaterial(pos.b)) {
      s.draw = true;
      s.endReason = 'insufficient_material';
    }
    return s;
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
    if (!/^[a-h][1-8]$/.test(a.from) || !/^[a-h][1-8]$/.test(a.to))
      return { ok: false, code: 'bad_square' };
    if (findLegal(s, a.from, a.to, a.promotion)) return { ok: true };
    const piece = s.board[sqFrom(a.from)]!;
    if (piece === '.' || (piece === piece.toUpperCase() ? 0 : 1) !== s.turn) {
      return { ok: false, code: 'not_your_piece' };
    }
    const legal = chessLegalMoves(s).filter((m) => m.from === a.from && m.to === a.to);
    if (legal.length > 0 && a.promotion === undefined)
      return { ok: false, code: 'promotion_required' };
    if (legal.length === 0 && a.promotion !== undefined) {
      // either an illegal move or a promotion piece on a move that does not promote
      return { ok: false, code: 'illegal_move' };
    }
    if (legal.length > 0) return { ok: false, code: 'bad_promotion' };
    return { ok: false, code: 'illegal_move' };
  },

  apply(s, by, a) {
    if (a.kind === 'resign') {
      const other = s.players.find((p) => p !== by)!;
      return { ...s, winner: other, endReason: 'resign', seq: s.seq + 1 };
    }
    const pos = toPos(s);
    const legal = legalMoves(pos);
    const f = sqFrom(a.from);
    const t = sqFrom(a.to);
    const m = legal.find(
      (x) =>
        x.from === f &&
        x.to === t &&
        (x.promo ? promoLetter(x.promo) === a.promotion : a.promotion === undefined),
    )!;
    const np = makeMove(pos, m);
    const nextLegal = legalMoves(np);
    const inCheck = attacked(np.b, kingSquare(np.b, np.turn), pos.turn);
    const mate = inCheck && nextLegal.length === 0;
    const san = sanOf(m, legal, inCheck, mate);

    const irreversible = typeOf(m.piece) === PAWN || m.captured !== 0;
    const halfmove = irreversible ? 0 : s.halfmove + 1;
    const key = positionKey(np, nextLegal);
    const seen = irreversible ? { [key]: 1 } : { ...s.seen, [key]: (s.seen[key] ?? 0) + 1 };

    const next: ChessState = {
      ...s,
      board: boardString(np.b),
      turn: np.turn,
      castling: castleString(np.castle),
      ep: np.ep >= 0 ? chessSquareName(np.ep) : null,
      halfmove,
      fullmove: s.fullmove + (pos.turn === 1 ? 1 : 0),
      seen,
      san: [...s.san, san],
      last: {
        by,
        from: a.from,
        to: a.to,
        piece: charOfCode(m.piece).toUpperCase(),
        captured: m.captured ? charOfCode(m.captured).toUpperCase() : null,
        promotion: m.promo ? promoLetter(m.promo) : null,
        castle: m.flag & F_KS ? 'K' : m.flag & F_QS ? 'Q' : null,
        enPassant: (m.flag & F_EP) !== 0,
        san,
      },
      check: inCheck,
      seq: s.seq + 1,
    };
    if (nextLegal.length === 0) {
      if (inCheck) {
        next.winner = by;
        next.endReason = 'checkmate';
      } else {
        next.draw = true;
        next.endReason = 'stalemate';
      }
    } else if (insufficientMaterial(np.b)) {
      next.draw = true;
      next.endReason = 'insufficient_material';
    } else if ((seen[key] ?? 0) >= 3) {
      next.draw = true;
      next.endReason = 'repetition';
    } else if (halfmove >= CHESS_FIFTY_MOVE_PLIES) {
      next.draw = true;
      next.endReason = 'fifty_move';
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
    // Perfect information. Only the repetition bookkeeping stays server-side.
    const { seen: _seen, ...visible } = s;
    return { ...visible, fen: chessFen(s), legal: chessLegalMoves(s) };
  },
};
