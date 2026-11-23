import {
  LIVE_GAMES,
  applyCanvas,
  type CanvasMessage,
  type CanvasStroke,
  type DoodleState,
  type ImposterState,
  type PartyGame,
  type WerewolfState,
} from '@dyce/games';
import type { LiveChat, LiveState } from '@dyce/shared';
import { DEFAULT_OPTIONS, type LiveMatchOptions } from './live-match.ts';
import { PartyMatch } from './party-match.ts';
import type { LoadedMatch } from './store.ts';
import { FakeScheduler, MemoryStore, flush } from './testing.ts';

const OPTS: LiveMatchOptions = {
  ...DEFAULT_OPTIONS,
  reconnectMs: 60_000,
  joinGraceMs: 90_000,
  settleRetries: 2,
  settleRetryMs: 1000,
};

const IDS = Array.from({ length: 12 }, (_, i) => `u${i + 1}`);

type Sent = { userId: string; state: LiveState };

function setup(
  slug: string,
  n: number,
  opts: {
    seed?: bigint;
    options?: Record<string, string | number | boolean>;
    connect?: number;
  } = {},
) {
  const game = LIVE_GAMES[slug] as PartyGame;
  const players = IDS.slice(0, n);
  const state = game.engine.init(players, opts.seed ?? 7n, game.buildCfg(opts.options ?? {}, n));
  const store = new MemoryStore();
  const sched = new FakeScheduler();
  const sent: Sent[] = [];
  const chats: { userId: string; chat: LiveChat }[] = [];
  const canvases: { userId: string; msg: CanvasMessage }[] = [];
  const errors: unknown[] = [];
  let finished = 0;
  const loaded: LoadedMatch = {
    matchId: 'm1',
    spaceId: 's1',
    gameSlug: slug,
    mode: 'pool',
    state,
    version: 0,
    players: players.map((userId, i) => ({ userId, seat: i + 1 })),
    forfeited: [],
  };
  const match = new PartyMatch(
    loaded,
    game,
    store,
    sched,
    {
      state: (userId, s) => sent.push({ userId, state: s }),
      chat: (userId, chat) => chats.push({ userId, chat }),
      stream: (userId, msg) => canvases.push({ userId, msg: msg as CanvasMessage }),
      finished: () => (finished += 1),
    },
    OPTS,
    (e) => errors.push(e),
  );
  match.start();
  for (const p of players.slice(0, opts.connect ?? n)) match.setConnected(p, true);
  return {
    game,
    match,
    store,
    sched,
    sent,
    chats,
    canvases,
    errors,
    players,
    finishedCount: () => finished,
    lastFor: (userId: string) => [...sent].reverse().find((s) => s.userId === userId)?.state,
  };
}

/** Plays out an Imposter game where every clue is `x` and everyone votes for a fixed set. */
async function playImposter(t: ReturnType<typeof setup>, voteFor: (voter: string) => string[]) {
  const { match, players } = t;
  const s = () => match.state as ImposterState;
  for (const p of players) await match.submit(p, undefined, { kind: 'ready' });
  while (s().phase === 'clue') {
    const speaker = s().order[s().slot % s().order.length]!;
    const r = await match.submit(speaker, undefined, { kind: 'clue', text: 'x' });
    expect(r.ok).toBe(true);
  }
  for (const p of players) await match.submit(p, undefined, { kind: 'vote', targets: voteFor(p) });
}

describe('starting', () => {
  it('keeps the clocks stopped until every seat has connected', async () => {
    const t = setup('imposter', 4, { connect: 3 });
    expect(t.lastFor('u1')!.waiting).toBe(true);
    expect(t.lastFor('u1')!.canAct).toBe(false);
    expect(t.lastFor('u1')!.turnDeadlineAt).toBeNull();
    const before = (t.match.state as ImposterState).timeLeftMs;
    await t.sched.advance(30_000);
    expect((t.match.state as ImposterState).timeLeftMs).toBe(before);
    const refused = await t.match.submit('u1', undefined, { kind: 'ready' });
    expect(refused).toMatchObject({ ok: false, code: 'waiting' });

    t.match.setConnected('u4', true);
    expect(t.lastFor('u1')).toMatchObject({ waiting: false, canAct: true, roomKind: 'party' });
    expect(t.lastFor('u1')!.turnDeadlineAt).toBeGreaterThan(t.sched.now());
    expect(t.match.running).toBe(true);
  });

  it('a seat that never shows up forfeits after the join grace and the game starts without it', async () => {
    const t = setup('imposter', 5, { connect: 4 });
    expect(t.match.running).toBe(false);
    await t.sched.advance(OPTS.joinGraceMs + 100);
    expect(t.store.forfeits).toEqual(['u5']);
    expect(t.match.running).toBe(true);
    expect(t.match.seatsView().find((s) => s.userId === 'u5')!.forfeited).toBe(true);
  });
});

describe('time', () => {
  it('feeds the engine real elapsed time and saves only the ticks that changed something', async () => {
    const t = setup('imposter', 4);
    const s = () => t.match.state as ImposterState;
    const start = s().timeLeftMs;
    await t.sched.advance(3_000);
    expect(s().phase).toBe('reveal');
    expect(s().timeLeftMs).toBe(start - 3_000);
    expect(t.store.moves).toHaveLength(0); // clocks only: nothing written

    await t.sched.advance(start); // the reveal runs out
    expect(s().phase).toBe('clue');
    expect(t.store.moves).toHaveLength(1);
    expect(t.store.moves[0]).toMatchObject({ seq: 1, userId: null });
    expect((t.store.moves[0]!.action as { kind: string }).kind).toBe('tick');
    expect(t.match.version).toBe(1);
  });

  it('only sends a seat a new state when something it can see changed', async () => {
    const t = setup('imposter', 4);
    await t.sched.advance(100);
    const n = t.sent.length;
    await t.sched.advance(4_000); // five seconds of countdown, nothing else
    expect(t.sent.length).toBe(n);
    await t.sched.advance(6_000); // reveal ends
    expect(t.sent.length).toBeGreaterThan(n);
    expect((t.lastFor('u1')!.view as { phase: string }).phase).toBe('clue');
  });

  it('a seat can never send a tick', async () => {
    const t = setup('werewolf', 5);
    const r = await t.match.submit('u1', undefined, { kind: 'tick', ms: 10_000 });
    expect(r).toMatchObject({ ok: false, code: 'invalid_action' });
    expect((t.match.state as WerewolfState).timeLeftMs).toBe(30_000);
  });

  it('a whole Werewolf game of silence ends in a draw by ticks alone', async () => {
    const t = setup('werewolf', 6);
    await t.sched.advance(30 * 60_000);
    expect(t.match.status).toBe('finished');
    expect(t.store.finished).toHaveLength(1);
    const { outcome } = t.store.finished[0]!;
    expect(outcome.draw).toBe(true);
    expect(outcome.placements).toHaveLength(1);
    expect(outcome.placements[0]!.sort()).toEqual(t.players);
    expect(t.finishedCount()).toBe(1);
  });
});

describe('hidden information', () => {
  it('never says whose turn it is and gives each seat only its own view', async () => {
    const t = setup('imposter', 4);
    const s = t.match.state as ImposterState;
    const imposter = s.imposters[0]!;
    const crew = s.players.find((p) => !s.imposters.includes(p))!;
    const vi = t.lastFor(imposter)!;
    const vc = t.lastFor(crew)!;
    expect(vi.turnUserId).toBeNull();
    expect((vi.view as { role: string; word: unknown }).role).toBe('imposter');
    expect((vi.view as { word: unknown }).word).toBeNull();
    expect((vc.view as { word: string }).word).toBe(s.word);
    expect(JSON.stringify(vi)).not.toContain(s.word);
    expect(JSON.stringify(vi)).not.toContain('"rng"');
  });

  it('werewolf: night actors are not revealed, only your own ability', async () => {
    const t = setup('werewolf', 6);
    const s = t.match.state as WerewolfState;
    const wolf = s.players.find((p) => s.roles[p] === 'werewolf')!;
    const villager = s.players.find((p) => s.roles[p] === 'villager')!;
    expect(t.lastFor(wolf)!.canAct).toBe(true);
    expect(t.lastFor(villager)!.canAct).toBe(false);
    for (const p of t.players) expect(t.lastFor(p)!.turnUserId).toBeNull();
    const v = t.lastFor(villager)!.view as Record<string, unknown>;
    expect(v.role).toBe('villager');
    expect(v.wolves).toBeUndefined();
    expect(v.roles).toBeUndefined();
    expect(v.wolfTargets).toBeUndefined();
    expect(JSON.stringify(v)).not.toContain('"werewolf":' + 'true');
  });
});

describe('a 4-player Imposter round', () => {
  it('plays reveal, clues, votes and settles the winning side', async () => {
    const t = setup('imposter', 4, { seed: 11n });
    const s = () => t.match.state as ImposterState;
    const imposter = s().imposters[0]!;
    // everybody votes for a crew member: the imposter is not caught and wins
    const crew = s().players.filter((p) => p !== imposter);
    await playImposter(t, (voter) => [voter === crew[0] ? crew[1]! : crew[0]!]);
    expect(s().phase).toBe('over');
    expect(s().winner).toBe('imposters');
    expect(t.match.status).toBe('finished');
    const { outcome } = t.store.finished[0]!;
    expect(outcome.placements[0]).toEqual([imposter]);
    expect(outcome.placements[1]!.sort()).toEqual(crew.sort());
    expect(outcome.draw).toBe(false);
    // every move is on record: clues and votes by seat, phase ticks by the room
    expect(t.store.moves.every((m, i) => m.seq === i + 1)).toBe(true);
    expect(t.store.moves.some((m) => m.userId === null)).toBe(false);
    expect(t.match.results).toHaveLength(4);
  });

  it('refuses out-of-turn clues, bad votes and acting after the end', async () => {
    const t = setup('imposter', 4, { seed: 3n });
    const s = () => t.match.state as ImposterState;
    for (const p of t.players) await t.match.submit(p, undefined, { kind: 'ready' });
    const speaker = s().order[0]!;
    const other = s().order[1]!;
    expect(await t.match.submit(other, undefined, { kind: 'clue', text: 'hi' })).toMatchObject({
      ok: false,
      code: 'not_your_turn',
    });
    expect(
      await t.match.submit(speaker, undefined, { kind: 'vote', targets: [other] }),
    ).toMatchObject({ ok: false, code: 'illegal_move' });
    expect(await t.match.submit(speaker, undefined, { nope: 1 })).toMatchObject({
      ok: false,
      code: 'invalid_action',
    });
    expect(await t.match.submit('stranger', undefined, { kind: 'ready' })).toMatchObject({
      ok: false,
      code: 'not_seated',
    });
  });
});

describe('leaving', () => {
  it('a seat offline for the reconnect window forfeits; coming back in time keeps it', async () => {
    const t = setup('imposter', 5);
    t.match.setConnected('u2', false);
    await t.sched.advance(OPTS.reconnectMs - 1_000);
    t.match.setConnected('u2', true);
    await t.sched.advance(OPTS.reconnectMs * 2);
    expect(t.store.forfeits).toEqual([]);

    t.match.setConnected('u3', false);
    await t.sched.advance(OPTS.reconnectMs + 100);
    expect(t.store.forfeits).toEqual(['u3']);
    expect(await t.match.submit('u3', undefined, { kind: 'ready' })).toMatchObject({
      ok: false,
      code: 'forfeited',
    });
  });

  it('one player left wins at once and the leavers rank last, the last to leave first', async () => {
    const t = setup('doodle-guess', 3);
    await t.match.forfeit('u2');
    expect(t.match.status).toBe('live');
    await t.match.forfeit('u3');
    expect(t.match.status).toBe('finished');
    const { outcome } = t.store.finished[0]!;
    expect(outcome.placements).toEqual([['u1'], ['u3'], ['u2']]);
    expect(outcome.forfeited).toEqual(['u2', 'u3']);
  });

  it('runs the clock forward when it is only waiting for a drawer who left', async () => {
    const t = setup('doodle-guess', 3, { options: { rounds: 1 } });
    const s = () => t.match.state as DoodleState;
    const drawer = s().order[0]!;
    await t.match.forfeit(drawer);
    const turn0 = s().turn;
    await t.sched.advance(8_000); // far less than the 10 s choose + 80 s draw a real wait would take
    expect(s().turn).toBeGreaterThan(turn0);
    expect(t.match.status).toBe('live');
  });

  it('a game whose seats have all left but one finishes with that one winning', async () => {
    const t = setup('werewolf', 5);
    for (const p of ['u2', 'u3', 'u4', 'u5']) await t.match.forfeit(p);
    expect(t.match.status).toBe('finished');
    expect(t.store.finished[0]!.outcome.placements[0]).toEqual(['u1']);
  });
});

describe('streams (Doodle Guess)', () => {
  it('batches strokes into one write and broadcasts them at most every 150 ms', async () => {
    const t = setup('doodle-guess', 3, { options: { rounds: 1 } });
    const s = () => t.match.state as DoodleState;
    const drawer = s().order[0]!;
    await t.match.submit(drawer, undefined, { kind: 'choose', index: 0 });
    const guesser = s().players.find((p) => p !== drawer)!;
    const savesBefore = t.store.saves;
    t.sent.length = 0;
    t.canvases.length = 0;
    for (let i = 0; i < 20; i++) {
      const r = await t.match.submit(drawer, undefined, {
        kind: 'stroke',
        points: [
          [i * 10, 5],
          [i * 10 + 5, 40],
        ],
        color: 1,
        width: 2,
      });
      expect(r.ok).toBe(true);
    }
    expect(s().strokes).toHaveLength(20);
    expect(t.store.saves).toBe(savesBefore); // nothing written yet
    expect(t.sent.filter((x) => x.userId === guesser)).toHaveLength(0); // coalesced
    expect(t.canvases.filter((x) => x.userId === guesser)).toHaveLength(0);
    await t.sched.advance(200);
    // the view carries only the count; the drawing itself arrives once, as one message
    expect(t.sent.filter((x) => x.userId === guesser)).toHaveLength(1);
    const view = t.lastFor(guesser)!.view as { strokes?: unknown; strokeCount: number };
    expect(view.strokes).toBeUndefined();
    expect(view.strokeCount).toBe(20);
    const mine = t.canvases.filter((x) => x.userId === guesser);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.msg).toMatchObject({ reset: false, extend: [] });
    expect(mine[0]!.msg.strokes).toHaveLength(20);

    await t.sched.advance(1_500);
    expect(t.store.saves).toBe(savesBefore + 1); // one transaction for all twenty
    const strokeRows = t.store.moves.filter(
      (m) => (m.action as { kind: string }).kind === 'stroke',
    );
    expect(strokeRows).toHaveLength(20);
  });

  it('a seat that keeps up gets deltas; undo, a new turn or a reconnect send the canvas again', async () => {
    const t = setup('doodle-guess', 3, { options: { rounds: 1 } });
    const s = () => t.match.state as DoodleState;
    const drawer = s().order[0]!;
    await t.match.submit(drawer, undefined, { kind: 'choose', index: 0 });
    const guesser = s().players.find((p) => p !== drawer)!;
    const stroke = (cont: boolean, x: number) => ({
      kind: 'stroke' as const,
      points: [
        [x, 1],
        [x + 1, 2],
      ] as [number, number][],
      color: 1,
      width: 2,
      cont,
    });
    // what the guesser's screen holds, rebuilt only from what the room sent it
    let screen: CanvasStroke[] = [];
    const sync = async () => {
      await t.sched.advance(200);
      for (const c of t.canvases.splice(0).filter((x) => x.userId === guesser)) {
        screen = applyCanvas(screen, c.msg);
      }
      expect(screen).toEqual(s().strokes);
    };
    await t.match.submit(drawer, undefined, stroke(false, 10));
    await sync();
    t.canvases.length = 0;

    await t.match.submit(drawer, undefined, stroke(true, 20)); // a stroke grows
    await t.sched.advance(200);
    const grow = t.canvases.filter((x) => x.userId === guesser);
    expect(grow).toHaveLength(1);
    expect(grow[0]!.msg).toMatchObject({ reset: false, strokes: [] });
    expect(grow[0]!.msg.extend).toHaveLength(1);
    expect(grow[0]!.msg.extend[0]!.pts).toHaveLength(2); // only the new points
    screen = applyCanvas(screen, grow[0]!.msg);
    t.canvases.length = 0;
    expect(screen).toEqual(s().strokes);

    await t.match.submit(drawer, undefined, stroke(false, 40));
    await sync(); // the new stroke reaches the guesser as an addition
    t.canvases.length = 0;
    await t.match.submit(drawer, undefined, { kind: 'undo' });
    await t.sched.advance(200);
    const afterUndo = t.canvases.filter((x) => x.userId === guesser);
    expect(afterUndo).toHaveLength(1);
    expect(afterUndo[0]!.msg.reset).toBe(true); // taking a stroke away cannot be described as an addition
    for (const c of afterUndo) screen = applyCanvas(screen, c.msg);
    expect(screen).toEqual(s().strokes);
    t.canvases.length = 0;

    // a seat that reconnects is sent everything again
    t.match.setConnected(guesser, false);
    t.match.setConnected(guesser, true);
    t.match.sendState(guesser);
    const again = t.canvases.filter((x) => x.userId === guesser);
    expect(again.at(-1)!.msg).toMatchObject({ reset: true });
    expect(applyCanvas([], again.at(-1)!.msg)).toEqual(s().strokes);

    // the next turn starts on an empty canvas
    t.canvases.length = 0;
    await t.sched.advance(100_000);
    const next = t.canvases.filter((x) => x.userId === guesser).at(-1);
    expect(next).toBeDefined();
    expect(next!.msg.reset).toBe(true);
  });

  it('a guess flushes the strokes waiting before it, in order', async () => {
    const t = setup('doodle-guess', 3, { options: { rounds: 1 } });
    const s = () => t.match.state as DoodleState;
    const drawer = s().order[0]!;
    await t.match.submit(drawer, undefined, { kind: 'choose', index: 0 });
    const guesser = s().players.find((p) => p !== drawer)!;
    for (let i = 0; i < 3; i++) {
      await t.match.submit(drawer, undefined, {
        kind: 'stroke',
        points: [[i, i]],
        color: 0,
        width: 1,
      });
    }
    await t.match.submit(guesser, undefined, { kind: 'guess', text: 'wrong guess' });
    const seqs = t.store.moves.map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect((t.store.moves.at(-1)!.action as { kind: string }).kind).toBe('guess');
    // guessers do not see the word, the drawer does
    expect((t.lastFor(guesser)!.view as { word: unknown }).word).toBeNull();
    expect((t.lastFor(drawer)!.view as { word: unknown }).word).toBe(s().word);
  });

  it('a failed batch write is retried with the next one and loses nothing', async () => {
    const t = setup('doodle-guess', 3, { options: { rounds: 1 } });
    const s = () => t.match.state as DoodleState;
    const drawer = s().order[0]!;
    await t.match.submit(drawer, undefined, { kind: 'choose', index: 0 });
    await t.match.submit(drawer, undefined, {
      kind: 'stroke',
      points: [[1, 1]],
      color: 0,
      width: 1,
    });
    t.store.failSave = 1;
    await t.sched.advance(1_600); // the flush fails
    expect(t.errors).toHaveLength(1);
    await t.match.submit(drawer, undefined, {
      kind: 'stroke',
      points: [[2, 2]],
      color: 0,
      width: 1,
    });
    await t.sched.advance(1_600);
    expect(
      t.store.moves.filter((m) => (m.action as { kind: string }).kind === 'stroke'),
    ).toHaveLength(2);
  });
});

describe('persistence failures', () => {
  it('a move that cannot be saved is not applied and the table carries on', async () => {
    const t = setup('imposter', 4);
    const s = () => t.match.state as ImposterState;
    t.store.failSave = 1;
    await expect(t.match.submit('u1', undefined, { kind: 'ready' })).rejects.toThrow('db down');
    expect(s().ready).toEqual([]);
    expect(t.match.version).toBe(0);
    expect(await t.match.submit('u1', undefined, { kind: 'ready' })).toEqual({ ok: true });
    expect(s().ready).toEqual(['u1']);
  });

  it('retries settlement, then gives up loudly without losing the table', async () => {
    const t = setup('imposter', 4);
    t.store.failFinish = 99;
    const imposter = (t.match.state as ImposterState).imposters[0]!;
    const crew = t.players.filter((p) => p !== imposter);
    let failure: unknown;
    const run = playImposter(t, (v) => [v === crew[0] ? crew[1]! : crew[0]!]).catch(
      (e: unknown) => {
        failure = e;
      },
    );
    await t.sched.advance(10_000);
    await run;
    expect(failure).toBeInstanceOf(Error);
    expect(t.match.status).toBe('live');
    expect(t.store.finished).toHaveLength(0);
  });

  it('a match recovered from the database picks up where it was', async () => {
    const a = setup('imposter', 4);
    for (const p of a.players) await a.match.submit(p, undefined, { kind: 'ready' });
    const saved = a.store.lastState as ImposterState;
    expect(saved.phase).toBe('clue');
    a.match.dispose();

    const game = LIVE_GAMES.imposter as PartyGame;
    const store = new MemoryStore();
    const sched = new FakeScheduler();
    const m = new PartyMatch(
      {
        matchId: 'm1',
        spaceId: 's1',
        gameSlug: 'imposter',
        mode: 'free',
        state: saved,
        version: a.match.version,
        players: a.players.map((userId, i) => ({ userId, seat: i + 1 })),
        forfeited: [],
      },
      game,
      store,
      sched,
      {
        state: () => undefined,
        chat: () => undefined,
        stream: () => undefined,
        finished: () => undefined,
      },
      OPTS,
    );
    m.start();
    expect(m.running).toBe(false); // seats must come back first
    for (const p of a.players) m.setConnected(p, true);
    expect(m.running).toBe(true);
    const speaker = saved.order[0]!;
    expect(await m.submit(speaker, undefined, { kind: 'clue', text: 'again' })).toEqual({
      ok: true,
    });
    expect(store.moves[0]!.seq).toBe(a.match.version + 1);
  });
});

describe('chat', () => {
  it('werewolf: wolves whisper at night, the dead hear but cannot speak to the living', async () => {
    const t = setup('werewolf', 6, { seed: 5n });
    const s = () => t.match.state as WerewolfState;
    const wolf = s().players.find((p) => s().roles[p] === 'werewolf')!;
    const villager = s().players.find((p) => s().roles[p] === 'villager')!;
    expect(t.match.chat(villager, 'who is it?')).toMatchObject({ ok: false, code: 'chat_closed' });
    expect(t.match.chat(wolf, 'pick the quiet one')).toEqual({ ok: true });
    expect(t.chats.map((c) => c.userId)).toEqual([wolf]);
    // history only for those who may hear it
    expect(t.match.chatHistoryFor(wolf)).toHaveLength(1);
    expect(t.match.chatHistoryFor(villager)).toHaveLength(0);
  });

  it('limits how fast one seat can talk and cleans the text', async () => {
    const t = setup('werewolf', 6, { seed: 5n });
    const s = t.match.state as WerewolfState;
    const wolf = s.players.find((p) => s.roles[p] === 'werewolf')!;
    expect(t.match.chat(wolf, 'one')).toEqual({ ok: true });
    expect(t.match.chat(wolf, 'two')).toMatchObject({ ok: false, code: 'rate_limited' });
    await t.sched.advance(700);
    expect(t.match.chat(wolf, 'what the fuck')).toMatchObject({
      ok: false,
      code: 'invalid_action',
    });
    expect(t.match.chat(wolf, '   ')).toMatchObject({ ok: false, code: 'invalid_action' });
    expect(t.match.chat('stranger', 'hi')).toMatchObject({ ok: false, code: 'not_seated' });
  });

  it('doodle guess has no chat: a guess is a move', async () => {
    const t = setup('doodle-guess', 3);
    expect(t.match.chat('u1', 'hello')).toMatchObject({ ok: false, code: 'chat_closed' });
  });
});

describe('flooding', () => {
  it('refuses a seat that sends more than its burst', async () => {
    const t = setup('doodle-guess', 3, { options: { rounds: 1 } });
    const s = () => t.match.state as DoodleState;
    const drawer = s().order[0]!;
    await t.match.submit(drawer, undefined, { kind: 'choose', index: 0 });
    const guesser = s().players.find((p) => p !== drawer)!;
    let refused = 0;
    for (let i = 0; i < 50; i++) {
      const r = await t.match.submit(guesser, undefined, { kind: 'guess', text: `try ${i}` });
      if (!r.ok && r.code === 'rate_limited') refused += 1;
    }
    expect(refused).toBeGreaterThan(10);
    await t.sched.advance(2_000);
    const again = await t.match.submit(guesser, undefined, { kind: 'guess', text: 'later' });
    expect(again.ok).toBe(true);
  });
});

describe('charades and the clock', () => {
  it('a team that never presses start forfeits its turns and the game ends level', async () => {
    const t = setup('charades', 4, { options: { rounds: 1 } });
    await t.sched.advance(60 * 60_000);
    expect(t.match.status).toBe('finished');
    const { outcome } = t.store.finished[0]!;
    expect(outcome.draw).toBe(true);
    await flush();
  });
});
