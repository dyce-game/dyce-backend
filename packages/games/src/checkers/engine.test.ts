import { describeEngine } from '../testing/engineHarness.ts';
import {
  CHECKERS_NO_PROGRESS_PLIES,
  checkersActionSchema,
  checkersEngine as E,
  checkersLegalMoves,
  type CheckersAction,
  type CheckersState,
} from './engine.ts';

/** Square index from (row, col). */
const sq = (r: number, c: number): number => r * 8 + c;

/** A hand-built position: eight rows of eight characters. */
function mk(rows: string[], turn: 0 | 1 = 0, over: Partial<CheckersState> = {}): CheckersState {
  if (rows.length !== 8 || rows.some((r) => r.length !== 8)) throw new Error('bad board');
  const board = rows.join('');
  return {
    players: ['a', 'b'],
    board,
    turn,
    noProgress: 0,
    seen: { [`${board}${turn}`]: 1 },
    winner: null,
    draw: false,
    endReason: null,
    last: null,
    seq: 0,
    ...over,
  };
}

const move = (...path: number[]): CheckersAction => ({ kind: 'move', path });
const count = (s: CheckersState, ch: string): number => s.board.split(ch).length - 1;

describeEngine(E, {
  playerCounts: [2],
  cfg: {},
  maxSteps: 4000,
  numRuns: 30,
  candidates: (s, by) => {
    if (s.players[s.turn] !== by) return [];
    return checkersLegalMoves(s.board, s.turn).map((m) => move(...m.path));
  },
  illegal: (s, by): CheckersAction[] => {
    if (E.isTerminal(s)) return [move(40, 33)];
    const out: CheckersAction[] = [move(0, 1), move(63, 63)];
    if (s.players[s.turn] !== by)
      out.push(...checkersLegalMoves(s.board, s.turn).map((m) => move(...m.path)));
    return out;
  },
});

describe('checkers: setup and turn order', () => {
  const s0 = E.init(['a', 'b'], 1n, {});

  it('starts with twelve men each on the dark squares and seven opening moves', () => {
    expect(count(s0, 'a')).toBe(12);
    expect(count(s0, 'b')).toBe(12);
    expect(checkersLegalMoves(s0.board, 0)).toHaveLength(7);
    expect(E.currentPlayers(s0)).toEqual(['a']);
  });

  it('needs exactly two different players', () => {
    expect(() => E.init(['a'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'b', 'c'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'a'], 1n, {})).toThrow();
  });

  it('rejects the wrong player, strangers, and moves of the opponent', () => {
    expect(E.validate(s0, 'b', move(sq(2, 1), sq(3, 0)))).toEqual({
      ok: false,
      code: 'not_your_turn',
    });
    expect(E.validate(s0, 'zed', move(40, 33))).toEqual({ ok: false, code: 'not_a_player' });
    // moving the opponent's man, an empty square, backwards and onto a light square
    expect(E.validate(s0, 'a', move(sq(2, 1), sq(3, 0))).ok).toBe(false);
    expect(E.validate(s0, 'a', move(sq(4, 1), sq(3, 2))).ok).toBe(false);
    expect(E.validate(s0, 'a', move(sq(5, 0), sq(6, 1))).ok).toBe(false);
    expect(E.validate(s0, 'a', move(sq(5, 0), sq(4, 0))).ok).toBe(false);
  });

  it('alternates turns and moves the piece without mutating the input', () => {
    const before = JSON.stringify(s0);
    const s1 = E.apply(s0, 'a', move(sq(5, 0), sq(4, 1)));
    expect(JSON.stringify(s0)).toBe(before);
    expect(s1.board[sq(4, 1)]).toBe('a');
    expect(s1.board[sq(5, 0)]).toBe('.');
    expect(E.currentPlayers(s1)).toEqual(['b']);
    expect(E.validate(s1, 'a', move(sq(5, 2), sq(4, 3)))).toEqual({
      ok: false,
      code: 'not_your_turn',
    });
  });
});

describe('checkers: capture rules', () => {
  const single = mk([
    '........',
    '........',
    '........',
    '..b.....',
    '...a....',
    '........',
    '........',
    'a.......',
  ]);

  it('a capture is forced: a simple move is refused while a jump exists', () => {
    expect(checkersLegalMoves(single.board, 0)).toEqual([
      { path: [sq(4, 3), sq(2, 1)], captured: [sq(3, 2)] },
    ]);
    expect(E.validate(single, 'a', move(sq(7, 0), sq(6, 1)))).toEqual({
      ok: false,
      code: 'must_capture',
    });
    expect(E.validate(single, 'a', move(sq(4, 3), sq(3, 4)))).toEqual({
      ok: false,
      code: 'must_capture',
    });
    expect(E.validate(single, 'a', move(sq(4, 3), sq(2, 1))).ok).toBe(true);
  });

  it('removes the captured man and passes the turn', () => {
    const s = E.apply(single, 'a', move(sq(4, 3), sq(2, 1)));
    expect(s.board[sq(3, 2)]).toBe('.');
    expect(s.board[sq(2, 1)]).toBe('a');
    expect(s.last).toEqual({
      by: 'a',
      path: [sq(4, 3), sq(2, 1)],
      captured: [sq(3, 2)],
      crowned: false,
    });
    // The last black man is gone, so black has no move and white wins.
    expect(E.isTerminal(s)).toBe(true);
    expect(s.winner).toBe('a');
    expect(s.endReason).toBe('no_moves');
  });

  it('a jump must continue, and multi-jumps are applied in one move', () => {
    const s0 = mk([
      '.......b',
      '........',
      '........',
      '..b.....',
      '........',
      '..b.....',
      '.a......',
      '........',
    ]);
    const moves = checkersLegalMoves(s0.board, 0);
    expect(moves).toEqual([
      { path: [sq(6, 1), sq(4, 3), sq(2, 1)], captured: [sq(5, 2), sq(3, 2)] },
    ]);
    expect(E.validate(s0, 'a', move(sq(6, 1), sq(4, 3)))).toEqual({
      ok: false,
      code: 'incomplete_jump',
    });
    const s1 = E.apply(s0, 'a', move(sq(6, 1), sq(4, 3), sq(2, 1)));
    expect(count(s1, 'b')).toBe(1);
    expect(s1.board[sq(2, 1)]).toBe('a');
    expect(E.currentPlayers(s1)).toEqual(['b']);
  });

  it('when several jumps exist any of them may be chosen (no longest-capture rule)', () => {
    const s = mk([
      '.......b',
      '........',
      '..b.b...',
      '........',
      '...a....',
      '........',
      '........',
      '........',
    ]);
    // Not capturable (empty squares between): no jump, plain moves.
    expect(checkersLegalMoves(s.board, 0).every((m) => m.captured.length === 0)).toBe(true);
    const t = mk([
      '.......b',
      '........',
      '........',
      '..b.b...',
      '...a....',
      '........',
      '........',
      '........',
    ]);
    const jumps = checkersLegalMoves(t.board, 0);
    expect(jumps.map((m) => m.path.at(-1)).sort()).toEqual([sq(2, 1), sq(2, 5)]);
    expect(E.validate(t, 'a', move(sq(4, 3), sq(2, 5))).ok).toBe(true);
  });

  it('a man cannot jump backwards, and a jump needs an empty landing square', () => {
    const backwards = mk([
      '.......b',
      '........',
      '........',
      '........',
      '...a....',
      '..b.....',
      '........',
      '........',
    ]);
    expect(checkersLegalMoves(backwards.board, 0).every((m) => m.captured.length === 0)).toBe(true);
    const open = mk([
      '.......b',
      '........',
      '........',
      '..b.....',
      '...a....',
      '........',
      '........',
      '........',
    ]);
    const shut = mk([
      '.......b',
      '........',
      '.b......',
      '..b.....',
      '...a....',
      '........',
      '........',
      '........',
    ]);
    expect(checkersLegalMoves(open.board, 0).some((m) => m.captured.length > 0)).toBe(true);
    expect(checkersLegalMoves(shut.board, 0).some((m) => m.captured.length > 0)).toBe(false);
  });
});

describe('checkers: kings', () => {
  it('a man reaching the far row is crowned and its move ends there', () => {
    const s0 = mk([
      '.......b',
      '..b.b...',
      '.a......',
      '........',
      '........',
      '........',
      '........',
      '........',
    ]);
    // a man on (2,1); black men on (1,2) and (1,4). Jump (1,2) -> (0,3), crowning.
    const moves = checkersLegalMoves(s0.board, 0);
    expect(moves).toEqual([{ path: [sq(2, 1), sq(0, 3)], captured: [sq(1, 2)] }]);
    const s1 = E.apply(s0, 'a', move(sq(2, 1), sq(0, 3)));
    expect(s1.board[sq(0, 3)]).toBe('A');
    expect(s1.last?.crowned).toBe(true);
    // The fresh king does not carry on and take (1,4) in the same move.
    expect(s1.board[sq(1, 4)]).toBe('b');
  });

  it('kings move and capture both ways', () => {
    const s = mk([
      '.......b',
      '........',
      '........',
      '..A.....',
      '........',
      '........',
      '........',
      '........',
    ]);
    const dest = checkersLegalMoves(s.board, 0)
      .map((m) => m.path[1]!)
      .sort((x, y) => x - y);
    expect(dest).toEqual([sq(2, 1), sq(2, 3), sq(4, 1), sq(4, 3)].sort((x, y) => x - y));
    const t = mk([
      '.......b',
      '........',
      '........',
      '..A.....',
      '...b....',
      '........',
      '........',
      '........',
    ]);
    expect(checkersLegalMoves(t.board, 0)).toEqual([
      { path: [sq(3, 2), sq(5, 4)], captured: [sq(4, 3)] },
    ]);
  });

  it('a man cannot move or capture backwards, and a black man moves down the board', () => {
    const s = mk(
      [
        '........',
        '........',
        '........',
        '...a....',
        '........',
        '........',
        '........',
        '........',
      ],
      0,
    );
    expect(checkersLegalMoves(s.board, 0).map((m) => m.path[1])).toEqual([sq(2, 2), sq(2, 4)]);
    const b = mk(
      [
        '........',
        '........',
        '..b.....',
        '........',
        '........',
        '........',
        '........',
        '........',
      ],
      1,
    );
    expect(checkersLegalMoves(b.board, 1).map((m) => m.path[1])).toEqual([sq(3, 1), sq(3, 3)]);
  });
});

describe('checkers: end of the game', () => {
  it('the side to move with no legal move loses (blocked, not just captured out)', () => {
    // Black man in the corner (0,7)... block it: white man on (1,6) with (2,5) behind it covered.
    const s0 = mk(
      [
        '.......b',
        '......a.',
        '.....a..',
        '........',
        '........',
        '........',
        '........',
        'a.......',
      ],
      1,
    );
    expect(checkersLegalMoves(s0.board, 1)).toEqual([]);
    // It is black's turn with no moves, so a white move that keeps it that way ends the game.
    const s1 = mk(
      [
        '.......b',
        '......a.',
        '.....a..',
        '........',
        '........',
        '........',
        '........',
        'a.......',
      ],
      0,
    );
    const next = E.apply(s1, 'a', move(sq(7, 0), sq(6, 1)));
    expect(E.isTerminal(next)).toBe(true);
    expect(next.winner).toBe('a');
    expect(E.result(next)).toEqual({ placements: [['a'], ['b']], draw: false });
    expect(E.currentPlayers(next)).toEqual([]);
    expect(E.validate(next, 'b', move(sq(0, 7), sq(1, 6)))).toEqual({
      ok: false,
      code: 'game_over',
    });
  });

  it('either player can resign at any time', () => {
    const s0 = E.init(['a', 'b'], 1n, {});
    const s1 = E.apply(s0, 'b', { kind: 'resign' }); // not b's turn, still allowed
    expect(s1.winner).toBe('a');
    expect(s1.endReason).toBe('resign');
    expect(E.result(s1).placements).toEqual([['a'], ['b']]);
    expect(E.validate(s1, 'a', { kind: 'resign' })).toEqual({ ok: false, code: 'game_over' });
  });

  it('a third occurrence of the same position is a draw', () => {
    let s = mk(
      [
        '.......B',
        '........',
        '........',
        '........',
        '........',
        '........',
        '........',
        'A.......',
      ],
      0,
    );
    const cycle: [number, number][] = [
      [sq(7, 0), sq(6, 1)],
      [sq(0, 7), sq(1, 6)],
      [sq(6, 1), sq(7, 0)],
      [sq(1, 6), sq(0, 7)],
    ];
    for (let lap = 0; lap < 2; lap++) {
      for (const [i, [from, to]] of cycle.entries()) {
        expect(E.isTerminal(s)).toBe(false);
        s = E.apply(s, i % 2 === 0 ? 'a' : 'b', move(from, to));
      }
    }
    expect(E.isTerminal(s)).toBe(true);
    expect(s.draw).toBe(true);
    expect(s.endReason).toBe('repetition');
    expect(E.result(s)).toEqual({ placements: [['a', 'b']], draw: true });
  });

  it('forty moves each without a capture or a man moving is a draw', () => {
    const s0 = mk(
      [
        '.......B',
        '........',
        '........',
        '........',
        '........',
        '........',
        '........',
        'A.......',
      ],
      0,
      { noProgress: CHECKERS_NO_PROGRESS_PLIES - 1 },
    );
    const s1 = E.apply(s0, 'a', move(sq(7, 0), sq(6, 1)));
    expect(s1.draw).toBe(true);
    expect(s1.endReason).toBe('forty_move');
    // A man move resets the counter.
    const s2 = mk(
      [
        '.......B',
        '........',
        '........',
        '........',
        '........',
        '........',
        '........',
        'A.....a.',
      ],
      0,
      { noProgress: CHECKERS_NO_PROGRESS_PLIES - 1 },
    );
    expect(E.apply(s2, 'a', move(sq(7, 6), sq(6, 5))).noProgress).toBe(0);
  });
});

describe('checkers: wire format and view', () => {
  it('validates wire actions with zod', () => {
    expect(checkersActionSchema.safeParse({ kind: 'move', path: [40, 33] }).success).toBe(true);
    expect(checkersActionSchema.safeParse({ kind: 'resign' }).success).toBe(true);
    expect(checkersActionSchema.safeParse({ kind: 'move', path: [40] }).success).toBe(false);
    expect(checkersActionSchema.safeParse({ kind: 'move', path: [40, 64] }).success).toBe(false);
    expect(checkersActionSchema.safeParse({ kind: 'move', path: [40, 1.5] }).success).toBe(false);
    expect(checkersActionSchema.safeParse({ kind: 'cheat' }).success).toBe(false);
  });

  it('view shows the board and the mover legal moves, never the repetition bookkeeping', () => {
    const s = E.init(['a', 'b'], 1n, {});
    for (const v of ['a', 'b', 'spectator'] as const) {
      const view = E.view(s, v) as Record<string, unknown>;
      expect(view).not.toHaveProperty('seen');
      expect(view.board).toBe(s.board);
      expect((view.legal as unknown[]).length).toBe(7);
    }
  });

  it('is deterministic: the same moves always give the same state', () => {
    const play = (): CheckersState => {
      let s = E.init(['a', 'b'], 9n, {});
      for (let i = 0; i < 60 && !E.isTerminal(s); i++) {
        const by = E.currentPlayers(s)[0]!;
        const legal = checkersLegalMoves(s.board, s.turn);
        s = E.apply(s, by, move(...legal[i % legal.length]!.path));
      }
      return s;
    };
    expect(play()).toEqual(play());
  });
});
