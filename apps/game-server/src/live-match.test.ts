import {
  LIVE_GAMES,
  whotEngine,
  type TurnGame,
  type WhotAction,
  type WhotState,
} from '@dyce/games';
import { LiveMatch, type LiveMatchOptions } from './live-match.ts';
import type { LoadedMatch } from './store.ts';
import { FakeScheduler, MemoryStore, flush } from './testing.ts';

const game = LIVE_GAMES.whot as TurnGame;
const OPTS: LiveMatchOptions = {
  reconnectMs: 60_000,
  joinGraceMs: 90_000,
  botDelayMs: 500,
  settleRetries: 2,
  settleRetryMs: 1000,
};

const IDS = ['u1', 'u2', 'u3', 'u4'];

function setup(n: number, seed = 7n) {
  const players = IDS.slice(0, n);
  const state = whotEngine.init(players, seed, {});
  const store = new MemoryStore();
  const sched = new FakeScheduler();
  const changes: number[] = [];
  const errors: unknown[] = [];
  const loaded: LoadedMatch = {
    matchId: 'm1',
    spaceId: 's1',
    gameSlug: 'whot',
    mode: 'pool',
    state,
    version: 0,
    players: players.map((userId, i) => ({ userId, seat: i + 1 })),
    forfeited: [],
  };
  const match = new LiveMatch(
    loaded,
    game,
    store,
    sched,
    (m) => changes.push(m.version),
    OPTS,
    (e) => errors.push(e),
  );
  for (const p of players) match.setConnected(p, true);
  match.start();
  return { match, store, sched, players, changes, errors };
}

const turnOf = (m: LiveMatch) => game.engine.currentPlayers(m.state)[0]!;
const st = (m: LiveMatch) => m.state as WhotState;
/** Plays what the game itself would play for that seat. */
const autoMove = (m: LiveMatch) => {
  const who = turnOf(m);
  return m.submit(who, m.version, game.autoAction(m.state, who));
};

describe('moves', () => {
  it('applies a legal move, persists it, bumps the version and starts the next clock', async () => {
    const { match, store, sched } = setup(3);
    await flush();
    const who = turnOf(match);
    const before = match.stateFor(who);
    expect(before.version).toBe(0);
    expect(before.turnUserId).toBe(who);
    expect(before.turnDeadlineAt).toBe(sched.t + 25_000);

    const r = await autoMove(match);
    expect(r).toEqual({ ok: true });
    expect(match.version).toBe(1);
    expect(store.moves).toHaveLength(1);
    expect(store.moves[0]).toMatchObject({ seq: 1, userId: who });
  });

  it('refuses moves out of turn, stale, illegal, malformed and from strangers', async () => {
    const { match, store } = setup(3);
    await flush();
    const who = turnOf(match);
    const other = IDS.slice(0, 3).find((p) => p !== who)!;
    const good = game.autoAction(match.state, who);

    expect(await match.submit(other, 0, good)).toMatchObject({ ok: false, code: 'not_your_turn' });
    expect(await match.submit(who, 5, good)).toMatchObject({ ok: false, code: 'stale_version' });
    expect(await match.submit(who, 0, { kind: 'bogus' })).toMatchObject({
      ok: false,
      code: 'invalid_action',
    });
    // a card the player does not hold
    expect(
      await match.submit(who, 0, { kind: 'play', card: { shape: 'whot', n: 19 } }),
    ).toMatchObject({ ok: false, code: 'illegal_move' });
    const hand = st(match).hands[who]!;
    const nope = hand.find(
      (c) => !whotEngine.validate(match.state as WhotState, who, { kind: 'play', card: c }).ok,
    );
    if (nope) {
      expect(
        await match.submit(
          who,
          0,
          nope.shape === 'whot'
            ? { kind: 'play', card: nope, shape: 'star' }
            : { kind: 'play', card: nope },
        ),
      ).toMatchObject({ ok: false, code: 'illegal_move' });
    }
    expect(await match.submit('stranger', 0, good)).toMatchObject({
      ok: false,
      code: 'not_seated',
    });
    expect(store.moves).toHaveLength(0);
    expect(match.version).toBe(0);
  });

  it('a repeated move (same version) is refused, not applied twice', async () => {
    const { match, store } = setup(2);
    await flush();
    const who = turnOf(match);
    const move = game.autoAction(match.state, who);
    expect((await match.submit(who, 0, move)).ok).toBe(true);
    // pass-through: whoever's turn it is now, the old version is stale
    expect(await match.submit(who, 0, move)).toMatchObject({ ok: false, code: 'stale_version' });
    expect(store.moves).toHaveLength(1);
  });

  it('two moves at the same instant: one applies, the other is stale', async () => {
    const { match, store } = setup(2);
    await flush();
    const who = turnOf(match);
    const move = game.autoAction(match.state, who);
    const [a, b] = await Promise.all([match.submit(who, 0, move), match.submit(who, 0, move)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(store.moves).toHaveLength(1);
  });

  it('shows each seat only its own cards', async () => {
    const { match } = setup(3);
    const [a, b] = [match.stateFor('u1'), match.stateFor('u2')];
    const va = a.view as { hand: unknown[]; counts: Record<string, number> };
    const vb = b.view as { hand: unknown[] };
    expect(va.hand).toEqual(st(match).hands['u1']);
    expect(vb.hand).toEqual(st(match).hands['u2']);
    expect(JSON.stringify(a)).not.toContain('"market":');
    expect(JSON.stringify(a.view)).not.toContain('rng');
    expect(va.counts['u2']).toBe(6);
  });
});

describe('the turn clock', () => {
  it('plays for a player who runs out of time, connected or not', async () => {
    const { match, store, sched } = setup(3);
    await flush();
    const who = turnOf(match);
    await sched.advance(24_999);
    expect(match.version).toBe(0);
    await sched.advance(2);
    expect(match.version).toBeGreaterThanOrEqual(1);
    expect(store.moves[0]).toMatchObject({ seq: 1, userId: who });
  });

  it('does not play twice for the same turn when the player moved just before the clock ran out', async () => {
    const { match, store, sched } = setup(2);
    await flush();
    await sched.advance(24_000);
    await autoMove(match);
    const v = match.version;
    await sched.advance(2_000); // the old clock would have fired by now
    expect(store.moves.length).toBe(v);
  });
});

describe('leaving', () => {
  it('a seat offline for a minute forfeits; coming back in time keeps it', async () => {
    const { match, sched } = setup(3);
    await flush();
    match.setConnected('u3', false);
    await sched.advance(59_000);
    match.setConnected('u3', true);
    await sched.advance(120_000);
    expect(match.seatsView().find((s) => s.userId === 'u3')!.forfeited).toBe(false);

    match.setConnected('u3', false);
    await sched.advance(61_000);
    expect(match.seatsView().find((s) => s.userId === 'u3')!.forfeited).toBe(true);
  });

  it('a seat that never shows up forfeits after the join grace', async () => {
    const players = IDS.slice(0, 2);
    const state = whotEngine.init(players, 3n, {});
    const store = new MemoryStore();
    const sched = new FakeScheduler();
    const m = new LiveMatch(
      {
        matchId: 'm',
        spaceId: 's',
        gameSlug: 'whot',
        mode: 'free',
        state,
        version: 0,
        players: players.map((userId, i) => ({ userId, seat: i + 1 })),
        forfeited: [],
      },
      game,
      store,
      sched,
      () => undefined,
      OPTS,
    );
    m.setConnected('u1', true);
    m.start();
    await sched.advance(89_000);
    expect(m.status).toBe('live');
    await sched.advance(2_000);
    expect(m.status).toBe('finished');
    expect(store.finished[0]!.outcome).toMatchObject({
      placements: [['u1'], ['u2']],
      forfeited: ['u2'],
    });
  });

  it('with two players, leaving hands the other the win at once', async () => {
    const { match, store } = setup(2);
    await flush();
    await match.forfeit('u1');
    expect(match.status).toBe('finished');
    expect(store.finished).toHaveLength(1);
    expect(store.finished[0]!.outcome).toEqual({
      placements: [['u2'], ['u1']],
      draw: false,
      forfeited: ['u1'],
    });
    expect(match.results?.map((r) => [r.userId, r.placement, r.result])).toEqual([
      ['u2', 1, 'win'],
      ['u1', 2, 'forfeit'],
    ]);
    // nothing more is accepted
    expect(await match.submit('u2', match.version, { kind: 'draw' })).toMatchObject({
      ok: false,
      code: 'not_running',
    });
  });

  it('with three players the game goes on without the leaver, who is played for and finishes last', async () => {
    const { match, store, sched, errors } = setup(3, 11n);
    await flush();
    await match.forfeit('u2');
    expect(match.status).toBe('live');
    // The table keeps moving: u2 is auto-played when their turn comes, u1/u3 play (here by auto too).
    for (let i = 0; i < 400 && match.status === 'live'; i++) {
      const who = turnOf(match);
      if (who === 'u2') {
        await sched.advance(600);
      } else {
        await autoMove(match);
      }
    }
    expect(errors).toEqual([]);
    expect(match.status).toBe('finished');
    const outcome = store.finished[0]!.outcome;
    expect(outcome.forfeited).toEqual(['u2']);
    expect(outcome.placements.at(-1)).toEqual(['u2']);
    expect(outcome.placements.flat().sort()).toEqual(['u1', 'u2', 'u3']);
    expect(outcome.placements[0]).toHaveLength(1);
  });

  it('later forfeits place better than earlier ones', async () => {
    const { match, store } = setup(4);
    await flush();
    await match.forfeit('u2');
    await match.forfeit('u3');
    await match.forfeit('u4');
    expect(match.status).toBe('finished');
    expect(store.finished[0]!.outcome.placements).toEqual([['u1'], ['u4'], ['u3'], ['u2']]);
  });

  it('forfeiting is idempotent and ignores strangers', async () => {
    const { match, store } = setup(3);
    await flush();
    await match.forfeit('u2');
    await match.forfeit('u2');
    await match.forfeit('nobody');
    expect(store.forfeits).toEqual(['u2']);
  });
});

describe('finishing', () => {
  it('plays a whole game to the end and settles exactly once', async () => {
    const { match, store, errors } = setup(4, 99n);
    await flush();
    for (let i = 0; i < 2000 && match.status === 'live'; i++) await autoMove(match);
    expect(errors).toEqual([]);
    expect(match.status).toBe('finished');
    expect(store.finished).toHaveLength(1);
    const winner = (match.state as WhotState).winner;
    const outcome = store.finished[0]!.outcome;
    if (winner) expect(outcome.placements[0]).toEqual([winner]);
    expect(outcome.placements.flat().sort()).toEqual(['u1', 'u2', 'u3', 'u4']);
    expect(match.results).toHaveLength(4);
    // the persisted moves replay to the same final state
    let replay = whotEngine.init(IDS, 99n, {});
    for (const mv of store.moves)
      replay = whotEngine.apply(replay, mv.userId!, mv.action as WhotAction);
    expect(JSON.stringify(replay)).toBe(JSON.stringify(match.state));
  });

  it('retries settlement, then gives up loudly without losing the table', async () => {
    const a = setup(2);
    a.store.failFinish = 1;
    await flush();
    const done = a.match.forfeit('u1');
    await a.sched.advance(1_500);
    await done;
    expect(a.match.status).toBe('finished');

    const b = setup(2);
    b.store.failFinish = 99;
    await flush();
    const failing = b.match.forfeit('u1').catch((e: unknown) => e);
    await b.sched.advance(10_000);
    expect(await failing).toBeInstanceOf(Error);
    expect(b.match.status).toBe('live');
    expect(b.store.finished).toHaveLength(0);
  });

  it('a match recovered after a restart that was already over is settled straight away', async () => {
    const live = setup(2, 5n);
    await flush();
    for (let i = 0; i < 2000 && live.match.status === 'live'; i++) await autoMove(live.match);
    expect(live.match.status).toBe('finished');
    const store = new MemoryStore();
    const sched = new FakeScheduler();
    const again = new LiveMatch(
      {
        matchId: 'm1',
        spaceId: 's1',
        gameSlug: 'whot',
        mode: 'free',
        state: live.match.state,
        version: live.match.version,
        players: [
          { userId: 'u1', seat: 1 },
          { userId: 'u2', seat: 2 },
        ],
        forfeited: [],
      },
      game,
      store,
      sched,
      () => undefined,
      OPTS,
    );
    again.start();
    await sched.advance(10);
    expect(again.status).toBe('finished');
    expect(store.finished).toHaveLength(1);
  });
});
