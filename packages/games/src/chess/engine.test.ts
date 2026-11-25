import { describeEngine } from '../testing/engineHarness.ts';
import {
  CHESS_START_FEN,
  chessActionSchema,
  chessEngine as E,
  chessFen,
  chessLegalMoves,
  chessPerft,
  type ChessAction,
  type ChessPromotion,
  type ChessState,
} from './engine.ts';

const uci = (m: string): ChessAction => ({
  kind: 'move',
  from: m.slice(0, 2),
  to: m.slice(2, 4),
  ...(m.length === 5 ? { promotion: m[4] as ChessPromotion } : {}),
});

const start = (fen?: string): ChessState => E.init(['w', 'b'], 1n, fen ? { fen } : {});

/** Play UCI moves in order, each by whoever is to move, failing loudly on an illegal one. */
function play(s: ChessState, ...moves: string[]): ChessState {
  let cur = s;
  for (const m of moves) {
    const by = cur.players[cur.turn]!;
    const v = E.validate(cur, by, uci(m));
    if (!v.ok) throw new Error(`illegal in setup: ${m} (${v.code}) in ${chessFen(cur)}`);
    cur = E.apply(cur, by, uci(m));
  }
  return cur;
}

const movesFrom = (s: ChessState, from: string): string[] =>
  chessLegalMoves(s)
    .filter((m) => m.from === from)
    .map((m) => m.to + (m.promotion ?? ''));

describeEngine(E, {
  playerCounts: [2],
  cfg: {},
  maxSteps: 3000,
  numRuns: 8,
  candidates: (s, by) => {
    if (s.players[s.turn] !== by) return [];
    return chessLegalMoves(s).map((m) => uci(m.from + m.to + (m.promotion ?? '')));
  },
  illegal: (s, by): ChessAction[] => {
    if (E.isTerminal(s)) return [uci('e2e4')];
    const out: ChessAction[] = [uci('a1a1'), uci('e4e4'), { kind: 'move', from: 'z9', to: 'a1' }];
    if (s.players[s.turn] !== by)
      out.push(
        ...chessLegalMoves(s)
          .slice(0, 3)
          .map((m) => uci(m.from + m.to)),
      );
    return out;
  },
});

describe('chess: the move generator (perft)', () => {
  // Reference node counts from the chess programming wiki's perft suite.
  const cases: { name: string; fen: string; counts: number[] }[] = [
    { name: 'start position', fen: CHESS_START_FEN, counts: [20, 400, 8902, 197_281] },
    {
      name: 'kiwipete (castling, pins, en passant)',
      fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
      counts: [48, 2039, 97_862],
    },
    {
      name: 'position 3 (en passant discovered checks)',
      fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
      counts: [14, 191, 2812, 43_238],
    },
    {
      name: 'position 4 (promotions, castling rights)',
      fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
      counts: [6, 264, 9467],
    },
    {
      name: 'position 5',
      fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
      counts: [44, 1486, 62_379],
    },
    {
      name: 'position 6',
      fen: 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
      counts: [46, 2079],
    },
  ];
  for (const c of cases) {
    it(`${c.name}: ${c.counts.join(', ')}`, () => {
      c.counts.forEach((n, i) => expect(chessPerft(c.fen, i + 1)).toBe(n));
    });
  }
});

describe('chess: setup', () => {
  it('starts from the standard position with White (players[0]) to move', () => {
    const s = start();
    expect(chessFen(s)).toBe(CHESS_START_FEN);
    expect(E.currentPlayers(s)).toEqual(['w']);
    expect(chessLegalMoves(s)).toHaveLength(20);
    expect(s.check).toBe(false);
  });

  it('needs two different players and a sane FEN', () => {
    expect(() => E.init(['w'], 1n, {})).toThrow();
    expect(() => E.init(['w', 'w'], 1n, {})).toThrow();
    expect(() => start('nonsense')).toThrow();
    expect(() => start('8/8/8/8/8/8/8/8 w - - 0 1')).toThrow(); // no kings
    expect(() => start('4k3/8/8/8/8/8/8/4K2P w - - 0 1')).toThrow(); // pawn on the back rank
    expect(() => start('4k3/8/8/8/8/8/8/4K3 x - - 0 1')).toThrow();
    expect(() => start('4k3/8/8/8/8/8/8/R3K3 w - - 0 1').turn).not.toThrow();
    // the side that just moved cannot be left in check
    expect(() => start('4k3/8/8/8/8/8/8/4RK2 w - - 0 1')).toThrow();
  });

  it('round-trips a FEN, and drops castling rights the pieces do not support', () => {
    const fen = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
    expect(chessFen(start(fen))).toBe(fen);
    expect(start('r3k2r/8/8/8/8/8/8/4K3 w KQkq - 0 1').castling).toBe('kq');
  });
});

describe('chess: validation', () => {
  const s0 = start();

  it('only the side to move may play, and only their own pieces', () => {
    expect(E.validate(s0, 'b', uci('e7e5'))).toEqual({ ok: false, code: 'not_your_turn' });
    expect(E.validate(s0, 'zed', uci('e2e4'))).toEqual({ ok: false, code: 'not_a_player' });
    expect(E.validate(s0, 'w', uci('e7e5'))).toEqual({ ok: false, code: 'not_your_piece' });
    expect(E.validate(s0, 'w', uci('e4e5'))).toEqual({ ok: false, code: 'not_your_piece' }); // empty square
    expect(E.validate(s0, 'w', { kind: 'move', from: 'e9', to: 'e4' })).toEqual({
      ok: false,
      code: 'bad_square',
    });
  });

  it('rejects illegal moves: blocked pieces, own pieces, wrong geometry', () => {
    expect(E.validate(s0, 'w', uci('a1a3')).ok).toBe(false); // rook blocked by its pawn
    expect(E.validate(s0, 'w', uci('d1d2'))).toEqual({ ok: false, code: 'illegal_move' }); // own pawn
    expect(E.validate(s0, 'w', uci('b1b3'))).toEqual({ ok: false, code: 'illegal_move' });
    expect(E.validate(s0, 'w', uci('e2e5'))).toEqual({ ok: false, code: 'illegal_move' });
    expect(E.validate(s0, 'w', uci('f1b5'))).toEqual({ ok: false, code: 'illegal_move' });
    expect(E.validate(s0, 'w', uci('e2e4')).ok).toBe(true);
  });

  it('a pinned piece cannot leave the pin line; a king cannot step into check', () => {
    const pinned = start('4r1k1/8/8/8/8/8/4B3/4K3 w - - 0 1');
    expect(movesFrom(pinned, 'e2')).toEqual([]);
    const kingMoves = movesFrom(pinned, 'e1').sort();
    expect(kingMoves).toEqual(['d1', 'd2', 'f1', 'f2']);
    const rookPinned = start('4r1k1/8/8/8/8/8/4R3/4K3 w - - 0 1');
    expect(movesFrom(rookPinned, 'e2').sort()).toEqual(['e3', 'e4', 'e5', 'e6', 'e7', 'e8']);
  });

  it('when in check only moves that resolve it are legal', () => {
    const s = play(start(), 'f2f3', 'e7e5', 'g2g4', 'd8h4'); // checkmate
    expect(s.check).toBe(true);
    expect(E.isTerminal(s)).toBe(true);
    expect(start('4k3/8/8/8/8/8/3r4/4K3 w - - 0 1').check).toBe(false);
    const checked = start('4k3/8/8/8/8/8/4r3/R3K3 w - - 0 1');
    expect(checked.check).toBe(true);
    // Kxe2 is possible (rook unprotected); Kd1/f1 stay in the rook's reach? d1, f1 are fine; d2, f2 are not
    const dests = movesFrom(checked, 'e1').sort();
    expect(dests).toEqual(['d1', 'e2', 'f1']);
    expect(movesFrom(checked, 'a1')).toEqual([]); // the rook cannot block or capture
  });
});

describe('chess: special moves', () => {
  it('castling both ways moves the rook and clears the rights', () => {
    const s = start('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    expect(movesFrom(s, 'e1')).toEqual(expect.arrayContaining(['g1', 'c1']));
    const ks = play(s, 'e1g1');
    expect(ks.board.slice(56)).toBe('R....RK.');
    expect(ks.castling).toBe('kq');
    expect(ks.last).toMatchObject({ castle: 'K', san: 'O-O' });
    const qs = play(s, 'e1c1', 'e8g8');
    expect(qs.board.slice(56)).toBe('..KR...R');
    expect(qs.board.slice(0, 8)).toBe('r....rk.');
    expect(qs.castling).toBe('-');
    expect(qs.san).toEqual(['O-O-O', 'O-O']);
  });

  it('cannot castle out of, through or into check, with pieces between, or after the rights are gone', () => {
    const through = start('4kr2/8/8/8/8/8/8/R3K2R w KQ - 0 1'); // black rook f8 covers f1
    expect(movesFrom(through, 'e1')).not.toContain('g1');
    expect(movesFrom(through, 'e1')).toContain('c1');
    const into = start('4k1r1/8/8/8/8/8/8/R3K2R w KQ - 0 1'); // g8 covers g1
    expect(movesFrom(into, 'e1')).not.toContain('g1');
    const outOf = start('4k3/8/8/8/8/8/4r3/R3K2R w KQ - 0 1');
    expect(movesFrom(outOf, 'e1')).not.toContain('g1');
    expect(movesFrom(outOf, 'e1')).not.toContain('c1');
    const blocked = start('4k3/8/8/8/8/8/8/RN2K2R w KQ - 0 1');
    expect(movesFrom(blocked, 'e1')).not.toContain('c1');
    expect(movesFrom(blocked, 'e1')).toContain('g1');
    // a rook may be attacked on b1 (queen side) and castling is still fine; only the king's path counts
    const rookAttacked = start('1r2k3/8/8/8/8/8/8/R3K3 w Q - 0 1');
    expect(movesFrom(rookAttacked, 'e1')).toContain('c1');
    // moving the king or a rook gives up the right for good
    const s = start('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    const moved = play(s, 'h1h2', 'a8a7', 'h2h1', 'a7a8');
    expect(moved.castling).toBe('Qk');
    expect(movesFrom(moved, 'e1')).not.toContain('g1');
    const kingMoved = play(s, 'e1e2', 'e8e7', 'e2e1', 'e7e8');
    expect(kingMoved.castling).toBe('-');
    expect(movesFrom(kingMoved, 'e1').sort()).toEqual(['d1', 'd2', 'e2', 'f1', 'f2']);
  });

  it('capturing a rook on its home square removes that castling right', () => {
    const s = start('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    const t = play(s, 'a1a8');
    expect(t.castling).toBe('Kk');
  });

  it('en passant is legal only on the very next move and removes the passed pawn', () => {
    const s = play(start(), 'e2e4', 'a7a6', 'e4e5', 'd7d5');
    expect(s.ep).toBe('d6');
    expect(movesFrom(s, 'e5')).toEqual(expect.arrayContaining(['d6', 'e6']));
    const t = play(s, 'e5d6');
    expect(t.board[27]).toBe('.'); // d5 is empty again
    expect(t.board[19]).toBe('P'); // d6
    expect(t.last).toMatchObject({ enPassant: true, captured: 'P', san: 'exd6' });
    // decline once and the chance is gone for good
    const later = play(s, 'g1f3', 'h7h6', 'f3g1', 'h6h5');
    expect(later.ep).toBeNull();
    expect(movesFrom(later, 'e5')).not.toContain('d6');
  });

  it('an en passant capture that would expose the own king is illegal', () => {
    // White king a5, white pawn e5, black pawn d5 (just pushed), black rook h5: capturing exposes the king.
    const s = start('4k3/8/8/K2pP2r/8/8/8/8 w - d6 0 1');
    expect(movesFrom(s, 'e5')).toEqual(['e6']);
  });

  it('promotion needs a piece, offers four, and under-promotion works', () => {
    const s = start('8/P6k/8/8/8/8/8/K7 w - - 0 1');
    expect(movesFrom(s, 'a7').sort()).toEqual(['a8b', 'a8n', 'a8q', 'a8r']);
    expect(E.validate(s, 'w', uci('a7a8'))).toEqual({ ok: false, code: 'promotion_required' });
    expect(
      E.validate(s, 'w', { kind: 'move', from: 'a7', to: 'a8', promotion: 'k' as 'q' }).ok,
    ).toBe(false);
    expect(E.validate(s, 'w', { kind: 'move', from: 'a1', to: 'a2', promotion: 'q' }).ok).toBe(
      false,
    );
    const q = play(s, 'a7a8q');
    expect(q.board[0]).toBe('Q');
    expect(q.last).toMatchObject({ promotion: 'q', san: 'a8=Q' });
    const n = play(s, 'a7a8n');
    expect(n.board[0]).toBe('N');
    // promotion by capture, and a non-promoting pawn move with a promotion piece is refused
    const cap = start('1r5k/P7/8/8/8/8/8/K7 w - - 0 1');
    expect(play(cap, 'a7b8q').last?.san).toBe('axb8=Q+'); // the new queen checks the king along the rank
    const plain = start();
    expect(E.validate(plain, 'w', { kind: 'move', from: 'e2', to: 'e4', promotion: 'q' })).toEqual({
      ok: false,
      code: 'bad_promotion',
    });
  });

  it('black promotes on the first rank', () => {
    const s = start('4k3/8/8/8/8/8/p7/K7 b - - 0 1');
    expect(E.validate(s, 'b', uci('a2a1q')).ok).toBe(false); // occupied by the king: no push onto a piece
    const t = start('4k3/8/8/8/8/8/p7/7K b - - 0 1');
    const u = play(t, 'a2a1q');
    expect(u.board[56]).toBe('q');
    expect(u.check).toBe(true); // the new queen attacks the king on h1 along the first rank
    expect(u.san).toEqual(['a1=Q+']);
  });
});

describe('chess: notation', () => {
  it('writes standard algebraic notation with captures, check and mate', () => {
    const s = play(start(), 'e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4', 'g8f6', 'h5f7');
    expect(s.san).toEqual(['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#']);
    expect(E.result(s)).toEqual({ placements: [['w'], ['b']], draw: false });
    const t = play(start(), 'e2e4', 'd7d5', 'e4d5', 'd8d5', 'b1c3');
    expect(t.san).toEqual(['e4', 'd5', 'exd5', 'Qxd5', 'Nc3']);
    const c = play(start(), 'e2e4', 'd7d5', 'f1b5');
    expect(c.san.at(-1)).toBe('Bb5+');
  });

  it('disambiguates by file, by rank, or by both', () => {
    const byFile = start('4k3/8/8/8/8/8/K7/R6R w - - 0 1');
    expect(play(byFile, 'a1d1').san).toEqual(['Rad1']);
    expect(play(byFile, 'h1d1').san).toEqual(['Rhd1']);
    // a king between the rooks means only one can reach d1: no disambiguation needed
    expect(play(start('4k3/8/8/8/8/8/8/R3K2R w - - 0 1'), 'a1d1').san).toEqual(['Rd1']);
    const byRank = start('4k3/8/8/R7/8/8/8/R3K3 w - - 0 1');
    expect(play(byRank, 'a1a3').san).toEqual(['R1a3']);
    expect(play(byRank, 'a5a3').san).toEqual(['R5a3']);
    // queens on a1, a3 and c3 can all reach b2: a1 shares only a file, a3 shares a file and a rank
    const both = start('4k3/8/8/8/8/Q1Q5/8/Q3K3 w - - 0 1');
    expect(play(both, 'a1b2').san).toEqual(['Q1b2']);
    expect(play(both, 'a3b2').san).toEqual(['Qa3b2']);
    expect(play(both, 'c3b2').san).toEqual(['Qcb2']);
  });
});

describe('chess: the end of the game', () => {
  it("fool's mate: checkmate, the mover wins", () => {
    const s = play(start(), 'f2f3', 'e7e5', 'g2g4', 'd8h4');
    expect(s.winner).toBe('b');
    expect(s.endReason).toBe('checkmate');
    expect(s.san.at(-1)).toBe('Qh4#');
    expect(E.currentPlayers(s)).toEqual([]);
    expect(E.validate(s, 'w', uci('a2a3'))).toEqual({ ok: false, code: 'game_over' });
    expect(chessLegalMoves(s)).toEqual([]);
  });

  it('stalemate is a draw', () => {
    const s = play(start('7k/8/6K1/8/8/8/8/5Q2 w - - 0 1'), 'f1f7');
    expect(s.draw).toBe(true);
    expect(s.endReason).toBe('stalemate');
    expect(E.result(s)).toEqual({ placements: [['w', 'b']], draw: true });
    // and a position that starts as stalemate is already over
    expect(start('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1').draw).toBe(true);
  });

  it('insufficient material draws: bare kings, a lone minor, same-coloured bishops', () => {
    expect(start('4k3/8/8/8/8/8/8/4K3 w - - 0 1').endReason).toBe('insufficient_material');
    expect(start('4k3/8/8/8/8/8/8/4KB2 w - - 0 1').draw).toBe(true);
    expect(start('4k3/8/8/8/8/8/8/4KN2 w - - 0 1').draw).toBe(true);
    expect(start('b3k3/8/8/8/8/8/8/4KB2 w - - 0 1').draw).toBe(true); // a8 and f1 are the same colour
    // opposite-coloured bishops, bishop vs knight, two knights and any pawn/rook/queen can still mate
    expect(start('1b2k3/8/8/8/8/8/8/4KB2 w - - 0 1').draw).toBe(false);
    expect(start('n3k3/8/8/8/8/8/8/4KB2 w - - 0 1').draw).toBe(false);
    expect(start('4k3/8/8/8/8/8/8/3NKN2 w - - 0 1').draw).toBe(false);
    expect(start('4k3/8/8/8/8/8/P7/4K3 w - - 0 1').draw).toBe(false);
    expect(start('4k3/8/8/8/8/8/8/R3K3 w - - 0 1').draw).toBe(false);
  });

  it('a capture that leaves bare kings ends the game in a draw', () => {
    const s = play(start('4k3/8/8/8/8/8/4r3/4K3 w - - 0 1'), 'e1e2'); // the king takes the last piece
    expect(s.draw).toBe(true);
    expect(s.endReason).toBe('insufficient_material');
  });

  it('the third occurrence of a position is a draw', () => {
    let s = start();
    const lap = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
    s = play(s, ...lap);
    expect(E.isTerminal(s)).toBe(false);
    s = play(s, ...lap.slice(0, 3));
    expect(E.isTerminal(s)).toBe(false);
    s = play(s, lap[3]!);
    expect(s.draw).toBe(true);
    expect(s.endReason).toBe('repetition');
    expect(E.result(s)).toEqual({ placements: [['w', 'b']], draw: true });
  });

  it('repetition counts the same castling rights and en passant chance only', () => {
    // Moving a rook out and back loses a castling right, so the position is not a repeat.
    let s = start('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    for (let i = 0; i < 2; i++) s = play(s, 'a1a2', 'a8a7', 'a2a1', 'a7a8');
    expect(s.draw).toBe(false);
    expect(s.castling).toBe('Kk');
  });

  it('50 moves without a pawn move or capture is a draw; a pawn move or capture resets the count', () => {
    const s = start('4k3/8/8/8/8/8/R7/4K3 w - - 99 80');
    const t = play(s, 'a2a3');
    expect(t.draw).toBe(true);
    expect(t.endReason).toBe('fifty_move');
    const u = start('4k3/8/8/8/8/8/P7/4K3 w - - 99 80');
    expect(play(u, 'a2a3').halfmove).toBe(0);
    expect(play(start('4k3/8/8/8/8/8/R7/4K3 w - - 20 80'), 'a2a3').halfmove).toBe(21);
  });

  it('checkmate takes precedence over the 50 move rule', () => {
    const s = start('6k1/5ppp/8/8/8/8/8/R3K3 w - - 99 60');
    const t = play(s, 'a1a8');
    expect(t.winner).toBe('w');
    expect(t.endReason).toBe('checkmate');
    expect(t.draw).toBe(false);
  });

  it('resigning ends the game at any time, by either player', () => {
    const s = E.apply(start(), 'b', { kind: 'resign' });
    expect(s.winner).toBe('w');
    expect(s.endReason).toBe('resign');
    expect(E.result(s)).toEqual({ placements: [['w'], ['b']], draw: false });
  });
});

describe('chess: wire format, view and purity', () => {
  it('validates actions with zod', () => {
    expect(chessActionSchema.safeParse(uci('e2e4')).success).toBe(true);
    expect(chessActionSchema.safeParse(uci('a7a8q')).success).toBe(true);
    expect(chessActionSchema.safeParse({ kind: 'resign' }).success).toBe(true);
    expect(chessActionSchema.safeParse({ kind: 'move', from: 'e2', to: 'e9' }).success).toBe(false);
    expect(chessActionSchema.safeParse({ kind: 'move', from: 'E2', to: 'e4' }).success).toBe(false);
    expect(
      chessActionSchema.safeParse({ kind: 'move', from: 'e2', to: 'e4', promotion: 'k' }).success,
    ).toBe(false);
    expect(chessActionSchema.safeParse({ kind: 'castle' }).success).toBe(false);
  });

  it('the view is public information plus the FEN and the legal moves, without bookkeeping', () => {
    const s = start();
    for (const v of ['w', 'b', 'spectator'] as const) {
      const view = E.view(s, v) as Record<string, unknown>;
      expect(view).not.toHaveProperty('seen');
      expect(view.fen).toBe(CHESS_START_FEN);
      expect((view.legal as unknown[]).length).toBe(20);
      expect(view.board).toBe(s.board);
    }
  });

  it('apply does not mutate its input and is deterministic', () => {
    const s = start();
    const before = JSON.stringify(s);
    const a = E.apply(s, 'w', uci('e2e4'));
    const b = E.apply(s, 'w', uci('e2e4'));
    expect(JSON.stringify(s)).toBe(before);
    expect(a).toEqual(b);
  });

  it('a famous game plays through (Opera Game, Morphy 1858) to checkmate', () => {
    const moves =
      'e2e4 e7e5 g1f3 d7d6 d2d4 c8g4 d4e5 g4f3 d1f3 d6e5 f1c4 g8f6 f3b3 d8e7 b1c3 c7c6 c1g5 b7b5 c3b5 c6b5 c4b5 b8d7 e1c1 a8d8 d1d7 d8d7 h1d1 e7e6 b5d7 f6d7 b3b8 d7b8 d1d8'.split(
        ' ',
      );
    const s = play(start(), ...moves);
    expect(s.endReason).toBe('checkmate');
    expect(s.winner).toBe('w');
    expect(s.san.at(-1)).toBe('Rd8#');
    expect(s.san).toContain('O-O-O');
    expect(s.san).toContain('Qb8+');
  });
});
