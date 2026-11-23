import { randomUUID } from 'node:crypto';
import type { QuickMatchTicket, RealtimeEvent } from '@dyce/shared';
import { MessagesService } from '../../src/chat/messages.service.ts';
import { QuickMatchService } from '../../src/quickmatch/quickmatch.service.ts';
import { SpacesService, type GameRooms } from '../../src/spaces/spaces.service.ts';
import {
  balanceOf,
  createTestDb,
  setBalance,
  type TestDb,
  type TestUser,
} from '../testing/testDb.ts';
import { expectLedgerClean, fundedUser, setConfig } from './helpers.ts';

/**
 * Quick match on real PostgreSQL: the queue, who may be paired (level, blocks, rematch), the Pool escrow at
 * the moment of the match, the 10 second accept window and its refunds, the limits, and the promise that
 * two strangers who played are still strangers. The ledger is checked after every test.
 */
const NAIRA = 100;
const GRANT = 200_000 * NAIRA;
const FEE = 500 * NAIRA;
const T0 = new Date('2026-11-14T10:00:00Z').getTime();
const clock = { t: T0 };
const now = () => new Date(clock.t);
const advance = (ms: number) => void (clock.t += ms);

let db: TestDb;
let spaces: SpacesService;
let qm: QuickMatchService;
let chat: MessagesService;
const published: { users: readonly string[]; event: RealtimeEvent }[] = [];
const roomCalls: string[] = [];
const rooms: GameRooms = {
  publicUrl: 'ws://game.test',
  async ensureRoom(matchId) {
    roomCalls.push(matchId);
    return { roomId: `room-${matchId}` };
  },
};

beforeAll(async () => {
  db = await createTestDb();
  const publisher = {
    publish: (users: readonly string[], event: RealtimeEvent) =>
      void published.push({ users, event }),
  };
  spaces = new SpacesService(db.app, publisher, rooms, now);
  qm = new QuickMatchService(db.app, publisher, spaces, now);
  chat = new MessagesService(db.app, publisher, now);
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  clock.t = T0;
  published.length = 0;
  roomCalls.length = 0;
  // Each test starts with an empty queue so leftovers from the one before can never pair with it.
  await db.admin.query(
    `UPDATE quick_match_tickets SET status = 'cancelled' WHERE status IN ('searching', 'found')`,
  );
  for (const [k, v] of Object.entries({
    quick_match_per_hour: 30,
    quick_match_miss_limit: 3,
    quick_match_rematch_minutes: 10,
    quick_match_level_gap: 3,
  })) {
    await setConfig(db, k, v);
  }
});
afterEach(async () => {
  await expectLedgerClean(db);
});

const code = (c: string) => expect.objectContaining({ code: c });
const free = (user: TestUser, gameSlug = 'whot') => qm.join(user.id, { gameSlug, mode: 'free' });
const pool = (user: TestUser, stakeKobo = FEE, gameSlug = 'whot') =>
  qm.join(user.id, { gameSlug, mode: 'pool', stakeKobo });
const mine = async (user: TestUser): Promise<QuickMatchTicket> => (await qm.state(user.id)).ticket!;

async function atLevel(level: number): Promise<TestUser> {
  const u = await fundedUser(db);
  await db.admin.query(`UPDATE profiles SET level = $2 WHERE id = $1`, [u.id, level]);
  return u;
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
const spaceOf = async (id: string) =>
  (await db.admin.query(`SELECT * FROM spaces WHERE id = $1`, [id])).rows[0] as {
    status: string;
    quick_match: boolean;
    visibility: string;
    max_seats: number;
    host_id: string;
  };
const matchOf = async (spaceId: string) =>
  (await db.admin.query(`SELECT id, status, mode FROM matches WHERE space_id = $1`, [spaceId]))
    .rows[0] as { id: string; status: string; mode: string };

/** Two strangers at the same level, paired and waiting to accept. */
async function pair(opts: { pool?: boolean } = {}) {
  const a = await fundedUser(db);
  const b = await fundedUser(db);
  const ta = opts.pool ? await pool(a) : await free(a);
  const tb = opts.pool ? await pool(b) : await free(b);
  return { a, b, ta, tb };
}

describe('finding a match', () => {
  it('pairs two strangers at once and shows each only the other’s public profile', async () => {
    const { a, b } = await pair();
    const ta = await mine(a);
    const tb = await mine(b);
    expect(ta).toMatchObject({ status: 'found', gameSlug: 'whot', mode: 'free', accepted: false });
    expect(tb.status).toBe('found');
    expect(ta.opponent).toMatchObject({ userId: b.id, username: b.username, level: 1, games: 0 });
    expect(ta.opponent!.winRatePct).toBeNull();
    expect(tb.opponent!.userId).toBe(a.id);
    expect(new Date(ta.acceptBy!).getTime()).toBe(T0 + 10_000);
    expect(JSON.stringify(ta)).not.toMatch(/phone|hash|contact/i);
    expect(ta.spaceId).toBeNull(); // not playing yet
  });

  it('opens a hidden two-seat space: no code to find, not in "your spaces", nothing started', async () => {
    const { a, b } = await pair();
    const t = (
      await db.admin.query(
        `SELECT space_id FROM quick_match_tickets WHERE user_id = $1 AND status = 'found'`,
        [a.id],
      )
    ).rows[0];
    const sp = await spaceOf(t.space_id);
    expect(sp).toMatchObject({
      status: 'waiting',
      quick_match: true,
      visibility: 'invite',
      max_seats: 2,
    });
    const full = (await db.admin.query(`SELECT code FROM spaces WHERE id = $1`, [t.space_id]))
      .rows[0];
    const outsider = await fundedUser(db);
    await expect(spaces.lookup(outsider.id, full.code)).rejects.toEqual(code('space_not_found'));
    await expect(spaces.join(outsider.id, full.code)).rejects.toEqual(code('space_not_found'));
    expect((await spaces.list(a.id)).spaces).toEqual([]);
    expect((await spaces.list(b.id)).spaces).toEqual([]);
    expect(roomCalls).toEqual([]);
  });

  it('both accepting starts the game and puts both in a live space', async () => {
    const { a, b } = await pair();
    await qm.accept(a.id, (await mine(a)).id);
    expect(await mine(a)).toMatchObject({ status: 'found', accepted: true });
    expect(roomCalls).toEqual([]); // waits for the other
    const done = await qm.accept(b.id, (await mine(b)).id);
    expect(done.status).toBe('playing');
    expect(done.spaceId).toBeTruthy();
    expect((await mine(a)).status).toBe('playing');
    const m = await matchOf(done.spaceId!);
    expect(m.status).toBe('active');
    expect(roomCalls).toEqual([m.id]);
    expect((await spaces.list(a.id)).spaces[0]).toMatchObject({ status: 'live', quickMatch: true });
    // a repeat changes nothing
    await qm.accept(b.id, done.id);
    expect(roomCalls).toHaveLength(1);
  });

  it('prefers the closest level and widens to anyone after 15 seconds', async () => {
    const five = await atLevel(5);
    const nine = await atLevel(9);
    await free(five);
    await free(nine);
    expect((await mine(five)).status).toBe('searching'); // 4 apart
    const six = await atLevel(6);
    await free(six);
    expect((await mine(six)).opponent!.userId).toBe(five.id); // 1 apart beats waiting for 9
    expect((await mine(nine)).status).toBe('searching');

    const one = await atLevel(1);
    await free(one);
    expect((await mine(one)).status).toBe('searching');
    advance(16_000);
    await qm.sweep();
    expect((await mine(one)).status).toBe('found');
    expect((await mine(nine)).status).toBe('found');
  });

  it('never pairs different games, modes or stakes', async () => {
    const a = await fundedUser(db);
    const b = await fundedUser(db);
    const c = await fundedUser(db);
    const d = await fundedUser(db);
    await free(a, 'whot');
    await free(b, 'crazy-cards');
    await pool(c, FEE);
    await pool(d, FEE * 2);
    advance(120_000);
    await qm.sweep();
    for (const u of [a, b, c, d])
      expect(['searching', 'expired']).toContain((await mine(u)).status);
    expect((await mine(a)).opponent).toBeNull();
  });

  it('never pairs a blocked pair, in either direction, even after widening', async () => {
    const a = await fundedUser(db);
    const b = await fundedUser(db);
    const c = await fundedUser(db);
    await db.admin.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [
      a.id,
      b.id,
    ]);
    await free(a);
    await free(b);
    advance(20_000);
    await qm.sweep();
    expect((await mine(a)).status).toBe('searching');
    expect((await mine(b)).status).toBe('searching');
    await free(c); // c pairs with one of them, never leaving both stuck
    const statuses = await Promise.all([a, b].map(async (u) => (await mine(u)).status));
    expect(statuses.filter((s) => s === 'found')).toHaveLength(1);
    const reverse = await fundedUser(db);
    const other = await fundedUser(db);
    await db.admin.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [
      other.id,
      reverse.id,
    ]);
    await free(reverse, 'crazy-cards');
    await free(other, 'crazy-cards');
    advance(20_000);
    await qm.sweep();
    expect((await mine(reverse)).status).toBe('searching');
  });

  it('skips disabled accounts', async () => {
    const a = await fundedUser(db);
    const b = await fundedUser(db);
    await free(a);
    await db.admin.query(`UPDATE users SET disabled_at = now() WHERE id = $1`, [a.id]);
    await free(b);
    expect((await mine(b)).status).toBe('searching');
  });

  it('is idempotent for the same search and refuses a different one while searching', async () => {
    const a = await fundedUser(db);
    const first = await free(a);
    expect((await free(a)).id).toBe(first.id);
    await expect(free(a, 'crazy-cards')).rejects.toEqual(code('quick_match_active'));
    await expect(pool(a)).rejects.toEqual(code('quick_match_active'));
    expect((await qm.cancel(a.id, first.id)).status).toBe('cancelled');
    expect((await qm.cancel(a.id, first.id)).status).toBe('cancelled');
    expect((await free(a, 'crazy-cards')).id).not.toBe(first.id);
  });

  it('refuses games that cannot be matched and unknown ones', async () => {
    const a = await fundedUser(db);
    await expect(free(a, 'imposter')).rejects.toEqual(code('quick_match_unavailable'));
    await expect(free(a, 'werewolf')).rejects.toEqual(code('quick_match_unavailable'));
    await expect(free(a, 'chess')).rejects.toEqual(code('game_not_found'));
    const state = await qm.state(a.id);
    expect(state.games.map((g) => g.slug).sort()).toEqual(['crazy-cards', 'whot']);
  });

  it('gives up on a search after a minute', async () => {
    const a = await fundedUser(db);
    const t = await free(a);
    advance(59_000);
    await qm.sweep();
    expect((await mine(a)).status).toBe('searching');
    advance(2_000);
    const r = await qm.sweep();
    expect(r.expired).toBe(1);
    expect((await mine(a)).status).toBe('expired');
    expect(t.id).toBe((await mine(a)).id);
    // and they can search again
    expect((await free(a)).status).toBe('searching');
  });

  it('tells each person about their own ticket as it changes', async () => {
    const { a, b } = await pair();
    const events = published.filter((p) => p.event.type === 'quick_match');
    const forA = events.filter((p) => p.users[0] === a.id);
    const forB = events.filter((p) => p.users[0] === b.id);
    expect(forA.at(-1)!.event).toMatchObject({
      ticket: { status: 'found', opponent: { userId: b.id } },
    });
    expect(forB.at(-1)!.event).toMatchObject({
      ticket: { status: 'found', opponent: { userId: a.id } },
    });
    expect(events.every((p) => p.users.length === 1)).toBe(true);
  });
});

describe('Pool: stakes at the match, refunds when it falls through', () => {
  it('escrows both seat fees the moment the match is found', async () => {
    const { a, b } = await pair({ pool: true });
    expect(await balanceOf(db, a.id)).toBe(GRANT - FEE);
    expect(await balanceOf(db, b.id)).toBe(GRANT - FEE);
    const sp = (
      await db.admin.query(
        `SELECT space_id FROM quick_match_tickets WHERE user_id = $1 AND status = 'found'`,
        [a.id],
      )
    ).rows[0].space_id;
    const m = await matchOf(sp);
    expect(await escrowOf(m.id)).toBe(FEE * 2);
    expect(m.mode).toBe('pool');
    const players = await db.admin.query(
      `SELECT staked_kobo FROM match_players WHERE match_id = $1`,
      [m.id],
    );
    expect(players.rows.map((r) => Number(r.staked_kobo))).toEqual([FEE, FEE]);
  });

  it('a decline gives both stakes back; the other person goes back to searching and pairs with the next', async () => {
    const { a, b } = await pair({ pool: true });
    const ta = await mine(a);
    const declined = await qm.decline(b.id, (await mine(b)).id);
    expect(declined.status).toBe('declined');
    expect(await balanceOf(db, a.id)).toBe(GRANT);
    expect(await balanceOf(db, b.id)).toBe(GRANT);
    const again = await mine(a);
    expect(again).toMatchObject({ id: ta.id, status: 'searching', opponent: null });
    const sp = await db.admin.query(
      `SELECT status FROM matches WHERE status IN ('cancelled') AND mode = 'pool' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(sp.rows[0].status).toBe('cancelled');

    const c = await fundedUser(db);
    await pool(c);
    expect((await mine(a)).status).toBe('found');
    expect((await mine(a)).opponent!.userId).toBe(c.id);
    expect(await balanceOf(db, a.id)).toBe(GRANT - FEE);
    expect(await balanceOf(db, b.id)).toBe(GRANT); // the one who walked away is not matched again
  });

  it('nobody accepting in time refunds both and marks both missed', async () => {
    const { a, b } = await pair({ pool: true });
    advance(10_000);
    expect((await qm.sweep()).missed).toBe(0); // inside the 3 s grace
    advance(4_000);
    const r = await qm.sweep();
    expect(r.missed).toBe(1);
    expect((await mine(a)).status).toBe('missed');
    expect((await mine(b)).status).toBe('missed');
    expect(await balanceOf(db, a.id)).toBe(GRANT);
    expect(await balanceOf(db, b.id)).toBe(GRANT);
    await expect(qm.accept(a.id, (await mine(a)).id)).rejects.toEqual(code('quick_match_expired'));
  });

  it('one accepted and one did not: the one who missed is out, the other searches on, refunded', async () => {
    const { a, b } = await pair({ pool: true });
    const accepted = await qm.accept(a.id, (await mine(a)).id);
    expect(accepted.accepted).toBe(true);
    advance(14_000);
    await qm.sweep();
    expect((await mine(b)).status).toBe('missed');
    expect((await mine(a)).status).toBe('searching');
    expect(await balanceOf(db, a.id)).toBe(GRANT);
    expect(await balanceOf(db, b.id)).toBe(GRANT);
  });

  it('accepting after the window is refused', async () => {
    const { a } = await pair({ pool: true });
    advance(14_000);
    await expect(qm.accept(a.id, (await mine(a)).id)).rejects.toEqual(code('quick_match_expired'));
  });

  it('a stake that cannot be taken drops only that person; the other waits for the next', async () => {
    const a = await fundedUser(db);
    const b = await fundedUser(db);
    const c = await fundedUser(db);
    await pool(a);
    await setBalance(db, a.id, FEE - 1); // spent it since searching
    await pool(b);
    expect(await mine(a)).toMatchObject({ status: 'failed', errorCode: 'insufficient_funds' });
    expect((await mine(b)).status).toBe('searching');
    expect(await balanceOf(db, b.id)).toBe(GRANT);
    expect(await balanceOf(db, a.id)).toBe(FEE - 1);
    await pool(c);
    expect((await mine(b)).opponent!.userId).toBe(c.id);
  });

  it('refuses a search that could never be paired: not enough cash, under 18, bad stake', async () => {
    const poor = await fundedUser(db);
    await setBalance(db, poor.id, FEE - 1);
    await expect(pool(poor)).rejects.toMatchObject({ code: 'insufficient_funds' });
    const minor = await fundedUser(db, { adult: false });
    await expect(pool(minor)).rejects.toMatchObject({ code: 'adult_required' });
    const ok = await fundedUser(db);
    await expect(pool(ok, 1)).rejects.toEqual(code('invalid_stake'));
    await expect(pool(ok, 999_999_999)).rejects.toEqual(code('invalid_stake'));
    // a minor can still quick match for fun
    expect((await free(minor)).status).toBe('searching');
  });

  it('a played match settles the pot to the winner', async () => {
    const { a, b } = await pair({ pool: true });
    await qm.accept(a.id, (await mine(a)).id);
    const playing = await qm.accept(b.id, (await mine(b)).id);
    const m = await matchOf(playing.spaceId!);
    await db.admin.query(
      `UPDATE match_players SET placement = CASE WHEN user_id = $2 THEN 1 ELSE 2 END WHERE match_id = $1`,
      [m.id, a.id],
    );
    await db.app.query(`SELECT settle_match($1)`, [m.id]);
    expect(await balanceOf(db, a.id)).toBe(GRANT + FEE);
    expect(await balanceOf(db, b.id)).toBe(GRANT - FEE);
  });
});

describe('limits', () => {
  it('caps searches per hour', async () => {
    await setConfig(db, 'quick_match_per_hour', 3);
    const a = await fundedUser(db);
    for (let i = 0; i < 3; i++) {
      const t = await free(a);
      await qm.cancel(a.id, t.id);
    }
    await expect(free(a)).rejects.toEqual(code('quick_match_rate_limited'));
    advance(3_600_000 + 1_000);
    expect((await free(a)).status).toBe('searching');
  });

  it('asks someone who keeps walking away from found matches to wait', async () => {
    const quitter = await fundedUser(db);
    for (let i = 0; i < 3; i++) {
      const other = await fundedUser(db);
      // nobody else is waiting: the quitter is paired with exactly this person
      await db.admin.query(
        `UPDATE quick_match_tickets SET status = 'cancelled'
          WHERE status IN ('searching', 'found') AND user_id <> $1`,
        [quitter.id],
      );
      await free(quitter);
      await free(other);
      expect((await mine(quitter)).status).toBe('found');
      expect((await qm.decline(quitter.id, (await mine(quitter)).id)).status).toBe('declined');
    }
    await expect(free(quitter)).rejects.toEqual(code('quick_match_cooldown'));
    advance(11 * 60_000);
    expect((await free(quitter)).status).toBe('searching');
  });

  it('does not pair the same two people again within ten minutes', async () => {
    const { a, b } = await pair();
    await qm.accept(a.id, (await mine(a)).id);
    await qm.accept(b.id, (await mine(b)).id);
    expect((await mine(a)).status).toBe('playing');
    advance(1_000);
    await db.admin.query(
      `UPDATE quick_match_tickets SET status = 'cancelled' WHERE user_id IN ($1, $2)`,
      [a.id, b.id],
    );
    await free(a);
    await free(b);
    advance(30_000);
    await qm.sweep();
    expect((await mine(a)).status).toBe('searching'); // wants someone else
    advance(11 * 60_000);
    await qm.sweep();
    expect((await mine(a)).status).toBe('expired'); // search window passed meanwhile
    await free(a);
    await free(b);
    expect((await mine(a)).status).toBe('found');
  });

  it('two people who already hold five open spaces are not matched', async () => {
    const a = await fundedUser(db);
    const b = await fundedUser(db);
    await db.admin.query(
      `INSERT INTO app_config (key, value) VALUES ('spaces_open_per_user', '0') ON CONFLICT (key) DO UPDATE SET value = '0'`,
    );
    await free(a);
    await free(b);
    expect(await mine(b)).toMatchObject({ status: 'failed', errorCode: 'spaces_limit' });
    await db.admin.query(`UPDATE app_config SET value = '5' WHERE key = 'spaces_open_per_user'`);
  });
});

describe('strangers stay strangers', () => {
  it('makes no conversation and no friendship; a message afterwards lands in Requests', async () => {
    const { a, b } = await pair();
    await qm.accept(a.id, (await mine(a)).id);
    await qm.accept(b.id, (await mine(b)).id);
    const convs = await db.admin.query(
      `SELECT count(*)::int AS n FROM conversation_members cm JOIN conversation_members o ON o.conversation_id = cm.conversation_id
        WHERE cm.user_id = $1 AND o.user_id = $2`,
      [a.id, b.id],
    );
    expect(convs.rows[0].n).toBe(0);
    const friends = await db.admin.query(
      `SELECT count(*)::int AS n FROM friendships WHERE user_low = LEAST($1::uuid, $2::uuid) AND user_high = GREATEST($1::uuid, $2::uuid)`,
      [a.id, b.id],
    );
    expect(friends.rows[0].n).toBe(0);
    expect((await chat.list(a.id)).conversations).toEqual([]);
    expect((await chat.list(b.id)).conversations).toEqual([]);

    // later, one of them writes: it is a request, never a chat
    const conv = await chat.openDirect(a.id, b.id);
    await chat.send(a.id, conv.id, { id: randomUUID(), body: 'gg, again?' });
    expect((await chat.list(b.id, 'all')).conversations).toEqual([]);
    const reqs = await chat.list(b.id, 'requests');
    expect(reqs.conversations).toHaveLength(1);
    expect(reqs.conversations[0]).toMatchObject({ state: 'request', peer: { id: a.id } });
  });
});

describe('under load', () => {
  it('twenty people searching at once end up in ten pairs, nobody twice', async () => {
    const users = await Promise.all(Array.from({ length: 20 }, () => fundedUser(db)));
    await Promise.all(users.map((u) => free(u, 'crazy-cards')));
    for (let i = 0; i < 6; i++) await qm.sweep();
    const tickets = await Promise.all(users.map((u) => mine(u)));
    expect(tickets.every((t) => t.status === 'found')).toBe(true);
    const bySpace = new Map<string, string[]>();
    for (const u of users) {
      const row = (
        await db.admin.query(
          `SELECT space_id FROM quick_match_tickets WHERE user_id = $1 AND status = 'found'`,
          [u.id],
        )
      ).rows[0];
      bySpace.set(row.space_id, [...(bySpace.get(row.space_id) ?? []), u.id]);
    }
    expect(bySpace.size).toBe(10);
    expect([...bySpace.values()].every((m) => m.length === 2)).toBe(true);
    const open = await db.admin.query(
      `SELECT count(*)::int AS n FROM space_members sm JOIN spaces s ON s.id = sm.space_id WHERE s.quick_match AND s.status = 'waiting' AND sm.user_id = ANY($1::uuid[])`,
      [users.map((u) => u.id)],
    );
    expect(open.rows[0].n).toBe(20);
  });

  it('twenty people searching for Pool at once: every stake is in one escrow, exactly', async () => {
    const users = await Promise.all(Array.from({ length: 20 }, () => fundedUser(db)));
    await Promise.all(users.map((u) => pool(u, FEE, 'crazy-cards')));
    for (let i = 0; i < 6; i++) await qm.sweep();
    let escrow = 0;
    const spacesSeen = new Set<string>();
    for (const u of users) {
      expect(await balanceOf(db, u.id)).toBe(GRANT - FEE);
      const row = (
        await db.admin.query(
          `SELECT space_id FROM quick_match_tickets WHERE user_id = $1 AND status = 'found'`,
          [u.id],
        )
      ).rows[0];
      if (!spacesSeen.has(row.space_id)) {
        spacesSeen.add(row.space_id);
        escrow += await escrowOf((await matchOf(row.space_id)).id);
      }
    }
    expect(escrow).toBe(FEE * 20);
  });

  it('both people accepting at the same instant starts the game once', async () => {
    const { a, b } = await pair();
    const [ta, tb] = [await mine(a), await mine(b)];
    await Promise.all([qm.accept(a.id, ta.id), qm.accept(b.id, tb.id)]);
    expect((await mine(a)).status).toBe('playing');
    expect((await mine(b)).status).toBe('playing');
    expect(roomCalls).toHaveLength(1);
    const m = await db.admin.query(
      `SELECT count(*)::int AS n FROM matches WHERE space_id = (SELECT space_id FROM quick_match_tickets WHERE id = $1)`,
      [ta.id],
    );
    expect(m.rows[0].n).toBe(1);
  });

  it('accept racing with a decline leaves one consistent outcome', async () => {
    const { a, b } = await pair({ pool: true });
    const [ta, tb] = [await mine(a), await mine(b)];
    const r = await Promise.allSettled([qm.accept(a.id, ta.id), qm.decline(b.id, tb.id)]);
    expect(r.some((x) => x.status === 'rejected' && !(x.reason as { code?: string }).code)).toBe(
      false,
    );
    const sa = (await mine(a)).status;
    const sb = (await mine(b)).status;
    expect(sb).toBe('declined');
    expect(['searching', 'found']).toContain(sa);
    // money is where it should be: refunded, or (if the accept won the race to nothing) still escrowed in a found match
    if (sa === 'searching') {
      expect(await balanceOf(db, a.id)).toBe(GRANT);
      expect(await balanceOf(db, b.id)).toBe(GRANT);
    }
  });
});

describe('a crash between accepting and starting', () => {
  it('the sweep starts a match whose two people both accepted', async () => {
    const { a, b } = await pair();
    // simulate the process dying right after both accepted: tickets say accepted, the space never started
    await db.admin.query(
      `UPDATE quick_match_tickets SET accepted_at = $2 WHERE user_id IN ($1, $3) AND status = 'found'`,
      [a.id, new Date(clock.t), b.id],
    );
    advance(14_000);
    const r = await qm.sweep();
    expect(r.restarted).toBe(1);
    expect((await mine(a)).status).toBe('playing');
    expect(roomCalls).toHaveLength(1);
  });
});
