import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Client, type Room } from 'colyseus.js';
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
 * The Ludo room (backend ADR-043): Ludo for 3 or 4 people at a table, in a real Colyseus room on a real PostgreSQL,
 * driven by real colyseus.js clients, with the API's SpacesService starting the room. A Pool table of 3 and a Free
 * table of 4 are played to the end by seats that roll and move the first legal token; the end of every test is the
 * ledger. (The rules are tested in packages/games; the generic room in room.test.ts.)
 */
const JWT_SECRET = 'j'.repeat(40);
const INTERNAL_SECRET = 'i'.repeat(40);
const NAIRA = 100;
const GRANT = 200_000 * NAIRA;
const FEE = 500 * NAIRA;

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
  const here = process.cwd();
  process.chdir(join(__dirname, '..', '..', 'api'));
  try {
    db = await createTestDb();
  } finally {
    process.chdir(here);
  }
  // Bots that answer in milliseconds would read as impossible timing to the integrity layer (ADR-039); a held payout
  // has its own test in room.test.ts.
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
const code = (c: string) => expect.objectContaining({ code: c });

type LudoView = { phase: 'roll' | 'move'; legal: number[]; turn: number; players: string[] };

/** What the app's table does when the player taps: roll, then move the first token that can move. */
function choose(v: LudoView): Record<string, unknown> {
  return v.phase === 'move' && v.legal.length > 0
    ? { kind: 'move', token: v.legal[0] }
    : { kind: 'roll' };
}

class Seat {
  room: Room | null = null;
  state: LiveState | null = null;
  errors: LiveError[] = [];
  closed: number | null = null;
  autoplay = false;

  constructor(
    readonly user: TestUser,
    private readonly roomId: string,
  ) {}

  async connect(): Promise<void> {
    const token = await tokens.signAccess({ userId: this.user.id, familyId: randomUUID() });
    const client = new Client(`ws://127.0.0.1:${port}`);
    const room = await client.joinById(this.roomId, { token });
    this.room = room;
    room.onMessage('state', (s: LiveState) => {
      this.state = s;
      this.maybePlay();
    });
    room.onMessage('error', (e: LiveError) => this.errors.push(e));
    room.onLeave((c) => {
      this.closed = c;
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
    this.send('move', { expectedVersion: s.version, action: choose(s.view as LudoView) });
  }
}

async function until<T>(fn: () => T | undefined | null | false, what: string, ms = 20_000) {
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

async function table(opts: {
  n: number;
  pool: boolean;
  scheme?: 'winner_all' | 'p60_40' | 'p50_30_20';
}) {
  const { host, others } = await group(opts.n - 1);
  const created = await spaces.create(host.id, {
    id: randomUUID(),
    gameSlug: 'ludo-room',
    name: 'Ludo night',
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

const matchRow = async (id: string) =>
  (await db.admin.query(`SELECT status, state_version FROM matches WHERE id = $1`, [id]))
    .rows[0] as { status: string; state_version: number };

describe('creating a Ludo room', () => {
  it('takes 3 or 4 seats, nothing else, and is not offered as a 2-player quick match', async () => {
    const host = await fundedUser(db);
    const make = (maxSeats: number) =>
      spaces.create(host.id, {
        id: randomUUID(),
        gameSlug: 'ludo-room',
        name: 'Ludo',
        maxSeats,
        visibility: 'friends',
        startRule: 'host',
      });
    await expect(make(2)).rejects.toEqual(code('invalid_seats'));
    await expect(make(5)).rejects.toEqual(code('invalid_seats'));
    expect(await make(3)).toMatchObject({ gameSlug: 'ludo-room', maxSeats: 3, quickMatch: false });
    expect(await make(4)).toMatchObject({ maxSeats: 4 });
    const games = await db.admin.query(
      `SELECT sync, min_players, max_players, supports_pool, pool_min_stake_kobo FROM games WHERE slug = 'ludo-room'`,
    );
    expect(games.rows[0]).toMatchObject({
      sync: 'live',
      min_players: 3,
      max_players: 4,
      supports_pool: true,
      pool_min_stake_kobo: '50000',
    });
  });
});

describe('playing a Ludo table', () => {
  it('gives every seat its own view, with the dice server-side', async () => {
    const { seats } = await table({ n: 3, pool: false });
    const v = seats[0]!.state!.view as LudoView & { rng?: unknown; tokens: number[][] };
    expect(v.players).toHaveLength(3);
    expect(v.tokens).toHaveLength(3);
    expect(v.rng).toBeUndefined();
    expect(seats[0]!.state).toMatchObject({ status: 'live', version: 0, roomKind: 'turns' });
    // someone is on the clock, and a seat that is not on the clock is refused
    const turn = seats[0]!.state!.turnUserId;
    const waiting = seats.find((s) => s.user.id !== turn)!;
    waiting.send('move', { expectedVersion: 0, action: { kind: 'roll' } });
    await until(() => waiting.errors.length > 0, 'an error');
    expect(waiting.errors[0]).toMatchObject({ code: 'not_your_turn' });
    for (const s of seats) s.leaveSocket();
  });

  it('plays a Free table of 4 to the end: every seat placed, no cash moved, moves stored', async () => {
    const { seats, space, matchId } = await table({ n: 4, pool: false });
    for (const s of seats) s.autoplay = true;
    for (const s of seats) s.send('sync');
    const done = await until(
      () => seats.find((s) => s.state?.status === 'finished')?.state,
      'the game to finish',
      120_000,
    );
    const results = done.results!;
    expect(results).toHaveLength(4);
    expect(new Set(results.map((r) => r.userId))).toEqual(new Set(seats.map((s) => s.user.id)));
    expect(results.some((r) => r.placement === 1)).toBe(true);
    expect(results.every((r) => r.payoutKobo === null)).toBe(true);
    const m = await matchRow(matchId);
    expect(m.status).toBe('finished');
    expect(m.state_version).toBeGreaterThan(20);
    const view: SpaceView = await spaces.get(seats[0]!.user.id, space.id);
    expect(view.status).toBe('ended');
    for (const s of seats) expect(await balanceOf(db, s.user.id)).toBe(GRANT);
    await until(() => seats.every((s) => s.closed !== null), 'the room to close', 5_000);
  }, 180_000);

  it('Pool, 3 seats, 50/30/20: the pot is paid by progress and the ledger balances', async () => {
    const { seats, space, matchId } = await table({ n: 3, pool: true, scheme: 'p50_30_20' });
    for (const s of seats) expect(await balanceOf(db, s.user.id)).toBe(GRANT - FEE);
    for (const s of seats) s.autoplay = true;
    for (const s of seats) s.send('sync');
    const done = await until(
      () => seats.find((s) => s.state?.status === 'finished')?.state,
      'the game to finish',
      120_000,
    );
    const pot = 3 * FEE;
    const results = [...done.results!].sort((a, b) => a.placement - b.placement);
    const paid = results.reduce((n, r) => n + (r.payoutKobo ?? 0), 0);
    expect(paid).toBe(pot); // nothing created or lost
    expect(results[0]!.placement).toBe(1);
    expect(results[0]!.payoutKobo).toBeGreaterThanOrEqual(results[1]!.payoutKobo!);
    expect(results[1]!.payoutKobo).toBeGreaterThanOrEqual(results[2]!.payoutKobo!);
    for (const r of done.results!) {
      expect(await balanceOf(db, r.userId)).toBe(GRANT - FEE + (r.payoutKobo ?? 0));
    }
    const esc = await db.admin.query(
      `SELECT coalesce(sum(e.amount_kobo), 0)::bigint s FROM ledger_accounts a JOIN ledger_entries e ON e.account_id = a.id
        WHERE a.kind = 'pool_escrow' AND a.match_id = $1`,
      [matchId],
    );
    expect(Number(esc.rows[0].s)).toBe(0);
    expect((await matchRow(matchId)).status).toBe('finished');
    expect((await spaces.get(seats[0]!.user.id, space.id)).status).toBe('ended');
    for (const s of seats) s.leaveSocket();
  }, 180_000);

  it('a seat that leaves a Pool table forfeits its stake; the others play on and are paid', async () => {
    const { seats, matchId } = await table({ n: 3, pool: true });
    const [a, b, c] = seats as [Seat, Seat, Seat];
    c.send('leave');
    await until(
      () => a.state?.seats.find((s) => s.userId === c.user.id)?.forfeited,
      'the leaver to be marked',
    );
    for (const s of [a, b]) {
      s.autoplay = true;
      s.send('sync');
    }
    const done = await until(
      () => (a.state?.status === 'finished' ? a.state : null),
      'the game to finish',
      120_000,
    );
    const leaver = done.results!.find((r) => r.userId === c.user.id)!;
    expect(leaver).toMatchObject({ result: 'forfeit', payoutKobo: 0 });
    expect(await balanceOf(db, c.user.id)).toBe(GRANT - FEE);
    const winners = done.results!.filter((r) => r.userId !== c.user.id);
    const total = winners.reduce((n, r) => n + (r.payoutKobo ?? 0), 0);
    expect(total).toBe(3 * FEE);
    expect((await matchRow(matchId)).status).toBe('finished');
    a.leaveSocket();
    b.leaveSocket();
  }, 180_000);
});
