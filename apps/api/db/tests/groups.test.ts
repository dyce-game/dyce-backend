import { randomBytes, randomUUID } from 'node:crypto';
import type { Message, RealtimeEvent } from '@dyce/shared';
import { hashPhone } from '../../src/auth/crypto.ts';
import { GroupsService } from '../../src/chat/groups.service.ts';
import { MessageActionsService } from '../../src/chat/message-actions.service.ts';
import { MessagesService, type Publisher } from '../../src/chat/messages.service.ts';
import { FriendsService } from '../../src/social/friends.service.ts';
import { createTestDb, type TestDb } from '../testing/testDb.ts';

const SECRET = 'k'.repeat(40);
const T0 = new Date('2026-11-14T10:00:00Z').getTime();

let db: TestDb;
let chat: MessagesService;
let groups: GroupsService;
let actions: MessageActionsService;
let friends: FriendsService;
/** Each call to the clock moves time forward one second, so messages always have a distinct, ordered time. */
const clock = { t: T0 };
const now = () => new Date((clock.t += 1000));
const published: { users: readonly string[]; event: RealtimeEvent }[] = [];
const publisher: Publisher = { publish: (users, event) => void published.push({ users, event }) };
const eventsOf = <T extends RealtimeEvent['type']>(type: T) =>
  published.filter((p) => p.event.type === type) as unknown as {
    users: string[];
    event: Extract<RealtimeEvent, { type: T }>;
  }[];

beforeAll(async () => {
  db = await createTestDb();
  chat = new MessagesService(db.app, publisher, now, { botReplyDelayMs: 0 });
  groups = new GroupsService(db.app, publisher, chat, now);
  actions = new MessageActionsService(db.app, publisher, chat, now);
  friends = new FriendsService(db.app, now);
});
afterAll(async () => {
  await chat.bots.idle();
  await db.close();
});
beforeEach(() => {
  clock.t = T0;
  published.length = 0;
});

type Person = { id: string; username: string; name: string };
let seq = 0;

async function person(): Promise<Person> {
  const id = randomUUID();
  seq++;
  await db.app.query('INSERT INTO users (id, phone_hash) VALUES ($1, $2)', [
    id,
    hashPhone(SECRET, `+23481${String(60000000 + seq * 17).padStart(8, '0')}`),
  ]);
  const username = `g${seq}_${randomBytes(2).toString('hex')}`;
  await db.app.query('INSERT INTO profiles (id, username, display_name) VALUES ($1, $2, $3)', [
    id,
    username,
    `Person ${seq}`,
  ]);
  return { id, username, name: `Person ${seq}` };
}

async function befriend(a: Person, b: Person) {
  await friends.sendRequest(a.id, b.id);
  await friends.accept(b.id, a.id);
}
/** `admin` plus `n` friends of the admin. */
async function crew(n = 2) {
  const admin = await person();
  const others: Person[] = [];
  for (let i = 0; i < n; i++) {
    const p = await person();
    await befriend(admin, p);
    others.push(p);
  }
  return { admin, others };
}
async function makeGroup(admin: Person, others: Person[], title = 'Game night') {
  const g = await groups.create(admin.id, {
    id: randomUUID(),
    title,
    memberIds: others.map((o) => o.id),
  });
  return g.id;
}
const block = (blocker: Person, blocked: Person) =>
  db.app.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [
    blocker.id,
    blocked.id,
  ]);
const code = (c: string) => expect.objectContaining({ code: c });
const say = (from: Person, conv: string, body = 'hello', replyTo?: string) =>
  chat.send(from.id, conv, { id: randomUUID(), body, replyTo });
const thread = async (viewer: Person, conv: string) =>
  (await chat.messages(viewer.id, conv, { limit: 50 })).messages;
const bodies = async (viewer: Person, conv: string) =>
  (await thread(viewer, conv)).map((m) => m.body);
const setConfig = (key: string, value: number) =>
  db.admin.query(
    `INSERT INTO app_config (key, value) VALUES ($1, to_jsonb($2::int))
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );

describe('creating a group', () => {
  it('makes you the admin and posts "created the group"', async () => {
    const { admin, others } = await crew(2);
    const g = await groups.create(admin.id, {
      id: randomUUID(),
      title: '  Sunday Game Night ',
      memberIds: others.map((o) => o.id),
    });
    expect(g.kind).toBe('group');
    if (g.kind !== 'group') throw new Error('not a group');
    expect(g.group).toMatchObject({ title: 'Sunday Game Night', memberCount: 3, role: 'admin' });
    expect(g.group.members.map((m) => m.id).sort()).toEqual(others.map((o) => o.id).sort());
    expect(g.lastMessage).toMatchObject({
      kind: 'system',
      body: `${admin.name} created the group`,
    });

    const mine = await chat.get(others[0]!.id, g.id);
    expect(mine.kind === 'group' && mine.group.role).toBe('member');
    // everyone is told, live: a system line and a "your groups changed"
    expect(eventsOf('message')[0]!.users.sort()).toEqual(
      [admin.id, ...others.map((o) => o.id)].sort(),
    );
    expect(eventsOf('conversation').map((e) => e.event.change)).toEqual(['updated']);
  });

  it('needs two other people, and only friends of yours', async () => {
    const { admin, others } = await crew(2);
    const stranger = await person();
    await expect(
      groups.create(admin.id, { id: randomUUID(), title: 'x', memberIds: [others[0]!.id] }),
    ).rejects.toEqual(code('validation_failed'));
    // yourself and duplicates do not count
    await expect(
      groups.create(admin.id, {
        id: randomUUID(),
        title: 'x',
        memberIds: [others[0]!.id, others[0]!.id, admin.id],
      }),
    ).rejects.toEqual(code('validation_failed'));
    // a stranger would land in Chat uninvited
    const err = await groups
      .create(admin.id, {
        id: randomUUID(),
        title: 'x',
        memberIds: [others[0]!.id, others[1]!.id, stranger.id],
      })
      .catch((e: unknown) => e);
    expect(err).toEqual(code('group_member_not_friend'));
    expect((err as { details: { userIds: string[] } }).details.userIds).toEqual([stranger.id]);
  });

  it('refuses blocked people (someone who blocked you looks like they do not exist)', async () => {
    const { admin, others } = await crew(3);
    await block(others[2]!, admin);
    await expect(
      groups.create(admin.id, {
        id: randomUUID(),
        title: 'x',
        memberIds: [others[0]!.id, others[2]!.id],
      }),
    ).rejects.toEqual(code('user_not_found'));
    await db.app.query('DELETE FROM blocks');
    await block(admin, others[2]!);
    await expect(
      groups.create(admin.id, {
        id: randomUUID(),
        title: 'x',
        memberIds: [others[0]!.id, others[2]!.id],
      }),
    ).rejects.toEqual(code('blocked'));
  });

  it('is idempotent on the id, and an id from someone else is taken', async () => {
    const { admin, others } = await crew(2);
    const id = randomUUID();
    const input = { id, title: 'Same', memberIds: others.map((o) => o.id) };
    const a = await groups.create(admin.id, input);
    const b = await groups.create(admin.id, input);
    expect(b.id).toBe(a.id);
    const count = await db.admin.query(
      'SELECT count(*)::int AS n FROM conversations WHERE id = $1',
      [id],
    );
    expect(count.rows[0].n).toBe(1);
    expect((await thread(admin, id)).filter((m) => m.kind === 'system')).toHaveLength(1);

    await expect(
      groups.create(others[0]!.id, { ...input, memberIds: [admin.id, others[1]!.id] }),
    ).rejects.toEqual(code('group_id_taken'));
    const direct = await chat.openDirect(admin.id, others[0]!.id);
    await expect(groups.create(admin.id, { ...input, id: direct.id })).rejects.toEqual(
      code('group_id_taken'),
    );
  });

  it('is capped per day and by size (both from app_config)', async () => {
    const { admin, others } = await crew(3);
    await setConfig('groups_created_per_day', 2);
    await makeGroup(admin, others);
    await makeGroup(admin, others);
    await expect(
      groups.create(admin.id, { id: randomUUID(), title: 'x', memberIds: others.map((o) => o.id) }),
    ).rejects.toEqual(code('groups_rate_limited'));
    await setConfig('groups_created_per_day', 10);
    await setConfig('group_max_members', 3);
    await expect(
      groups.create(admin.id, { id: randomUUID(), title: 'x', memberIds: others.map((o) => o.id) }),
    ).rejects.toEqual(code('group_full'));
    await setConfig('group_max_members', 50);
  });

  it('has DB limits on the title too', async () => {
    const { admin, others } = await crew(2);
    const id = await makeGroup(admin, others);
    await expect(
      db.admin.query(`UPDATE conversations SET title = '' WHERE id = $1`, [id]),
    ).rejects.toThrow(/conversations_group_title_chk/);
  });
});

describe('messaging in a group', () => {
  it('reaches every member live and shows in everyone’s thread, newest first', async () => {
    const { admin, others } = await crew(2);
    const g = await makeGroup(admin, others);
    published.length = 0;
    const m = await say(others[0]!, g, 'who is next?');
    expect(m).toMatchObject({ kind: 'text', senderId: others[0]!.id, body: 'who is next?' });
    expect(eventsOf('message')[0]!.users.sort()).toEqual(
      [admin.id, ...others.map((o) => o.id)].sort(),
    );
    expect((await bodies(admin, g))[0]).toBe('who is next?');
    expect((await bodies(others[1]!, g))[0]).toBe('who is next?');
  });

  it('retries safely: the same id stores one message; another group’s id is taken', async () => {
    const { admin, others } = await crew(2);
    const g1 = await makeGroup(admin, others);
    const g2 = await makeGroup(admin, others, 'Other');
    const id = randomUUID();
    await chat.send(admin.id, g1, { id, body: 'once' });
    published.length = 0;
    await chat.send(admin.id, g1, { id, body: 'once' });
    expect(published).toEqual([]); // nothing re-sent
    expect((await bodies(admin, g1)).filter((b) => b === 'once')).toHaveLength(1);
    await expect(chat.send(admin.id, g2, { id, body: 'once' })).rejects.toEqual(
      code('message_id_taken'),
    );
    await expect(chat.send(others[0]!.id, g1, { id, body: 'mine now' })).rejects.toEqual(
      code('message_id_taken'),
    );
  });

  it('shows the list row with the last message, the sender’s name and unread counts', async () => {
    const { admin, others } = await crew(2);
    const g = await makeGroup(admin, others);
    await say(others[0]!, g, 'one');
    await say(others[1]!, g, 'two');
    const list = await chat.list(admin.id, 'groups');
    expect(list.conversations).toHaveLength(1);
    const row = list.conversations[0]!;
    expect(row.unread).toBe(2); // the "created the group" line does not count
    expect(row.lastMessage).toMatchObject({ body: 'two', senderName: others[1]!.name });
    expect(list.unreadTotal).toBe(2);
    // also under All, not under Friends
    expect((await chat.list(admin.id, 'all')).conversations.map((c) => c.id)).toContain(g);
    expect((await chat.list(admin.id, 'friends')).conversations).toHaveLength(0);

    await chat.markRead(admin.id, g);
    expect((await chat.list(admin.id, 'groups')).conversations[0]!.unread).toBe(0);
    expect(eventsOf('read')).toEqual([]); // groups have no read receipts
    expect((await chat.messages(admin.id, g)).peerReadAt).toBeNull();
  });

  it('sends typing to the other members, not to yourself', async () => {
    const { admin, others } = await crew(2);
    const g = await makeGroup(admin, others);
    expect((await chat.typingTargets(admin.id, g)).sort()).toEqual(others.map((o) => o.id).sort());
    const outsider = await person();
    expect(await chat.typingTargets(outsider.id, g)).toEqual([]);
  });

  it('hides messages from people you blocked, and does not push them to you', async () => {
    const { admin, others } = await crew(2);
    const g = await makeGroup(admin, others);
    await say(others[0]!, g, 'before the block');
    await block(admin, others[0]!);
    published.length = 0;
    await say(others[0]!, g, 'after the block');
    expect(await bodies(admin, g)).not.toContain('before the block');
    expect(await bodies(admin, g)).not.toContain('after the block');
    expect(eventsOf('message')[0]!.users).not.toContain(admin.id);
    expect(await bodies(others[1]!, g)).toContain('after the block');
    const row = (await chat.list(admin.id, 'groups')).conversations[0]!;
    expect(row.unread).toBe(0);
  });

  it('only lets members in', async () => {
    const { admin, others } = await crew(2);
    const g = await makeGroup(admin, others);
    const outsider = await person();
    await expect(say(outsider, g)).rejects.toEqual(code('conversation_not_found'));
    await expect(chat.messages(outsider.id, g)).rejects.toEqual(code('conversation_not_found'));
    await expect(chat.get(outsider.id, g)).rejects.toEqual(code('conversation_not_found'));
    await expect(chat.markRead(outsider.id, g)).rejects.toEqual(code('conversation_not_found'));
    // a group is not a direct chat: no accepting, declining or games
    await expect(chat.accept(admin.id, g)).rejects.toEqual(code('conversation_not_found'));
    await expect(chat.playablePeer(admin.id, g)).rejects.toEqual(code('conversation_not_found'));
  });
});

describe('members and admins', () => {
  it('lists members with roles and your relationship to each', async () => {
    const { admin, others } = await crew(2);
    const g = await makeGroup(admin, others);
    const { members } = await groups.members(others[0]!.id, g);
    expect(members.map((m) => m.role)).toEqual(['admin', 'member', 'member']);
    expect(members[0]!.user.id).toBe(admin.id);
    expect(members[0]!.user.relationship).toBe('friends');
    // the other member is not a friend of others[0]
    expect(members.find((m) => m.user.id === others[1]!.id)!.user.relationship).toBe('none');
    await expect(groups.members((await person()).id, g)).rejects.toEqual(
      code('conversation_not_found'),
    );
  });

  it('lets only admins add people, and only their friends', async () => {
    const { admin, others } = await crew(2);
    const g = await makeGroup(admin, others);
    const newcomer = await person();
    await expect(groups.add(others[0]!.id, g, [newcomer.id])).rejects.toEqual(
      code('not_group_admin'),
    );
    await expect(groups.add(admin.id, g, [newcomer.id])).rejects.toEqual(
      code('group_member_not_friend'),
    );
    await befriend(admin, newcomer);
    published.length = 0;
    const r = await groups.add(admin.id, g, [newcomer.id, newcomer.id]);
    expect(r.members.filter((m) => m.state === 'active')).toHaveLength(4);
    expect(eventsOf('message')[0]!.event.message.body).toBe(`${admin.name} added ${newcomer.name}`);
    // adding someone already in is a no-op
    published.length = 0;
    await groups.add(admin.id, g, [newcomer.id]);
    expect(published).toEqual([]);
  });

  it('shows a new member only what is said after they join', async () => {
    const { admin, others } = await crew(2);
    const g = await makeGroup(admin, others);
    await say(admin, g, 'secret plans');
    const newcomer = await person();
    await befriend(admin, newcomer);
    await groups.add(admin.id, g, [newcomer.id]);
    await say(admin, g, 'welcome');
    const seen = await bodies(newcomer, g);
    expect(seen).toContain('welcome');
    expect(seen).not.toContain('secret plans');
    // and the "added" line is not an unread message for them
    expect((await chat.list(newcomer.id, 'groups')).conversations[0]!.unread).toBe(1);
  });

  it('enforces the member limit, even for adds that race', async () => {
    const { admin, others } = await crew(2);
    const g = await makeGroup(admin, others);
    await setConfig('group_max_members', 4);
    const a = await person();
    const b = await person();
    await befriend(admin, a);
    await befriend(admin, b);
    const results = await Promise.allSettled([
      groups.add(admin.id, g, [a.id]),
      groups.add(admin.id, g, [b.id]),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ code: 'group_full' }),
    });
    const active = await db.admin.query(
      `SELECT count(*)::int AS n FROM conversation_members WHERE conversation_id = $1 AND state = 'active'`,
      [g],
    );
    expect(active.rows[0].n).toBe(4);
    await setConfig('group_max_members', 50);
  });

  it('removes members, ends their access, and lets them be added back', async () => {
    const { admin, others } = await crew(3);
    const g = await makeGroup(admin, others);
    const out = others[0]!;
    await say(out, g, 'I was here');
    published.length = 0;
    const r = await groups.remove(admin.id, g, out.id);
    expect(r.members.find((m) => m.user.id === out.id)!.state).toBe('left');
    expect(
      eventsOf('conversation').some(
        (e) => e.users.includes(out.id) && e.event.change === 'removed',
      ),
    ).toBe(true);
    expect(eventsOf('message')[0]!.event.message.body).toBe(`${admin.name} removed ${out.name}`);
    expect(eventsOf('message')[0]!.users).not.toContain(out.id);

    await expect(say(out, g)).rejects.toEqual(code('conversation_not_found'));
    await expect(chat.messages(out.id, g)).rejects.toEqual(code('conversation_not_found'));
    expect((await chat.list(out.id, 'groups')).conversations).toHaveLength(0);
    // their old message keeps its sender, and the members list still names them
    expect(await bodies(admin, g)).toContain('I was here');
    expect((await groups.members(admin.id, g)).members.some((m) => m.user.id === out.id)).toBe(
      true,
    );

    await groups.add(admin.id, g, [out.id]);
    expect((await chat.list(out.id, 'groups')).conversations).toHaveLength(1);
    expect(await bodies(out, g)).not.toContain('I was here'); // history before they re-joined stays hidden
  });

  it('does not let admins remove admins, or members remove anyone', async () => {
    const { admin, others } = await crew(2);
    const g = await makeGroup(admin, others);
    await groups.setRole(admin.id, g, others[0]!.id, 'admin');
    await expect(groups.remove(admin.id, g, others[0]!.id)).rejects.toEqual(
      code('not_group_admin'),
    );
    await expect(groups.remove(others[0]!.id, g, admin.id)).rejects.toEqual(
      code('not_group_admin'),
    );
    await expect(groups.remove(others[1]!.id, g, others[0]!.id)).rejects.toEqual(
      code('not_group_admin'),
    );
  });

  it('makes admins, and only lets an admin step down themselves (never the last one)', async () => {
    const { admin, others } = await crew(2);
    const g = await makeGroup(admin, others);
    await expect(groups.setRole(others[0]!.id, g, others[1]!.id, 'admin')).rejects.toEqual(
      code('not_group_admin'),
    );
    await groups.setRole(admin.id, g, others[0]!.id, 'admin');
    expect(eventsOf('message').pop()!.event.message.body).toBe(
      `${admin.name} made ${others[0]!.name} an admin`,
    );
    // an admin cannot demote another admin
    await expect(groups.setRole(others[0]!.id, g, admin.id, 'member')).rejects.toEqual(
      code('not_group_admin'),
    );
    // stepping down is fine while another admin remains
    await groups.setRole(admin.id, g, admin.id, 'member');
    // but the last admin cannot
    await expect(groups.setRole(others[0]!.id, g, others[0]!.id, 'member')).rejects.toEqual(
      code('last_admin'),
    );
    const sole = await chat.get(others[0]!.id, g);
    expect(sole.kind === 'group' && sole.group.role).toBe('admin');
  });

  it('renames, for admins only, and tells everyone', async () => {
    const { admin, others } = await crew(2);
    const g = await makeGroup(admin, others);
    await expect(groups.rename(others[0]!.id, g, 'Mine now')).rejects.toEqual(
      code('not_group_admin'),
    );
    published.length = 0;
    const renamed = await groups.rename(admin.id, g, 'Office Doodles');
    expect(renamed.kind === 'group' && renamed.group.title).toBe('Office Doodles');
    expect(eventsOf('message')[0]!.event.message.body).toBe(
      `${admin.name} renamed the group to “Office Doodles”`,
    );
    published.length = 0;
    await groups.rename(admin.id, g, 'Office Doodles'); // same name: nothing to say
    expect(published).toEqual([]);
  });

  it('lets anyone leave; the longest-standing member becomes admin when the last admin goes', async () => {
    const { admin, others } = await crew(3);
    const g = await makeGroup(admin, others);
    published.length = 0;
    await groups.leave(admin.id, g);
    const messages = eventsOf('message').map((e) => e.event.message.body);
    expect(messages[0]).toBe(`${admin.name} left`);
    expect(messages[1]).toMatch(/is now an admin$/);
    const { members } = await groups.members(others[0]!.id, g);
    expect(members.filter((m) => m.state === 'active' && m.role === 'admin')).toHaveLength(1);
    // the earliest joined (ties by id) is the new admin: all joined at once, so the lowest id
    const expected = [...others].sort((a, b) => (a.id < b.id ? -1 : 1))[0]!;
    expect(members.find((m) => m.role === 'admin' && m.state === 'active')!.user.id).toBe(
      expected.id,
    );
    // leaving again is quiet
    published.length = 0;
    await groups.leave(admin.id, g);
    expect(published).toEqual([]);
    await expect(chat.get(admin.id, g)).rejects.toEqual(code('conversation_not_found'));
  });

  it('is quiet about direct chats (no leaving or administering them)', async () => {
    const { admin, others } = await crew(1);
    const direct = await chat.openDirect(admin.id, others[0]!.id);
    await expect(groups.leave(admin.id, direct.id)).rejects.toEqual(code('not_a_group'));
    await expect(groups.add(admin.id, direct.id, [others[0]!.id])).rejects.toEqual(
      code('not_a_group'),
    );
    await expect(groups.members(admin.id, direct.id)).rejects.toEqual(code('not_a_group'));
  });
});

describe('replies', () => {
  it('quote the original (sender, text) and survive its deletion', async () => {
    const { admin, others } = await crew(2);
    const g = await makeGroup(admin, others);
    const original = await say(others[0]!, g, 'who is bringing the cards?');
    const reply = await say(admin, g, 'me', original.id);
    expect(reply.replyTo).toEqual({
      id: original.id,
      senderId: others[0]!.id,
      senderName: others[0]!.name,
      snippet: 'who is bringing the cards?',
      deleted: false,
    });
    expect((await thread(others[1]!, g))[0]!.replyTo!.snippet).toBe('who is bringing the cards?');

    await actions.delete(others[0]!.id, g, original.id, 'everyone');
    const after = (await thread(admin, g))[0]!;
    expect(after.replyTo).toMatchObject({ deleted: true, snippet: '' });
  });

  it('must point at a live message in the same conversation', async () => {
    const { admin, others } = await crew(2);
    const g1 = await makeGroup(admin, others);
    const g2 = await makeGroup(admin, others, 'Other');
    const elsewhere = await say(admin, g2, 'other group');
    await expect(say(admin, g1, 'reply', elsewhere.id)).rejects.toEqual(code('message_not_found'));
    await expect(say(admin, g1, 'reply', randomUUID())).rejects.toEqual(code('message_not_found'));
    const dead = await say(admin, g1, 'bye');
    await actions.delete(admin.id, g1, dead.id, 'everyone');
    await expect(say(admin, g1, 'reply', dead.id)).rejects.toEqual(code('message_not_found'));
  });

  it('work in direct chats too', async () => {
    const { admin, others } = await crew(1);
    const direct = await chat.openDirect(admin.id, others[0]!.id);
    const first = await say(others[0]!, direct.id, 'hey');
    const reply = await say(admin, direct.id, 'hi', first.id);
    expect(reply.replyTo).toMatchObject({ senderName: others[0]!.name, snippet: 'hey' });
  });
});

describe('reactions', () => {
  it('count per key, replace your own, and can be taken back', async () => {
    const { admin, others } = await crew(2);
    const g = await makeGroup(admin, others);
    const m = await say(admin, g, 'gg everyone');
    published.length = 0;
    expect(await actions.react(others[0]!.id, g, m.id, 'gg')).toEqual([
      { key: 'gg', count: 1, mine: true },
    ]);
    await actions.react(others[1]!.id, g, m.id, 'gg');
    const mine = await actions.react(admin.id, g, m.id, 'ha');
    expect(mine).toEqual([
      { key: 'gg', count: 2, mine: false },
      { key: 'ha', count: 1, mine: true },
    ]);
    // reacting again replaces (one reaction per person)
    expect(await actions.react(others[0]!.id, g, m.id, 'wow')).toEqual([
      { key: 'gg', count: 1, mine: false },
      { key: 'ha', count: 1, mine: false },
      { key: 'wow', count: 1, mine: true },
    ]);
    // idempotent
    await actions.react(others[0]!.id, g, m.id, 'wow');
    expect((await thread(admin, g))[0]!.reactions).toEqual([
      { key: 'gg', count: 1, mine: false },
      { key: 'ha', count: 1, mine: true },
      { key: 'wow', count: 1, mine: false },
    ]);
    expect(await actions.react(others[0]!.id, g, m.id, null)).toEqual([
      { key: 'gg', count: 1, mine: false },
      { key: 'ha', count: 1, mine: false },
    ]);
    const last = eventsOf('reaction').pop()!;
    expect(last.event).toMatchObject({ userId: others[0]!.id, reaction: null, messageId: m.id });
    expect(last.users.sort()).toEqual([admin.id, ...others.map((o) => o.id)].sort());
  });

  it('are limited to the fixed set (also in the database)', async () => {
    const { admin, others } = await crew(2);
    const g = await makeGroup(admin, others);
    const m = await say(admin, g);
    await expect(
      db.app.query(`INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, 'fire')`, [
        m.id,
        admin.id,
      ]),
    ).rejects.toThrow(/reactions_key_chk/);
  });

  it('need access: not for outsiders, removed members, system lines, deleted messages', async () => {
    const { admin, others } = await crew(2);
    const g = await makeGroup(admin, others);
    const m = await say(admin, g);
    const outsider = await person();
    await expect(actions.react(outsider.id, g, m.id, 'gg')).rejects.toEqual(
      code('conversation_not_found'),
    );
    const system = (await thread(admin, g)).find((x) => x.kind === 'system')!;
    await expect(actions.react(admin.id, g, system.id, 'gg')).rejects.toEqual(
      code('message_not_found'),
    );
    await expect(actions.react(admin.id, g, randomUUID(), 'gg')).rejects.toEqual(
      code('message_not_found'),
    );
    await groups.remove(admin.id, g, others[0]!.id);
    await expect(actions.react(others[0]!.id, g, m.id, 'gg')).rejects.toEqual(
      code('conversation_not_found'),
    );
    await actions.delete(admin.id, g, m.id, 'everyone');
    await expect(actions.react(admin.id, g, m.id, 'gg')).rejects.toEqual(code('message_not_found'));
  });

  it('work in a friend chat, and are refused in a request you have not accepted or after a block', async () => {
    const { admin, others } = await crew(1);
    const friend = others[0]!;
    const direct = await chat.openDirect(admin.id, friend.id);
    const m = await say(admin, direct.id, 'hello');
    published.length = 0;
    await actions.react(friend.id, direct.id, m.id, 'ha');
    expect(eventsOf('reaction')[0]!.users.sort()).toEqual([admin.id, friend.id].sort());

    const stranger = await person();
    const dm = await chat.openDirect(stranger.id, admin.id);
    const hi = await say(stranger, dm.id, 'hi, I am new');
    // admin has not accepted: can read, cannot react
    await expect(actions.react(admin.id, dm.id, hi.id, 'gg')).rejects.toEqual(
      code('conversation_not_found'),
    );
    await block(friend, admin);
    await expect(actions.react(admin.id, direct.id, m.id, 'gg')).rejects.toEqual(
      code('user_not_found'),
    );
  });
});

describe('deleting messages', () => {
  it('for me hides it from you alone, and from your list preview', async () => {
    const { admin, others } = await crew(2);
    const g = await makeGroup(admin, others);
    const m = await say(others[0]!, g, 'oops');
    published.length = 0;
    await actions.delete(admin.id, g, m.id, 'me');
    expect(await bodies(admin, g)).not.toContain('oops');
    expect(await bodies(others[1]!, g)).toContain('oops');
    expect(eventsOf('message_deleted')).toEqual([
      expect.objectContaining({
        users: [admin.id],
        event: expect.objectContaining({ scope: 'me' }),
      }),
    ]);
    const row = (await chat.list(admin.id, 'groups')).conversations[0]!;
    expect(row.lastMessage!.kind).toBe('system'); // the previous visible message
    await actions.delete(admin.id, g, m.id, 'me'); // idempotent
    await expect(actions.delete(admin.id, g, randomUUID(), 'me')).rejects.toEqual(
      code('message_not_found'),
    );
  });

  it('for everyone wipes it, leaves a tombstone, and tells everyone', async () => {
    const { admin, others } = await crew(2);
    const g = await makeGroup(admin, others);
    const m = await say(others[0]!, g, 'regret');
    await actions.react(admin.id, g, m.id, 'gg');
    published.length = 0;
    await actions.delete(others[0]!.id, g, m.id, 'everyone');
    const seen = (await thread(admin, g))[0]!;
    expect(seen).toMatchObject({ id: m.id, kind: 'text', body: '', deleted: true });
    expect(seen.reactions).toBeUndefined();
    const stored = await db.admin.query('SELECT body, payload FROM messages WHERE id = $1', [m.id]);
    expect(stored.rows[0]).toEqual({ body: '', payload: {} });
    expect(eventsOf('message_deleted')[0]!.users.sort()).toEqual(
      [admin.id, ...others.map((o) => o.id)].sort(),
    );
    // the list shows a tombstone, and it is not unread text
    const row = (await chat.list(admin.id, 'groups')).conversations[0]!;
    expect(row.lastMessage).toMatchObject({ deleted: true, body: '' });
    expect(row.unread).toBe(0);
    // idempotent
    published.length = 0;
    await actions.delete(others[0]!.id, g, m.id, 'everyone');
    expect(published).toEqual([]);
  });

  it('for everyone only works on your own text or poll, within the window', async () => {
    const { admin, others } = await crew(2);
    const g = await makeGroup(admin, others);
    const m = await say(others[0]!, g, 'mine');
    await expect(actions.delete(admin.id, g, m.id, 'everyone')).rejects.toEqual(
      code('cannot_delete_message'),
    );
    const system = (await thread(admin, g)).find((x) => x.kind === 'system')!;
    await expect(actions.delete(admin.id, g, system.id, 'everyone')).rejects.toEqual(
      code('cannot_delete_message'),
    );
    // 16 minutes later it is too late (15 by default)
    clock.t = new Date(m.createdAt).getTime() + 16 * 60_000;
    const err = await actions.delete(others[0]!.id, g, m.id, 'everyone').catch((e: unknown) => e);
    expect(err).toEqual(code('delete_window_closed'));
    expect((err as { details: { minutes: number } }).details.minutes).toBe(15);
    // 14 minutes is fine
    const fresh = await say(others[0]!, g, 'recent');
    clock.t = new Date(fresh.createdAt).getTime() + 14 * 60_000;
    await actions.delete(others[0]!.id, g, fresh.id, 'everyone');
    // the window is config
    await setConfig('delete_for_everyone_minutes', 1);
    const quick = await say(others[0]!, g, 'quick');
    clock.t = new Date(quick.createdAt).getTime() + 2 * 60_000;
    await expect(actions.delete(others[0]!.id, g, quick.id, 'everyone')).rejects.toEqual(
      code('delete_window_closed'),
    );
    await setConfig('delete_for_everyone_minutes', 15);
  });

  it('never lets a card (money or game) be wiped for everyone', async () => {
    const { admin, others } = await crew(1);
    const direct = await chat.openDirect(admin.id, others[0]!.id);
    const card = await chat.postCard(direct.id, admin.id, {
      id: randomUUID(),
      kind: 'money_sent',
      body: 'Sent ₦500',
      payload: { amountKobo: 50_000, note: '', txnId: randomUUID() },
    });
    await expect(actions.delete(admin.id, direct.id, card.id, 'everyone')).rejects.toEqual(
      code('cannot_delete_message'),
    );
    await actions.delete(admin.id, direct.id, card.id, 'me'); // yours to hide
  });

  it('does not reset the stranger limit: deleted messages still count', async () => {
    const a = await person();
    const b = await person();
    const conv = (await chat.openDirect(a.id, b.id)).id;
    for (let i = 0; i < 3; i++) {
      const m = await say(a, conv, `msg ${i}`);
      await actions.delete(a.id, conv, m.id, 'everyone');
    }
    await expect(say(a, conv, 'one more')).rejects.toEqual(code('request_pending'));
  });
});

describe('polls', () => {
  async function poll(g: string, by: Person, options = ['Crazy Cards', 'Whot!', 'Doodle Guess']) {
    return actions.createPoll(by.id, g, {
      id: randomUUID(),
      question: 'What are we playing at 9?',
      options,
    });
  }

  it('are posted into the group and tallied per option', async () => {
    const { admin, others } = await crew(2);
    const g = await makeGroup(admin, others);
    published.length = 0;
    const p = await poll(g, admin);
    expect(p).toMatchObject({
      kind: 'poll',
      body: 'Poll: What are we playing at 9?',
      payload: {
        question: 'What are we playing at 9?',
        total: 0,
        myVote: null,
        options: [
          { id: 0, text: 'Crazy Cards', votes: 0 },
          { id: 1, text: 'Whot!', votes: 0 },
          { id: 2, text: 'Doodle Guess', votes: 0 },
        ],
      },
    });
    expect(eventsOf('message')[0]!.users).toHaveLength(3);

    await actions.vote(others[0]!.id, g, p.id, 1);
    await actions.vote(others[1]!.id, g, p.id, 1);
    const mine = await actions.vote(admin.id, g, p.id, 0);
    expect(mine).toMatchObject({ total: 3, myVote: 0 });
    expect(mine.options.map((o) => o.votes)).toEqual([1, 2, 0]);
    const seenByOther = (await thread(others[0]!, g))[0]!;
    expect(seenByOther.kind === 'poll' && seenByOther.payload.myVote).toBe(1);
    const ev = eventsOf('poll').pop()!.event;
    expect(ev).toMatchObject({ voterId: admin.id, optionId: 0, total: 3 });
    expect(ev.votes).toEqual([
      { id: 0, votes: 1 },
      { id: 1, votes: 2 },
      { id: 2, votes: 0 },
    ]);
  });

  it('let you change or take back your vote, but never vote twice', async () => {
    const { admin, others } = await crew(2);
    const g = await makeGroup(admin, others);
    const p = await poll(g, admin);
    await actions.vote(admin.id, g, p.id, 0);
    await actions.vote(admin.id, g, p.id, 0);
    expect((await actions.vote(admin.id, g, p.id, 2)).options.map((o) => o.votes)).toEqual([
      0, 0, 1,
    ]);
    expect(await actions.vote(admin.id, g, p.id, null)).toMatchObject({ total: 0, myVote: null });
    const rows = await db.admin.query(
      'SELECT count(*)::int AS n FROM poll_votes WHERE message_id = $1',
      [p.id],
    );
    expect(rows.rows[0].n).toBe(0);
  });

  it('are idempotent on the message id and validate the vote', async () => {
    const { admin, others } = await crew(2);
    const g = await makeGroup(admin, others);
    const id = randomUUID();
    const input = { id, question: 'Q?', options: ['a', 'b'] };
    await actions.createPoll(admin.id, g, input);
    published.length = 0;
    await actions.createPoll(admin.id, g, input);
    expect(published).toEqual([]);
    await expect(actions.createPoll(others[0]!.id, g, input)).rejects.toEqual(
      code('message_id_taken'),
    );
    await expect(actions.vote(admin.id, g, id, 2)).rejects.toEqual(code('invalid_vote'));
    await expect(actions.vote(admin.id, g, randomUUID(), 0)).rejects.toEqual(
      code('message_not_found'),
    );
    const notPoll = await say(admin, g);
    await expect(actions.vote(admin.id, g, notPoll.id, 0)).rejects.toEqual(
      code('message_not_found'),
    );
  });

  it('are group-only, members-only, and gone when deleted', async () => {
    const { admin, others } = await crew(2);
    const g = await makeGroup(admin, others);
    const direct = await chat.openDirect(admin.id, others[0]!.id);
    await expect(
      actions.createPoll(admin.id, direct.id, {
        id: randomUUID(),
        question: 'Q?',
        options: ['a', 'b'],
      }),
    ).rejects.toEqual(code('not_a_group'));
    const p = await poll(g, admin);
    const outsider = await person();
    await expect(actions.vote(outsider.id, g, p.id, 0)).rejects.toEqual(
      code('conversation_not_found'),
    );
    await actions.vote(others[0]!.id, g, p.id, 0);
    await actions.delete(admin.id, g, p.id, 'everyone');
    await expect(actions.vote(others[1]!.id, g, p.id, 0)).rejects.toEqual(
      code('message_not_found'),
    );
    const votes = await db.admin.query(
      'SELECT count(*)::int AS n FROM poll_votes WHERE message_id = $1',
      [p.id],
    );
    expect(votes.rows[0].n).toBe(0);
  });

  it('are validated by the shared schema limits', async () => {
    const { createPollSchema } = await import('@dyce/shared');
    const base = { id: randomUUID(), question: 'Q?' };
    expect(createPollSchema.safeParse({ ...base, options: ['a'] }).success).toBe(false);
    expect(createPollSchema.safeParse({ ...base, options: ['a', ' '] }).success).toBe(false);
    expect(createPollSchema.safeParse({ ...base, options: Array(7).fill('x') }).success).toBe(
      false,
    );
    expect(createPollSchema.safeParse({ ...base, options: ['a', 'b'] }).success).toBe(true);
  });
});

describe('bots', () => {
  it('lists all four, created with a greeting you have already read', async () => {
    const me = await person();
    const bots = await chat.list(me.id, 'bots');
    expect(bots.conversations.map((c) => c.kind === 'bot' && c.bot.slug)).toEqual([
      'coach-cue',
      'quiz-mama',
      'word-hunt-trainer',
      'admiral-ade',
    ]);
    expect(bots.conversations.every((c) => c.unread === 0 && c.lastMessage !== null)).toBe(true);
    expect(bots.unreadTotal).toBe(0);
    const first = bots.conversations[0]!;
    expect(first.lastMessage).toMatchObject({ senderId: 'bot:coach-cue', kind: 'text' });
    // asking again creates nothing new
    const again = await chat.list(me.id, 'bots');
    expect(again.conversations.map((c) => c.id)).toEqual(bots.conversations.map((c) => c.id));
    const greetings = await db.admin.query(
      `SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1`,
      [first.id],
    );
    expect(greetings.rows[0].n).toBe(1);
    // not in All (nor Friends) until you talk to one
    expect((await chat.list(me.id, 'all')).conversations).toEqual([]);
  });

  it('answers a message once, from the script, and then shows in All', async () => {
    const me = await person();
    const coach = (await chat.list(me.id, 'bots')).conversations[0]!;
    published.length = 0;
    const sent = await chat.send(me.id, coach.id, {
      id: randomUUID(),
      body: 'help with my bank shots',
    });
    await chat.bots.idle();
    const reply = eventsOf('message').find((e) => e.event.message.senderId === 'bot:coach-cue')!;
    expect(reply.users).toEqual([me.id]);
    expect(reply.event.message.body).toMatch(/Bank shots/);
    expect((await thread(me, coach.id)).map((m) => m.senderId)).toEqual([
      'bot:coach-cue',
      me.id,
      'bot:coach-cue',
    ]);
    // a retried send does not make a second reply
    await chat.send(me.id, coach.id, { id: sent.id, body: 'help with my bank shots' });
    await chat.bots.idle();
    expect((await thread(me, coach.id)).filter((m) => m.senderId === 'bot:coach-cue')).toHaveLength(
      2,
    );
    const all = await chat.list(me.id, 'all');
    expect(all.conversations.map((c) => c.id)).toEqual([coach.id]);
    expect(all.conversations[0]!.unread).toBe(1); // the reply, until you read it
  });

  it('keeps a quiz going across messages (Quiz Mama)', async () => {
    const me = await person();
    const conv = (await chat.list(me.id, 'bots')).conversations[1]!;
    const talk = async (text: string) => {
      await chat.send(me.id, conv.id, { id: randomUUID(), body: text });
      await chat.bots.idle();
      return (await thread(me, conv.id))[0]!.body;
    };
    expect(await talk('hello')).toMatch(/Say "start"/);
    expect(await talk('start')).toMatch(/Question 1 of 10: Which river/);
    expect(await talk('The Niger')).toMatch(/^Correct! Question 2 of 10/);
    expect(await talk('Kano')).toMatch(/^Not quite\. Abuja\. Question 3 of 10/);
  });

  it('are private to you, and cannot be opened for someone else', async () => {
    const me = await person();
    const other = await person();
    const mine = (await chat.list(me.id, 'bots')).conversations[0]!;
    await expect(chat.get(other.id, mine.id)).rejects.toEqual(code('conversation_not_found'));
    await expect(chat.send(other.id, mine.id, { id: randomUUID(), body: 'x' })).rejects.toEqual(
      code('conversation_not_found'),
    );
    expect(await chat.typingTargets(me.id, mine.id)).toEqual([]);
    const theirs = (await chat.list(other.id, 'bots')).conversations[0]!;
    expect(theirs.id).not.toBe(mine.id);
  });

  it('can be reacted to and replied to like any conversation', async () => {
    const me = await person();
    const coach = (await chat.list(me.id, 'bots')).conversations[0]!;
    const greeting = (await thread(me, coach.id))[0]!;
    await actions.react(me.id, coach.id, greeting.id, 'gg');
    const reply = await chat.send(me.id, coach.id, {
      id: randomUUID(),
      body: 'thanks',
      replyTo: greeting.id,
    });
    expect(reply.replyTo).toMatchObject({ senderName: 'Someone', senderId: 'bot:coach-cue' });
  });
});

describe('strangers never land in Chat', () => {
  it('cannot be put into a group by anyone who is not their friend', async () => {
    const { admin, others } = await crew(2);
    const g = await makeGroup(admin, others);
    const stranger = await person();
    await expect(groups.add(admin.id, g, [stranger.id])).rejects.toEqual(
      code('group_member_not_friend'),
    );
    expect((await chat.list(stranger.id, 'all')).conversations).toEqual([]);
    expect((await chat.list(stranger.id, 'requests')).requestCount).toBe(0);
  });

  it('keep group chats out of Requests and the request count', async () => {
    const { admin, others } = await crew(2);
    await makeGroup(admin, others);
    const r = await chat.list(others[0]!.id, 'requests');
    expect(r.conversations).toEqual([]);
    expect(r.requestCount).toBe(0);
  });
});

it('keeps every direct-message payload shape (no reactions or replies unless there are some)', async () => {
  const { admin, others } = await crew(1);
  const direct = await chat.openDirect(admin.id, others[0]!.id);
  const m: Message = await say(admin, direct.id, 'plain');
  expect(m.replyTo).toBeUndefined();
  expect(m.reactions).toBeUndefined();
  expect(m.deleted).toBeUndefined();
});
