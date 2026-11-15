import { randomUUID } from 'node:crypto';
import type { RealtimeEvent, SpaceView } from '@dyce/shared';
import type { GameRooms } from '../../src/spaces/spaces.service.ts';
import { SpacesService } from '../../src/spaces/spaces.service.ts';
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
 * Spaces (ADR-018) on real PostgreSQL: lobby rules, seat fees in Pool (stake on sitting down, back on
 * leaving, removal, closing and expiry), starting, and the ledger staying balanced through all of it.
 */
const NAIRA = 100;
const GRANT = 200_000 * NAIRA;
const FEE = 500 * NAIRA;
const T0 = new Date('2026-11-14T10:00:00Z').getTime();
const clock = { t: T0 };
const now = () => new Date((clock.t += 1000));

let db: TestDb;
let friends: FriendsService;
let spaces: SpacesService;
const published: { users: readonly string[]; event: RealtimeEvent }[] = [];
const roomCalls: string[] = [];
const rooms: GameRooms & { fail: boolean } = {
  publicUrl: 'ws://game.test',
  fail: false,
  async ensureRoom(matchId) {
    roomCalls.push(matchId);
    if (rooms.fail) throw new Error('down');
    return { roomId: `room-${matchId}` };
  },
};

beforeAll(async () => {
  db = await createTestDb();
  friends = new FriendsService(db.app, now);
  spaces = new SpacesService(
    db.app,
    { publish: (users, event) => void published.push({ users, event }) },
    rooms,
    now,
  );
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  clock.t = T0;
  published.length = 0;
  roomCalls.length = 0;
  rooms.fail = false;
});
afterEach(async () => {
  await expectLedgerClean(db);
});

const code = (c: string) => expect.objectContaining({ code: c });

async function befriend(a: TestUser, b: TestUser) {
  await friends.sendRequest(a.id, b.id);
  await friends.accept(b.id, a.id);
}

type Opts = Partial<Parameters<SpacesService['create']>[1]>;
const make = (host: TestUser, o: Opts = {}) =>
  spaces.create(host.id, {
    id: randomUUID(),
    gameSlug: 'whot',
    name: 'Game night',
    maxSeats: 4,
    visibility: 'friends',
    startRule: 'host',
    ...o,
  });
const makePool = (host: TestUser, o: Opts = {}) =>
  make(host, { mode: 'pool', seatFeeKobo: FEE, ...o });

/** A host plus n friends. */
async function group(n: number) {
  const host = await fundedUser(db);
  const others: TestUser[] = [];
  for (let i = 0; i < n; i++) {
    const u = await fundedUser(db);
    await befriend(host, u);
    others.push(u);
  }
  return { host, others };
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

describe('creating a space', () => {
  it('seats the host, makes a readable code and a waiting match', async () => {
    const { host } = await group(0);
    const s = await make(host, { name: '  Sunday  ' });
    expect(s).toMatchObject({
      name: 'Sunday',
      gameSlug: 'whot',
      mode: 'free',
      status: 'waiting',
      maxSeats: 4,
      minSeats: 2,
      seated: true,
      hosting: true,
      potKobo: 0,
    });
    expect(s.code).toMatch(/^DY-[2-9A-HJ-NP-Z]{4}$/);
    expect(s.members.map((m) => [m.userId, m.seat, m.isHost])).toEqual([[host.id, 1, true]]);
    const m = await db.admin.query(`SELECT status, space_id, mode FROM matches WHERE id = $1`, [
      s.matchId,
    ]);
    expect(m.rows[0]).toMatchObject({ status: 'invited', space_id: s.id, mode: 'free' });
  });

  it('is idempotent on the space id and refuses someone else reusing it', async () => {
    const { host, others } = await group(1);
    const id = randomUUID();
    const a = await make(host, { id });
    const b = await make(host, { id });
    expect(b.id).toBe(a.id);
    expect(b.code).toBe(a.code);
    expect(
      (await db.admin.query(`SELECT count(*)::int n FROM spaces WHERE id = $1`, [id])).rows[0].n,
    ).toBe(1);
    await expect(make(others[0]!, { id })).rejects.toMatchObject(code('space_id_taken'));
  });

  it('checks the game, the seat count and the Pool settings', async () => {
    const { host } = await group(0);
    await expect(make(host, { gameSlug: 'nope' })).rejects.toMatchObject(code('game_not_found'));
    await expect(make(host, { gameSlug: '_example' })).rejects.toMatchObject(
      code('game_not_found'),
    );
    await expect(make(host, { maxSeats: 1 })).rejects.toMatchObject(code('invalid_seats'));
    await expect(make(host, { maxSeats: 5 })).rejects.toMatchObject(code('invalid_seats'));
    await expect(makePool(host, { seatFeeKobo: 100 })).rejects.toMatchObject(code('invalid_stake'));
    await expect(makePool(host, { seatFeeKobo: 99_999_999 })).rejects.toMatchObject(
      code('invalid_stake'),
    );
    await expect(makePool(host, { payoutScheme: 'p50_30_20', maxSeats: 2 })).rejects.toMatchObject(
      code('invalid_payout'),
    );
  });

  it('limits how many open spaces one person can be in', async () => {
    const { host } = await group(0);
    await setConfig(db, 'spaces_open_per_user', 2);
    await make(host);
    await make(host);
    await expect(make(host)).rejects.toMatchObject(code('spaces_limit'));
    await setConfig(db, 'spaces_open_per_user', 5);
  });

  it('Pool: locks the host seat fee before the space exists, and rolls back if it cannot', async () => {
    const { host } = await group(0);
    const s = await makePool(host);
    expect(s).toMatchObject({ mode: 'pool', seatFeeKobo: FEE, potKobo: FEE });
    expect(s.members[0]).toMatchObject({ stakedKobo: FEE });
    expect(await balanceOf(db, host.id)).toBe(GRANT - FEE);
    expect(await escrowOf(s.matchId!)).toBe(FEE);

    const broke = await fundedUser(db);
    await setBalance(db, broke.id, 100);
    const id = randomUUID();
    await expect(makePool(broke, { id })).rejects.toThrow();
    expect((await db.admin.query(`SELECT 1 FROM spaces WHERE id = $1`, [id])).rowCount).toBe(0);
    expect(await balanceOf(db, broke.id)).toBe(100);

    const minor = await fundedUser(db, { adult: false });
    await expect(makePool(minor)).rejects.toMatchObject({ code: 'adult_required' });
  });
});

describe('joining', () => {
  it('seats a friend by code, in any spelling, once', async () => {
    const { host, others } = await group(2);
    const s = await make(host);
    const a = await spaces.join(others[0]!.id, s.code.toLowerCase().replace('-', ''));
    expect(a.members.map((m) => m.userId)).toEqual([host.id, others[0]!.id]);
    expect(a.seated).toBe(true);
    expect(a.hosting).toBe(false);
    const again = await spaces.join(others[0]!.id, s.code);
    expect(again.members).toHaveLength(2);
    const b = await spaces.join(others[1]!.id, s.code);
    expect(b.members.map((m) => m.seat)).toEqual([1, 2, 3]);
    // the host hears about every change
    const toHost = published.filter((p) => p.users[0] === host.id && p.event.type === 'space');
    expect(toHost.length).toBeGreaterThanOrEqual(2);
  });

  it('friends-only spaces refuse strangers; invite spaces take anyone with the code', async () => {
    const { host } = await group(0);
    const stranger = await fundedUser(db);
    const closed = await make(host, { visibility: 'friends' });
    await expect(spaces.join(stranger.id, closed.code)).rejects.toMatchObject(
      code('space_friends_only'),
    );
    await expect(spaces.lookup(stranger.id, closed.code)).rejects.toMatchObject(
      code('space_friends_only'),
    );
    const open = await make(host, { visibility: 'invite' });
    const preview = await spaces.lookup(stranger.id, open.code);
    expect(preview).toMatchObject({ seated: false, hosting: false, name: 'Game night' });
    const joined = await spaces.join(stranger.id, open.code);
    expect(joined.members).toHaveLength(2);
  });

  it('refuses unknown codes, blocked people, full and started spaces', async () => {
    const { host, others } = await group(3);
    await expect(spaces.join(others[0]!.id, 'DY-AAAA')).rejects.toMatchObject(
      code('space_not_found'),
    );
    const s = await make(host, { maxSeats: 2 });
    await db.admin.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [
      others[2]!.id,
      host.id,
    ]);
    await expect(spaces.join(others[2]!.id, s.code)).rejects.toMatchObject(code('blocked'));
    await spaces.join(others[0]!.id, s.code);
    await expect(spaces.join(others[1]!.id, s.code)).rejects.toMatchObject(code('space_full'));

    const t = await make(host, { visibility: 'invite' });
    await spaces.join(others[0]!.id, t.code);
    await spaces.start(host.id, t.id);
    await expect(spaces.join(others[1]!.id, t.code)).rejects.toMatchObject(code('space_not_open'));
  });

  it('two people racing for the last seat: one gets it, the other is told it is full', async () => {
    const { host, others } = await group(2);
    const s = await make(host, { maxSeats: 2 });
    const r = await Promise.allSettled(others.map((o) => spaces.join(o.id, s.code)));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost = r.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: 'space_full' });
    const members = await db.admin.query(
      `SELECT count(*)::int n FROM space_members WHERE space_id = $1 AND left_at IS NULL`,
      [s.id],
    );
    expect(members.rows[0].n).toBe(2);
  });

  it('Pool: the seat fee is taken on sitting down; a person who cannot pay is not seated', async () => {
    const { host, others } = await group(2);
    const s = await makePool(host);
    const a = await spaces.join(others[0]!.id, s.code);
    expect(a.potKobo).toBe(2 * FEE);
    expect(await balanceOf(db, others[0]!.id)).toBe(GRANT - FEE);
    expect(await escrowOf(s.matchId!)).toBe(2 * FEE);

    await setBalance(db, others[1]!.id, FEE - 1);
    await expect(spaces.join(others[1]!.id, s.code)).rejects.toMatchObject({
      code: 'insufficient_funds',
    });
    expect(await balanceOf(db, others[1]!.id)).toBe(FEE - 1);
    const view = await spaces.get(host.id, s.id);
    expect(view.members).toHaveLength(2);
    expect(await escrowOf(s.matchId!)).toBe(2 * FEE);

    const minor = await fundedUser(db, { adult: false });
    await befriend(host, minor);
    await expect(spaces.join(minor.id, s.code)).rejects.toMatchObject({ code: 'adult_required' });
  });
});

describe('leaving, removal, closing', () => {
  it('Pool: leaving gives the fee back, frees the seat, and sitting down again pays again', async () => {
    const { host, others } = await group(2);
    const s = await makePool(host);
    await spaces.join(others[0]!.id, s.code);
    await spaces.join(others[1]!.id, s.code);
    const left = await spaces.leave(others[0]!.id, s.id);
    expect(left).toMatchObject({ seated: false });
    expect(await balanceOf(db, others[0]!.id)).toBe(GRANT);
    expect(await escrowOf(s.matchId!)).toBe(2 * FEE);
    expect((await spaces.get(host.id, s.id)).members.map((m) => m.seat)).toEqual([1, 3]);
    // idempotent
    await spaces.leave(others[0]!.id, s.id);
    expect(await balanceOf(db, others[0]!.id)).toBe(GRANT);

    const back = await spaces.join(others[0]!.id, s.code);
    expect(back.members.map((m) => m.seat)).toEqual([1, 2, 3]);
    expect(await balanceOf(db, others[0]!.id)).toBe(GRANT - FEE);
    expect(await escrowOf(s.matchId!)).toBe(3 * FEE);
  });

  it('hands the host to the longest-seated person and closes an empty space (fees refunded)', async () => {
    const { host, others } = await group(2);
    const s = await makePool(host);
    await spaces.join(others[0]!.id, s.code);
    await spaces.join(others[1]!.id, s.code);
    await spaces.leave(host.id, s.id);
    const view = await spaces.get(others[0]!.id, s.id);
    expect(view.hostId).toBe(others[0]!.id);
    expect(view.hosting).toBe(true);
    expect(await balanceOf(db, host.id)).toBe(GRANT);

    await spaces.leave(others[0]!.id, s.id);
    await spaces.leave(others[1]!.id, s.id);
    const row = await db.admin.query(`SELECT status FROM spaces WHERE id = $1`, [s.id]);
    expect(row.rows[0].status).toBe('closed');
    expect(await escrowOf(s.matchId!)).toBe(0);
    for (const u of [host, ...others]) expect(await balanceOf(db, u.id)).toBe(GRANT);
  });

  it('the host can remove someone (refunded, cannot come back); others cannot', async () => {
    const { host, others } = await group(2);
    const s = await makePool(host);
    await spaces.join(others[0]!.id, s.code);
    await spaces.join(others[1]!.id, s.code);
    await expect(spaces.remove(others[0]!.id, s.id, others[1]!.id)).rejects.toMatchObject(
      code('not_space_host'),
    );
    await spaces.remove(host.id, s.id, others[0]!.id);
    expect(await balanceOf(db, others[0]!.id)).toBe(GRANT);
    await expect(spaces.join(others[0]!.id, s.code)).rejects.toMatchObject(code('space_removed'));
    expect((await spaces.get(host.id, s.id)).members).toHaveLength(2);
  });

  it('the host can close a waiting space: every fee goes back, once', async () => {
    const { host, others } = await group(2);
    const s = await makePool(host);
    await spaces.join(others[0]!.id, s.code);
    await expect(spaces.close(others[0]!.id, s.id)).rejects.toMatchObject(code('not_space_host'));
    const closed = await spaces.close(host.id, s.id);
    expect(closed.status).toBe('closed');
    await spaces.close(host.id, s.id);
    for (const u of [host, others[0]!]) expect(await balanceOf(db, u.id)).toBe(GRANT);
    const m = await db.admin.query(`SELECT status FROM matches WHERE id = $1`, [s.matchId]);
    expect(m.rows[0].status).toBe('cancelled');
    await expect(spaces.join(others[1]!.id, s.code)).rejects.toMatchObject(code('space_not_open'));
  });

  it('expires waiting spaces nobody started and refunds them', async () => {
    const { host, others } = await group(1);
    const s = await makePool(host);
    await spaces.join(others[0]!.id, s.code);
    expect(await spaces.expireStaleSpaces()).toBe(0);
    clock.t += 7 * 3_600_000;
    expect(await spaces.expireStaleSpaces()).toBeGreaterThanOrEqual(1);
    const row = await db.admin.query(`SELECT status FROM spaces WHERE id = $1`, [s.id]);
    expect(row.rows[0].status).toBe('closed');
    expect(
      (await db.admin.query(`SELECT status FROM matches WHERE id = $1`, [s.matchId])).rows[0]
        .status,
    ).toBe('expired');
    for (const u of [host, others[0]!]) expect(await balanceOf(db, u.id)).toBe(GRANT);
  });
});

describe('starting', () => {
  it('only the host starts, with enough people; the engine is dealt and the room requested', async () => {
    const { host, others } = await group(2);
    const s = await make(host);
    await expect(spaces.start(host.id, s.id)).rejects.toMatchObject(code('not_enough_players'));
    await spaces.join(others[0]!.id, s.code);
    await expect(spaces.start(others[0]!.id, s.id)).rejects.toMatchObject(code('not_space_host'));
    const live = await spaces.start(host.id, s.id);
    expect(live.status).toBe('live');
    expect(roomCalls).toEqual([s.matchId]);

    const m = await db.admin.query(
      `SELECT status, state_version, current_turn, turn_deadline, state FROM matches WHERE id = $1`,
      [s.matchId],
    );
    const row = m.rows[0];
    expect(row).toMatchObject({ status: 'active', state_version: 0 });
    expect(row.turn_deadline).not.toBeNull();
    expect(row.state.players).toEqual([host.id, others[0]!.id]);
    expect(row.state.hands[host.id]).toHaveLength(6);
    expect([host.id, others[0]!.id]).toContain(row.current_turn);

    // idempotent
    await spaces.start(host.id, s.id);
    expect(roomCalls).toHaveLength(1);
    // nobody can leave a running game through the lobby
    await expect(spaces.leave(others[0]!.id, s.id)).rejects.toMatchObject(code('space_live'));
  });

  it('starts by itself when the last seat fills and the rule is when_full', async () => {
    const { host, others } = await group(2);
    const s = await make(host, { maxSeats: 3, startRule: 'when_full' });
    await spaces.join(others[0]!.id, s.code);
    expect((await spaces.get(host.id, s.id)).status).toBe('waiting');
    const last = await spaces.join(others[1]!.id, s.code);
    expect(last.status).toBe('live');
    expect(roomCalls).toEqual([s.matchId]);
  });

  it('Pool: pays out 60/40 for two players who picked 50/30/20', async () => {
    const { host, others } = await group(2);
    const s = await makePool(host, { payoutScheme: 'p50_30_20' });
    await spaces.join(others[0]!.id, s.code);
    await spaces.start(host.id, s.id);
    const m = await db.admin.query(`SELECT payout_scheme FROM matches WHERE id = $1`, [s.matchId]);
    expect(m.rows[0].payout_scheme).toBe('p60_40');

    const t = await makePool(host, { payoutScheme: 'p50_30_20' });
    await spaces.join(others[0]!.id, t.code);
    await spaces.join(others[1]!.id, t.code);
    await spaces.start(host.id, t.id);
    const m2 = await db.admin.query(`SELECT payout_scheme FROM matches WHERE id = $1`, [t.matchId]);
    expect(m2.rows[0].payout_scheme).toBe('p50_30_20');
  });

  it('still starts when the game server is down; connecting reports it and retries', async () => {
    const { host, others } = await group(1);
    const s = await make(host);
    await spaces.join(others[0]!.id, s.code);
    rooms.fail = true;
    const live = await spaces.start(host.id, s.id);
    expect(live.status).toBe('live');
    await expect(spaces.connect(host.id, s.id)).rejects.toMatchObject(code('room_unavailable'));
    rooms.fail = false;
    await expect(spaces.connect(host.id, s.id)).resolves.toEqual({
      url: 'ws://game.test',
      roomId: `room-${s.matchId}`,
      matchId: s.matchId,
    });
    await expect(spaces.connect(randomUUID(), s.id)).rejects.toMatchObject(code('space_not_found'));
  });
});

describe('listing', () => {
  it('lists the spaces you are seated in, newest first, and not ones you left', async () => {
    const { host, others } = await group(1);
    const a = await make(host, { name: 'First' });
    clock.t += 5000;
    const b = await make(host, { name: 'Second' });
    await spaces.join(others[0]!.id, b.code);
    const mine = (await spaces.list(host.id)).spaces.map((x: SpaceView) => x.name);
    expect(mine).toEqual(['Second', 'First']);
    expect((await spaces.list(others[0]!.id)).spaces.map((x) => x.id)).toEqual([b.id]);
    await spaces.leave(others[0]!.id, b.id);
    expect((await spaces.list(others[0]!.id)).spaces).toEqual([]);
    expect(a.id).not.toBe(b.id);
  });
});
