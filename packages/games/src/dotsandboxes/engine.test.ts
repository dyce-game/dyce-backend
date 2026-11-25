import { describeEngine } from '../testing/engineHarness.ts';
import {
  dotsAndBoxesActionSchema,
  dotsAndBoxesEngine as E,
  dotsLineExists,
  dotsOpenLines,
  type DotsAndBoxesAction,
  type DotsAndBoxesState,
} from './engine.ts';

const line = (dir: 'h' | 'v', r: number, c: number): DotsAndBoxesAction => ({
  kind: 'line',
  dir,
  r,
  c,
});

/** Play lines in order, each by whoever is to move, returning the final state. */
function playLines(s: DotsAndBoxesState, lines: DotsAndBoxesAction[]): DotsAndBoxesState {
  let cur = s;
  for (const a of lines) {
    const by = E.currentPlayers(cur)[0]!;
    const v = E.validate(cur, by, a);
    if (!v.ok) throw new Error(`illegal in setup: ${JSON.stringify(a)} ${v.code}`);
    cur = E.apply(cur, by, a);
  }
  return cur;
}

describeEngine(E, {
  playerCounts: [2],
  cfg: {},
  numRuns: 25,
  candidates: (s) => dotsOpenLines(s).map((l) => line(l.dir, l.r, l.c)),
  illegal: (s, by): DotsAndBoxesAction[] => {
    const out: DotsAndBoxesAction[] = [line('h', 99, 0), line('v', 0, 99), line('h', -1, 0)];
    const taken = dotsOpenLines(s);
    if (taken.length < 2 * s.dots * (s.dots - 1)) {
      // some line has been drawn: find one and try it again
      for (let r = 0; r < s.dots; r++) {
        for (let c = 0; c < s.dots - 1; c++)
          if (s.h[r * (s.dots - 1) + c]! >= 0) out.push(line('h', r, c));
      }
    }
    if (s.players[s.turn] !== by) out.push(...taken.slice(0, 3).map((l) => line(l.dir, l.r, l.c)));
    return out;
  },
});

describe('dots & boxes: setup', () => {
  it('defaults to 5x5 dots: 16 boxes and 40 lines', () => {
    const s = E.init(['a', 'b'], 1n, {});
    expect(s.dots).toBe(5);
    expect(s.boxes).toHaveLength(16);
    expect(dotsOpenLines(s)).toHaveLength(40);
    expect(E.currentPlayers(s)).toEqual(['a']);
  });

  it('supports other sizes and rejects bad config and player counts', () => {
    expect(E.init(['a', 'b'], 1n, { dots: 3 }).boxes).toHaveLength(4);
    expect(() => E.init(['a', 'b'], 1n, { dots: 2 })).toThrow();
    expect(() => E.init(['a', 'b'], 1n, { dots: 9 })).toThrow();
    expect(() => E.init(['a', 'b'], 1n, { dots: 4.5 })).toThrow();
    expect(() => E.init(['a'], 1n, {})).toThrow();
    expect(() => E.init(['a', 'a'], 1n, {})).toThrow();
  });
});

describe('dots & boxes: turns and lines', () => {
  const s0 = E.init(['a', 'b'], 1n, { dots: 3 });

  it('a line that closes no box passes the turn', () => {
    const s1 = E.apply(s0, 'a', line('h', 0, 0));
    expect(E.currentPlayers(s1)).toEqual(['b']);
    expect(s1.h[0]).toBe(0);
  });

  it('rejects out of turn, strangers, off-board and already drawn lines', () => {
    expect(E.validate(s0, 'b', line('h', 0, 0))).toEqual({ ok: false, code: 'not_your_turn' });
    expect(E.validate(s0, 'zed', line('h', 0, 0))).toEqual({ ok: false, code: 'not_a_player' });
    expect(E.validate(s0, 'a', line('h', 0, 2))).toEqual({ ok: false, code: 'no_such_line' });
    expect(E.validate(s0, 'a', line('v', 2, 0))).toEqual({ ok: false, code: 'no_such_line' });
    expect(E.validate(s0, 'a', line('h', 3, 0))).toEqual({ ok: false, code: 'no_such_line' });
    const s1 = E.apply(s0, 'a', line('h', 0, 0));
    expect(E.validate(s1, 'b', line('h', 0, 0))).toEqual({ ok: false, code: 'line_taken' });
  });

  it('closing a box claims it and gives an extra turn', () => {
    // Box (0,0): top h(0,0), left v(0,0), right v(0,1), bottom h(1,0). a, b, a, then b closes it.
    let s = playLines(s0, [line('h', 0, 0), line('v', 0, 0), line('v', 0, 1)]);
    expect(E.currentPlayers(s)).toEqual(['b']);
    s = E.apply(s, 'b', line('h', 1, 0));
    expect(s.boxes[0]).toBe(1);
    expect(s.scores).toEqual([0, 1]);
    expect(s.last?.boxes).toEqual([0]);
    expect(E.currentPlayers(s)).toEqual(['b']); // b moves again
  });

  it('one line can close two boxes at once', () => {
    // 3x3 dots = 2x2 boxes. Shared line v(0,1) between box (0,0) and (0,1).
    let s = playLines(s0, [
      line('h', 0, 0), // a
      line('h', 1, 0), // b
      line('v', 0, 0), // a
      line('h', 0, 1), // b
      line('h', 1, 1), // a
      line('v', 0, 2), // b
    ]);
    expect(s.scores).toEqual([0, 0]);
    s = E.apply(s, 'a', line('v', 0, 1));
    expect(s.boxes[0]).toBe(0);
    expect(s.boxes[1]).toBe(0);
    expect(s.scores).toEqual([2, 0]);
    expect(E.currentPlayers(s)).toEqual(['a']);
    expect(s.last?.boxes).toEqual([0, 1]);
  });

  it('does not mutate its input', () => {
    const before = JSON.stringify(s0);
    E.apply(s0, 'a', line('v', 1, 1));
    expect(JSON.stringify(s0)).toBe(before);
  });
});

describe('dots & boxes: end of the game', () => {
  const all = (dots: number) => {
    const s = E.init(['a', 'b'], 1n, { dots });
    return dotsOpenLines(s).map((l) => line(l.dir, l.r, l.c));
  };

  it('the player with more boxes wins when the last box closes', () => {
    // 3 dots: a tidy script where `a` finishes three of four boxes.
    let s = E.init(['a', 'b'], 1n, { dots: 3 });
    // Draw all lines except the four that finish box (1,1) / others in a fixed order, tracking who closes what.
    for (const a of all(3)) {
      if (E.isTerminal(s)) break;
      s = E.apply(s, E.currentPlayers(s)[0]!, a);
    }
    expect(E.isTerminal(s)).toBe(true);
    expect(s.scores[0]! + s.scores[1]!).toBe(4);
    const res = E.result(s);
    if (s.scores[0] === s.scores[1]) expect(res.draw).toBe(true);
    else {
      expect(res.draw).toBe(false);
      const top = s.scores[0]! > s.scores[1]! ? 'a' : 'b';
      expect(res.placements[0]).toEqual([top]);
    }
    expect(E.currentPlayers(s)).toEqual([]);
    expect(E.validate(s, 'a', line('h', 0, 0))).toEqual({ ok: false, code: 'game_over' });
  });

  it('chained extra turns can take the whole board', () => {
    let s = E.init(['a', 'b'], 1n, { dots: 3 });
    const script: [string, DotsAndBoxesAction][] = [
      ['a', line('h', 0, 0)],
      ['b', line('h', 0, 1)],
      ['a', line('v', 0, 0)],
      ['b', line('v', 0, 2)],
      ['a', line('h', 2, 0)],
      ['b', line('h', 2, 1)],
      ['a', line('v', 1, 0)],
      ['b', line('v', 1, 2)],
      ['a', line('v', 1, 1)], // closes nothing: the middle h lines are missing
      ['b', line('h', 1, 0)], // closes the bottom-left box
      ['b', line('h', 1, 1)], // closes the bottom-right box, again b
      ['b', line('v', 0, 1)], // closes both top boxes
    ];
    for (const [who, act] of script) {
      expect(E.currentPlayers(s)).toEqual([who]);
      s = E.apply(s, who, act);
    }
    expect(s.scores).toEqual([0, 4]);
    expect(s.winner).toBe('b');
  });

  it('an equal split is a draw', () => {
    const base = E.init(['a', 'b'], 1n, { dots: 3 });
    // Hand-built: every line but the bottom of the bottom-right box is drawn; a has two boxes, b one.
    const almost: DotsAndBoxesState = {
      ...base,
      h: base.h.map((_, i) => (i === 5 ? -1 : 0)),
      v: base.v.map(() => 0),
      boxes: [0, 0, 1, -1],
      scores: [2, 1],
      turn: 1,
    };
    const end = E.apply(almost, 'b', line('h', 2, 1));
    expect(end.scores).toEqual([2, 2]);
    expect(end.draw).toBe(true);
    expect(end.winner).toBeNull();
    expect(E.isTerminal(end)).toBe(true);
    expect(E.result(end)).toEqual({ placements: [['a', 'b']], draw: true });
  });

  it('resigning hands the win to the other player', () => {
    const s = E.apply(E.init(['a', 'b'], 1n, {}), 'a', { kind: 'resign' });
    expect(s.winner).toBe('b');
    expect(s.endReason).toBe('resign');
    expect(E.result(s)).toEqual({ placements: [['b'], ['a']], draw: false });
  });

  it('a full 5x5 game with alternating tidy lines always reaches 16 boxes claimed', () => {
    let s = E.init(['a', 'b'], 1n, {});
    for (const a of all(5)) {
      if (E.isTerminal(s)) break;
      s = E.apply(s, E.currentPlayers(s)[0]!, a);
    }
    expect(s.scores[0]! + s.scores[1]!).toBe(16);
    expect(s.boxes.every((b) => b >= 0)).toBe(true);
  });
});

describe('dots & boxes: wire format and view', () => {
  it('validates actions with zod', () => {
    expect(dotsAndBoxesActionSchema.safeParse(line('h', 0, 3)).success).toBe(true);
    expect(dotsAndBoxesActionSchema.safeParse({ kind: 'resign' }).success).toBe(true);
    expect(dotsAndBoxesActionSchema.safeParse({ kind: 'line', dir: 'x', r: 0, c: 0 }).success).toBe(
      false,
    );
    expect(
      dotsAndBoxesActionSchema.safeParse({ kind: 'line', dir: 'h', r: -1, c: 0 }).success,
    ).toBe(false);
    expect(
      dotsAndBoxesActionSchema.safeParse({ kind: 'line', dir: 'h', r: 0.5, c: 0 }).success,
    ).toBe(false);
    expect(dotsAndBoxesActionSchema.safeParse({ kind: 'nope' }).success).toBe(false);
  });

  it('dotsLineExists matches the board geometry', () => {
    expect(dotsLineExists(5, 'h', 4, 3)).toBe(true);
    expect(dotsLineExists(5, 'h', 4, 4)).toBe(false);
    expect(dotsLineExists(5, 'v', 3, 4)).toBe(true);
    expect(dotsLineExists(5, 'v', 4, 0)).toBe(false);
  });

  it('the view is the public state (no secrets exist) and identical for everyone', () => {
    const s = E.init(['a', 'b'], 1n, {});
    expect(E.view(s, 'a')).toEqual(E.view(s, 'spectator'));
    expect(JSON.stringify(E.view(s, 'b'))).toBe(JSON.stringify(s));
  });
});
