import { randomUUID } from 'node:crypto';
import type { RealtimeEvent } from '@dyce/shared';
import { MessagesService, type Publisher } from '../../src/chat/messages.service.ts';
import { LedgerRepo } from '../../src/ledger/ledger.repo.ts';
import { WalletService } from '../../src/wallet/wallet.service.ts';
import {
  createMatch,
  createTestDb,
  balanceOf,
  setBalance,
  type TestDb,
  type TestUser,
} from '../testing/testDb.ts';
import { expectLedgerClean, fundedUser } from './helpers.ts';

let db: TestDb;
let wallet: WalletService;
let chat: MessagesService;
const published: { users: readonly string[]; event: RealtimeEvent }[] = [];
const publisher: Publisher = { publish: (users, event) => void published.push({ users, event }) };

beforeAll(async () => {
  db = await createTestDb();
  chat = new MessagesService(db.app, publisher);
  wallet = new WalletService(db.app, new LedgerRepo(db.app), chat);
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  published.length = 0;
});

const NAIRA = 100;
const key = () => `k-${randomUUID()}`;
const code = (c: string) => expect.objectContaining({ code: c });
const person = (): Promise<TestUser> => fundedUser(db);

async function befriend(a: TestUser, b: TestUser) {
  await db.admin.query(
    `INSERT INTO friendships (user_low, user_high, status, requested_by)
     VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid), 'accepted', $1)`,
    [a.id, b.id],
  );
}
const block = (blocker: TestUser, blocked: TestUser) =>
  db.admin.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [
    blocker.id,
    blocked.id,
  ]);
const send = (from: TestUser, to: TestUser, naira: number, note = '', k = key()) =>
  wallet.send(from.id, { toUserId: to.id, amountKobo: naira * NAIRA, note, idempotencyKey: k });
const messagesOf = async (a: TestUser, b: TestUser) => {
  const c = await chat.openDirect(a.id, b.id);
  return (await chat.messages(a.id, c.id)).messages;
};

describe('summary and top-up', () => {
  it('shows the balance, limits and a closed top-up for a funded user', async () => {
    const u = await person();
    const s = await wallet.summary(u.id);
    expect(s.balanceKobo).toBe(200_000 * NAIRA);
    expect(s.topup).toMatchObject({
      available: false,
      amountKobo: 20_000 * NAIRA,
      thresholdKobo: 10_000 * NAIRA,
    });
    expect(s.limits).toEqual({
      perSendKobo: 50_000 * NAIRA,
      dailyKobo: 200_000 * NAIRA,
      sentTodayKobo: 0,
    });
    expect(s.openRequests).toBe(0);
  });

  it('counts what you sent today toward the daily limit', async () => {
    const a = await person();
    const b = await person();
    await befriend(a, b);
    await send(a, b, 1_500);
    expect((await wallet.summary(a.id)).limits.sentTodayKobo).toBe(1_500 * NAIRA);
  });

  it('offers the free top-up when the balance is low, once a day', async () => {
    const u = await person();
    await setBalance(db, u.id, 5_000 * NAIRA);
    expect((await wallet.summary(u.id)).topup.available).toBe(true);
    const r = await wallet.claimTopup(u.id);
    expect(r.balanceKobo).toBe(25_000 * NAIRA);
    expect((await wallet.summary(u.id)).topup.available).toBe(false);
    await setBalance(db, u.id, 100 * NAIRA);
    await expect(wallet.claimTopup(u.id)).rejects.toEqual(code('topup_already_claimed'));
  });

  it('refuses a top-up when you are not low on cash', async () => {
    const u = await person();
    await expect(wallet.claimTopup(u.id)).rejects.toEqual(code('balance_too_high'));
  });
});

describe('send', () => {
  it('moves the money and puts a "Sent" card in the chat, live, for both people', async () => {
    const a = await person();
    const b = await person();
    await befriend(a, b);
    const r = await send(a, b, 5_000, 'suya');
    expect(r).toMatchObject({ replayed: false, balanceKobo: 195_000 * NAIRA });
    expect(await balanceOf(db, b.id)).toBe(205_000 * NAIRA);

    const [card] = await messagesOf(b, a);
    expect(card).toMatchObject({
      kind: 'money_sent',
      senderId: a.id,
      body: 'Sent Ð5,000 · suya',
      payload: { amountKobo: 5_000 * NAIRA, note: 'suya', txnId: r.txnId },
    });
    const live = published.filter((p) => p.event.type === 'message');
    expect(live.at(-1)!.users).toEqual(expect.arrayContaining([a.id, b.id]));
    await expectLedgerClean(db);
  });

  it('shows the card as the last message in both chat lists', async () => {
    const a = await person();
    const b = await person();
    await befriend(a, b);
    await send(a, b, 1_000);
    for (const who of [a, b]) {
      const list = await chat.list(who.id);
      expect(list.conversations[0]!.lastMessage).toMatchObject({
        kind: 'money_sent',
        body: 'Sent Ð1,000',
      });
    }
  });

  it('a retry with the same key sends nothing new and posts one card', async () => {
    const a = await person();
    const b = await person();
    await befriend(a, b);
    const k = key();
    const first = await send(a, b, 2_000, '', k);
    const again = await send(a, b, 2_000, '', k);
    expect(again).toMatchObject({ txnId: first.txnId, replayed: true });
    expect(await balanceOf(db, a.id)).toBe(198_000 * NAIRA);
    expect((await messagesOf(a, b)).filter((m) => m.kind === 'money_sent')).toHaveLength(1);
  });

  it('puts the card back when the first attempt died after the money moved', async () => {
    const a = await person();
    const b = await person();
    await befriend(a, b);
    const k = key();
    const first = await send(a, b, 1_000, '', k);
    await db.admin.query('DELETE FROM messages WHERE id = $1', [first.txnId]); // the lost card
    await send(a, b, 1_000, '', k);
    expect((await messagesOf(a, b)).map((m) => m.id)).toContain(first.txnId);
    expect(await balanceOf(db, a.id)).toBe(199_000 * NAIRA);
  });

  it("can't be replayed by another user reusing someone else's key", async () => {
    const a = await person();
    const b = await person();
    const c = await person();
    await befriend(a, b);
    await befriend(c, b);
    const k = key();
    const mine = await send(a, b, 1_000, '', k);
    const theirs = await send(c, b, 1_000, '', k);
    expect(theirs.txnId).not.toBe(mine.txnId);
    expect(theirs.replayed).toBe(false);
    expect(await balanceOf(db, c.id)).toBe(199_000 * NAIRA);
  });

  it('only lets you pay people you can already talk to', async () => {
    const a = await person();
    const stranger = await person();
    await expect(send(a, stranger, 100)).rejects.toEqual(code('recipient_not_reachable'));
    expect(await balanceOf(db, a.id)).toBe(200_000 * NAIRA);

    // contacts are fine
    const contact = await person();
    await db.admin.query('INSERT INTO contact_links (owner_id, contact_user_id) VALUES ($1, $2)', [
      a.id,
      contact.id,
    ]);
    await expect(send(a, contact, 100)).resolves.toBeDefined();

    // so is someone whose chat you both accepted
    const chatty = await person();
    const conv = await chat.openDirect(a.id, chatty.id);
    await chat.send(a.id, conv.id, { id: randomUUID(), body: 'hi' });
    await expect(send(a, chatty, 100)).rejects.toEqual(code('recipient_not_reachable')); // they haven't accepted yet
    await chat.accept(chatty.id, conv.id);
    await expect(send(a, chatty, 100)).resolves.toBeDefined();
  });

  it('refuses yourself, unknown people, blocked people and disabled accounts', async () => {
    const a = await person();
    const b = await person();
    const gone = await person();
    await befriend(a, b);
    await befriend(a, gone);
    await expect(send(a, a, 100)).rejects.toEqual(code('self_payment'));
    await expect(
      wallet.send(a.id, {
        toUserId: randomUUID(),
        amountKobo: 100,
        note: '',
        idempotencyKey: key(),
      }),
    ).rejects.toEqual(code('user_not_found'));
    await block(b, a);
    await expect(send(a, b, 100)).rejects.toEqual(code('blocked'));
    await db.admin.query('UPDATE users SET disabled_at = now() WHERE id = $1', [gone.id]);
    await expect(send(a, gone, 100)).rejects.toEqual(code('user_not_found'));
  });

  it('refuses more than you have, and more than the limits, leaving nothing behind', async () => {
    const a = await person();
    const b = await person();
    await befriend(a, b);
    await setBalance(db, a.id, 1_000 * NAIRA);
    await expect(send(a, b, 1_001)).rejects.toEqual(code('insufficient_funds'));
    await setBalance(db, a.id, 200_000 * NAIRA);
    await expect(send(a, b, 50_001)).rejects.toEqual(code('over_send_limit'));
    expect(await balanceOf(db, a.id)).toBe(200_000 * NAIRA);
    expect(await messagesOf(a, b)).toEqual([]);
  });

  it('two sends of the last naira at once: exactly one wins', async () => {
    const a = await person();
    const b = await person();
    const c = await person();
    await befriend(a, b);
    await befriend(a, c);
    await setBalance(db, a.id, 1_000 * NAIRA);
    const results = await Promise.allSettled([send(a, b, 1_000), send(a, c, 1_000)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await balanceOf(db, a.id)).toBe(0);
    await expectLedgerClean(db);
  });
});

describe('payment requests', () => {
  it('creates a QR request that expires in about 15 minutes and posts no card', async () => {
    const a = await person();
    const view = await wallet.createRequest(a.id, {
      amountKobo: 2_000 * NAIRA,
      note: 'suya',
      delivery: 'qr',
    });
    expect(view).toMatchObject({
      status: 'open',
      amountKobo: 2_000 * NAIRA,
      note: 'suya',
      mine: true,
      forYou: false,
      paidBy: null,
      requester: { id: a.id, username: a.username },
    });
    expect(view.code).toMatch(/^[A-Z2-7]{10}$/);
    const minutes = (Date.parse(view.expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(13);
    expect(minutes).toBeLessThan(16);
    expect((await chat.list(a.id)).conversations).toEqual([]);
    expect((await wallet.summary(a.id)).openRequests).toBe(1);
  });

  it('sends a request to a friend as a card that lasts a week', async () => {
    const a = await person();
    const b = await person();
    await befriend(a, b);
    const view = await wallet.createRequest(a.id, {
      amountKobo: 3_000 * NAIRA,
      note: 'ride',
      targetUserId: b.id,
      delivery: 'chat',
    });
    const [card] = await messagesOf(b, a);
    expect(card).toMatchObject({
      kind: 'money_request',
      body: 'Requested Ð3,000',
      payload: { code: view.code, status: 'open', amountKobo: 3_000 * NAIRA },
    });
    const days = (Date.parse(view.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect((await wallet.getRequest(b.id, view.code)).forYou).toBe(true);
  });

  it('only lets you aim a request at someone you can talk to', async () => {
    const a = await person();
    const stranger = await person();
    await expect(
      wallet.createRequest(a.id, {
        amountKobo: 100,
        note: '',
        targetUserId: stranger.id,
        delivery: 'chat',
      }),
    ).rejects.toEqual(code('recipient_not_reachable'));
  });

  it('shows the payer the real requester, from the server, and hides who paid from everyone else', async () => {
    const a = await person();
    const b = await person();
    const view = await wallet.createRequest(a.id, { note: '', delivery: 'qr' });
    const seen = await wallet.getRequest(b.id, view.code.toLowerCase()); // codes are case-insensitive
    expect(seen).toMatchObject({
      amountKobo: null,
      mine: false,
      forYou: false,
      requester: { id: a.id, username: a.username, relationship: 'none' },
    });
    await expect(wallet.getRequest(b.id, 'AAAAAAAAAA')).rejects.toEqual(code('request_not_found'));
  });

  it('a stranger can pay a code; the card lands in the requester’s Requests, not their Chat', async () => {
    const requester = await person();
    const payer = await person();
    const view = await wallet.createRequest(requester.id, {
      amountKobo: 2_000 * NAIRA,
      note: 'suya',
      delivery: 'qr',
    });
    const r = await wallet.payRequest(payer.id, view.code, { idempotencyKey: key() });
    expect(r.balanceKobo).toBe(198_000 * NAIRA);
    expect(await balanceOf(db, requester.id)).toBe(202_000 * NAIRA);

    const after = await wallet.getRequest(requester.id, view.code);
    expect(after).toMatchObject({ status: 'paid', paidBy: { id: payer.id } });
    expect((await wallet.getRequest(payer.id, view.code)).paidBy).toBeNull();

    const [card] = await messagesOf(requester, payer);
    expect(card).toMatchObject({
      kind: 'money_sent',
      senderId: payer.id,
      body: 'Paid Ð2,000 · suya',
    });
    expect((await chat.list(requester.id, 'all')).conversations).toEqual([]);
    expect((await chat.list(requester.id, 'requests')).conversations).toHaveLength(1);
    await expectLedgerClean(db);
  });

  it('marks the chat card paid, live', async () => {
    const a = await person();
    const b = await person();
    await befriend(a, b);
    const view = await wallet.createRequest(a.id, {
      amountKobo: 1_000 * NAIRA,
      note: '',
      targetUserId: b.id,
      delivery: 'chat',
    });
    published.length = 0;
    await wallet.payRequest(b.id, view.code, { idempotencyKey: key() });
    const msgs = await messagesOf(a, b);
    expect(msgs.find((m) => m.kind === 'money_request')).toMatchObject({
      payload: { status: 'paid' },
    });
    expect(
      published.some((p) => p.event.type === 'message' && p.event.message.kind === 'money_request'),
    ).toBe(true);
  });

  it('paying twice (a new key) fails; the same key is a safe retry', async () => {
    const a = await person();
    const b = await person();
    const c = await person();
    const view = await wallet.createRequest(a.id, {
      amountKobo: 500 * NAIRA,
      note: '',
      delivery: 'qr',
    });
    const k = key();
    const first = await wallet.payRequest(b.id, view.code, { idempotencyKey: k });
    const retry = await wallet.payRequest(b.id, view.code, { idempotencyKey: k });
    expect(retry).toMatchObject({ txnId: first.txnId, replayed: true });
    await expect(wallet.payRequest(c.id, view.code, { idempotencyKey: key() })).rejects.toEqual(
      code('request_already_paid'),
    );
    expect(await balanceOf(db, b.id)).toBe(199_500 * NAIRA);
  });

  it('two people racing to pay one request: exactly one pays', async () => {
    const a = await person();
    const b = await person();
    const c = await person();
    const view = await wallet.createRequest(a.id, {
      amountKobo: 500 * NAIRA,
      note: '',
      delivery: 'qr',
    });
    const results = await Promise.allSettled([
      wallet.payRequest(b.id, view.code, { idempotencyKey: key() }),
      wallet.payRequest(c.id, view.code, { idempotencyKey: key() }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await balanceOf(db, a.id)).toBe(200_500 * NAIRA);
  });

  it('needs an amount for "any amount" requests and refuses a wrong one', async () => {
    const a = await person();
    const b = await person();
    const any = await wallet.createRequest(a.id, { note: '', delivery: 'qr' });
    await expect(wallet.payRequest(b.id, any.code, { idempotencyKey: key() })).rejects.toEqual(
      code('amount_required'),
    );
    await expect(
      wallet.payRequest(b.id, any.code, { amountKobo: 700 * NAIRA, idempotencyKey: key() }),
    ).resolves.toMatchObject({ balanceKobo: 199_300 * NAIRA });
    const fixed = await wallet.createRequest(a.id, {
      amountKobo: 100 * NAIRA,
      note: '',
      delivery: 'qr',
    });
    await expect(
      wallet.payRequest(b.id, fixed.code, { amountKobo: 99 * NAIRA, idempotencyKey: key() }),
    ).rejects.toEqual(code('amount_mismatch'));
  });

  it('refuses paying yourself, a request meant for someone else, and when you cannot afford it', async () => {
    const a = await person();
    const b = await person();
    const c = await person();
    await befriend(a, b);
    const mine = await wallet.createRequest(a.id, {
      amountKobo: 100 * NAIRA,
      note: '',
      delivery: 'qr',
    });
    await expect(wallet.payRequest(a.id, mine.code, { idempotencyKey: key() })).rejects.toEqual(
      code('self_payment'),
    );
    const forB = await wallet.createRequest(a.id, {
      amountKobo: 100 * NAIRA,
      note: '',
      targetUserId: b.id,
      delivery: 'chat',
    });
    await expect(wallet.payRequest(c.id, forB.code, { idempotencyKey: key() })).rejects.toEqual(
      code('request_not_for_you'),
    );
    await setBalance(db, c.id, 50 * NAIRA);
    await expect(wallet.payRequest(c.id, mine.code, { idempotencyKey: key() })).rejects.toEqual(
      code('insufficient_funds'),
    );
    expect((await wallet.getRequest(a.id, mine.code)).status).toBe('open');
  });

  it('cancelling closes it and updates the card; an expired code reads as expired and cannot be paid', async () => {
    const a = await person();
    const b = await person();
    await befriend(a, b);
    const toB = await wallet.createRequest(a.id, {
      amountKobo: 100 * NAIRA,
      note: '',
      targetUserId: b.id,
      delivery: 'chat',
    });
    await wallet.cancelRequest(a.id, toB.code);
    expect((await wallet.getRequest(a.id, toB.code)).status).toBe('cancelled');
    expect((await messagesOf(a, b)).find((m) => m.kind === 'money_request')).toMatchObject({
      payload: { status: 'cancelled' },
    });
    await expect(wallet.payRequest(b.id, toB.code, { idempotencyKey: key() })).rejects.toEqual(
      code('request_cancelled'),
    );
    await expect(wallet.cancelRequest(b.id, toB.code)).rejects.toEqual(code('request_not_found'));

    const old = await wallet.createRequest(a.id, {
      amountKobo: 100 * NAIRA,
      note: '',
      delivery: 'qr',
    });
    await db.admin.query(
      `UPDATE payment_requests SET expires_at = now() - interval '1 minute' WHERE code = $1`,
      [old.code],
    );
    expect((await wallet.getRequest(b.id, old.code)).status).toBe('expired');
    await expect(wallet.payRequest(b.id, old.code, { idempotencyKey: key() })).rejects.toEqual(
      code('request_expired'),
    );
  });

  it('hides a request from someone who blocked the requester, and caps open requests at 10', async () => {
    const a = await person();
    const b = await person();
    const view = await wallet.createRequest(a.id, { note: '', delivery: 'qr' });
    await block(b, a);
    await expect(wallet.getRequest(b.id, view.code)).rejects.toEqual(code('request_not_found'));

    const c = await person();
    for (let i = 0; i < 10; i++) await wallet.createRequest(c.id, { note: '', delivery: 'qr' });
    await expect(wallet.createRequest(c.id, { note: '', delivery: 'qr' })).rejects.toEqual(
      code('too_many_open_requests'),
    );
    expect((await wallet.myRequests(c.id)).requests).toHaveLength(10);
  });
});

describe('history and receipts', () => {
  it('lists what moved, newest first, with who it was with and the note', async () => {
    const a = await person();
    const b = await person();
    await befriend(a, b);
    await send(a, b, 1_000, 'one');
    await send(b, a, 400, 'two');
    const h = await wallet.history(a.id, { filter: 'all', limit: 10 });
    expect(h.items.map((i) => [i.kind, i.amountKobo, i.note, i.counterparty?.username])).toEqual([
      ['transfer', 400 * NAIRA, 'two', b.username],
      ['transfer', -1_000 * NAIRA, 'one', b.username],
      ['grant', 200_000 * NAIRA, '', undefined],
    ]);
    expect(h.nextCursor).toBeNull();
  });

  it('filters Pools, Transfers and Bonuses & refunds', async () => {
    const a = await person();
    const b = await person();
    await befriend(a, b);
    await send(a, b, 1_000);
    await send(b, a, 400);
    const view = await wallet.createRequest(a.id, {
      amountKobo: 200 * NAIRA,
      note: '',
      delivery: 'qr',
    });
    await wallet.payRequest(b.id, view.code, { idempotencyKey: key() });
    await setBalance(db, a.id, 100 * NAIRA);
    await wallet.claimTopup(a.id);
    const kinds = async (filter: 'pool' | 'transfer' | 'bonus') =>
      (await wallet.history(a.id, { filter, limit: 20 })).items.map((i) => [
        i.kind,
        Math.sign(i.amountKobo),
      ]);
    expect(await kinds('transfer')).toEqual([
      ['request_payment', 1],
      ['transfer', 1],
      ['transfer', -1],
    ]);
    expect(await kinds('bonus')).toEqual([
      ['topup', 1],
      ['adjust', -1], // the test's own setBalance
      ['grant', 1],
    ]);
    expect(await kinds('pool')).toEqual([]);
  });

  it('pages through a long history without gaps or repeats', async () => {
    const a = await person();
    const b = await person();
    await befriend(a, b);
    for (let i = 1; i <= 7; i++) await send(a, b, i, `n${i}`);
    const seen: string[] = [];
    let before: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await wallet.history(a.id, { filter: 'transfer', limit: 3, before });
      seen.push(...page.items.map((i) => i.note));
      if (!page.nextCursor) break;
      before = page.nextCursor;
    }
    expect(seen).toEqual(['n7', 'n6', 'n5', 'n4', 'n3', 'n2', 'n1']);
  });

  it('only shows your own transactions', async () => {
    const a = await person();
    const b = await person();
    const c = await person();
    await befriend(a, b);
    await send(a, b, 1_000);
    const h = await wallet.history(c.id, { filter: 'all', limit: 10 });
    expect(h.items.map((i) => i.kind)).toEqual(['grant']);
  });

  it('gives a receipt to either party, and to nobody else', async () => {
    const a = await person();
    const b = await person();
    const c = await person();
    await befriend(a, b);
    const r = await send(a, b, 2_500, 'lunch');
    const mine = await wallet.receipt(a.id, r.txnId);
    expect(mine).toMatchObject({
      direction: 'out',
      amountKobo: 2_500 * NAIRA,
      note: 'lunch',
      kind: 'transfer',
      from: { id: a.id },
      to: { id: b.id },
      systemLabel: null,
    });
    expect(await wallet.receipt(b.id, r.txnId)).toMatchObject({
      direction: 'in',
      amountKobo: 2_500 * NAIRA,
    });
    await expect(wallet.receipt(c.id, r.txnId)).rejects.toEqual(code('transaction_not_found'));
    await expect(wallet.receipt(a.id, randomUUID())).rejects.toEqual(code('transaction_not_found'));
  });

  it('labels the welcome gift and top-ups instead of naming a person', async () => {
    const a = await person();
    const grant = (await wallet.history(a.id, { filter: 'bonus', limit: 5 })).items[0]!;
    expect(await wallet.receipt(a.id, grant.id)).toMatchObject({
      kind: 'grant',
      systemLabel: 'Dyce welcome gift',
      direction: 'in',
    });
  });
});

describe('wallet stats, locked pools and the week', () => {
  it('starts with zeros and no win rate', async () => {
    const u = await person();
    const s = await wallet.summary(u.id);
    expect(s.stats).toEqual({ wonThisWeekKobo: 0, winRatePct: null, winStreak: 0 });
    expect(s.locked).toEqual({ kobo: 0, pools: 0 });
  });

  it('counts stakes held in unfinished pools, not finished ones', async () => {
    const a = await person();
    const b = await person();
    const open = await createMatch(db, a.id, [a.id, b.id], { mode: 'pool', stake: 1_500 * NAIRA });
    await db.app.query('SELECT * FROM stake_pool($1, $2, $3, $4)', [
      open,
      a.id,
      1_500 * NAIRA,
      key(),
    ]);
    expect((await wallet.summary(a.id)).locked).toEqual({ kobo: 1_500 * NAIRA, pools: 1 });
    expect((await wallet.summary(b.id)).locked).toEqual({ kobo: 0, pools: 0 });
    await db.admin.query(
      `UPDATE matches SET status = 'finished', finished_at = now() WHERE id = $1`,
      [open],
    );
    expect((await wallet.summary(a.id)).locked).toEqual({ kobo: 0, pools: 0 });
  });

  it('works out win rate and the current streak from finished games', async () => {
    const a = await person();
    const b = await person();
    // oldest to newest: loss, win, win, draw, win, win
    const results = ['loss', 'win', 'win', 'draw', 'win', 'win'];
    for (const [i, result] of results.entries()) {
      const m = await createMatch(db, a.id, [a.id, b.id]);
      await db.admin.query(
        `UPDATE matches SET status = 'finished', finished_at = $2 WHERE id = $1`,
        [m, new Date(Date.now() - (results.length - i) * 60_000)],
      );
      await db.admin.query(
        `UPDATE match_players SET result = $3::match_result WHERE match_id = $1 AND user_id = $2`,
        [m, a.id, result],
      );
    }
    const s = await wallet.summary(a.id);
    expect(s.stats.winRatePct).toBe(67); // 4 of 6
    expect(s.stats.winStreak).toBe(2);
  });

  it("shows the last seven days: today's net and any top-up, oldest first", async () => {
    const a = await person();
    const b = await person();
    await befriend(a, b);
    await send(a, b, 1_000);
    await setBalance(db, a.id, 100 * NAIRA);
    await wallet.claimTopup(a.id);
    const week = await wallet.weekly(a.id);
    expect(week.days).toHaveLength(7);
    const dates = week.days.map((d) => d.date);
    expect([...dates].sort()).toEqual(dates);
    const today = week.days[6]!;
    expect(today.topupKobo).toBe(20_000 * NAIRA);
    expect(week.days.slice(0, 6).every((d) => d.netKobo === 0 && d.topupKobo === 0)).toBe(true);
    expect(week.netKobo).toBe(today.netKobo);
    // the welcome gift is not "this week's net"; the send (-1,000), the adjustment and the top-up are
    expect(today.netKobo).toBe(-1_000 * NAIRA + (100 * NAIRA - 199_000 * NAIRA) + 20_000 * NAIRA);
  });
});

describe('integrity', () => {
  it('leaves the ledger consistent after everything above', async () => {
    await expectLedgerClean(db);
  });
});
