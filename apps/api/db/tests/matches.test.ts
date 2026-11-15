import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { GameCardPayload, MatchView, RealtimeEvent } from '@dyce/shared';
import { MessagesService } from '../../src/chat/messages.service.ts';
import type { AnyEngine, EngineEntry } from '../../src/matches/engines.ts';
import { MatchesService } from '../../src/matches/matches.service.ts';
import { FriendsService } from '../../src/social/friends.service.ts';
import { createTestDb, createUser, type TestDb, type TestUser } from '../testing/testDb.ts';

/**
 * A tiny deterministic game with hidden information, so the tests control every outcome:
 * players alternate adding 1-3 to a shared total; whoever reaches 5 wins. `secret` must never reach a client.
 */
type RaceState = {
  players: string[];
  turn: number;
  total: number;
  winner: string | null;
  secret: string;
};
const raceEngine: AnyEngine = {
  slug: 'test_race',
  actionSchema: z.object({ kind: z.literal('add'), n: z.number().int() }),
  init: (players, seed) =>
    ({ players, turn: 0, total: 0, winner: null, secret: `secret-${seed}` }) satisfies RaceState,
  currentPlayers: (s) => {
    const st = s as RaceState;
    return st.winner ? [] : [st.players[st.turn]!];
  },
  validate: (_s, _by, a) => {
    const n = (a as { n: number }).n;
    return n >= 1 && n <= 3 ? { ok: true } : { ok: false, code: 'bad_step' };
  },
  apply: (s, by, a) => {
    const st = s as RaceState;
    const total = st.total + (a as { n: number }).n;
    return { ...st, total, winner: total >= 5 ? by : null, turn: (st.turn + 1) % 2 };
  },
  isTerminal: (s) => (s as RaceState).winner !== null,
  result: (s) => {
    const st = s as RaceState;
    const loser = st.players.find((p) => p !== st.winner)!;
    return { placements: [[st.winner!], [loser]], draw: false };
  },
  view: (s) => {
    const { secret: _secret, ...visible } = s as RaceState;
    return visible;
  },
};

/** Ends in a draw after two moves. */
const drawEngine: AnyEngine = {
  ...raceEngine,
  slug: 'test_draw',
  isTerminal: (s) => (s as RaceState).total >= 2,
  currentPlayers: (s) =>
    (s as RaceState).total >= 2 ? [] : [(s as RaceState).players[(s as RaceState).turn]!],
  result: (s) => ({ placements: [(s as RaceState).players], draw: true }),
};

const ENGINES: Record<string, EngineEntry> = {
  test_race: { engine: raceEngine, cfg: {} },
  test_draw: { engine: drawEngine, cfg: {} },
};

const T0 = new Date('2026-11-14T10:00:00Z').getTime();
const clock = { t: T0 };
const now = () => new Date((clock.t += 1000));

let db: TestDb;
let chat: MessagesService;
let friends: FriendsService;
let matches: MatchesService;
const published: { users: readonly string[]; event: RealtimeEvent }[] = [];
const publisher = {
  publish: (users: readonly string[], event: RealtimeEvent) =>
    void published.push({ users, event }),
};

beforeAll(async () => {
  db = await createTestDb();
  for (const [slug, name] of [
    ['test_race', 'Race'],
    ['test_draw', 'Draw'],
  ] as const) {
    await db.admin.query(
      `INSERT INTO games (slug, name, dimension, sync, min_players, max_players, enabled)
       VALUES ($1, $2, '2d', 'async', 2, 2, true)`,
      [slug, name],
    );
  }
  chat = new MessagesService(db.app, publisher, now);
  friends = new FriendsService(db.app, now);
  matches = new MatchesService(db.app, publisher, chat, now, {
    allowDevGames: true,
    engines: ENGINES,
  });
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  clock.t = T0;
  published.length = 0;
});

const code = (c: string) => expect.objectContaining({ code: c });
const add = (n: number) => ({ kind: 'add', n });

/** Two friends and their conversation. */
async function pair() {
  const a = await createUser(db);
  const b = await createUser(db);
  await friends.sendRequest(a.id, b.id);
  await friends.accept(b.id, a.id);
  const conv = (await chat.openDirect(a.id, b.id)).id;
  return { a, b, conv };
}

const send = (from: TestUser, conv: string, gameSlug = 'test_race') =>
  matches.create(from.id, { id: randomUUID(), conversationId: conv, gameSlug, mode: 'free' });

/** An accepted match, a to move. */
async function started(gameSlug = 'test_race') {
  const p = await pair();
  const m = await send(p.a, p.conv, gameSlug);
  await matches.accept(p.b.id, m.id);
  return { ...p, id: m.id };
}

const moves = async (id: string) =>
  (
    await db.admin.query(
      'SELECT seq, user_id, action FROM match_moves WHERE match_id = $1 ORDER BY seq',
      [id],
    )
  ).rows;

describe('games catalogue', () => {
  it('lists the games that are enabled and have an engine', async () => {
    const { games } = await matches.listGames();
    expect(games.map((g) => g.slug).sort()).toEqual(['test_draw', 'test_race']);
  });

  it('offers the reference game only outside production', async () => {
    const dev = new MatchesService(db.app, publisher, chat, now, { allowDevGames: true });
    const prod = new MatchesService(db.app, publisher, chat, now, { allowDevGames: false });
    expect((await dev.listGames()).games.map((g) => g.slug)).toContain('_example');
    expect((await prod.listGames()).games.map((g) => g.slug)).not.toContain('_example');
    const p = await pair();
    await expect(
      prod.create(p.a.id, {
        id: randomUUID(),
        conversationId: p.conv,
        gameSlug: '_example',
        mode: 'free',
      }),
    ).rejects.toEqual(code('game_not_found'));
  });

  it('skips a disabled game', async () => {
    await db.admin.query(`UPDATE games SET enabled = false WHERE slug = 'test_draw'`);
    try {
      expect((await matches.listGames()).games.map((g) => g.slug)).toEqual(['test_race']);
    } finally {
      await db.admin.query(`UPDATE games SET enabled = true WHERE slug = 'test_draw'`);
    }
  });
});

describe('sending a game', () => {
  it('creates an invite and posts a game card both people see', async () => {
    const { a, b, conv } = await pair();
    const m = await send(a, conv);
    expect(m).toMatchObject({
      status: 'invited',
      mode: 'free',
      gameName: 'Race',
      createdBy: a.id,
      stateVersion: 0,
      view: null,
      currentTurn: null,
      conversationId: conv,
    });
    expect(m.players.map((p) => [p.userId, p.seat, p.accepted])).toEqual([
      [a.id, 1, true],
      [b.id, 2, false],
    ]);
    expect(m.inviteExpiresAt).not.toBeNull();

    for (const who of [a, b]) {
      const page = await chat.messages(who.id, conv);
      const card = page.messages.find((x) => x.kind === 'game');
      expect(card).toMatchObject({ id: m.id, senderId: a.id, body: 'Race · Free' });
      expect((card!.payload as GameCardPayload).status).toBe('invited');
    }
    expect(published.some((e) => e.event.type === 'message' && e.users.includes(b.id))).toBe(true);
  });

  it('is idempotent on the match id', async () => {
    const { a, conv } = await pair();
    const id = randomUUID();
    const input = { id, conversationId: conv, gameSlug: 'test_race', mode: 'free' as const };
    const first = await matches.create(a.id, input);
    const again = await matches.create(a.id, input);
    expect(again.id).toBe(first.id);
    const n = await db.admin.query(`SELECT count(*)::int AS n FROM matches WHERE id = $1`, [id]);
    const cards = await db.admin.query(`SELECT count(*)::int AS n FROM messages WHERE id = $1`, [
      id,
    ]);
    const players = await db.admin.query(
      `SELECT count(*)::int AS n FROM match_players WHERE match_id = $1`,
      [id],
    );
    expect([n.rows[0].n, cards.rows[0].n, players.rows[0].n]).toEqual([1, 1, 2]);
  });

  it("won't reuse someone else's match id", async () => {
    const one = await pair();
    const two = await pair();
    const m = await send(one.a, one.conv);
    await expect(
      matches.create(two.a.id, {
        id: m.id,
        conversationId: two.conv,
        gameSlug: 'test_race',
        mode: 'free',
      }),
    ).rejects.toEqual(code('message_id_taken'));
  });

  it('needs a conversation you are in', async () => {
    const one = await pair();
    const outsider = await createUser(db);
    await expect(send(outsider, one.conv)).rejects.toEqual(code('conversation_not_found'));
  });

  it('is only for friends', async () => {
    const a = await createUser(db);
    const stranger = await createUser(db);
    const conv = (await chat.openDirect(a.id, stranger.id)).id;
    await expect(send(a, conv)).rejects.toEqual(code('match_requires_friends'));
  });

  it('refuses a blocked pair, and says nothing to the one who was blocked', async () => {
    const { a, b, conv } = await pair();
    await db.app.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [b.id, a.id]);
    await expect(send(a, conv)).rejects.toEqual(code('user_not_found'));
    await expect(send(b, conv)).rejects.toEqual(code('blocked'));
  });

  it('needs a stake to send a Pool game (the full Pool flow is in pool-matches.test.ts)', async () => {
    const { a, conv } = await pair();
    await expect(
      matches.create(a.id, {
        id: randomUUID(),
        conversationId: conv,
        gameSlug: 'test_race',
        mode: 'pool',
      }),
    ).rejects.toEqual(code('invalid_stake'));
  });

  it('rejects an unknown game', async () => {
    const { a, conv } = await pair();
    await expect(send(a, conv, 'nope')).rejects.toEqual(code('game_not_found'));
  });

  it('caps unanswered invites per chat', async () => {
    const { a, conv } = await pair();
    for (let i = 0; i < 5; i++) await send(a, conv);
    await expect(send(a, conv)).rejects.toEqual(code('open_invites_limit'));
  });
});

describe('answering an invite', () => {
  it('starts the game when the other person accepts, with the first player to move', async () => {
    const { a, b, conv } = await pair();
    const m = await send(a, conv);
    published.length = 0;
    const view = await matches.accept(b.id, m.id);
    expect(view).toMatchObject({ status: 'active', stateVersion: 0, currentTurn: a.id });
    expect(view.players.every((p) => p.accepted)).toBe(true);
    expect(view.view).toMatchObject({ total: 0, turn: 0 });

    // The card follows, and each player is sent their own view
    const card = (await chat.messages(a.id, conv)).messages.find((x) => x.kind === 'game')!;
    expect(card.payload).toMatchObject({ status: 'active', currentTurn: a.id });
    const events = published.filter((e) => e.event.type === 'match');
    expect(events.map((e) => e.users[0]).sort()).toEqual([a.id, b.id].sort());
  });

  it('is idempotent', async () => {
    const { a, b, conv } = await pair();
    const m = await send(a, conv);
    await matches.accept(b.id, m.id);
    published.length = 0;
    const again = await matches.accept(b.id, m.id);
    expect(again.status).toBe('active');
    expect(published).toHaveLength(0);
  });

  it("can't be accepted by the sender or someone outside the chat", async () => {
    const { a, conv } = await pair();
    const m = await send(a, conv);
    await expect(matches.accept(a.id, m.id)).rejects.toEqual(code('cannot_accept_own_invite'));
    const outsider = await createUser(db);
    await expect(matches.accept(outsider.id, m.id)).rejects.toEqual(code('match_not_found'));
    await expect(matches.get(outsider.id, m.id)).rejects.toEqual(code('match_not_found'));
  });

  it('can be declined by the invitee and taken back by the sender', async () => {
    const { a, b, conv } = await pair();
    const m1 = await send(a, conv);
    const declined = await matches.decline(b.id, m1.id);
    expect(declined.status).toBe('cancelled');
    expect((await matches.decline(b.id, m1.id)).status).toBe('cancelled'); // idempotent
    await expect(matches.accept(b.id, m1.id)).rejects.toEqual(code('match_not_open'));
    const card = (await chat.messages(a.id, conv)).messages.find((x) => x.id === m1.id)!;
    expect((card.payload as GameCardPayload).status).toBe('cancelled');

    const m2 = await send(a, conv);
    await expect(matches.cancel(b.id, m2.id)).rejects.toEqual(code('match_not_open'));
    await expect(matches.decline(a.id, m2.id)).rejects.toEqual(code('match_not_open'));
    expect((await matches.cancel(a.id, m2.id)).status).toBe('cancelled');
  });

  it("can't be declined once it has started", async () => {
    const { b, id } = await started();
    await expect(matches.decline(b.id, id)).rejects.toEqual(code('match_not_open'));
  });

  it('expires after the invite window', async () => {
    const { a, b, conv } = await pair();
    const m = await send(a, conv);
    clock.t += 25 * 3_600_000;
    await expect(matches.accept(b.id, m.id)).resolves.toMatchObject({ status: 'expired' });
    const card = (await chat.messages(a.id, conv)).messages.find((x) => x.id === m.id)!;
    expect((card.payload as GameCardPayload).status).toBe('expired');

    // reading an old invite expires it too
    const m2 = await send(a, conv);
    clock.t += 25 * 3_600_000;
    expect((await matches.get(a.id, m2.id)).status).toBe('expired');
  });

  it("can't be accepted if the sender blocked you", async () => {
    const { a, b, conv } = await pair();
    const m = await send(a, conv);
    await db.app.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [a.id, b.id]);
    await expect(matches.accept(b.id, m.id)).rejects.toEqual(code('user_not_found'));
  });
});

describe('playing', () => {
  it('applies moves in turn and records each one', async () => {
    const { a, b, id } = await started();
    const v1 = await matches.submitMove(a.id, id, { expectedVersion: 0, action: add(2) });
    expect(v1).toMatchObject({
      stateVersion: 1,
      currentTurn: b.id,
      view: expect.objectContaining({ total: 2 }),
    });
    const v2 = await matches.submitMove(b.id, id, { expectedVersion: 1, action: add(1) });
    expect(v2).toMatchObject({ stateVersion: 2, currentTurn: a.id });
    expect((await moves(id)).map((m) => [m.seq, m.user_id, m.action])).toEqual([
      [1, a.id, add(2)],
      [2, b.id, add(1)],
    ]);
  });

  it('rejects an illegal move without changing anything', async () => {
    const { a, id } = await started();
    await expect(
      matches.submitMove(a.id, id, { expectedVersion: 0, action: add(9) }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'illegal_move', details: { reason: 'bad_step' } }),
    );
    expect(await moves(id)).toHaveLength(0);
    expect((await matches.get(a.id, id)).stateVersion).toBe(0);
  });

  it('rejects an action the game does not understand', async () => {
    const { a, id } = await started();
    await expect(
      matches.submitMove(a.id, id, { expectedVersion: 0, action: { kind: 'teleport' } }),
    ).rejects.toEqual(code('invalid_action'));
  });

  it('rejects a move out of turn, and from someone who is not in the match', async () => {
    const { a, b, id } = await started();
    await expect(
      matches.submitMove(b.id, id, { expectedVersion: 0, action: add(1) }),
    ).rejects.toEqual(code('not_your_turn'));
    const outsider = await createUser(db);
    await expect(
      matches.submitMove(outsider.id, id, { expectedVersion: 0, action: add(1) }),
    ).rejects.toEqual(code('match_not_found'));
    expect(await moves(id)).toHaveLength(0);
    await matches.submitMove(a.id, id, { expectedVersion: 0, action: add(1) }); // the right player still can
  });

  it('rejects a move on a match that has not started', async () => {
    const { a, conv } = await pair();
    const m = await send(a, conv);
    await expect(
      matches.submitMove(a.id, m.id, { expectedVersion: 0, action: add(1) }),
    ).rejects.toEqual(code('match_not_open'));
  });

  it('rejects a stale version and says what the current one is', async () => {
    const { a, b, id } = await started();
    await matches.submitMove(a.id, id, { expectedVersion: 0, action: add(1) });
    // b was looking at version 0 and plays an older state
    await expect(
      matches.submitMove(b.id, id, { expectedVersion: 0, action: add(2) }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'stale_version', details: { currentVersion: 1 } }),
    );
    // ...and a version from the future is no better
    await expect(
      matches.submitMove(b.id, id, { expectedVersion: 5, action: add(2) }),
    ).rejects.toEqual(code('stale_version'));
    expect(await moves(id)).toHaveLength(1);
  });

  it('treats a retry of an applied move as a success and applies it once', async () => {
    const { a, id } = await started();
    const first = await matches.submitMove(a.id, id, { expectedVersion: 0, action: add(2) });
    published.length = 0;
    const retry = await matches.submitMove(a.id, id, { expectedVersion: 0, action: add(2) });
    expect(retry.stateVersion).toBe(1);
    expect(retry.view).toEqual(first.view);
    expect(await moves(id)).toHaveLength(1);
    expect(published).toHaveLength(0); // nothing new to announce

    // a different move at the old version is still stale
    await expect(
      matches.submitMove(a.id, id, { expectedVersion: 0, action: add(3) }),
    ).rejects.toEqual(code('stale_version'));
  });

  it('lets only one of two simultaneous moves through', async () => {
    const { a, id } = await started();
    const results = await Promise.allSettled([
      matches.submitMove(a.id, id, { expectedVersion: 0, action: add(1) }),
      matches.submitMove(a.id, id, { expectedVersion: 0, action: add(2) }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toEqual(code('stale_version'));
    expect(await moves(id)).toHaveLength(1);
  });

  it('stops moves once a block is placed', async () => {
    const { a, b, id } = await started();
    await db.app.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [b.id, a.id]);
    await expect(
      matches.submitMove(a.id, id, { expectedVersion: 0, action: add(1) }),
    ).rejects.toEqual(code('user_not_found'));
    expect(await moves(id)).toHaveLength(0);
  });

  it('never sends hidden state: neither the API view nor live events carry it', async () => {
    const { a, b, id } = await started();
    const stored = await db.admin.query('SELECT state FROM matches WHERE id = $1', [id]);
    expect(stored.rows[0].state.secret).toMatch(/^secret-/); // it exists on the server

    published.length = 0;
    const va = await matches.submitMove(a.id, id, { expectedVersion: 0, action: add(1) });
    const vb = await matches.get(b.id, id);
    for (const payload of [va, vb, ...published.map((e) => e.event)]) {
      expect(JSON.stringify(payload)).not.toContain('secret');
    }
  });
});

describe('finishing', () => {
  it('decides the winner on the server, and both players see the same result', async () => {
    const { a, b, conv, id } = await started();
    await matches.submitMove(a.id, id, { expectedVersion: 0, action: add(3) }); // 3
    await matches.submitMove(b.id, id, { expectedVersion: 1, action: add(1) }); // 4
    published.length = 0;
    const last = await matches.submitMove(a.id, id, { expectedVersion: 2, action: add(1) }); // 5: a wins

    expect(last).toMatchObject({
      status: 'finished',
      currentTurn: null,
      stateVersion: 3,
      outcome: { winnerIds: [a.id], draw: false },
    });
    const va = await matches.get(a.id, id);
    const vb = await matches.get(b.id, id);
    expect(vb.outcome).toEqual(va.outcome);
    expect(vb.players.map((p) => [p.userId, p.result, p.placement])).toEqual([
      [a.id, 'win', 1],
      [b.id, 'loss', 2],
    ]);
    expect(vb.finishedAt).not.toBeNull();

    const card = (await chat.messages(b.id, conv)).messages.find((x) => x.id === id)!;
    expect(card.payload).toMatchObject({ status: 'finished', winnerIds: [a.id], draw: false });
    expect(published.filter((e) => e.event.type === 'match')).toHaveLength(2);

    // it is over: no more moves, and a lost response to the winning move can still be retried
    await expect(
      matches.submitMove(b.id, id, { expectedVersion: 3, action: add(1) }),
    ).rejects.toEqual(code('match_not_open'));
    await expect(
      matches.submitMove(a.id, id, { expectedVersion: 2, action: add(1) }),
    ).resolves.toMatchObject({ status: 'finished' });
    expect(await moves(id)).toHaveLength(3);
  });

  it('records a draw for both', async () => {
    const { a, b, id } = await started('test_draw');
    await matches.submitMove(a.id, id, { expectedVersion: 0, action: add(1) });
    const done = await matches.submitMove(b.id, id, { expectedVersion: 1, action: add(1) });
    expect(done).toMatchObject({ status: 'finished', outcome: { winnerIds: [], draw: true } });
    expect(done.players.map((p) => p.result)).toEqual(['draw', 'draw']);
  });

  it('plays the reference engine (Pig) to a result', async () => {
    const dev = new MatchesService(db.app, publisher, chat, now, { allowDevGames: true });
    const { a, b, conv } = await pair();
    const m = await dev.create(a.id, {
      id: randomUUID(),
      conversationId: conv,
      gameSlug: '_example',
      mode: 'free',
    });
    await dev.accept(b.id, m.id);
    const who = { [a.id]: a, [b.id]: b } as Record<string, TestUser>;

    let view: MatchView = await dev.get(a.id, m.id);
    for (let guard = 0; view.status === 'active' && guard < 2000; guard++) {
      const turn = view.currentTurn!;
      const pig = view.view as { turnPoints: number };
      expect(JSON.stringify(view.view)).not.toContain('"rng"');
      const action = pig.turnPoints >= 10 ? { kind: 'hold' } : { kind: 'roll' };
      view = await dev.submitMove(who[turn]!.id, m.id, {
        expectedVersion: view.stateVersion,
        action,
      });
    }

    expect(view.status).toBe('finished');
    const otherView = await dev.get(b.id, m.id);
    expect(otherView.outcome).toEqual(view.outcome);
    expect(view.outcome!.winnerIds).toHaveLength(1);
    const winner = view.outcome!.winnerIds[0]!;
    const scores = (view.view as { scores: Record<string, number> }).scores;
    expect(scores[winner]).toBeGreaterThanOrEqual(50);
    const loser = Object.keys(scores).find((id) => id !== winner)!;
    expect(scores[loser]).toBeLessThan(50);
    expect((await moves(m.id)).length).toBe(view.stateVersion);

    const results = await db.admin.query(
      `SELECT user_id, result FROM match_players WHERE match_id = $1 ORDER BY seat`,
      [m.id],
    );
    expect(Object.fromEntries(results.rows.map((r) => [r.user_id, r.result]))).toEqual({
      [winner]: 'win',
      [loser]: 'loss',
    });
  });
});
