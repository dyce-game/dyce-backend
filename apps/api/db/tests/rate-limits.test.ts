import { randomUUID } from 'node:crypto';
import { MessagesService } from '../../src/chat/messages.service.ts';
import { LedgerRepo } from '../../src/ledger/ledger.repo.ts';
import { FriendsService } from '../../src/social/friends.service.ts';
import { WalletService } from '../../src/wallet/wallet.service.ts';
import { balanceOf, createTestDb, type TestDb, type TestUser } from '../testing/testDb.ts';
import { expectLedgerClean, fundedUser, setConfig } from './helpers.ts';

/**
 * The two money limits the SPEC and WALLET_AND_QR promised and nothing enforced until the rate-limit review
 * (ADR-039, docs/RATE_LIMITS.md): money requests a day, and strangers' codes opened a day.
 */
const NAIRA = 100;
let db: TestDb;
let wallet: WalletService;
let friends: FriendsService;

beforeAll(async () => {
  db = await createTestDb();
  const chat = new MessagesService(db.app, { publish: () => undefined });
  wallet = new WalletService(db.app, new LedgerRepo(db.app), chat);
  friends = new FriendsService(db.app);
});
afterAll(async () => {
  await db.close();
});
afterEach(async () => {
  await setConfig(db, 'money_requests_per_day', 30);
  await setConfig(db, 'stranger_scans_per_day', 20);
  await expectLedgerClean(db);
});

const code = (c: string) => expect.objectContaining({ code: c });
const ask = (u: TestUser) =>
  wallet.createRequest(u.id, { amountKobo: 500 * NAIRA, note: 'suya', delivery: 'qr' });

describe('money requests a day', () => {
  it('stops at the limit, tells you when it resets, and a cancelled request still counts', async () => {
    await setConfig(db, 'money_requests_per_day', 3);
    const u = await fundedUser(db);
    for (let i = 0; i < 3; i++) await wallet.cancelRequest(u.id, (await ask(u)).code);
    await expect(ask(u)).rejects.toMatchObject({
      code: 'money_requests_rate_limited',
      details: { retryAfterSeconds: expect.any(Number) },
    });
    // someone else is not affected
    await expect(ask(await fundedUser(db))).resolves.toMatchObject({ status: 'open' });
  });

  it('only counts today: yesterday’s requests do not', async () => {
    await setConfig(db, 'money_requests_per_day', 2);
    const u = await fundedUser(db);
    await wallet.cancelRequest(u.id, (await ask(u)).code);
    await wallet.cancelRequest(u.id, (await ask(u)).code);
    await db.admin.query(
      `UPDATE payment_requests SET created_at = now() - interval '2 days' WHERE requester = $1`,
      [u.id],
    );
    await expect(ask(u)).resolves.toMatchObject({ status: 'open' });
  });
});

describe('strangers’ codes a day', () => {
  async function stranger(): Promise<{ owner: TestUser; code: string }> {
    const owner = await fundedUser(db);
    return { owner, code: (await ask(owner)).code };
  }

  it('lets you open the same code again and again, but only so many different ones', async () => {
    await setConfig(db, 'stranger_scans_per_day', 2);
    const me = await fundedUser(db);
    const [a, b, c] = [await stranger(), await stranger(), await stranger()];
    await wallet.getRequest(me.id, a.code);
    await wallet.getRequest(me.id, a.code);
    await wallet.getRequest(me.id, b.code);
    await expect(wallet.getRequest(me.id, c.code)).rejects.toMatchObject({
      code: 'stranger_scans_rate_limited',
      details: { retryAfterSeconds: expect.any(Number) },
    });
    // a code you have already opened still works for the rest of the day
    await expect(wallet.getRequest(me.id, a.code)).resolves.toMatchObject({ code: a.code });
  });

  it('applies to paying a code you never opened, and the money does not move', async () => {
    await setConfig(db, 'stranger_scans_per_day', 1);
    const me = await fundedUser(db);
    const [a, b] = [await stranger(), await stranger()];
    await wallet.getRequest(me.id, a.code);
    const before = await balanceOf(db, me.id);
    await expect(
      wallet.payRequest(me.id, b.code, { idempotencyKey: randomUUID() }),
    ).rejects.toEqual(code('stranger_scans_rate_limited'));
    expect(await balanceOf(db, me.id)).toBe(before);
    // the one you opened can be paid
    await expect(
      wallet.payRequest(me.id, a.code, { idempotencyKey: randomUUID() }),
    ).resolves.toBeDefined();
  });

  it('never counts friends, contacts or your own codes', async () => {
    await setConfig(db, 'stranger_scans_per_day', 1);
    const me = await fundedUser(db);
    const friend = await fundedUser(db);
    await friends.sendRequest(me.id, friend.id);
    await friends.accept(friend.id, me.id);
    const contact = await fundedUser(db);
    await db.admin.query(`INSERT INTO contact_links (owner_id, contact_user_id) VALUES ($1, $2)`, [
      me.id,
      contact.id,
    ]);
    const mine = await ask(me);
    const codes = [(await ask(friend)).code, (await ask(contact)).code, mine.code];
    for (const c of codes) await expect(wallet.getRequest(me.id, c)).resolves.toBeDefined();
    const s = await stranger();
    await expect(wallet.getRequest(me.id, s.code)).resolves.toBeDefined(); // the first stranger's code is free
    const t = await stranger();
    await expect(wallet.getRequest(me.id, t.code)).rejects.toEqual(
      code('stranger_scans_rate_limited'),
    );
  });

  it('counts per person per day', async () => {
    await setConfig(db, 'stranger_scans_per_day', 1);
    const [one, two] = [await fundedUser(db), await fundedUser(db)];
    const [a, b] = [await stranger(), await stranger()];
    await wallet.getRequest(one.id, a.code);
    await wallet.getRequest(two.id, a.code);
    await expect(wallet.getRequest(one.id, b.code)).rejects.toEqual(
      code('stranger_scans_rate_limited'),
    );
    await db.admin.query(`UPDATE stranger_scans SET day = day - 1 WHERE user_id = $1`, [one.id]);
    await expect(wallet.getRequest(one.id, b.code)).resolves.toBeDefined();
  });
});
