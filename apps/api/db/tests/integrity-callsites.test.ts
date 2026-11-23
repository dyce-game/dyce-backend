import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import type { RealtimeEvent } from '@dyce/shared';
import { MessagesService } from '../../src/chat/messages.service.ts';
import { ModerationService } from '../../src/integrity/moderation.service.ts';
import { isPoolEntry } from '../../src/integrity/pool-entry.ts';
import type { AnyEngine } from '../../src/matches/engines.ts';
import { MatchesService } from '../../src/matches/matches.service.ts';
import { QuickMatchService } from '../../src/quickmatch/quickmatch.service.ts';
import { FriendsService } from '../../src/social/friends.service.ts';
import { SpacesService, type GameRooms } from '../../src/spaces/spaces.service.ts';
import {
  balanceOf,
  createMatch,
  createTestDb,
  type TestDb,
  type TestUser,
} from '../testing/testDb.ts';
import { expectLedgerClean, fundedUser } from './helpers.ts';

/**
 * The places that settle or stake Pool money, with the integrity layer in place (ADR-039): the async match service
 * (a final move and a resignation), quick match pairing, and the check that decides whether a route is a Pool entry.
 * The signals themselves are tested in integrity.test.ts.
 */
const NAIRA = 100;
const STAKE = 1_000 * NAIRA;

let db: TestDb;
let admin: pg.Pool;
let moderation: ModerationService;
let chat: MessagesService;
let friends: FriendsService;
let matches: MatchesService;
let qm: QuickMatchService;
const publisher = { publish: (_users: readonly string[], _event: RealtimeEvent) => undefined };
// real time: the signals look at the last week by the database clock
const now = () => new Date();

/** First to a total of 5, steps of 1 to 3 (the same toy engine the Pool match tests use). */
type RaceState = { players: string[]; turn: number; total: number; winner: string | null };
const raceEngine: AnyEngine = {
  slug: 'test_race',
  actionSchema: z.object({ kind: z.literal('add'), n: z.number().int() }),
  init: (players) => ({ players, turn: 0, total: 0, winner: null }) satisfies RaceState,
  currentPlayers: (st) => {
    const r = st as RaceState;
    return r.winner ? [] : [r.players[r.turn]!];
  },
  validate: (_s, _by, a) =>
    (a as { n: number }).n >= 1 && (a as { n: number }).n <= 3
      ? { ok: true }
      : { ok: false, code: 'bad_step' },
  apply: (st, by, a) => {
    const r = st as RaceState;
    const total = r.total + (a as { n: number }).n;
    return { ...r, total, winner: total >= 5 ? by : null, turn: (r.turn + 1) % 2 };
  },
  isTerminal: (st) => (st as RaceState).winner !== null,
  result: (st) => {
    const r = st as RaceState;
    return { placements: [[r.winner!], [r.players.find((p) => p !== r.winner)!]], draw: false };
  },
  view: (st) => st,
};

beforeAll(async () => {
  db = await createTestDb();
  await db.admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dyce_moderator') THEN
      CREATE ROLE dyce_moderator LOGIN PASSWORD 'dyce_moderator' IN ROLE dyce_admin;
    END IF;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  const url = new URL(process.env.TEST_DATABASE_ADMIN_URL!);
  const name = (await db.admin.query<{ n: string }>('SELECT current_database() AS n')).rows[0]!.n;
  url.pathname = `/${name}`;
  url.username = 'dyce_moderator';
  url.password = 'dyce_moderator';
  admin = new pg.Pool({ connectionString: url.toString(), max: 3 });
  moderation = new ModerationService(admin);
  await db.admin.query(
    `INSERT INTO games (slug, name, dimension, sync, min_players, max_players, supports_pool, enabled)
     VALUES ('test_race', 'Race', '2d', 'async', 2, 2, true, true)`,
  );
  chat = new MessagesService(db.app, publisher, now);
  friends = new FriendsService(db.app, now);
  matches = new MatchesService(db.app, publisher, chat, now, {
    allowDevGames: true,
    engines: { test_race: { engine: raceEngine, cfg: {} } },
  });
  const rooms: GameRooms = {
    publicUrl: 'ws://game.test',
    ensureRoom: (id) => Promise.resolve({ roomId: `room-${id}` }),
  };
  qm = new QuickMatchService(
    db.app,
    publisher,
    new SpacesService(db.app, publisher, rooms, now),
    now,
  );
});
afterAll(async () => {
  await admin.end();
  await db.close();
});

async function player(): Promise<TestUser> {
  const u = await fundedUser(db);
  await db.admin.query(`UPDATE users SET created_at = now() - interval '60 days' WHERE id = $1`, [
    u.id,
  ]);
  return u;
}

const fingerprint = (u: TestUser, kind: 'device' | 'ip', value: Buffer) =>
  db.admin.query(`INSERT INTO user_fingerprints (user_id, kind, value_hash) VALUES ($1, $2, $3)`, [
    u.id,
    kind,
    value,
  ]);

/** `n` earlier decided Pool matches between the two, all won by `a`. */
async function history(a: TestUser, b: TestUser, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    await db.admin.query(
      `INSERT INTO matches (id, game_slug, mode, stake_kobo, status, seed, created_by, finished_at)
       VALUES ($1, '_example', 'pool', $2, 'finished', 1, $3, now())`,
      [id, STAKE, a.id],
    );
    for (const [seat, p] of [a, b].entries()) {
      await db.admin.query(
        `INSERT INTO match_players (match_id, user_id, seat, staked_kobo, placement, result, payout_kobo)
         VALUES ($1, $2, $3, $4, $5, $6::match_result, $7)`,
        [
          id,
          p.id,
          seat + 1,
          STAKE,
          seat + 1,
          seat === 0 ? 'win' : 'loss',
          seat === 0 ? 2 * STAKE : 0,
        ],
      );
    }
  }
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

const holdOf = async (matchId: string) =>
  (await db.admin.query(`SELECT * FROM integrity_holds WHERE match_id = $1`, [matchId])).rows[0];

describe('through the match service', () => {
  async function friendsPair() {
    const a = await player();
    const b = await player();
    await friends.sendRequest(a.id, b.id);
    await friends.accept(b.id, a.id);
    const conv = (await chat.openDirect(a.id, b.id)).id;
    return { a, b, conv };
  }
  async function poolRace(a: TestUser, b: TestUser, conv: string) {
    const m = await matches.create(a.id, {
      id: randomUUID(),
      conversationId: conv,
      gameSlug: 'test_race',
      mode: 'pool',
      stakeKobo: STAKE,
      allowCounter: false,
    });
    await matches.accept(b.id, m.id);
    return m.id;
  }
  const add = (n: number) => ({ kind: 'add', n });
  async function colludingFriends() {
    const p = await friendsPair();
    await history(p.a, p.b, 4);
    const phone = randomBytes(32);
    await fingerprint(p.a, 'device', phone);
    await fingerprint(p.b, 'device', phone);
    return p;
  }

  it('a final move that would settle a suspicious match holds it: nobody is paid yet', async () => {
    const { a, b, conv } = await colludingFriends();
    const id = await poolRace(a, b, conv);
    await matches.submitMove(a.id, id, { expectedVersion: 0, action: add(3) });
    const done = await matches.submitMove(b.id, id, { expectedVersion: 1, action: add(2) });

    expect(done.status).toBe('disputed');
    expect(done.outcome?.winnerIds).toEqual([b.id]);
    expect(done.players.map((p) => p.payoutKobo)).toEqual([null, null]);
    expect((await matches.get(a.id, id)).status).toBe('disputed');
    expect(await balanceOf(db, a.id)).toBe(200_000 * NAIRA - STAKE);
    expect(await balanceOf(db, b.id)).toBe(200_000 * NAIRA - STAKE);
    expect(await escrowOf(id)).toBe(2 * STAKE);
    const card = (await chat.messages(a.id, conv)).messages.find((m) => m.id === id);
    expect(card).toMatchObject({
      kind: 'game',
      payload: { status: 'disputed', winnerIds: [b.id] },
    });

    // a retried final move is acknowledged and changes nothing
    await matches.submitMove(b.id, id, { expectedVersion: 1, action: add(2) });
    expect(
      (await db.admin.query('SELECT 1 FROM integrity_holds WHERE match_id = $1', [id])).rows,
    ).toHaveLength(1);

    // the decision pays the winner through the ordinary settlement
    await moderation.resolveHold((await holdOf(id)).id, 'release', 'amaka', 'checked');
    const after = await matches.get(b.id, id);
    expect(after.status).toBe('finished');
    expect(after.players.find((p) => p.userId === b.id)?.payoutKobo).toBe(2 * STAKE);
    expect(await balanceOf(db, b.id)).toBe(200_000 * NAIRA + STAKE);
    await expectLedgerClean(db);
  });

  it('resigning is judged the same way', async () => {
    const { a, b, conv } = await colludingFriends();
    const id = await poolRace(a, b, conv);
    const res = await matches.resign(a.id, id);
    expect(res.status).toBe('disputed');
    expect(await escrowOf(id)).toBe(2 * STAKE);
    await expectLedgerClean(db);
  });

  it('a clean match between friends still pays at once', async () => {
    const { a, b, conv } = await friendsPair();
    const id = await poolRace(a, b, conv);
    await matches.submitMove(a.id, id, { expectedVersion: 0, action: add(3) });
    const done = await matches.submitMove(b.id, id, { expectedVersion: 1, action: add(2) });
    expect(done.status).toBe('finished');
    expect(done.players.find((p) => p.userId === b.id)?.payoutKobo).toBe(2 * STAKE);
    await expectLedgerClean(db);
  });
});

describe('quick match and Pool entry', () => {
  const ticket = async (u: TestUser) => (await qm.state(u.id)).ticket;

  it('never pairs two accounts that share a phone in Pool, but does in Free', async () => {
    const a = await player();
    const b = await player();
    const c = await player();
    const phone = randomBytes(32);
    await fingerprint(a, 'device', phone);
    await fingerprint(b, 'device', phone);
    await qm.join(a.id, { gameSlug: 'whot', mode: 'pool', stakeKobo: STAKE });
    await qm.join(b.id, { gameSlug: 'whot', mode: 'pool', stakeKobo: STAKE });
    expect((await ticket(a))?.status).toBe('searching');
    expect((await ticket(b))?.status).toBe('searching');
    // a stranger arrives and is paired with one of the two, never the two with each other
    await qm.join(c.id, { gameSlug: 'whot', mode: 'pool', stakeKobo: STAKE });
    const states = [await ticket(a), await ticket(b), await ticket(c)];
    expect(states.filter((t) => t?.status === 'found')).toHaveLength(2);
    expect((await ticket(c))?.status).toBe('found');
    expect(states.filter((t) => t?.status === 'searching')).toHaveLength(1);
    await expectLedgerClean(db);

    const d = await player();
    const e = await player();
    const shared = randomBytes(32);
    await fingerprint(d, 'device', shared);
    await fingerprint(e, 'device', shared);
    await qm.join(d.id, { gameSlug: 'whot', mode: 'free' });
    await qm.join(e.id, { gameSlug: 'whot', mode: 'free' });
    expect((await ticket(d))?.status).toBe('found');
  });

  it('knows which requests are Pool entries before the body is validated', async () => {
    const a = await player();
    const b = await player();
    const poolMatch = await createMatch(db, a.id, [a.id, b.id], { mode: 'pool', stake: STAKE });
    const freeMatch = await createMatch(db, a.id, [a.id, b.id], { mode: 'free' });
    await db.admin.query(
      `INSERT INTO spaces (id, code, name, host_id, game_slug, mode, seat_fee_kobo, max_seats)
       VALUES ($1, 'DY-4K9P', 'Room', $2, 'whot', 'pool', $3, 3)`,
      [randomUUID(), a.id, STAKE],
    );
    expect(await isPoolEntry(db.app, 'body', { body: { mode: 'pool' } })).toBe(true);
    expect(await isPoolEntry(db.app, 'body', { body: { mode: 'free' } })).toBe(false);
    expect(await isPoolEntry(db.app, 'body', {})).toBe(false);
    expect(await isPoolEntry(db.app, 'match', { params: { id: poolMatch } })).toBe(true);
    expect(await isPoolEntry(db.app, 'match', { params: { id: freeMatch } })).toBe(false);
    expect(await isPoolEntry(db.app, 'match', { params: { id: 'not-a-uuid' } })).toBe(false);
    expect(await isPoolEntry(db.app, 'space', { body: { code: 'dy-4k9p' } })).toBe(true);
    expect(await isPoolEntry(db.app, 'space', { body: { code: 'nonsense' } })).toBe(false);
  });
});
