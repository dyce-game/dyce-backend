import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { GameCardPayload, RealtimeEvent } from '@dyce/shared';
import { MessagesService } from '../../src/chat/messages.service.ts';
import type { AnyEngine, EngineEntry } from '../../src/matches/engines.ts';
import { MatchesService } from '../../src/matches/matches.service.ts';
import { FriendsService } from '../../src/social/friends.service.ts';
import {
  balanceOf,
  createTestDb,
  setBalance,
  type TestDb,
  type TestUser,
} from '../testing/testDb.ts';
import { expectLedgerClean, fundedUser, setConfig } from './helpers.ts';

/**
 * Pool mode for async matches (ADR-017), end to end on real PostgreSQL: every path that moves money,
 * with the ledger invariants checked after each one.
 */
type RaceState = { players: string[]; turn: number; total: number; winner: string | null };
const raceEngine: AnyEngine = {
  slug: 'test_race',
  actionSchema: z.object({ kind: z.literal('add'), n: z.number().int() }),
  init: (players) => ({ players, turn: 0, total: 0, winner: null }) satisfies RaceState,
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
  view: (s) => s,
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
  test_nopool: { engine: raceEngine, cfg: {} },
};

const NAIRA = 100;
const GRANT = 200_000 * NAIRA;
const STAKE = 1_000 * NAIRA;
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
  for (const [slug, name, pool] of [
    ['test_race', 'Race', true],
    ['test_draw', 'Draw', true],
    ['test_nopool', 'No Pool', false],
  ] as const) {
    await db.admin.query(
      `INSERT INTO games (slug, name, dimension, sync, min_players, max_players, supports_pool, enabled)
       VALUES ($1, $2, '2d', 'async', 2, 2, $3, true)`,
      [slug, name, pool],
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

async function pair(opts: { adultB?: boolean } = {}) {
  const a = await fundedUser(db);
  const b = await fundedUser(db, { adult: opts.adultB ?? true });
  await friends.sendRequest(a.id, b.id);
  await friends.accept(b.id, a.id);
  const conv = (await chat.openDirect(a.id, b.id)).id;
  return { a, b, conv };
}

const sendPool = (
  from: TestUser,
  conv: string,
  o: { stake?: number; slug?: string; allowCounter?: boolean; id?: string } = {},
) =>
  matches.create(from.id, {
    id: o.id ?? randomUUID(),
    conversationId: conv,
    gameSlug: o.slug ?? 'test_race',
    mode: 'pool',
    stakeKobo: o.stake ?? STAKE,
    allowCounter: o.allowCounter ?? true,
  });

/** An accepted Pool match, a to move. */
async function started(slug = 'test_race') {
  const p = await pair();
  const m = await sendPool(p.a, p.conv, { slug });
  await matches.accept(p.b.id, m.id);
  return { ...p, id: m.id };
}

const escrowOf = async (matchId: string): Promise<number> =>
  Number(
    (
      await db.admin.query(
        `SELECT coalesce(sum(e.amount_kobo), 0)::bigint AS s FROM ledger_accounts a
           JOIN ledger_entries e ON e.account_id = a.id
          WHERE a.kind = 'pool_escrow' AND a.match_id = $1`,
        [matchId],
      )
    ).rows[0].s,
  );

const txnCount = async (matchId: string, kind: string): Promise<number> =>
  Number(
    (
      await db.admin.query(
        `SELECT count(*)::int AS n FROM ledger_txns WHERE kind = $1 AND meta->>'match_id' = $2`,
        [kind, matchId],
      )
    ).rows[0].n,
  );

const matchRows = async (id: string): Promise<number> =>
  Number(
    (await db.admin.query(`SELECT count(*)::int AS n FROM matches WHERE id = $1`, [id])).rows[0].n,
  );

/** a wins (3, then b 1, then a 1 = 5). */
async function aWins(id: string, a: TestUser, b: TestUser) {
  await matches.submitMove(a.id, id, { expectedVersion: 0, action: add(3) });
  await matches.submitMove(b.id, id, { expectedVersion: 1, action: add(1) });
  return matches.submitMove(a.id, id, { expectedVersion: 2, action: add(1) });
}

afterEach(async () => {
  await expectLedgerClean(db);
});

describe('sending a Pool game', () => {
  it('locks the creator stake in escrow and shows mode, stake and pot on the match and the card', async () => {
    const { a, b, conv } = await pair();
    const m = await sendPool(a, conv);
    expect(m).toMatchObject({
      mode: 'pool',
      status: 'invited',
      stakeKobo: STAKE,
      potKobo: 2 * STAKE,
      allowCounter: true,
      counterStakeKobo: null,
    });
    expect(m.players.map((p) => [p.userId, p.stakedKobo, p.payoutKobo])).toEqual([
      [a.id, STAKE, null],
      [b.id, 0, null],
    ]);
    expect(await balanceOf(db, a.id)).toBe(GRANT - STAKE);
    expect(await balanceOf(db, b.id)).toBe(GRANT);
    expect(await escrowOf(m.id)).toBe(STAKE);

    for (const who of [a, b]) {
      const card = (await chat.messages(who.id, conv)).messages.find((x) => x.id === m.id)!;
      expect(card.body).toBe('Race · Pool');
      expect(card.payload as GameCardPayload).toMatchObject({
        mode: 'pool',
        stakeKobo: STAKE,
        potKobo: 2 * STAKE,
        counterStakeKobo: null,
      });
    }
    const evt = published.find((e) => e.event.type === 'match' && e.users.includes(b.id));
    expect(evt && evt.event.type === 'match' && evt.event.match).toMatchObject({
      mode: 'pool',
      potKobo: 2 * STAKE,
    });
  });

  it('is idempotent on the match id: a retry takes the stake once and posts one card', async () => {
    const { a, conv } = await pair();
    const id = randomUUID();
    const first = await sendPool(a, conv, { id });
    const again = await sendPool(a, conv, { id });
    expect(again.id).toBe(first.id);
    expect(await balanceOf(db, a.id)).toBe(GRANT - STAKE);
    expect(await txnCount(id, 'stake')).toBe(1);
    const cards = await db.admin.query(`SELECT count(*)::int AS n FROM messages WHERE id = $1`, [
      id,
    ]);
    expect(cards.rows[0].n).toBe(1);
  });

  it('a double tap sends one game and takes one stake', async () => {
    const { a, conv } = await pair();
    const id = randomUUID();
    const r = await Promise.allSettled([sendPool(a, conv, { id }), sendPool(a, conv, { id })]);
    expect(r.every((x) => x.status === 'fulfilled')).toBe(true);
    expect(await txnCount(id, 'stake')).toBe(1);
    expect(await balanceOf(db, a.id)).toBe(GRANT - STAKE);
  });

  it('refuses a retry that changes the stake (the id is taken)', async () => {
    const { a, conv } = await pair();
    const id = randomUUID();
    await sendPool(a, conv, { id });
    await expect(
      matches.create(a.id, {
        id,
        conversationId: conv,
        gameSlug: 'test_race',
        mode: 'free',
      }),
    ).rejects.toEqual(code('message_id_taken'));
    expect(await balanceOf(db, a.id)).toBe(GRANT - STAKE);
  });

  it('refuses a stake outside the limits, and no money or match is left behind', async () => {
    const { a, conv } = await pair();
    for (const stake of [0, 99 * NAIRA - 1, 20_001 * NAIRA]) {
      const id = randomUUID();
      await expect(sendPool(a, conv, { stake, id })).rejects.toMatchObject({
        code: 'invalid_stake',
        details: { minStakeKobo: 100 * NAIRA, maxStakeKobo: 20_000 * NAIRA },
      });
      expect(await matchRows(id)).toBe(0);
    }
    expect(await balanceOf(db, a.id)).toBe(GRANT);
  });

  it('refuses when you cannot cover the stake', async () => {
    const { a, conv } = await pair();
    await setBalance(db, a.id, STAKE - 1);
    const id = randomUUID();
    await expect(sendPool(a, conv, { id })).rejects.toMatchObject({ code: 'insufficient_funds' });
    expect(await matchRows(id)).toBe(0);
    expect(await balanceOf(db, a.id)).toBe(STAKE - 1);
    const cards = await db.admin.query(`SELECT count(*)::int AS n FROM messages WHERE id = $1`, [
      id,
    ]);
    expect(cards.rows[0].n).toBe(0);
  });

  it('needs the age gate (18+)', async () => {
    const minor = await fundedUser(db, { adult: false });
    const friend = await fundedUser(db);
    await friends.sendRequest(minor.id, friend.id);
    await friends.accept(friend.id, minor.id);
    const conv = (await chat.openDirect(minor.id, friend.id)).id;
    const id = randomUUID();
    await expect(sendPool(minor, conv, { id })).rejects.toMatchObject({ code: 'adult_required' });
    expect(await matchRows(id)).toBe(0);
    expect(await balanceOf(db, minor.id)).toBe(GRANT);
  });

  it('respects the daily stake and games limits', async () => {
    const { a, conv } = await pair();
    await setConfig(db, 'pool_staked_per_day_kobo', STAKE + STAKE / 2);
    try {
      await sendPool(a, conv);
      const id = randomUUID();
      await expect(sendPool(a, conv, { id })).rejects.toMatchObject({
        code: 'over_pool_stake_limit',
      });
      expect(await matchRows(id)).toBe(0);
    } finally {
      await setConfig(db, 'pool_staked_per_day_kobo', 10_000_000);
    }
    const p = await pair();
    await setConfig(db, 'pool_games_per_day', 1);
    try {
      await sendPool(p.a, p.conv);
      await expect(sendPool(p.a, p.conv)).rejects.toMatchObject({ code: 'over_pool_games_limit' });
    } finally {
      await setConfig(db, 'pool_games_per_day', 20);
    }
  });

  it('refuses a game that has no Pool, a non-friend, and a blocked pair, without moving money', async () => {
    const { a, b, conv } = await pair();
    await expect(sendPool(a, conv, { slug: 'test_nopool' })).rejects.toEqual(
      code('pool_not_supported'),
    );

    const stranger = await fundedUser(db);
    const strangerConv = (
      await chat.openDirect(a.id, stranger.id).catch(() => ({ id: randomUUID() }))
    ).id;
    await expect(sendPool(a, strangerConv)).rejects.toBeDefined();

    await db.app.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [b.id, a.id]);
    await expect(sendPool(a, conv)).rejects.toBeDefined();
    expect(await balanceOf(db, a.id)).toBe(GRANT);
  });
});

describe('answering a Pool invite', () => {
  it('locks the invitee stake on accept and the match starts with the pot in escrow', async () => {
    const { a, b, conv } = await pair();
    const m = await sendPool(a, conv);
    const v = await matches.accept(b.id, m.id);
    expect(v).toMatchObject({ status: 'active', potKobo: 2 * STAKE, currentTurn: a.id });
    expect(v.players.map((p) => p.stakedKobo)).toEqual([STAKE, STAKE]);
    expect(await balanceOf(db, b.id)).toBe(GRANT - STAKE);
    expect(await escrowOf(m.id)).toBe(2 * STAKE);
  });

  it('a double tap and a retry take the stake once', async () => {
    const { a, b, conv } = await pair();
    const m = await sendPool(a, conv);
    const r = await Promise.allSettled([matches.accept(b.id, m.id), matches.accept(b.id, m.id)]);
    expect(r.every((x) => x.status === 'fulfilled')).toBe(true);
    await matches.accept(b.id, m.id);
    expect(await txnCount(m.id, 'stake')).toBe(2);
    expect(await balanceOf(db, b.id)).toBe(GRANT - STAKE);
  });

  it('does not start if the invitee cannot cover the stake, and the invite stays open', async () => {
    const { a, b, conv } = await pair();
    const m = await sendPool(a, conv);
    await setBalance(db, b.id, STAKE - 1);
    await expect(matches.accept(b.id, m.id)).rejects.toMatchObject({ code: 'insufficient_funds' });
    const v = await matches.get(a.id, m.id);
    expect(v.status).toBe('invited');
    expect(await balanceOf(db, b.id)).toBe(STAKE - 1);
    expect(await escrowOf(m.id)).toBe(STAKE);
  });

  it('does not start for an invitee who has not passed the age gate', async () => {
    const { a, b, conv } = await pair({ adultB: false });
    const m = await sendPool(a, conv);
    await expect(matches.accept(b.id, m.id)).rejects.toMatchObject({ code: 'adult_required' });
    expect((await matches.get(a.id, m.id)).status).toBe('invited');
    expect(await balanceOf(db, b.id)).toBe(GRANT);
  });

  it("does not start when the invitee's daily limit is used up", async () => {
    const { a, b, conv } = await pair();
    const m = await sendPool(a, conv);
    await setConfig(db, 'pool_staked_per_day_kobo', STAKE - 1);
    try {
      await expect(matches.accept(b.id, m.id)).rejects.toMatchObject({
        code: 'over_pool_stake_limit',
      });
    } finally {
      await setConfig(db, 'pool_staked_per_day_kobo', 10_000_000);
    }
    expect(await balanceOf(db, b.id)).toBe(GRANT);
    expect(await escrowOf(m.id)).toBe(STAKE);
  });

  it('refuses to start once the pair has blocked each other', async () => {
    const { a, b, conv } = await pair();
    const m = await sendPool(a, conv);
    await db.app.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [a.id, b.id]);
    await expect(matches.accept(b.id, m.id)).rejects.toBeDefined();
    expect(await balanceOf(db, b.id)).toBe(GRANT);
    // The creator's stake is not stranded: expiry still gives it back.
    clock.t += 25 * 3_600_000;
    expect(await matches.expireStaleInvites()).toBeGreaterThanOrEqual(1);
    expect(await balanceOf(db, a.id)).toBe(GRANT);
  });

  it('refunds the creator when the invitee declines (and again on a retry changes nothing)', async () => {
    const { a, b, conv } = await pair();
    const m = await sendPool(a, conv);
    const v = await matches.decline(b.id, m.id);
    expect(v.status).toBe('cancelled');
    expect(v.players.find((p) => p.userId === a.id)).toMatchObject({
      stakedKobo: STAKE,
      payoutKobo: STAKE,
    });
    expect(await balanceOf(db, a.id)).toBe(GRANT);
    expect(await escrowOf(m.id)).toBe(0);
    await matches.decline(b.id, m.id);
    expect(await txnCount(m.id, 'refund')).toBe(1);
    await expect(matches.accept(b.id, m.id)).rejects.toEqual(code('match_not_open'));
    expect(await balanceOf(db, b.id)).toBe(GRANT);
  });

  it('refunds when the creator takes the invite back', async () => {
    const { a, conv } = await pair();
    const m = await sendPool(a, conv);
    expect((await matches.cancel(a.id, m.id)).status).toBe('cancelled');
    expect(await balanceOf(db, a.id)).toBe(GRANT);
    await matches.cancel(a.id, m.id);
    expect(await txnCount(m.id, 'refund')).toBe(1);
  });

  it('refunds on expiry, whether someone opens the match or the sweep finds it', async () => {
    const { a, b, conv } = await pair();
    const m1 = await sendPool(a, conv);
    clock.t += 25 * 3_600_000;
    await expect(matches.accept(b.id, m1.id)).resolves.toMatchObject({ status: 'expired' });
    expect(await balanceOf(db, a.id)).toBe(GRANT);
    expect(await balanceOf(db, b.id)).toBe(GRANT);

    const m2 = await sendPool(a, conv);
    clock.t += 25 * 3_600_000;
    expect(await matches.expireStaleInvites()).toBeGreaterThanOrEqual(1);
    expect(await matches.expireStaleInvites()).toBe(0);
    expect((await matches.get(a.id, m2.id)).status).toBe('expired');
    const card = (await chat.messages(a.id, conv)).messages.find((x) => x.id === m2.id)!;
    expect((card.payload as GameCardPayload).status).toBe('expired');
    expect(await balanceOf(db, a.id)).toBe(GRANT);
    expect(await txnCount(m2.id, 'refund')).toBe(1);
  });
});

describe('counter-offers', () => {
  it('lets the invitee suggest a smaller stake once; nothing moves until the creator answers', async () => {
    const { a, b, conv } = await pair();
    const m = await sendPool(a, conv);
    const v = await matches.counter(b.id, m.id, { stakeKobo: STAKE / 2 });
    expect(v).toMatchObject({ status: 'countered', counterStakeKobo: STAKE / 2, stakeKobo: STAKE });
    expect(await balanceOf(db, a.id)).toBe(GRANT - STAKE);
    expect(await balanceOf(db, b.id)).toBe(GRANT);
    const card = (await chat.messages(a.id, conv)).messages.find((x) => x.id === m.id)!;
    expect(card.payload as GameCardPayload).toMatchObject({
      status: 'countered',
      counterStakeKobo: STAKE / 2,
    });
    // the same counter again is a no-op, another one is not allowed
    await matches.counter(b.id, m.id, { stakeKobo: STAKE / 2 });
    await expect(matches.counter(b.id, m.id, { stakeKobo: STAKE / 4 })).rejects.toEqual(
      code('match_not_open'),
    );
    // the creator cannot counter their own invite, and the invitee cannot accept their own counter
    await expect(matches.counter(a.id, m.id, { stakeKobo: 100 * NAIRA })).rejects.toEqual(
      code('counter_not_allowed'),
    );
    await expect(matches.accept(b.id, m.id)).rejects.toEqual(code('match_not_open'));
  });

  it('only allows a smaller stake within the limits, and only when the sender allowed it', async () => {
    const { a, b, conv } = await pair();
    const m = await sendPool(a, conv);
    for (const stake of [STAKE, STAKE * 2, 50 * NAIRA]) {
      await expect(matches.counter(b.id, m.id, { stakeKobo: stake })).rejects.toEqual(
        code('invalid_stake'),
      );
    }
    const closed = await sendPool(a, conv, { allowCounter: false });
    await expect(matches.counter(b.id, closed.id, { stakeKobo: STAKE / 2 })).rejects.toEqual(
      code('counter_not_allowed'),
    );
    await setBalance(db, b.id, STAKE / 2 - 1);
    await expect(matches.counter(b.id, m.id, { stakeKobo: STAKE / 2 })).rejects.toMatchObject({
      code: 'insufficient_funds',
    });
  });

  it('on accept the sender gets the difference back and both lock the new stake, then they play', async () => {
    const { a, b, conv } = await pair();
    const m = await sendPool(a, conv);
    await matches.counter(b.id, m.id, { stakeKobo: STAKE / 2 });
    const v = await matches.accept(a.id, m.id);
    expect(v).toMatchObject({
      status: 'active',
      stakeKobo: STAKE / 2,
      potKobo: STAKE,
      counterStakeKobo: null,
    });
    expect(v.players.map((p) => p.stakedKobo)).toEqual([STAKE / 2, STAKE / 2]);
    expect(await balanceOf(db, a.id)).toBe(GRANT - STAKE / 2);
    expect(await balanceOf(db, b.id)).toBe(GRANT - STAKE / 2);
    expect(await escrowOf(m.id)).toBe(STAKE);
    await matches.accept(a.id, m.id); // a retry changes nothing
    expect(await balanceOf(db, a.id)).toBe(GRANT - STAKE / 2);

    const done = await aWins(m.id, a, b);
    expect(done.status).toBe('finished');
    expect(await balanceOf(db, a.id)).toBe(GRANT + STAKE / 2);
    expect(await balanceOf(db, b.id)).toBe(GRANT - STAKE / 2);
    expect(await escrowOf(m.id)).toBe(0);
  });

  it('a counter to play free turns the match into a Free one and returns the whole stake', async () => {
    const { a, b, conv } = await pair();
    const m = await sendPool(a, conv);
    await matches.counter(b.id, m.id, { stakeKobo: 0 });
    const v = await matches.accept(a.id, m.id);
    expect(v).toMatchObject({ mode: 'free', status: 'active', stakeKobo: 0, potKobo: 0 });
    expect(await balanceOf(db, a.id)).toBe(GRANT);
    expect(await balanceOf(db, b.id)).toBe(GRANT);
    expect(await escrowOf(m.id)).toBe(0);
    const done = await aWins(m.id, a, b);
    expect(done).toMatchObject({ mode: 'free', status: 'finished' });
    expect(await balanceOf(db, a.id)).toBe(GRANT);
  });

  it('declining the counter refunds the creator in full', async () => {
    const { a, b, conv } = await pair();
    const m = await sendPool(a, conv);
    await matches.counter(b.id, m.id, { stakeKobo: STAKE / 2 });
    expect((await matches.decline(a.id, m.id)).status).toBe('cancelled');
    expect(await balanceOf(db, a.id)).toBe(GRANT);
    expect(await balanceOf(db, b.id)).toBe(GRANT);
    expect(await escrowOf(m.id)).toBe(0);
  });

  it('the invitee can withdraw their counter, which also refunds the creator', async () => {
    const { a, b, conv } = await pair();
    const m = await sendPool(a, conv);
    await matches.counter(b.id, m.id, { stakeKobo: STAKE / 2 });
    expect((await matches.decline(b.id, m.id)).status).toBe('cancelled');
    expect(await balanceOf(db, a.id)).toBe(GRANT);
  });

  it('changes nothing when the invitee can no longer cover their own counter', async () => {
    const { a, b, conv } = await pair();
    const m = await sendPool(a, conv);
    await matches.counter(b.id, m.id, { stakeKobo: STAKE / 2 });
    await setBalance(db, b.id, 100 * NAIRA);
    await expect(matches.accept(a.id, m.id)).rejects.toMatchObject({
      code: 'opponent_cannot_stake',
      details: { reason: 'insufficient_funds' },
    });
    const v = await matches.get(a.id, m.id);
    expect(v.status).toBe('countered');
    expect(await balanceOf(db, a.id)).toBe(GRANT - STAKE);
    expect(await escrowOf(m.id)).toBe(STAKE);
    expect(await balanceOf(db, b.id)).toBe(100 * NAIRA);
  });

  it('an unanswered counter expires and refunds the creator', async () => {
    const { a, b, conv } = await pair();
    const m = await sendPool(a, conv);
    await matches.counter(b.id, m.id, { stakeKobo: STAKE / 2 });
    clock.t += 23 * 3_600_000; // the counter gave the creator a fresh window
    expect((await matches.get(a.id, m.id)).status).toBe('countered');
    clock.t += 2 * 3_600_000;
    expect(await matches.expireStaleInvites()).toBeGreaterThanOrEqual(1);
    expect((await matches.get(b.id, m.id)).status).toBe('expired');
    expect(await balanceOf(db, a.id)).toBe(GRANT);
  });
});

describe('finishing a Pool match', () => {
  it('pays the whole pot to the winner when the game ends, and shows it on the match and the card', async () => {
    const { a, b, id, conv } = await started();
    const v = await aWins(id, a, b);
    expect(v).toMatchObject({ status: 'finished', mode: 'pool', potKobo: 2 * STAKE });
    expect(v.outcome).toEqual({ winnerIds: [a.id], draw: false });
    expect(v.players.map((p) => [p.userId, p.result, p.stakedKobo, p.payoutKobo])).toEqual([
      [a.id, 'win', STAKE, 2 * STAKE],
      [b.id, 'loss', STAKE, 0],
    ]);
    expect(await balanceOf(db, a.id)).toBe(GRANT + STAKE);
    expect(await balanceOf(db, b.id)).toBe(GRANT - STAKE);
    expect(await escrowOf(id)).toBe(0);
    expect(await txnCount(id, 'payout')).toBe(1);
    const card = (await chat.messages(b.id, conv)).messages.find((x) => x.id === id)!;
    expect(card.payload as GameCardPayload).toMatchObject({
      status: 'finished',
      winnerIds: [a.id],
      potKobo: 2 * STAKE,
    });
  });

  it('refunds both stakes on a draw', async () => {
    const { a, b, id } = await started('test_draw');
    await matches.submitMove(a.id, id, { expectedVersion: 0, action: add(1) });
    const v = await matches.submitMove(b.id, id, { expectedVersion: 1, action: add(1) });
    expect(v.outcome).toEqual({ winnerIds: [], draw: true });
    expect(v.players.map((p) => [p.result, p.payoutKobo])).toEqual([
      ['draw', STAKE],
      ['draw', STAKE],
    ]);
    expect(await balanceOf(db, a.id)).toBe(GRANT);
    expect(await balanceOf(db, b.id)).toBe(GRANT);
  });

  it('a retried final move pays out once', async () => {
    const { a, b, id } = await started();
    await matches.submitMove(a.id, id, { expectedVersion: 0, action: add(3) });
    await matches.submitMove(b.id, id, { expectedVersion: 1, action: add(1) });
    const last = { expectedVersion: 2, action: add(1) };
    const r = await Promise.allSettled([
      matches.submitMove(a.id, id, last),
      matches.submitMove(a.id, id, last),
    ]);
    expect(r.every((x) => x.status === 'fulfilled')).toBe(true);
    await matches.submitMove(a.id, id, last); // a late retry
    expect(await txnCount(id, 'payout')).toBe(1);
    expect(await balanceOf(db, a.id)).toBe(GRANT + STAKE);
    expect(await balanceOf(db, b.id)).toBe(GRANT - STAKE);
  });

  it('keeps every wallet and escrow balanced after all of the above', async () => {
    const r = await db.app.query('SELECT * FROM ledger_check_invariants(false)');
    expect(r.rows).toEqual([]);
  });
});

describe('pool info for the stake picker', () => {
  it('reports the limits, usage today and whether the age gate was answered', async () => {
    const { a, b, conv } = await pair();
    await db.admin.query(`UPDATE profiles SET birth_year = 1990 WHERE id = $1`, [a.id]);
    const before = await matches.poolInfo(a.id);
    expect(before).toMatchObject({
      isAdult: true,
      ageAnswered: true,
      minStakeKobo: 100 * NAIRA,
      maxStakeKobo: 20_000 * NAIRA,
      dailyStakeLimitKobo: 100_000 * NAIRA,
      stakedTodayKobo: 0,
      dailyGamesLimit: 20,
      gamesToday: 0,
    });
    expect(before.resetsInSeconds).toBeGreaterThan(0);
    await sendPool(a, conv);
    expect(await matches.poolInfo(a.id)).toMatchObject({ stakedTodayKobo: STAKE, gamesToday: 1 });
    expect((await matches.poolInfo(b.id)).ageAnswered).toBe(false);
  });
});
