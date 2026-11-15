import { randomUUID } from 'node:crypto';
import { MessagesService } from '../../src/chat/messages.service.ts';
import { LedgerRepo } from '../../src/ledger/ledger.repo.ts';
import { SafetyService } from '../../src/safety/safety.service.ts';
import { FriendsService } from '../../src/social/friends.service.ts';
import { WalletService } from '../../src/wallet/wallet.service.ts';
import { createTestDb, type TestDb, type TestUser } from '../testing/testDb.ts';
import { fundedUser } from './helpers.ts';

let db: TestDb;
let safety: SafetyService;
let chat: MessagesService;
let friends: FriendsService;
let wallet: WalletService;
const clock = { t: new Date('2026-11-14T10:00:00Z').getTime() };

beforeAll(async () => {
  db = await createTestDb();
  chat = new MessagesService(db.app, { publish: () => undefined });
  friends = new FriendsService(db.app);
  wallet = new WalletService(db.app, new LedgerRepo(db.app), chat);
  safety = new SafetyService(db.app, () => new Date(clock.t));
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  clock.t = new Date('2026-11-14T10:00:00Z').getTime();
});

const code = (c: string) => expect.objectContaining({ code: c });
const person = (): Promise<TestUser> => fundedUser(db);
async function befriend(a: TestUser, b: TestUser) {
  await friends.sendRequest(a.id, b.id);
  await friends.accept(b.id, a.id);
}
const say = async (from: TestUser, to: TestUser, body: string) => {
  const c = await chat.openDirect(from.id, to.id);
  await chat.send(from.id, c.id, { id: randomUUID(), body });
  return c.id;
};
const isBlocked = async (a: TestUser, b: TestUser) =>
  (
    await db.admin.query(`SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`, [
      a.id,
      b.id,
    ])
  ).rows.length > 0;
const reportRows = async (reporter: TestUser) =>
  (
    await db.admin.query(`SELECT * FROM reports WHERE reporter_id = $1 ORDER BY created_at`, [
      reporter.id,
    ])
  ).rows;

describe('blocking', () => {
  it('blocks someone, idempotently, and lists them newest first', async () => {
    const me = await person();
    const a = await person();
    const b = await person();
    await safety.block(me.id, a.id);
    await safety.block(me.id, a.id);
    clock.t += 60_000;
    await db.admin.query(
      `INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES ($1, $2, now() + interval '1 minute')`,
      [me.id, b.id],
    );
    const list = (await safety.list(me.id)).blocked;
    expect(list.map((x) => x.user.id)).toEqual([b.id, a.id]);
    expect(list[1]!.user.username).toBe(a.username);
    expect(await isBlocked(me, a)).toBe(true);
    expect(await isBlocked(a, me)).toBe(false); // one-way
  });

  it('refuses blocking yourself or someone who does not exist', async () => {
    const me = await person();
    await expect(safety.block(me.id, me.id)).rejects.toEqual(code('cannot_add_self'));
    await expect(safety.block(me.id, randomUUID())).rejects.toEqual(code('user_not_found'));
  });

  it('keeps each person’s list to themselves', async () => {
    const me = await person();
    const other = await person();
    const target = await person();
    await safety.block(me.id, target.id);
    expect((await safety.list(other.id)).blocked).toEqual([]);
  });

  it('ends a friendship, and unblocking does not bring it back', async () => {
    const me = await person();
    const them = await person();
    await befriend(me, them);
    await safety.block(me.id, them.id);
    expect((await friends.list(me.id)).friends).toEqual([]);
    expect((await friends.list(them.id)).friends).toEqual([]);
    await safety.unblock(me.id, them.id);
    expect((await friends.list(me.id)).friends).toEqual([]);
    expect(await friends.sendRequest(me.id, them.id)).toEqual({ relationship: 'pending_out' });
  });

  it('removes a pending friend request too', async () => {
    const me = await person();
    const them = await person();
    await friends.sendRequest(them.id, me.id);
    await safety.block(me.id, them.id);
    expect((await friends.requests(me.id)).incoming).toEqual([]);
  });

  it('unblocking is idempotent and works on someone you never blocked', async () => {
    const me = await person();
    const them = await person();
    await safety.unblock(me.id, them.id);
    await safety.block(me.id, them.id);
    await safety.unblock(me.id, them.id);
    await safety.unblock(me.id, them.id);
    expect((await safety.list(me.id)).blocked).toEqual([]);
  });

  it('two people blocking each other at once is fine', async () => {
    const a = await person();
    const b = await person();
    await Promise.all([safety.block(a.id, b.id), safety.block(b.id, a.id)]);
    expect(await isBlocked(a, b)).toBe(true);
    expect(await isBlocked(b, a)).toBe(true);
  });
});

describe('what blocking cuts off', () => {
  it('hides the conversation from the blocker and stops the blocked person writing', async () => {
    const me = await person();
    const them = await person();
    await befriend(me, them);
    const conv = await say(them, me, 'hello');
    expect((await chat.list(me.id)).conversations).toHaveLength(1);
    await safety.block(me.id, them.id);
    expect((await chat.list(me.id)).conversations).toEqual([]);
    // they can no longer reach you, and are not told why: you look like you don't exist
    await expect(chat.send(them.id, conv, { id: randomUUID(), body: 'hey?' })).rejects.toEqual(
      code('user_not_found'),
    );
    await expect(chat.openDirect(them.id, me.id)).rejects.toEqual(code('user_not_found'));
    // you told them apart: sending to someone you blocked says so
    await expect(chat.send(me.id, conv, { id: randomUUID(), body: 'x' })).rejects.toEqual(
      code('blocked'),
    );
    expect(await chat.typingTarget(them.id, conv)).toBeNull();
  });

  it('brings the chat back when you unblock (the history was never deleted)', async () => {
    const me = await person();
    const them = await person();
    await befriend(me, them);
    await say(them, me, 'hello');
    await safety.block(me.id, them.id);
    await safety.unblock(me.id, them.id);
    await befriend(me, them);
    expect((await chat.list(me.id)).conversations).toHaveLength(1);
  });

  it('stops money in both directions and requests from the blocked person', async () => {
    const me = await person();
    const them = await person();
    await befriend(me, them);
    await safety.block(me.id, them.id);
    const send = (from: TestUser, to: TestUser) =>
      wallet.send(from.id, {
        toUserId: to.id,
        amountKobo: 100,
        note: '',
        idempotencyKey: `k-${randomUUID()}`,
      });
    await expect(send(them, me)).rejects.toEqual(
      expect.objectContaining({
        code: expect.stringMatching(/user_not_found|recipient_not_reachable|blocked/),
      }),
    );
    await expect(send(me, them)).rejects.toEqual(
      expect.objectContaining({ code: expect.stringMatching(/blocked|recipient_not_reachable/) }),
    );
    const view = await wallet.createRequest(me.id, { note: '', delivery: 'qr' });
    await expect(wallet.getRequest(them.id, view.code)).rejects.toEqual(code('request_not_found'));
  });

  it('hides the blocker from friend lookups and stops new friend requests', async () => {
    const me = await person();
    const them = await person();
    await safety.block(me.id, them.id);
    await expect(friends.findByUsername(them.id, me.username)).rejects.toEqual(
      code('user_not_found'),
    );
    await expect(friends.sendRequest(them.id, me.id)).rejects.toEqual(code('user_not_found'));
    await expect(friends.sendRequest(me.id, them.id)).rejects.toEqual(code('blocked'));
  });
});

describe('reporting', () => {
  const report = (reporter: TestUser, target: TestUser, extra: Record<string, unknown> = {}) =>
    safety.report(reporter.id, {
      userId: target.id,
      reason: 'abuse',
      alsoBlock: false,
      ...extra,
    } as never);

  it('files a report without telling the person, and without blocking unless asked', async () => {
    const me = await person();
    const them = await person();
    const r = await report(me, them, { note: 'kept insulting me' });
    expect(r.blocked).toBe(false);
    const rows = await reportRows(me);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: r.reportId,
      target_user_id: them.id,
      reason: 'abuse',
      note: 'kept insulting me',
      status: 'open',
    });
    // the reported person has nothing to see: no report of theirs, no notification, no change
    expect(await reportRows(them)).toEqual([]);
    expect(await isBlocked(me, them)).toBe(false);
  });

  it('can also block them in the same step', async () => {
    const me = await person();
    const them = await person();
    const r = await report(me, them, { alsoBlock: true });
    expect(r.blocked).toBe(true);
    expect(await isBlocked(me, them)).toBe(true);
  });

  it('reports a person you have already blocked', async () => {
    const me = await person();
    const them = await person();
    await safety.block(me.id, them.id);
    expect((await report(me, them)).blocked).toBe(true);
  });

  it('attaches the recent messages of your chat as evidence', async () => {
    const me = await person();
    const them = await person();
    await befriend(me, them);
    const conv = await say(them, me, 'first');
    await say(me, them, 'second');
    const last = await chat.messages(me.id, conv);
    const r = await report(me, them, { conversationId: conv, messageId: last.messages[0]!.id });
    const row = (await reportRows(me)).find((x) => x.id === r.reportId)!;
    expect(row.conversation_id).toBe(conv);
    expect(row.message_id).toBe(last.messages[0]!.id);
    expect(row.evidence.messages.map((m: { body: string }) => m.body)).toEqual(['first', 'second']);
    expect(row.evidence.messages[0]).toMatchObject({ senderId: them.id, kind: 'text' });
    // the snapshot survives later deletions
    await db.admin.query(`UPDATE messages SET deleted_at = now() WHERE conversation_id = $1`, [
      conv,
    ]);
    expect((await reportRows(me)).find((x) => x.id === r.reportId)!.evidence.messages).toHaveLength(
      2,
    );
  });

  it('keeps only the latest 20 messages', async () => {
    const me = await person();
    const them = await person();
    await befriend(me, them);
    const conv = (await chat.openDirect(me.id, them.id)).id;
    for (let i = 0; i < 25; i++) {
      await db.admin.query(
        `INSERT INTO messages (id, conversation_id, sender_id, kind, body, created_at) VALUES ($1, $2, $3, 'text', $4, $5)`,
        [randomUUID(), conv, them.id, `m${i}`, new Date(Date.UTC(2026, 10, 14, 9, i))],
      );
    }
    const r = await report(me, them, { conversationId: conv });
    const ev = (await reportRows(me)).find((x) => x.id === r.reportId)!.evidence.messages;
    expect(ev).toHaveLength(20);
    expect(ev[0].body).toBe('m5');
    expect(ev[19].body).toBe('m24');
  });

  it('refuses to attach a conversation that is not yours with them', async () => {
    const me = await person();
    const them = await person();
    const a = await person();
    const b = await person();
    await befriend(a, b);
    const others = await say(a, b, 'private');
    await expect(report(me, them, { conversationId: others })).rejects.toEqual(
      code('conversation_not_found'),
    );
    await expect(report(me, them, { conversationId: randomUUID() })).rejects.toEqual(
      code('conversation_not_found'),
    );
    // and not your chat with someone else
    await befriend(me, a);
    const mine = await say(a, me, 'hi');
    await expect(report(me, them, { conversationId: mine })).rejects.toEqual(
      code('conversation_not_found'),
    );
    expect(await reportRows(me)).toEqual([]);
  });

  it('refuses a message that is not in that conversation', async () => {
    const me = await person();
    const them = await person();
    await befriend(me, them);
    const conv = await say(them, me, 'hi');
    const a = await person();
    const b = await person();
    await befriend(a, b);
    const otherConv = await say(a, b, 'x');
    const stray = (await chat.messages(a.id, otherConv)).messages[0]!.id;
    await expect(report(me, them, { conversationId: conv, messageId: stray })).rejects.toEqual(
      code('conversation_not_found'),
    );
    await expect(report(me, them, { messageId: stray })).rejects.toEqual(code('validation_failed'));
  });

  it('refuses reporting yourself or someone who does not exist', async () => {
    const me = await person();
    await expect(report(me, me)).rejects.toEqual(code('cannot_add_self'));
    await expect(
      safety.report(me.id, { userId: randomUUID(), reason: 'spam', alsoBlock: false }),
    ).rejects.toEqual(code('user_not_found'));
  });

  it('treats the same report twice as one, but a different reason as a new one', async () => {
    const me = await person();
    const them = await person();
    const first = await report(me, them);
    const again = await report(me, them);
    expect(again.reportId).toBe(first.reportId);
    const other = await report(me, them, { reason: 'scam' });
    expect(other.reportId).not.toBe(first.reportId);
    expect(await reportRows(me)).toHaveLength(2);
    clock.t += 25 * 3_600_000; // a day later it's a fresh report
    expect((await report(me, them)).reportId).not.toBe(first.reportId);
  });

  it('limits how many reports one person can file per day', async () => {
    await db.admin.query(
      `INSERT INTO app_config (key, value) VALUES ('reports_per_day', '2') ON CONFLICT (key) DO UPDATE SET value = '2'`,
    );
    try {
      const me = await person();
      await report(me, await person());
      await report(me, await person());
      await expect(report(me, await person())).rejects.toEqual(code('reports_rate_limited'));
    } finally {
      await db.admin.query(`UPDATE app_config SET value = '20' WHERE key = 'reports_per_day'`);
    }
  });

  it('the database only accepts the known reasons and a note of sensible length', async () => {
    const me = await person();
    const them = await person();
    await expect(
      db.admin.query(
        `INSERT INTO reports (reporter_id, target_user_id, reason) VALUES ($1, $2, 'because')`,
        [me.id, them.id],
      ),
    ).rejects.toThrow();
    await expect(
      db.admin.query(
        `INSERT INTO reports (reporter_id, target_user_id, reason, note) VALUES ($1, $2, 'spam', $3)`,
        [me.id, them.id, 'x'.repeat(501)],
      ),
    ).rejects.toThrow();
  });

  it('keeps a report even if the person reported is blocked, disabled or later blocks the reporter', async () => {
    const me = await person();
    const them = await person();
    const r = await report(me, them);
    await db.admin.query(`UPDATE users SET disabled_at = now() WHERE id = $1`, [them.id]);
    await db.admin.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [
      them.id,
      me.id,
    ]);
    expect((await reportRows(me)).map((x) => x.id)).toContain(r.reportId);
  });
});
