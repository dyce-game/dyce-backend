import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Client, type Room } from 'colyseus.js';
import { whotCanPlay, type WhotCard, type WhotShape } from '@dyce/games';
import type { LiveError, LiveState, SpaceView } from '@dyce/shared';
import { TokenService } from '../../api/src/auth/tokens.ts';
import { FriendsService } from '../../api/src/social/friends.service.ts';
import { HttpGameRooms } from '../../api/src/spaces/game-rooms.ts';
import { SpacesService } from '../../api/src/spaces/spaces.service.ts';
import {
  balanceOf,
  createTestDb,
  type TestDb,
  type TestUser,
} from '../../api/db/testing/testDb.ts';
import { expectLedgerClean, fundedUser } from '../../api/db/tests/helpers.ts';
import { createGameServer, type GameServer } from '../src/server.ts';

/**
 * Whot in a real Colyseus room on a real PostgreSQL, driven by real colyseus.js clients, with the API's
 * SpacesService starting the room over the signed internal call. The end of every test is the ledger.
 */
const JWT_SECRET = 'j'.repeat(40);
const INTERNAL_SECRET = 'i'.repeat(40);
const NAIRA = 100;
const GRANT = 200_000 * NAIRA;
const FEE = 500 * NAIRA;

// colyseus.js logs every refused join and closed socket; the tests provoke both on purpose.
beforeAll(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

let db: TestDb;
let server: GameServer;
let port: number;
let spaces: SpacesService;
let friends: FriendsService;
const tokens = new TokenService(JWT_SECRET, { accessTtlSeconds: 900 });

beforeAll(async () => {
  // The migrator reads `db/migrations` relative to the working directory: borrow the API's.
  const here = process.cwd();
  process.chdir(join(__dirname, '..', '..', 'api'));
  try {
    db = await createTestDb();
  } finally {
    process.chdir(here);
  }
  // These tests drive seats with bots that answer in milliseconds, which the integrity layer (backend ADR-039)
  // rightly reads as impossible timing. Payout holds have their own test below.
  await db.admin.query(
    `INSERT INTO app_config (key, value) VALUES ('integrity_hold_threshold', '101')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
  server = createGameServer({
    pool: db.app,
    jwtSecret: JWT_SECRET,
    internalSecret: INTERNAL_SECRET,
    options: {
      reconnectMs: 700,
      joinGraceMs: 4_000,
      botDelayMs: 15,
      settleRetries: 1,
      settleRetryMs: 50,
    },
    lingerMs: 400,
    log: () => undefined,
  });
  port = await server.listen(0, '127.0.0.1');
  friends = new FriendsService(db.app);
  spaces = new SpacesService(
    db.app,
    { publish: () => undefined },
    new HttpGameRooms({ baseUrl: `http://127.0.0.1:${port}`, secret: INTERNAL_SECRET }),
  );
}, 120_000);

afterAll(async () => {
  await server.close();
  await db.close();
});

afterEach(async () => {
  await expectLedgerClean(db);
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A seated person with a live connection. */
class Seat {
  room: Room | null = null;
  state: LiveState | null = null;
  errors: LiveError[] = [];
  closed: number | null = null;
  autoplay = false;
  moves = 0;

  constructor(
    readonly user: TestUser,
    private readonly roomId: string,
  ) {}

  async connect(): Promise<void> {
    const token = await tokens.signAccess({ userId: this.user.id, familyId: randomUUID() });
    const client = new Client(`ws://127.0.0.1:${port}`);
    const room = await client.joinById(this.roomId, { token });
    this.room = room;
    this.closed = null;
    room.onMessage('state', (s: LiveState) => {
      this.state = s;
      this.maybePlay();
    });
    room.onMessage('error', (e: LiveError) => this.errors.push(e));
    room.onLeave((code) => {
      this.closed = code;
    });
  }

  send(type: string, body?: unknown) {
    this.room!.send(type, body);
  }

  leaveSocket() {
    void this.room?.leave(false);
  }

  private maybePlay() {
    const s = this.state;
    if (!this.autoplay || !s || s.status !== 'live' || s.turnUserId !== this.user.id) return;
    const action = chooseMove(s.view as WhotView);
    this.moves += 1;
    this.send('move', { expectedVersion: s.version, action });
  }
}

type WhotView = {
  hand: WhotCard[];
  top: WhotCard;
  requested: WhotShape | null;
  pending: { n: number; total: number } | null;
  counts: Record<string, number>;
  hands?: unknown;
};

/** What the app's table does when the player taps for them: any playable card, else draw. */
function chooseMove(v: WhotView) {
  const playable = v.hand.filter((c) => whotCanPlay(c, v.top, v.requested, v.pending));
  const card = playable.find((c) => c.shape !== 'whot') ?? playable[0];
  if (!card) return { kind: 'draw' };
  const out: Record<string, unknown> = { kind: 'play', card };
  if (card.shape === 'whot') {
    const own = v.hand.filter((c) => c.shape !== 'whot');
    out.shape = (own[0]?.shape as WhotShape | undefined) ?? 'circle';
  }
  if (v.hand.length - 1 <= 1) out.call = true;
  return out;
}

async function until<T>(
  fn: () => T | undefined | null | false,
  what: string,
  ms = 20_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(15);
  }
}

async function group(n: number) {
  const host = await fundedUser(db);
  const others: TestUser[] = [];
  for (let i = 0; i < n; i++) {
    const u = await fundedUser(db);
    await friends.sendRequest(host.id, u.id);
    await friends.accept(u.id, host.id);
    others.push(u);
  }
  return { host, others };
}

/** A started space with everyone connected. */
async function table(opts: {
  n: number;
  pool: boolean;
  scheme?: 'winner_all' | 'p60_40' | 'p50_30_20';
}) {
  const { host, others } = await group(opts.n - 1);
  const created = await spaces.create(host.id, {
    id: randomUUID(),
    gameSlug: 'whot',
    name: 'Table',
    maxSeats: opts.n,
    visibility: 'friends',
    startRule: 'host',
    ...(opts.pool
      ? { mode: 'pool' as const, seatFeeKobo: FEE, payoutScheme: opts.scheme ?? 'winner_all' }
      : {}),
  });
  for (const o of others) await spaces.join(o.id, created.code);
  const live = await spaces.start(host.id, created.id);
  const conn = await spaces.connect(host.id, created.id);
  expect(conn.roomId).toBe(live.matchId);
  const seats = [host, ...others].map((u) => new Seat(u, conn.roomId));
  for (const s of seats) await s.connect();
  await until(() => seats.every((s) => s.state), 'first state');
  return { space: live, seats, matchId: live.matchId! };
}

const spaceRow = async (id: string) =>
  (await db.admin.query(`SELECT status FROM spaces WHERE id = $1`, [id])).rows[0].status as string;
const matchRow = async (id: string) =>
  (await db.admin.query(`SELECT status, state_version FROM matches WHERE id = $1`, [id]))
    .rows[0] as {
    status: string;
    state_version: number;
  };

describe('connecting', () => {
  it('seats get their own view; nobody sees another hand or the market', async () => {
    const { seats } = await table({ n: 3, pool: false });
    const [a, b] = [seats[0]!, seats[1]!];
    const va = a.state!.view as WhotView;
    const vb = b.state!.view as WhotView;
    expect(va.hand).toHaveLength(6);
    expect(vb.hand).toHaveLength(6);
    expect(va.hand).not.toEqual(vb.hand);
    expect(va.hands).toBeUndefined();
    expect(JSON.stringify(a.state)).not.toContain('"market"');
    expect(a.state!.seats.map((s) => [s.userId, s.connected])).toEqual(
      seats.map((s) => [s.user.id, true]),
    );
    expect(a.state).toMatchObject({ status: 'live', version: 0, mode: 'free', results: null });
    expect(a.state!.turnDeadlineAt).toBeGreaterThan(a.state!.serverNow);
    for (const s of seats) s.leaveSocket();
  });

  it('refuses people without a valid token or without a seat', async () => {
    const { seats, space } = await table({ n: 2, pool: false });
    const client = new Client(`ws://127.0.0.1:${port}`);
    await expect(client.joinById(space.matchId!, {})).rejects.toBeDefined();
    await expect(client.joinById(space.matchId!, { token: 'x'.repeat(40) })).rejects.toBeDefined();
    const outsider = await fundedUser(db);
    const token = await tokens.signAccess({ userId: outsider.id, familyId: randomUUID() });
    await expect(client.joinById(space.matchId!, { token })).rejects.toBeDefined();
    for (const s of seats) s.leaveSocket();
  });

  it('the internal room call needs a good signature', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/internal/rooms`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dyce-timestamp': String(Date.now()),
        'x-dyce-signature': 'ab'.repeat(32),
      },
      body: JSON.stringify({ matchId: randomUUID() }),
    });
    expect(r.status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
  });

  it('a second connection from the same person replaces the first', async () => {
    const { seats, space } = await table({ n: 2, pool: false });
    const first = seats[1]!;
    const again = new Seat(first.user, space.matchId!);
    await again.connect();
    await until(() => first.closed !== null, 'old connection closed');
    expect(first.closed).toBe(4010);
    await until(() => again.state, 'state on the new connection');
    expect(again.state!.seats.find((s) => s.userId === first.user.id)!.connected).toBe(true);
    seats[0]!.leaveSocket();
    again.leaveSocket();
  });
});

describe('playing', () => {
  it('refuses a move out of turn or stale, and tells the player so', async () => {
    const { seats } = await table({ n: 3, pool: false });
    const turn = seats[0]!.state!.turnUserId;
    const waiting = seats.find((s) => s.user.id !== turn)!;
    waiting.send('move', {
      expectedVersion: 0,
      action: chooseMove(waiting.state!.view as WhotView),
    });
    await until(() => waiting.errors.length > 0, 'an error');
    expect(waiting.errors[0]).toMatchObject({ code: 'not_your_turn', expectedVersion: 0 });

    const mover = seats.find((s) => s.user.id === turn)!;
    mover.send('move', { expectedVersion: 7, action: chooseMove(mover.state!.view as WhotView) });
    await until(() => mover.errors.length > 0, 'a stale error');
    expect(mover.errors[0]!.code).toBe('stale_version');
    mover.send('move', { expectedVersion: 0, action: { kind: 'nonsense' } });
    await until(() => mover.errors.length > 1, 'an invalid error');
    expect(mover.errors[1]!.code).toBe('invalid_action');
    for (const s of seats) s.leaveSocket();
  });

  it('plays a Free game to the end: placements, a result for everyone, space ended, moves stored', async () => {
    const { seats, space, matchId } = await table({ n: 4, pool: false });
    for (const s of seats) s.autoplay = true;
    // Start the chain: whoever's turn it is plays on their next state; nudge with a sync.
    for (const s of seats) s.send('sync');
    const done = await until(
      () => seats.find((s) => s.state?.status === 'finished')?.state,
      'the game to finish',
      60_000,
    );
    await until(() => seats.every((s) => s.state?.status === 'finished'), 'everyone sees the end');
    const results = done.results!;
    expect(results).toHaveLength(4);
    expect(results.map((r) => r.placement)).toEqual(
      [...results.map((r) => r.placement)].sort((a, b) => a - b),
    );
    expect(results[0]).toMatchObject({ placement: 1 });
    expect(new Set(results.map((r) => r.userId))).toEqual(new Set(seats.map((s) => s.user.id)));
    expect(results.every((r) => r.payoutKobo === null)).toBe(true);

    const m = await matchRow(matchId);
    expect(m.status).toBe('finished');
    expect(m.state_version).toBeGreaterThan(5);
    const moves = await db.admin.query(
      `SELECT count(*)::int n, max(seq) mx FROM match_moves WHERE match_id = $1`,
      [matchId],
    );
    expect(moves.rows[0]).toMatchObject({ n: m.state_version, mx: m.state_version });
    expect(await spaceRow(space.id)).toBe('ended');

    // the finished space is readable through the API with placements for everyone
    const view: SpaceView = await spaces.get(seats[0]!.user.id, space.id);
    expect(view.status).toBe('ended');
    expect(view.members.map((x) => x.placement).filter((p) => p !== null)).toHaveLength(4);
    for (const s of seats) expect(await balanceOf(db, s.user.id)).toBe(GRANT);
    // The table closes by itself a little later.
    await until(() => seats.every((s) => s.closed !== null), 'the room to close', 5_000);
  }, 90_000);

  it('Pool, 3 players, 50/30/20: the pot is paid by placement and the ledger balances', async () => {
    const { seats, space, matchId } = await table({ n: 3, pool: true, scheme: 'p50_30_20' });
    for (const s of seats) expect(await balanceOf(db, s.user.id)).toBe(GRANT - FEE);
    for (const s of seats) s.autoplay = true;
    for (const s of seats) s.send('sync');
    const done = await until(
      () => seats.find((s) => s.state?.status === 'finished')?.state,
      'the game to finish',
      60_000,
    );
    const pot = 3 * FEE;
    const byPlace = [...done.results!].sort((a, b) => a.placement - b.placement);
    expect(byPlace.map((r) => r.payoutKobo)).toEqual([pot * 0.5, pot * 0.3, pot * 0.2]);
    for (const r of done.results!) {
      expect(await balanceOf(db, r.userId)).toBe(GRANT - FEE + (r.payoutKobo ?? 0));
    }
    const esc = await db.admin.query(
      `SELECT coalesce(sum(e.amount_kobo), 0)::bigint s FROM ledger_accounts a JOIN ledger_entries e ON e.account_id = a.id
        WHERE a.kind = 'pool_escrow' AND a.match_id = $1`,
      [matchId],
    );
    expect(Number(esc.rows[0].s)).toBe(0);
    expect(await spaceRow(space.id)).toBe('ended');
    expect((await matchRow(matchId)).status).toBe('finished');
    for (const s of seats) s.leaveSocket();
  }, 90_000);
});

describe('leaving and reconnecting', () => {
  it('leaving the table forfeits: the other player wins the whole Pool pot', async () => {
    const { seats, matchId } = await table({ n: 2, pool: true });
    const [stay, go] = seats as [Seat, Seat];
    go.send('leave');
    const st = await until(
      () => (stay.state?.status === 'finished' ? stay.state : null),
      'the game to end',
    );
    expect(st.results!.map((r) => [r.userId, r.placement, r.result, r.payoutKobo])).toEqual([
      [stay.user.id, 1, 'win', 2 * FEE],
      [go.user.id, 2, 'forfeit', 0],
    ]);
    expect(await balanceOf(db, stay.user.id)).toBe(GRANT + FEE);
    expect(await balanceOf(db, go.user.id)).toBe(GRANT - FEE);
    expect((await matchRow(matchId)).status).toBe('finished');
    stay.leaveSocket();
  });

  it('a live Pool game the integrity layer is suspicious of is held: the result stands, the pot waits for a moderator', async () => {
    await db.admin.query(
      `UPDATE app_config SET value = '70' WHERE key = 'integrity_hold_threshold'`,
    );
    const { seats, matchId } = await table({ n: 2, pool: true });
    const [stay, go] = seats as [Seat, Seat];
    // the same two accounts, five meetings in a week, one phone: what wash trading looks like (ADR-039)
    const phone = Buffer.from('ab'.repeat(32), 'hex');
    for (const u of [stay.user, go.user]) {
      await db.admin.query(
        `INSERT INTO user_fingerprints (user_id, kind, value_hash) VALUES ($1, 'device', $2)`,
        [u.id, phone],
      );
    }
    for (let i = 0; i < 4; i++) {
      const id = randomUUID();
      await db.admin.query(
        `INSERT INTO matches (id, game_slug, mode, stake_kobo, status, seed, created_by, finished_at)
         VALUES ($1, 'whot', 'pool', $2, 'finished', 1, $3, now())`,
        [id, FEE, stay.user.id],
      );
      for (const [seat, u] of [stay.user, go.user].entries()) {
        await db.admin.query(
          `INSERT INTO match_players (match_id, user_id, seat, staked_kobo, placement, result, payout_kobo)
           VALUES ($1, $2, $3, $4, $5, $6::match_result, $7)`,
          [
            id,
            u.id,
            seat + 1,
            FEE,
            seat + 1,
            seat === 0 ? 'win' : 'loss',
            seat === 0 ? 2 * FEE : 0,
          ],
        );
      }
    }
    go.send('leave');
    const st = await until(
      () => (stay.state?.status === 'finished' ? stay.state : null),
      'the game to end',
    );
    // the placements and results are what the game decided; nobody has been paid
    expect(st.results!.map((r) => [r.userId, r.placement, r.result, r.payoutKobo])).toEqual([
      [stay.user.id, 1, 'win', null],
      [go.user.id, 2, 'forfeit', null],
    ]);
    expect(await balanceOf(db, stay.user.id)).toBe(GRANT - FEE);
    expect(await balanceOf(db, go.user.id)).toBe(GRANT - FEE);
    expect((await matchRow(matchId)).status).toBe('disputed');
    const hold = await db.admin.query(`SELECT status FROM integrity_holds WHERE match_id = $1`, [
      matchId,
    ]);
    expect(hold.rows).toEqual([{ status: 'held' }]);
    const escrow = await db.admin.query(
      `SELECT coalesce(sum(e.amount_kobo), 0)::bigint AS s FROM ledger_accounts a
         JOIN ledger_entries e ON e.account_id = a.id WHERE a.kind = 'pool_escrow' AND a.match_id = $1`,
      [matchId],
    );
    expect(Number(escrow.rows[0].s)).toBe(2 * FEE);
    // a moderator releasing it pays the winner exactly as the room decided
    await db.admin.query(
      `SELECT resolve_integrity_hold(id, 'release', 'amaka', 'checked') FROM integrity_holds WHERE match_id = $1`,
      [matchId],
    );
    expect(await balanceOf(db, stay.user.id)).toBe(GRANT + FEE);
    expect((await matchRow(matchId)).status).toBe('finished');
    await db.admin.query(
      `UPDATE app_config SET value = '101' WHERE key = 'integrity_hold_threshold'`,
    );
    stay.leaveSocket();
  });

  it('a dropped connection can come back inside the window and keeps its seat and cards', async () => {
    const { seats, space } = await table({ n: 2, pool: false });
    const [stay, flaky] = seats as [Seat, Seat];
    const hand = (flaky.state!.view as WhotView).hand;
    flaky.leaveSocket();
    await until(
      () => stay.state!.seats.find((s) => s.userId === flaky.user.id)!.connected === false,
      'drop seen',
    );
    const back = new Seat(flaky.user, space.matchId!);
    await wait(200);
    await back.connect();
    await until(() => back.state, 'state after reconnect');
    expect((back.state!.view as WhotView).hand).toEqual(hand);
    await until(
      () => stay.state!.seats.find((s) => s.userId === flaky.user.id)!.connected,
      'reconnect seen',
    );
    await wait(1_000); // longer than the 700 ms window: the seat must still be in the game
    expect(stay.state!.status).toBe('live');
    expect(stay.state!.seats.every((s) => !s.forfeited)).toBe(true);
    stay.leaveSocket();
    back.leaveSocket();
  });

  it('a connection that stays away past the window forfeits (Pool: refund is not owed, the pot goes to the other)', async () => {
    const { seats } = await table({ n: 2, pool: true });
    const [stay, gone] = seats as [Seat, Seat];
    gone.leaveSocket();
    const st = await until(
      () => (stay.state?.status === 'finished' ? stay.state : null),
      'forfeit after the window',
      10_000,
    );
    expect(st.results![0]).toMatchObject({
      userId: stay.user.id,
      placement: 1,
      payoutKobo: 2 * FEE,
    });
    expect(st.results![1]).toMatchObject({
      userId: gone.user.id,
      result: 'forfeit',
      payoutKobo: 0,
    });
    stay.leaveSocket();
  });

  it('a lost room is rebuilt from the database when someone asks for it again', async () => {
    const { seats, space, matchId } = await table({ n: 2, pool: false });
    // Make a couple of moves so there is persisted state to come back to.
    const turn = seats.find((s) => s.state!.turnUserId === s.user.id)!;
    turn.send('move', { expectedVersion: 0, action: chooseMove(turn.state!.view as WhotView) });
    await until(() => seats[0]!.state!.version >= 1, 'first move');
    const version = seats[0]!.state!.version;
    for (const s of seats) s.leaveSocket();
    // Drop the room (as a restart would). The match row stays active.
    const { matchMaker } = await import('@colyseus/core');
    await matchMaker.getLocalRoomById(matchId)?.disconnect();
    await until(() => !matchMaker.getLocalRoomById(matchId), 'room gone', 5_000);
    expect((await matchRow(matchId)).status).toBe('active');

    const conn = await spaces.connect(seats[0]!.user.id, space.id);
    expect(conn.roomId).toBe(matchId);
    const again = new Seat(seats[0]!.user, conn.roomId);
    await again.connect();
    await until(() => again.state, 'state from the rebuilt room');
    expect(again.state!.version).toBe(version);
    again.leaveSocket();
  });
});
