import { randomBytes, randomUUID } from 'node:crypto';
import { LedgerRepo } from '../../src/ledger/ledger.repo.ts';
import { MessagesService } from '../../src/chat/messages.service.ts';
import { ProfileService } from '../../src/profile/profile.service.ts';
import { FriendsService } from '../../src/social/friends.service.ts';
import { createTestDb, type TestDb } from '../testing/testDb.ts';

let db: TestDb;
let profiles: ProfileService;
let friends: FriendsService;
let messages: MessagesService;

beforeAll(async () => {
  db = await createTestDb();
  profiles = new ProfileService(db.app, new LedgerRepo(db.app));
  friends = new FriendsService(db.app);
  messages = new MessagesService(db.app, { publish: () => undefined });
});
afterAll(async () => {
  await db.close();
});

let n = 0;
async function person(): Promise<string> {
  const id = randomUUID();
  await db.app.query('INSERT INTO users (id, phone_hash) VALUES ($1, $2)', [id, randomBytes(32)]);
  await profiles.createProfile(id, { username: `av${++n}_${randomBytes(2).toString('hex')}` });
  return id;
}

describe('choosing a look', () => {
  it('starts with no avatar and the avatar step still to do', async () => {
    const id = await person();
    const me = await profiles.getMe(id);
    expect(me.profile?.avatar).toBeNull();
    expect(me.onboarding.avatar).toBe(false);
  });

  it('saves a starter look, counts as the avatar step, and can be changed later', async () => {
    const id = await person();
    await profiles.completeStep(id, 'contacts');
    const r = await profiles.setAvatar(id, { v: 1, preset: 'dyce_av_042' });
    expect(r.avatar).toEqual({ v: 1, preset: 'dyce_av_042' });
    expect(r.nextStep).toBe('bonus');
    expect((await profiles.getMe(id)).profile?.avatar).toEqual({ v: 1, preset: 'dyce_av_042' });

    await profiles.setAvatar(id, { v: 1, preset: 'dyce_av_100' });
    expect((await profiles.getMe(id)).profile?.avatar).toEqual({ v: 1, preset: 'dyce_av_100' });
  });

  it('refuses a person without a profile', async () => {
    const id = randomUUID();
    await db.app.query('INSERT INTO users (id, phone_hash) VALUES ($1, $2)', [id, randomBytes(32)]);
    await expect(profiles.setAvatar(id, { v: 1, preset: 'dyce_av_001' })).rejects.toMatchObject({
      code: 'profile_required',
    });
  });

  it('a garbage value in the database reads as no avatar instead of breaking the profile', async () => {
    const id = await person();
    await db.admin.query(`UPDATE profiles SET avatar = '{"v":1,"preset":"nope"}' WHERE id = $1`, [
      id,
    ]);
    expect((await profiles.getMe(id)).profile?.avatar).toBeNull();
  });
});

describe("seeing other people's looks", () => {
  it('friends and their chats carry the look (null until they pick one)', async () => {
    const me = await person();
    const them = await person();
    await friends.sendRequest(me, them);
    await friends.accept(them, me);

    let list = (await friends.list(me)).friends;
    expect(list[0]?.avatar).toBeNull();

    await profiles.setAvatar(them, { v: 1, preset: 'dyce_av_077' });
    list = (await friends.list(me)).friends;
    expect(list[0]?.avatar).toEqual({ v: 1, preset: 'dyce_av_077' });

    const conv = await messages.openDirect(me, them);
    expect(conv.peer.avatar).toEqual({ v: 1, preset: 'dyce_av_077' });
  });
});
