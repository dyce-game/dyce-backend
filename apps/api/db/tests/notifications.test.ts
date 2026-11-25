import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RealtimeEvent } from '@dyce/shared';
import { MessagesService } from '../../src/chat/messages.service.ts';
import type { AnyEngine, EngineEntry } from '../../src/matches/engines.ts';
import { MatchesService } from '../../src/matches/matches.service.ts';
import { ConsolePushDriver } from '../../src/notifications/console-push.driver.ts';
import { NotificationsService } from '../../src/notifications/notifications.service.ts';
import { PushDispatcher } from '../../src/notifications/push-dispatcher.ts';
import type { PushDriver, PushMessage } from '../../src/notifications/push-driver.ts';
import { FriendsService } from '../../src/social/friends.service.ts';
import { createTestDb, createUser, type TestDb, type TestUser } from '../testing/testDb.ts';
import { fundedUser } from './helpers.ts';

/** Notifications (ADR-023): the triggers that create them, the list, preferences, devices and the push queue. */
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
    return { placements: [[st.winner!], [st.players.find((p) => p !== st.winner)!]], draw: false };
  },
  view: (s) => s,
};
const ENGINES: Record<string, EngineEntry> = { test_race: { engine: raceEngine, cfg: {} } };

const STAKE = 100_000;
const T0 = new Date('2026-11-14T10:00:00Z').getTime();
const clock = { t: T0 };
const now = () => new Date((clock.t += 1000));
const add = (n: number) => ({ kind: 'add', n });

let db: TestDb;
let chat: MessagesService;
let friends: FriendsService;
let matches: MatchesService;
let notifs: NotificationsService;
const published: { users: readonly string[]; event: RealtimeEvent }[] = [];
const publisher = {
  publish: (users: readonly string[], event: RealtimeEvent) =>
    void published.push({ users, event }),
};

beforeAll(async () => {
  db = await createTestDb();
  await db.admin.query(
    `INSERT INTO games (slug, name, dimension, sync, min_players, max_players, supports_pool, enabled)
     VALUES ('test_race', 'Race', '2d', 'async', 2, 2, true, true)`,
  );
  chat = new MessagesService(db.app, publisher, now);
  friends = new FriendsService(db.app, now);
  matches = new MatchesService(db.app, publisher, chat, now, {
    allowDevGames: true,
    engines: ENGINES,
  });
  notifs = new NotificationsService(db.app);
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  clock.t = T0;
  published.length = 0;
});

const list = async (u: TestUser, filter: 'all' | 'turn' | 'pool' = 'all') =>
  (await notifs.list(u.id, { filter, limit: 50 })).items;
const kinds = async (u: TestUser) => (await list(u)).map((i) => i.kind).sort();
const unread = async (u: TestUser) => (await notifs.unread(u.id)).unread;

async function pair(funded = false) {
  const a = funded ? await fundedUser(db) : await createUser(db);
  const b = funded ? await fundedUser(db) : await createUser(db);
  await friends.sendRequest(a.id, b.id);
  await friends.accept(b.id, a.id);
  const conv = (await chat.openDirect(a.id, b.id)).id;
  return { a, b, conv };
}
const sendFree = (from: TestUser, conv: string) =>
  matches.create(from.id, {
    id: randomUUID(),
    conversationId: conv,
    gameSlug: 'test_race',
    mode: 'free',
  });
const sendPool = (from: TestUser, conv: string) =>
  matches.create(from.id, {
    id: randomUUID(),
    conversationId: conv,
    gameSlug: 'test_race',
    mode: 'pool',
    stakeKobo: STAKE,
    allowCounter: true,
  });

describe('friends', () => {
  it('tells the recipient of a request, then the requester when it is accepted', async () => {
    const a = await createUser(db);
    const b = await createUser(db);
    await friends.sendRequest(a.id, b.id);
    const [req] = await list(b);
    expect(req).toMatchObject({
      kind: 'friend_request',
      read: false,
      actor: { id: a.id, username: a.username },
    });
    expect(await kinds(a)).toEqual([]);
    await friends.accept(b.id, a.id);
    expect((await list(b))[0]!.read).toBe(true); // answered: no longer waiting
    expect(await kinds(a)).toEqual(['friend_accepted']);
  });

  it('removes the notification when the request is withdrawn', async () => {
    const a = await createUser(db);
    const b = await createUser(db);
    await friends.sendRequest(a.id, b.id);
    await friends.cancel(a.id, b.id);
    expect(await kinds(b)).toEqual([]);
  });

  it('says nothing about a request from someone who is blocked', async () => {
    const a = await createUser(db);
    const b = await createUser(db);
    await db.app.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [b.id, a.id]);
    const [lo, hi] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
    await db.admin.query(
      `INSERT INTO friendships (user_low, user_high, status, requested_by) VALUES ($1, $2, 'pending', $3)`,
      [lo, hi, a.id],
    );
    expect(await kinds(b)).toEqual([]);
  });

  it('hides what a person caused once you block them, and does not count it', async () => {
    const a = await createUser(db);
    const b = await createUser(db);
    await friends.sendRequest(a.id, b.id);
    expect(await unread(b)).toBe(1);
    await db.app.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [b.id, a.id]);
    expect(await kinds(b)).toEqual([]);
    expect(await unread(b)).toBe(0);
  });
});

describe('Free games', () => {
  it('walks invite, accepted, your turn, result, and keeps one live "your turn" per match', async () => {
    const { a, b, conv } = await pair();
    const m = await sendFree(a, conv);
    expect((await list(b))[0]).toMatchObject({
      kind: 'game_invite',
      payload: { matchId: m.id, gameName: 'Race', mode: 'free' },
    });
    expect(await kinds(a)).toEqual(['friend_accepted']);

    await matches.accept(b.id, m.id);
    expect((await list(b)).find((i) => i.kind === 'game_invite')!.read).toBe(true);
    const accepted = (await list(a)).find((i) => i.kind === 'game_accepted')!;
    expect(accepted.payload).toMatchObject({ yourTurn: true });
    expect(accepted.actor!.id).toBe(b.id);

    await matches.submitMove(a.id, m.id, { expectedVersion: 0, action: add(3) });
    const turn = (await list(b)).filter((i) => i.kind === 'your_turn');
    expect(turn).toHaveLength(1);
    expect(turn[0]).toMatchObject({ read: false, actor: { id: a.id }, payload: { matchId: m.id } });

    await matches.submitMove(b.id, m.id, { expectedVersion: 1, action: add(1) });
    expect((await list(b)).filter((i) => i.kind === 'your_turn')[0]!.read).toBe(true); // b has moved
    expect((await list(a)).filter((i) => i.kind === 'your_turn' && !i.read)).toHaveLength(1);

    await matches.submitMove(a.id, m.id, { expectedVersion: 2, action: add(1) });
    const resultA = (await list(a)).find((i) => i.kind === 'game_result')!;
    const resultB = (await list(b)).find((i) => i.kind === 'game_result')!;
    expect(resultA.payload).toMatchObject({ result: 'win', mode: 'free' });
    expect(resultA.payload.xp).toBe(30);
    expect(resultB.payload).toMatchObject({ result: 'loss' });
    expect(resultB.payload.xp).toBe(15);
    expect((await list(a)).filter((i) => i.kind === 'your_turn' && !i.read)).toHaveLength(0);
    // one row per match, however many turns it took
    expect((await list(a)).filter((i) => i.kind === 'your_turn')).toHaveLength(1);
    expect((await list(b)).filter((i) => i.kind === 'your_turn')).toHaveLength(1);
  });
});

describe('Pool games', () => {
  it('tells the invitee the stake, the creator about a counter-offer, and refunds on a decline', async () => {
    const { a, b, conv } = await pair(true);
    const m = await sendPool(a, conv);
    expect((await list(b)).find((i) => i.kind === 'game_invite')!.payload).toMatchObject({
      mode: 'pool',
      stakeKobo: STAKE,
    });
    await matches.counter(b.id, m.id, { stakeKobo: STAKE / 2 });
    expect((await list(a)).find((i) => i.kind === 'pool_countered')!.payload).toMatchObject({
      counterStakeKobo: STAKE / 2,
      stakeKobo: STAKE,
    });
    await matches.decline(a.id, m.id);
    const refund = (await list(a)).find((i) => i.kind === 'pool_refunded')!;
    expect(refund.payload).toMatchObject({ reason: 'cancelled' });
    expect(refund.payload.amountKobo).toBeGreaterThan(0);
  });

  it('tells the creator when an unanswered invite expires and refunds', async () => {
    const { a, conv } = await pair(true);
    await sendPool(a, conv);
    clock.t += 25 * 3_600_000;
    await matches.expireStaleInvites();
    expect((await list(a)).find((i) => i.kind === 'pool_refunded')!.payload).toMatchObject({
      reason: 'expired',
      amountKobo: STAKE,
    });
  });

  it('sends each player a pool_result with what they got', async () => {
    const { a, b, conv } = await pair(true);
    const m = await sendPool(a, conv);
    await matches.accept(b.id, m.id);
    await matches.submitMove(a.id, m.id, { expectedVersion: 0, action: add(3) });
    await matches.submitMove(b.id, m.id, { expectedVersion: 1, action: add(1) });
    await matches.submitMove(a.id, m.id, { expectedVersion: 2, action: add(1) });
    expect((await list(a)).find((i) => i.kind === 'pool_result')!.payload).toMatchObject({
      result: 'win',
      payoutKobo: 2 * STAKE,
    });
    expect((await list(b)).find((i) => i.kind === 'pool_result')!.payload).toMatchObject({
      result: 'loss',
      payoutKobo: 0,
    });
    expect((await list(a, 'pool')).map((i) => i.kind)).toContain('pool_result');
    expect((await list(a, 'turn')).map((i) => i.kind)).not.toContain('pool_result');
  });
});

describe('money', () => {
  it('tells the receiver of a transfer, once even if the call is retried', async () => {
    const a = await fundedUser(db);
    const b = await fundedUser(db);
    const key = `n:${randomUUID()}`;
    await db.app.query('SELECT transfer($1, $2, 250000, $3, $4)', [a.id, b.id, 'lunch', key]);
    await db.app.query('SELECT transfer($1, $2, 250000, $3, $4)', [a.id, b.id, 'lunch', key]);
    const got = (await list(b)).filter((i) => i.kind === 'money_received');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      actor: { id: a.id },
      payload: { amountKobo: 250000, viaRequest: false },
    });
    expect(await kinds(a)).toEqual([]);
  });

  it('tells a friend about a request addressed to them, and the requester when it is paid', async () => {
    const { a, b } = await pair(true);
    const req = await db.app.query<{ code: string }>(
      'SELECT * FROM create_payment_request($1, 300000, $2, $3, 60)',
      [a.id, 'tickets', b.id],
    );
    const code = req.rows[0]!.code;
    const asked = (await list(b)).find((i) => i.kind === 'money_requested')!;
    expect(asked.payload).toMatchObject({ code, amountKobo: 300000 });
    await db.app.query('SELECT pay_payment_request($1, $2, NULL, $3)', [code, b.id, `pay:${code}`]);
    expect((await list(b)).find((i) => i.kind === 'money_requested')!.read).toBe(true);
    expect((await list(a)).find((i) => i.kind === 'money_received')!.payload).toMatchObject({
      amountKobo: 300000,
      viaRequest: true,
    });
  });

  it('does not notify a stranger about a money request', async () => {
    const a = await fundedUser(db);
    const c = await fundedUser(db);
    await db.app.query('SELECT * FROM create_payment_request($1, 100000, $2, $3, 60)', [
      a.id,
      'hi',
      c.id,
    ]);
    expect(await kinds(c)).toEqual([]);
  });
});

describe('spaces', () => {
  it('tells everyone seated except the host when the space starts', async () => {
    const host = await createUser(db);
    const p2 = await createUser(db);
    const p3 = await createUser(db);
    const id = randomUUID();
    await db.admin.query(
      `INSERT INTO spaces (id, code, name, host_id, game_slug, max_seats) VALUES ($1, 'DY-4821', 'Friday night', $2, 'test_race', 4)`,
      [id, host.id],
    );
    for (const [i, u] of [host, p2, p3].entries()) {
      await db.admin.query(
        'INSERT INTO space_members (space_id, user_id, seat) VALUES ($1, $2, $3)',
        [id, u.id, i + 1],
      );
    }
    await db.admin.query(`UPDATE spaces SET status = 'live' WHERE id = $1`, [id]);
    expect(await kinds(host)).toEqual([]);
    expect((await list(p2))[0]).toMatchObject({
      kind: 'space_starting',
      actor: { id: host.id },
      payload: { spaceId: id, code: 'DY-4821', name: 'Friday night' },
    });
    await db.admin.query(`UPDATE spaces SET status = 'closed' WHERE id = $1`, [id]);
    expect((await list(p2))[0]!.read).toBe(true);
  });
});

describe('the list', () => {
  it('pages newest first without gaps or repeats, and filters', async () => {
    const me = await createUser(db);
    const senders: TestUser[] = [];
    for (let i = 0; i < 5; i++) {
      const s = await createUser(db);
      senders.push(s);
      await friends.sendRequest(s.id, me.id);
    }
    const seen: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 3; page++) {
      const r = await notifs.list(me.id, { filter: 'all', limit: 2, before });
      seen.push(...r.items.map((i) => i.id));
      expect(r.unread).toBe(5);
      before = r.nextCursor ?? undefined;
      if (!before) break;
    }
    expect(new Set(seen).size).toBe(5);
    expect(seen).toHaveLength(5);
    const created = (await list(me)).map((i) => i.createdAt);
    expect([...created].sort().reverse()).toEqual(created);
    expect(await list(me, 'pool')).toEqual([]);
    await expect(
      notifs.list(me.id, { filter: 'all', limit: 5, before: 'nonsense' }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('marks some or all as read, and ignores other people’s ids', async () => {
    const me = await createUser(db);
    const other = await createUser(db);
    const x = await createUser(db);
    const y = await createUser(db);
    await friends.sendRequest(x.id, me.id);
    await friends.sendRequest(y.id, me.id);
    await friends.sendRequest(x.id, other.id);
    const mine = await list(me);
    const theirs = await list(other);
    expect(await notifs.markRead(me.id, { ids: [mine[0]!.id, theirs[0]!.id] })).toEqual({
      unread: 1,
    });
    expect(await unread(other)).toBe(1); // untouched
    expect(await notifs.markRead(me.id, { all: true })).toEqual({ unread: 0 });
  });
});

describe('preferences', () => {
  it('starts with everything on and merges patches', async () => {
    const u = await createUser(db);
    expect(await notifs.getPrefs(u.id)).toEqual({
      groups: { turns: true, invites: true, pool: true, money: true, spaces: true },
      quietHours: { enabled: false, startMinute: 1320, endMinute: 420 },
      tzOffsetMin: 60,
    });
    await notifs.updatePrefs(u.id, { groups: { turns: false } });
    await notifs.updatePrefs(u.id, {
      groups: { money: false },
      quietHours: { enabled: true },
      tzOffsetMin: -300,
    });
    const p = await notifs.getPrefs(u.id);
    expect(p.groups).toEqual({
      turns: false,
      invites: true,
      pool: true,
      money: false,
      spaces: true,
    });
    expect(p.quietHours).toEqual({ enabled: true, startMinute: 1320, endMinute: 420 });
    expect(p.tzOffsetMin).toBe(-300);
    await notifs.updatePrefs(u.id, { groups: { turns: true } });
    expect((await notifs.getPrefs(u.id)).groups.turns).toBe(true);
  });
});

describe('devices', () => {
  const tok = (n: string) => `ExponentPushToken[${n.padEnd(10, 'x')}]`;

  it('moves a token to the person who signs in on that phone, and removes only your own', async () => {
    const a = await createUser(db);
    const b = await createUser(db);
    await notifs.registerToken(a.id, { token: tok('moveme'), platform: 'ios' });
    await notifs.registerToken(b.id, { token: tok('moveme'), platform: 'ios' });
    const owner = async () =>
      (
        await db.admin.query('SELECT user_id FROM push_tokens WHERE token = $1', [tok('moveme')])
      ).rows.map((r) => r.user_id);
    expect(await owner()).toEqual([b.id]);
    await notifs.removeToken(a.id, tok('moveme'));
    expect(await owner()).toEqual([b.id]);
    await notifs.removeToken(b.id, tok('moveme'));
    expect(await owner()).toEqual([]);
  });

  it('keeps at most 10 devices per person (the newest)', async () => {
    const a = await createUser(db);
    for (let i = 0; i < 12; i++) {
      await notifs.registerToken(a.id, { token: tok(`dev${i}`), platform: 'android' });
      await db.admin.query(
        `UPDATE push_tokens SET updated_at = now() - ($2 || ' seconds')::interval WHERE token = $1`,
        [tok(`dev${i}`), String(100 - i)],
      );
    }
    const left = await db.admin.query('SELECT token FROM push_tokens WHERE user_id = $1', [a.id]);
    expect(left.rowCount).toBeLessThanOrEqual(11);
    expect(left.rows.map((r) => r.token)).toContain(tok('dev11'));
  });
});

describe('the push dispatcher', () => {
  const token = (u: TestUser) => `ExponentPushToken[${u.id.slice(0, 12)}]`;
  beforeEach(async () => {
    await db.admin.query(
      `UPDATE notifications SET dispatched_at = now() WHERE dispatched_at IS NULL`,
    );
  });
  const fresh = (driver: PushDriver, at = new Date(T0 + 60_000)) =>
    new PushDispatcher(db.app, driver, publisher, () => at);

  /** A user with a device and one pending notification (a friend request). */
  async function pending(opts: { device?: boolean } = {}) {
    const me = await createUser(db);
    const x = await createUser(db);
    if (opts.device !== false)
      await notifs.registerToken(me.id, { token: token(me), platform: 'ios' });
    await friends.sendRequest(x.id, me.id);
    await db.admin.query(`UPDATE notifications SET created_at = $1 WHERE user_id = $2`, [
      new Date(T0 + 30_000),
      me.id,
    ]);
    return { me, x };
  }

  it('sends the words, the route and the unread count to every device, once', async () => {
    const { me, x } = await pending();
    const driver = new ConsolePushDriver(() => undefined);
    const run = await fresh(driver).dispatchPending();
    expect(run).toMatchObject({ sent: 1, skipped: 0, failed: 0 });
    expect(driver.sent[0]).toMatchObject({
      to: token(me),
      title: `${x.username} wants to be friends`,
      data: { kind: 'friend_request', route: '/friends' },
      badge: 1,
    });
    expect(await fresh(driver).dispatchPending()).toMatchObject({ handled: 0 });
    expect(driver.sent).toHaveLength(1);
  });

  it('also tells an open app, whether or not a push was sent', async () => {
    const { me } = await pending({ device: false });
    published.length = 0;
    const driver = new ConsolePushDriver(() => undefined);
    const run = await fresh(driver).dispatchPending();
    expect(run.skipped).toBe(1);
    expect(driver.sent).toHaveLength(0);
    expect(published.some((p) => p.users.includes(me.id) && p.event.type === 'notification')).toBe(
      true,
    );
  });

  it('skips a switched-off group, quiet hours, kinds that are never pushed and stale ones', async () => {
    const off = await pending();
    await notifs.updatePrefs(off.me.id, { groups: { invites: false } });
    const quiet = await pending();
    await notifs.updatePrefs(quiet.me.id, {
      quietHours: { enabled: true, startMinute: 11 * 60, endMinute: 13 * 60 },
      tzOffsetMin: 0,
    });
    const stale = await pending();
    await db.admin.query(`UPDATE notifications SET created_at = $1 WHERE user_id = $2`, [
      new Date(T0 - 7 * 3_600_000),
      stale.me.id,
    ]);
    const never = await createUser(db);
    await notifs.registerToken(never.id, { token: token(never), platform: 'ios' });
    await db.admin.query(
      `INSERT INTO notifications (user_id, kind, payload, created_at) VALUES ($1, 'level_up', '{"level":3}', $2)`,
      [never.id, new Date(T0 + 30_000)],
    );
    const driver = new ConsolePushDriver(() => undefined);
    // 11:30 UTC is inside the quiet window only for `quiet`
    const run = await fresh(driver, new Date('2026-11-14T11:30:00Z')).dispatchPending();
    expect(run).toMatchObject({ sent: 0, skipped: 4 });
    expect(driver.sent).toHaveLength(0);
  });

  it('deletes a token the service says is dead', async () => {
    const { me } = await pending();
    const dead: PushDriver = {
      send: (m) =>
        Promise.resolve(
          m.map(() => ({
            ok: false,
            error: 'DeviceNotRegistered',
            invalidToken: true,
            retry: false,
          })),
        ),
    };
    await fresh(dead).dispatchPending();
    expect(
      (await db.admin.query('SELECT 1 FROM push_tokens WHERE user_id = $1', [me.id])).rowCount,
    ).toBe(0);
  });

  it('retries a failed send, then gives up after three tries', async () => {
    const { me } = await pending();
    let calls = 0;
    const flaky: PushDriver = {
      send: (m: PushMessage[]) => {
        calls++;
        return Promise.resolve(
          m.map(() => ({ ok: false, error: 'network', invalidToken: false, retry: true })),
        );
      },
    };
    const d = fresh(flaky);
    expect(await d.dispatchPending()).toMatchObject({ failed: 1, handled: 0 });
    expect(await d.dispatchPending()).toMatchObject({ failed: 1, handled: 0 });
    expect(await d.dispatchPending()).toMatchObject({ failed: 1, handled: 1 });
    expect(await d.dispatchPending()).toMatchObject({ handled: 0 });
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(await unread(me)).toBe(1); // still in the list
  });

  it('two dispatchers running at once send each notification once', async () => {
    for (let i = 0; i < 6; i++) await pending();
    const driver = new ConsolePushDriver(() => undefined);
    const [r1, r2] = await Promise.all([
      fresh(driver).dispatchPending(),
      fresh(driver).dispatchPending(),
    ]);
    expect(r1.sent + r2.sent).toBe(6);
    expect(
      new Set(driver.sent.map((m) => (m.data as { notificationId: string }).notificationId)).size,
    ).toBe(6);
  });
});
