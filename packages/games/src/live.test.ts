import { LIVE_GAMES, liveGame, type PartyGame } from './live.ts';
import {
  applyCanvas,
  chatAudienceFor,
  cleanChatText,
  diffCanvas,
  splitDoodleView,
  type CanvasCursor,
  type CanvasStroke,
} from './party/live-adapters.ts';
import { ROOM_ACTOR } from './party/common.ts';
import { werewolfEngine } from './werewolf/engine.ts';
import { imposterEngine } from './imposter/engine.ts';
import { charadesEngine } from './charades/engine.ts';
import { doodleGuessEngine } from './doodleguess/engine.ts';

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `p${i + 1}`);

describe('live registry', () => {
  it('lists the two card games, the Ludo room and the four party games', () => {
    expect(Object.keys(LIVE_GAMES).sort()).toEqual(
      [
        'charades',
        'crazy-cards',
        'doodle-guess',
        'imposter',
        'ludo-room',
        'whot',
        'werewolf',
      ].sort(),
    );
    expect(liveGame('nope')).toBeNull();
  });

  it.each(Object.values(LIVE_GAMES))(
    '$slug initialises at every seat count it advertises',
    (game) => {
      for (let n = game.minPlayers; n <= game.maxPlayers; n++) {
        const s = game.engine.init(ids(n), 42n, game.buildCfg({}, n));
        expect(game.engine.isTerminal(s)).toBe(false);
        expect(game.engine.currentPlayers(s).length).toBeGreaterThan(0);
      }
    },
  );

  it('only 2-seat card games can be quick matched, and they pay winner takes all or any scheme', () => {
    expect(
      Object.values(LIVE_GAMES)
        .filter((g) => g.quickMatch)
        .map((g) => g.slug)
        .sort(),
    ).toEqual(['crazy-cards', 'whot']);
    for (const g of Object.values(LIVE_GAMES).filter((x) => x.quickMatch)) {
      expect(g.minPlayers).toBe(2);
    }
  });

  it('side games (Imposter, Werewolf) only allow winner takes all', () => {
    expect(LIVE_GAMES.imposter!.payoutSchemes).toEqual(['winner_all']);
    expect(LIVE_GAMES.werewolf!.payoutSchemes).toEqual(['winner_all']);
    expect(LIVE_GAMES.whot!.payoutSchemes).toContain('p50_30_20');
  });

  it('validates and builds per-game options', () => {
    const imp = LIVE_GAMES.imposter!;
    expect(imp.optionsValid({ clueRounds: 3, imposters: 2 })).toBe(true);
    expect(imp.optionsValid({ clueRounds: 4 })).toBe(false);
    expect(imp.optionsValid({ clueRounds: 1.5 })).toBe(false);
    expect(imp.optionsValid({ words: 'x' })).toBe(false);
    // asked for 2 imposters at a table of 4: that would be half the table, so it is dropped
    expect(imp.buildCfg({ imposters: 2, clueRounds: 1 }, 4)).toEqual({ clueRounds: 1 });
    expect(imp.buildCfg({ imposters: 2 }, 6)).toEqual({ imposters: 2 });
    const ch = LIVE_GAMES.charades!;
    expect(ch.optionsValid({ mode: 'headsup', rounds: 2 })).toBe(true);
    expect(ch.optionsValid({ mode: 'mime' })).toBe(false);
    expect(LIVE_GAMES.whot!.optionsValid({ a: 1 })).toBe(false);
    expect(LIVE_GAMES.werewolf!.optionsValid({})).toBe(true);
  });
});

describe('the Ludo room', () => {
  const room = LIVE_GAMES['ludo-room']!;

  it('is a turn room for 3 or 4 seats that pays by progress and cannot be quick matched', () => {
    expect(room.kind).toBe('turns');
    expect([room.minPlayers, room.maxPlayers]).toEqual([3, 4]);
    expect(room.quickMatch).toBe(false);
    expect(room.payoutSchemes).toEqual(['winner_all', 'p60_40', 'p50_30_20']);
    expect(room.optionsValid({})).toBe(true);
    expect(room.optionsValid({ tokens: 1 })).toBe(false);
  });

  it.each([3, 4])('plays a whole game at %i seats with only its own auto action', (n) => {
    if (room.kind !== 'turns') throw new Error('turns room');
    let s = room.engine.init(ids(n), 7n, room.buildCfg({}, n));
    let moves = 0;
    while (!room.engine.isTerminal(s) && moves < 6000) {
      const by = room.engine.currentPlayers(s)[0]!;
      const a = room.autoAction(s, by);
      expect(room.engine.validate(s, by, a)).toEqual({ ok: true });
      s = room.engine.apply(s, by, a);
      moves += 1;
    }
    expect(room.engine.isTerminal(s)).toBe(true);
    const { placements, draw } = room.engine.result(s);
    expect(draw).toBe(false);
    expect(placements.flat().sort()).toEqual(ids(n).sort());
  });
});

describe('party chat rules', () => {
  const wolf = (n = 6) => werewolfEngine.init(ids(n), 9n, {});
  const roleOf = (s: ReturnType<typeof wolf>, role: string) =>
    s.players.filter((p) => s.roles[p] === role);

  it('werewolf: only living wolves talk at night, the living talk by day, the dead talk to the dead', () => {
    const s = wolf();
    const [w] = roleOf(s, 'werewolf');
    const [v] = roleOf(s, 'villager');
    expect(chatAudienceFor('werewolf', s, w!)).toEqual([w]);
    expect(chatAudienceFor('werewolf', s, v!)).toBeNull();
    const day = { ...s, phase: 'day' as const };
    expect(chatAudienceFor('werewolf', day, v!)).toEqual(s.players);
    const dying = { ...day, dead: [v!] };
    expect(chatAudienceFor('werewolf', dying, v!)).toEqual([v]);
    // the living still reach the dead (who spectate), the dead never reach the living
    expect(chatAudienceFor('werewolf', dying, w!)).toContain(v);
    expect(chatAudienceFor('werewolf', { ...dying, phase: 'over' as const }, v!)).toEqual(
      s.players,
    );
    expect(chatAudienceFor('werewolf', s, 'stranger')).toBeNull();
  });

  it('imposter: chat opens only for the vote and the end', () => {
    const s = imposterEngine.init(ids(4), 1n, {});
    expect(chatAudienceFor('imposter', s, 'p1')).toBeNull();
    expect(chatAudienceFor('imposter', { ...s, phase: 'clue' }, 'p1')).toBeNull();
    expect(chatAudienceFor('imposter', { ...s, phase: 'vote' }, 'p1')).toEqual(s.players);
    expect(chatAudienceFor('imposter', { ...s, phase: 'guess' }, 'p1')).toBeNull();
    expect(chatAudienceFor('imposter', { ...s, phase: 'over' }, 'p1')).toEqual(s.players);
  });

  it('charades: everyone talks except the player acting; doodle guess has no chat', () => {
    const s = charadesEngine.init(ids(4), 3n, {});
    const actor = s.schedule[0]!;
    const acting = { ...s, phase: 'acting' as const };
    expect(chatAudienceFor('charades', acting, actor)).toBeNull();
    const other = s.players.find((p) => p !== actor)!;
    expect(chatAudienceFor('charades', acting, other)).toEqual(s.players);
    expect(chatAudienceFor('charades', s, actor)).toEqual(s.players);
    expect((LIVE_GAMES['doodle-guess'] as PartyGame).chatAudience({}, 'p1')).toBeNull();
  });

  it('cleans chat text', () => {
    expect(cleanChatText('  hello   there ')).toBe('hello there');
    expect(cleanChatText('   ')).toBeNull();
    expect(cleanChatText('x'.repeat(201))).toBeNull();
    expect(cleanChatText('what the fuck')).toBeNull();
  });
});

describe('party blockers and streams', () => {
  it('doodle guess only waits for the drawer; strokes are streamy, guesses are not', () => {
    const game = LIVE_GAMES['doodle-guess'] as PartyGame;
    const s = doodleGuessEngine.init(ids(4), 5n, {});
    expect(game.blockers(s)).toEqual([s.order[0]]);
    expect(game.streamy({ kind: 'stroke', points: [[1, 1]], color: 0, width: 1 })).toBe(true);
    expect(game.streamy({ kind: 'undo' })).toBe(true);
    expect(game.streamy({ kind: 'guess', text: 'x' })).toBe(false);
    expect(game.streamy(null)).toBe(false);
  });

  it('every party engine moves on by ticks alone and rejects a tick from a seat', () => {
    for (const g of Object.values(LIVE_GAMES).filter((x): x is PartyGame => x.kind === 'party')) {
      const n = g.minPlayers;
      let s = g.engine.init(ids(n), 11n, g.buildCfg({}, n));
      expect(g.engine.validate(s, 'p1', { kind: 'tick', ms: 1000 })).toEqual({
        ok: false,
        code: 'room_only',
      });
      let guard = 0;
      while (!g.engine.isTerminal(s) && guard++ < 5000) {
        s = g.engine.apply(s, ROOM_ACTOR, { kind: 'tick', ms: 10_000 });
      }
      expect(g.engine.isTerminal(s)).toBe(true);
    }
  });
});

describe('canvas deltas', () => {
  type S = { id: number; color: number; width: number; pts: [number, number][] };
  const stroke = (id: number, n: number): S => ({
    id,
    color: 1,
    width: 2,
    pts: Array.from({ length: n }, (_, i) => [id * 10 + i, i] as [number, number]),
  });

  it('splits the strokes out of a view and leaves their count', () => {
    const { rest, stream } = splitDoodleView({ turn: 4, phase: 'draw', strokes: [stroke(1, 2)] });
    expect(rest).toEqual({ turn: 4, phase: 'draw', strokeCount: 1 });
    expect(stream.strokes).toHaveLength(1);
    expect(stream.turn).toBe(4);
  });

  it('a seat that follows every change always ends up with exactly the server canvas', () => {
    // A long random drawing session: draw, extend the last stroke, undo, clear, start a new turn.
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    let server: S[] = [];
    let turn = 0;
    let nextId = 1;
    let cursor: CanvasCursor | null = null;
    let client: CanvasStroke[] = [];
    let resets = 0;
    let deltas = 0;
    for (let step = 0; step < 600; step++) {
      const op = rnd(10);
      if (op < 4) server = [...server, stroke(nextId++, 1 + rnd(3))];
      else if (op < 7 && server.length > 0) {
        const last = server[server.length - 1]!;
        server = [
          ...server.slice(0, -1),
          { ...last, pts: [...last.pts, [step, step] as [number, number]] },
        ];
      } else if (op === 7) server = server.slice(0, -1);
      else if (op === 8) server = [];
      else {
        turn += 1;
        server = [];
      }
      // the room only sends after some steps: a seat is often several changes behind
      if (rnd(3) === 0) {
        const d = diffCanvas(cursor, { turn, strokes: server });
        cursor = d.cursor;
        if (d.msg) {
          if (d.msg.reset) resets += 1;
          else deltas += 1;
          client = applyCanvas(client, d.msg);
        }
        expect(client).toEqual(server);
      }
    }
    expect(deltas).toBeGreaterThan(resets); // mostly additions, not whole canvases
  });

  it('says nothing when nothing changed, and everything to a seat with no cursor', () => {
    const now = { turn: 1, strokes: [stroke(1, 3)] };
    const first = diffCanvas(null, now);
    expect(first.msg).toMatchObject({ reset: true });
    expect(diffCanvas(first.cursor, now).msg).toBeNull();
    expect(diffCanvas(null, { turn: 1, strokes: [] }).msg).toMatchObject({
      reset: true,
      strokes: [],
    });
  });
});
