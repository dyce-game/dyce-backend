import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RealtimeEvent } from '@dyce/shared';
import { AccountService } from '../../src/account/account.service.ts';
import { DisputesService } from '../../src/account/disputes.service.ts';
import { MessagesService } from '../../src/chat/messages.service.ts';
import type { AnyEngine, EngineEntry } from '../../src/matches/engines.ts';
import { MatchesService } from '../../src/matches/matches.service.ts';
import { SpacesService, type GameRooms } from '../../src/spaces/spaces.service.ts';
import { FriendsService } from '../../src/social/friends.service.ts';
import { balanceOf, createTestDb, type TestDb, type TestUser } from '../testing/testDb.ts';
import { expectLedgerClean, expectPermissionDenied, fundedUser } from './helpers.ts';

/**
 * The edge flows (ADR-037) on real PostgreSQL: resigning, Pool disputes, account deletion, the data export and the
 * "why am I out of this space" view. Money checks run `ledger_check_invariants` after every test.
 */
type RaceState = { players: string[]; turn: number; total: number; winner: string | null };
const raceEngine: AnyEngine = {
  slug: 'edge_race',
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
const ENGINES: Record<string, EngineEntry> = { edge_race: { engine: raceEngine, cfg: {} } };

const NAIRA = 100;
const GRANT = 200_000 * NAIRA;
const STAKE = 1_000 * NAIRA;
const FEE = 500 * NAIRA;
const T0 = new Date('2026-11-14T10:00:00Z').getTime();
const clock = { t: T0 };
const now = () => new Date(clock.t);

let db: TestDb;
let chat: MessagesService;
let friends: FriendsService;
let matches: MatchesService;
let spaces: SpacesService;
let disputes: DisputesService;
let account: AccountService;
const published: { users: readonly string[]; event: RealtimeEvent }[] = [];
const publisher = {
  publish: (users: readonly string[], event: RealtimeEvent) =>
    void published.push({ users, event }),
};
const rooms: GameRooms = {
  publicUrl: 'ws://game.test',
  async ensureRoom(matchId) {
    return { roomId: `room-${matchId}` };
  },
};

beforeAll(async () => {
  db = await createTestDb();
  await db.admin.query(
    `INSERT INTO games (slug, name, dimension, sync, min_players, max_players, supports_pool, enabled)
     VALUES ('edge_race', 'Race', '2d', 'async', 2, 2, true, true)`,
  );
  chat = new MessagesService(db.app, publisher, now);
  friends = new FriendsService(db.app, now);
  matches = new MatchesService(db.app, publisher, chat, now, {
    allowDevGames: true,
    engines: ENGINES,
  });
  spaces = new SpacesService(db.app, publisher, rooms, now);
  disputes = new DisputesService(db.app); // real clock: matches are finished by the database's now()
  account = new AccountService(db.app, spaces, now);
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  clock.t = T0;
  published.length = 0;
});
afterEach(async () => {
  await expectLedgerClean(db);
});

const code = (c: string) => expect.objectContaining({ code: c });
const add = (n: number) => ({ kind: 'add', n });

async function pair() {
  const a = await fundedUser(db);
  const b = await fundedUser(db);
  await friends.sendRequest(a.id, b.id);
  await friends.accept(b.id, a.id);
  const conv = (await chat.openDirect(a.id, b.id)).id;
  return { a, b, conv };
}

/** An accepted match, `a` to move. */
async function started(mode: 'free' | 'pool' = 'pool') {
  const p = await pair();
  const m = await matches.create(p.a.id, {
    id: randomUUID(),
    conversationId: p.conv,
    gameSlug: 'edge_race',
    mode,
    stakeKobo: mode === 'pool' ? STAKE : 0,
    allowCounter: false,
  });
  await matches.accept(p.b.id, m.id);
  return { ...p, id: m.id };
}

/** `a` wins: 3, then 1, then 1 = 5. */
async function aWins(id: string, a: TestUser, b: TestUser) {
  await matches.submitMove(a.id, id, { expectedVersion: 0, action: add(3) });
  await matches.submitMove(b.id, id, { expectedVersion: 1, action: add(1) });
  return matches.submitMove(a.id, id, { expectedVersion: 2, action: add(1) });
}

const dbOne = async <T>(sql: string, values: unknown[] = []): Promise<T> =>
  (await db.admin.query(sql, values)).rows[0] as T;

describe('resigning a match', () => {
  it('Pool: the other player takes the pot, the resigner is charged only the stake', async () => {
    const { a, b, id } = await started('pool');
    const m = await matches.resign(a.id, id);
    expect(m.status).toBe('finished');
    expect(await balanceOf(db, a.id)).toBe(GRANT - STAKE);
    expect(await balanceOf(db, b.id)).toBe(GRANT + STAKE);
    const results = await db.admin.query(
      `SELECT user_id, result, placement FROM match_players WHERE match_id = $1`,
      [id],
    );
    const by = Object.fromEntries(results.rows.map((r) => [r.user_id, r.result]));
    expect(by[b.id]).toBe('win');
    expect(by[a.id]).toBe('loss');
  });

  it('Free: records a forfeit and no money moves', async () => {
    const { a, b, id } = await started('free');
    await matches.resign(b.id, id);
    const r = await db.admin.query(
      `SELECT user_id, result FROM match_players WHERE match_id = $1`,
      [id],
    );
    const by = Object.fromEntries(r.rows.map((x) => [x.user_id, x.result]));
    expect(by[b.id]).toBe('forfeit');
    expect(by[a.id]).toBe('win');
    expect(await balanceOf(db, a.id)).toBe(GRANT);
  });

  it('a retry changes nothing, and nobody else can resign it', async () => {
    const { a, b, id } = await started('pool');
    await matches.resign(a.id, id);
    const first = await balanceOf(db, b.id);
    await expect(matches.resign(a.id, id)).resolves.toMatchObject({ status: 'finished' });
    expect(await balanceOf(db, b.id)).toBe(first);
    await expect(matches.resign(b.id, id)).rejects.toMatchObject(code('match_not_open'));
    const stranger = await fundedUser(db);
    await expect(matches.resign(stranger.id, id)).rejects.toMatchObject(code('match_not_found'));
  });

  it('is refused before the match starts', async () => {
    const p = await pair();
    const m = await matches.create(p.a.id, {
      id: randomUUID(),
      conversationId: p.conv,
      gameSlug: 'edge_race',
      mode: 'pool',
      stakeKobo: STAKE,
      allowCounter: false,
    });
    await expect(matches.resign(p.a.id, m.id)).rejects.toMatchObject(code('match_not_open'));
    await matches.cancel(p.a.id, m.id);
  });
});

describe('disputing a Pool result', () => {
  it('opens one dispute with a reference, readable by the player and idempotent', async () => {
    const { a, b, id } = await started('pool');
    await aWins(id, a, b);
    const before = await disputes.info(b.id, id);
    expect(before).toMatchObject({ dispute: null, canDispute: true, blockedBy: null });
    expect(before.windowEndsAt).not.toBeNull();

    const d = await disputes.open(b.id, id, { reason: 'cheat', note: 'Too perfect' });
    expect(d).toMatchObject({ status: 'open', reason: 'cheat', note: 'Too perfect', matchId: id });
    expect(d.reference).toMatch(/^DY-DSP-[0-9A-F]{6}$/);
    expect(await disputes.open(b.id, id, { reason: 'other' })).toMatchObject({
      id: d.id,
      reason: 'cheat',
    });
    expect((await disputes.info(b.id, id)).canDispute).toBe(false);
    expect((await disputes.info(a.id, id)).dispute).toBeNull(); // the other player sees no dispute of mine
    // no money moved: opening a dispute neither freezes nor refunds
    expect(await balanceOf(db, b.id)).toBe(GRANT - STAKE);
    expect(await balanceOf(db, a.id)).toBe(GRANT + STAKE);
  });

  it('only for a finished Pool match you played, inside the window', async () => {
    const free = await started('free');
    await aWins(free.id, free.a, free.b);
    await expect(disputes.open(free.b.id, free.id, { reason: 'score' })).rejects.toMatchObject(
      code('dispute_not_allowed'),
    );
    expect((await disputes.info(free.b.id, free.id)).blockedBy).toBe('not_pool');

    const running = await started('pool');
    await expect(
      disputes.open(running.b.id, running.id, { reason: 'glitch' }),
    ).rejects.toMatchObject(code('dispute_not_allowed'));
    expect((await disputes.info(running.b.id, running.id)).blockedBy).toBe('not_finished');

    const done = await started('pool');
    await aWins(done.id, done.a, done.b);
    const stranger = await fundedUser(db);
    await expect(disputes.open(stranger.id, done.id, { reason: 'cheat' })).rejects.toMatchObject(
      code('match_not_found'),
    );
    // the database stamps finished_at with its own clock, so age the match instead of moving ours
    await db.admin.query(
      `UPDATE matches SET finished_at = now() - interval '25 hours' WHERE id = $1`,
      [done.id],
    );
    await expect(disputes.open(done.b.id, done.id, { reason: 'cheat' })).rejects.toMatchObject(
      code('dispute_window_closed'),
    );
    expect((await disputes.info(done.b.id, done.id)).blockedBy).toBe('window_closed');
  });

  it('limits how many a person can open in a day', async () => {
    await db.admin.query(
      `INSERT INTO app_config (key, value) VALUES ('disputes_per_day', '1')
       ON CONFLICT (key) DO UPDATE SET value = '1'`,
    );
    const x = await started('pool');
    await aWins(x.id, x.a, x.b);
    const y = await started('pool');
    await aWins(y.id, y.a, y.b);
    await disputes.open(x.b.id, x.id, { reason: 'cheat' });
    // a different person is unaffected
    await disputes.open(y.b.id, y.id, { reason: 'cheat' });
    const z = await started('pool');
    await matches.submitMove(z.a.id, z.id, { expectedVersion: 0, action: add(3) });
    await matches.submitMove(z.b.id, z.id, { expectedVersion: 1, action: add(1) });
    await matches.submitMove(z.a.id, z.id, { expectedVersion: 2, action: add(1) });
    await expect(disputes.open(z.b.id, z.id, { reason: 'cheat' })).resolves.toBeDefined();
    await expect(disputes.open(x.b.id, z.id, { reason: 'cheat' })).rejects.toMatchObject(
      code('match_not_found'),
    );
    await db.admin.query(`DELETE FROM app_config WHERE key = 'disputes_per_day'`);
  });

  it('a moderator moves it along; a reversal needs its own reversing transaction; the API role cannot', async () => {
    const { a, b, id } = await started('pool');
    await aWins(id, a, b);
    const d = await disputes.open(b.id, id, { reason: 'score' });
    const admin = await fundedUser(db);

    await expectPermissionDenied(
      db.app.query(`SELECT resolve_dispute($1, 'upheld', 'x', $2)`, [d.id, admin.id]),
    );
    await expectPermissionDenied(db.app.query(`SELECT * FROM moderation_dispute_queue`));

    const queue = await db.admin.query(`SELECT * FROM moderation_dispute_queue WHERE id = $1`, [
      d.id,
    ]);
    expect(queue.rows[0]).toMatchObject({
      reference: d.reference,
      disputer: b.username,
      opponents: a.username,
      status: 'open',
    });
    expect(Number(queue.rows[0].pot_kobo)).toBe(2 * STAKE);

    await db.admin.query(`SELECT resolve_dispute($1, 'reviewing', NULL, $2)`, [d.id, admin.id]);
    expect((await disputes.info(b.id, id)).dispute?.status).toBe('reviewing');

    // 'reversed' without a reversal transaction is refused (a payout is never undone by editing a row)
    await expect(
      db.admin.query(`SELECT resolve_dispute($1, 'reversed', 'no', $2)`, [d.id, admin.id]),
    ).rejects.toThrow('dyce:reversal_required');

    const settle = await dbOne<{ id: string }>(
      `SELECT id FROM ledger_txns WHERE kind = 'payout' AND meta->>'match_id' = $1`,
      [id],
    );
    const rev = await dbOne<{ txn_id: string }>(`SELECT * FROM reverse_txn($1, 'dispute', $2)`, [
      settle.id,
      admin.id,
    ]);
    await db.admin.query(`SELECT resolve_dispute($1, 'reversed', 'Corrected', $2, $3)`, [
      d.id,
      admin.id,
      rev.txn_id,
    ]);
    await db.admin.query(`SELECT resolve_dispute($1, 'reversed', 'Corrected', $2, $3)`, [
      d.id,
      admin.id,
      rev.txn_id,
    ]); // idempotent
    const after = (await disputes.info(b.id, id)).dispute!;
    expect(after).toMatchObject({ status: 'reversed', decisionNote: 'Corrected' });
    expect(after.resolvedAt).not.toBeNull();
    await expect(
      db.admin.query(`SELECT resolve_dispute($1, 'upheld', 'again', $2)`, [d.id, admin.id]),
    ).rejects.toThrow('dyce:dispute_resolved');
  });
});

describe('deleting an account', () => {
  async function givenDeletionDue(user: TestUser) {
    await account.requestDeletion(user.id, user.username);
    await db.admin.query(
      `UPDATE account_deletions SET execute_after = now() - interval '1 minute' WHERE user_id = $1`,
      [user.id],
    );
  }

  it('asks for the username, then waits out a grace period that signing in cancels', async () => {
    const u = await fundedUser(db);
    await expect(account.requestDeletion(u.id, 'someone_else')).rejects.toMatchObject(
      code('username_mismatch'),
    );
    expect((await account.deletionStatus(u.id)).pending).toBe(false);

    await db.admin.query(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')`,
      [u.id, randomUUID(), Buffer.from(randomUUID())],
    );
    const s = await account.requestDeletion(u.id, `@${u.username.toUpperCase()}`);
    expect(s.pending).toBe(true);
    const days = (new Date(s.executeAfter!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThanOrEqual(30);
    const live = await db.admin.query(
      `SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`,
      [u.id],
    );
    expect(live.rows[0].n).toBe(0); // every session ended

    // asking again keeps the original date
    const again = await account.requestDeletion(u.id, u.username);
    expect(again.executeAfter).toBe(s.executeAfter);

    // nothing is erased before the date
    expect(await account.processDue()).toEqual({ done: 0, deferred: 0 });
    expect(await balanceOf(db, u.id)).toBe(GRANT);

    const cancelled = await account.cancelDeletion(u.id);
    expect(cancelled.pending).toBe(false);
    await db.admin.query(
      `UPDATE account_deletions SET execute_after = now() - interval '1 day' WHERE user_id = $1`,
      [u.id],
    );
    expect(await account.processDue()).toEqual({ done: 0, deferred: 0 }); // cancelled requests are never run
  });

  it('clears the balance with a balanced entry, returns open Pool stakes, keeps games as "Deleted player"', async () => {
    const { a, b, conv } = await pair();
    // a game in progress and a Pool invite nobody answered
    const running = await matches.create(a.id, {
      id: randomUUID(),
      conversationId: conv,
      gameSlug: 'edge_race',
      mode: 'pool',
      stakeKobo: STAKE,
      allowCounter: false,
    });
    await matches.accept(b.id, running.id);
    expect(await balanceOf(db, b.id)).toBe(GRANT - STAKE);
    // one finished game so there is history
    const done = await started('free');
    await aWins(done.id, done.a, done.b);
    const finishedAsA = done.a;
    await friends.sendRequest(a.id, finishedAsA.id);

    await givenDeletionDue(a);
    expect(await account.processDue()).toEqual({ done: 1, deferred: 0 });

    // balance cleared, the other player's stake is back
    expect(await balanceOf(db, a.id)).toBe(0);
    expect(await balanceOf(db, b.id)).toBe(GRANT);
    expect((await matches.get(b.id, running.id)).status).toBe('cancelled');
    const wallet = await dbOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM ledger_txns WHERE idempotency_key = $1`,
      [`account_delete:${a.id}`],
    );
    expect(wallet.n).toBe(1);

    // the person is gone, the history stays
    const p = await dbOne<{ username: string; display_name: string; disabled_at: Date | null }>(
      `SELECT pr.username, pr.display_name, u.disabled_at FROM profiles pr JOIN users u ON u.id = pr.id WHERE pr.id = $1`,
      [a.id],
    );
    expect(p.username).toMatch(/^deleted_[0-9a-f]{8}$/);
    expect(p.display_name).toBe('Deleted player');
    expect(p.disabled_at).not.toBeNull();
    const ties = await dbOne<{ n: number }>(
      `SELECT (SELECT count(*) FROM friendships WHERE user_low = $1 OR user_high = $1)::int AS n`,
      [a.id],
    );
    expect(ties.n).toBe(0);
    const view = await matches.get(b.id, running.id);
    expect(view.players.find((x) => x.userId === a.id)?.username).toMatch(/^deleted_/);
  });

  it('is idempotent: a second run does nothing and the ledger has one clearing entry', async () => {
    const u = await fundedUser(db);
    await givenDeletionDue(u);
    expect(await account.eraseOne(u.id)).toBe(true);
    expect(await account.eraseOne(u.id)).toBe(true);
    const n = await dbOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM ledger_txns WHERE idempotency_key = $1`,
      [`account_delete:${u.id}`],
    );
    expect(n.n).toBe(1);
    expect(await balanceOf(db, u.id)).toBe(0);
    await expect(account.requestDeletion(u.id, u.username)).rejects.toThrow();
  });

  it('frees the phone number so the same person can start again', async () => {
    const u = await fundedUser(db);
    const before = await dbOne<{ phone_hash: Buffer }>(
      `SELECT phone_hash FROM users WHERE id = $1`,
      [u.id],
    );
    await givenDeletionDue(u);
    await account.eraseOne(u.id);
    const after = await dbOne<{ phone_hash: Buffer }>(
      `SELECT phone_hash FROM users WHERE id = $1`,
      [u.id],
    );
    expect(after.phone_hash.equals(before.phone_hash)).toBe(false);
    await db.app.query('INSERT INTO users (phone_hash) VALUES ($1)', [before.phone_hash]); // no unique clash
  });

  it('leaves a waiting space first (seat fee back), but waits for a live one', async () => {
    const host = await fundedUser(db);
    const guest = await fundedUser(db);
    await friends.sendRequest(host.id, guest.id);
    await friends.accept(guest.id, host.id);
    const mk = (id: string) =>
      spaces.create(host.id, {
        id,
        gameSlug: 'whot',
        name: 'Night',
        maxSeats: 4,
        visibility: 'friends',
        startRule: 'host',
        mode: 'pool',
        seatFeeKobo: FEE,
      });
    const waiting = await mk(randomUUID());
    await spaces.join(guest.id, waiting.code);
    expect(await balanceOf(db, guest.id)).toBe(GRANT - FEE);

    await givenDeletionDue(guest);
    expect(await account.eraseOne(guest.id)).toBe(true);
    expect(await balanceOf(db, guest.id)).toBe(0); // fee came back, then the balance was cleared
    expect((await spaces.get(host.id, waiting.id)).members.map((m) => m.userId)).toEqual([host.id]);

    // a live space: deferred, nothing changes
    const live = await mk(randomUUID());
    const other = await fundedUser(db);
    await friends.sendRequest(host.id, other.id);
    await friends.accept(other.id, host.id);
    await spaces.join(other.id, live.code);
    await db.admin.query(`UPDATE spaces SET status = 'live' WHERE id = $1`, [live.id]);
    await givenDeletionDue(other);
    expect(await account.processDue()).toEqual({ done: 0, deferred: 1 });
    expect(await balanceOf(db, other.id)).toBe(GRANT - FEE);
    await db.admin.query(`UPDATE spaces SET status = 'ended' WHERE id = $1`, [live.id]);
    expect(await account.processDue()).toEqual({ done: 1, deferred: 0 });
  });
});

describe('downloading my data', () => {
  it('is the person’s own data, with no phone number or hash and nothing of anyone else’s', async () => {
    const { a, b, conv } = await pair();
    const m = await matches.create(a.id, {
      id: randomUUID(),
      conversationId: conv,
      gameSlug: 'edge_race',
      mode: 'pool',
      stakeKobo: STAKE,
      allowCounter: false,
    });
    await matches.accept(b.id, m.id);
    await aWins(m.id, a, b);
    await chat.send(a.id, conv, { id: randomUUID(), body: 'hello from a' });
    await chat.send(b.id, conv, { id: randomUUID(), body: 'secret from b' });
    await db.admin.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [
      a.id,
      (await fundedUser(db)).id,
    ]);

    const data = await account.exportData(a.id);
    expect(data).toMatchObject({ format: 'dyce-data-export', version: 1 });
    expect(data.profile.username).toBe(a.username);
    expect(data.wallet.balanceKobo).toBe(GRANT + STAKE);
    expect(data.wallet.transactions.map((t) => t.kind)).toEqual(
      expect.arrayContaining(['grant', 'stake', 'payout']),
    );
    expect(data.matches).toHaveLength(1);
    expect(data.matches[0]).toMatchObject({ mode: 'pool', result: 'win', opponents: [b.username] });
    expect(data.friends).toEqual([b.username]);
    expect(data.blocked).toHaveLength(1);
    expect(data.messagesSent.map((x) => x.body)).toContain('hello from a');
    const text = JSON.stringify(data);
    expect(text).not.toContain('secret from b');
    expect(text).not.toMatch(/phone/i);
    expect(text).not.toContain(b.id); // other people appear by username only
  });
});

describe('the space you were in', () => {
  async function room(mode: 'free' | 'pool' = 'pool') {
    const host = await fundedUser(db);
    const guest = await fundedUser(db);
    await friends.sendRequest(host.id, guest.id);
    await friends.accept(guest.id, host.id);
    const s = await spaces.create(host.id, {
      id: randomUUID(),
      gameSlug: 'whot',
      name: 'Sunday Game Night',
      maxSeats: 4,
      visibility: 'friends',
      startRule: 'host',
      mode,
      seatFeeKobo: mode === 'pool' ? FEE : 0,
    });
    await spaces.join(guest.id, s.code);
    return { host, guest, s };
  }

  it('says the host closed it, and that the seat fee came back', async () => {
    const { host, guest, s } = await room();
    await spaces.close(host.id, s.id);
    const v = await spaces.get(guest.id, s.id);
    expect(v).toMatchObject({ seated: false, members: [], matchId: null });
    expect(v.exit).toMatchObject({ reason: 'host_closed', refundedKobo: FEE });
    expect(v.exit?.hostName).toBe(host.username);
    expect(await balanceOf(db, guest.id)).toBe(GRANT);
  });

  it('says you were removed, or that you left, and refunds the same', async () => {
    const { host, guest, s } = await room();
    await spaces.remove(host.id, s.id, guest.id);
    expect((await spaces.get(guest.id, s.id)).exit).toMatchObject({
      reason: 'removed',
      refundedKobo: FEE,
    });
    await expect(spaces.join(guest.id, s.code)).rejects.toMatchObject(code('space_removed'));

    const r2 = await room('free');
    await spaces.leave(r2.guest.id, r2.s.id);
    expect((await spaces.get(r2.guest.id, r2.s.id)).exit).toMatchObject({
      reason: 'left',
      refundedKobo: 0,
    });
  });

  it('says it timed out when nobody started it', async () => {
    const { guest, s } = await room();
    clock.t = T0 + 7 * 3_600_000;
    await spaces.expireStaleSpaces();
    expect((await spaces.get(guest.id, s.id)).exit).toMatchObject({
      reason: 'expired',
      refundedKobo: FEE,
    });
  });

  it('tells a stranger nothing, and a full space names itself to someone with its code', async () => {
    const { host, s } = await room();
    const stranger = await fundedUser(db);
    await expect(spaces.get(stranger.id, s.id)).rejects.toMatchObject(code('space_not_found'));

    const small = await spaces.create(host.id, {
      id: randomUUID(),
      gameSlug: 'whot',
      name: 'Tiny',
      maxSeats: 2,
      visibility: 'invite',
      startRule: 'host',
    });
    const a = await fundedUser(db);
    const b = await fundedUser(db);
    await spaces.join(a.id, small.code);
    await expect(spaces.join(b.id, small.code)).rejects.toMatchObject({
      code: 'space_full',
      details: { name: 'Tiny', gameSlug: 'whot', seats: 2 },
    });
  });
});
