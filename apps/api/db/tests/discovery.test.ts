import { randomUUID } from 'node:crypto';
import { LeaderboardService, lagosWeekStart } from '../../src/discovery/leaderboard.service.ts';
import { SearchService } from '../../src/discovery/search.service.ts';
import { UserProfileService } from '../../src/discovery/user-profile.service.ts';
import {
  createMatch,
  createTestDb,
  createUser,
  type TestDb,
  type TestUser,
} from '../testing/testDb.ts';
import { fundedUser, setConfig } from './helpers.ts';

/** Search, other people's profiles and leaderboards (ADR-023): results, privacy and limits on real PostgreSQL. */
let db: TestDb;
let search: SearchService;
let profiles: UserProfileService;
let boards: LeaderboardService;

beforeAll(async () => {
  db = await createTestDb();
  search = new SearchService(db.app);
  profiles = new UserProfileService(db.app);
  boards = new LeaderboardService(db.app);
  await db.admin.query(
    `INSERT INTO games (slug, name, dimension, sync, min_players, max_players, supports_pool, enabled)
     VALUES ('test_race', 'Race', '2d', 'async', 2, 2, true, true), ('test_dice', 'Dice', '2d', 'async', 2, 2, false, true)
     ON CONFLICT DO NOTHING`,
  );
});
afterAll(async () => {
  await db.close();
});

let seq = 0;
const uniq = () => `${(++seq).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const person = async (username?: string, displayName?: string): Promise<TestUser> => {
  const u = await createUser(db, { username });
  if (displayName)
    await db.admin.query('UPDATE profiles SET display_name = $2 WHERE id = $1', [
      u.id,
      displayName,
    ]);
  return u;
};
async function befriend(a: TestUser, b: TestUser) {
  const [lo, hi] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
  await db.admin.query(
    `INSERT INTO friendships (user_low, user_high, status, requested_by, responded_at) VALUES ($1, $2, 'accepted', $3, now())`,
    [lo, hi, a.id],
  );
}
const block = (blocker: TestUser, blocked: TestUser) =>
  db.app.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [
    blocker.id,
    blocked.id,
  ]);
const names = async (viewer: TestUser, q: string) =>
  (await search.people(viewer.id, q)).people.map((p) => p.username);

async function play(
  a: TestUser,
  b: TestUser,
  winner: TestUser | null,
  opts: { slug?: string; pool?: number; at?: string } = {},
) {
  const m = await createMatch(db, a.id, [a.id, b.id], {
    mode: opts.pool ? 'pool' : 'free',
    stake: opts.pool ?? 0,
  });
  if (opts.slug)
    await db.admin.query('UPDATE matches SET game_slug = $2 WHERE id = $1', [m, opts.slug]);
  if (opts.pool) {
    await db.app.query('SELECT stake_pool($1, $2, $3, $4)', [m, a.id, opts.pool, `s:${m}:a`]);
    await db.app.query('SELECT stake_pool($1, $2, $3, $4)', [m, b.id, opts.pool, `s:${m}:b`]);
  }
  if (opts.at)
    await db.admin.query('UPDATE matches SET finished_at = $2 WHERE id = $1', [m, opts.at]);
  for (const u of [a, b]) {
    const result = winner === null ? 'draw' : winner.id === u.id ? 'win' : 'loss';
    await db.app.query(
      `UPDATE match_players SET placement = $3, result = $4::match_result WHERE match_id = $1 AND user_id = $2`,
      [m, u.id, result === 'loss' ? 2 : 1, result],
    );
  }
  await db.app.query('SELECT settle_match($1)', [m]);
  return m;
}

describe('people search', () => {
  it('finds friends by username prefix or any word of their name from 2 characters', async () => {
    const me = await person();
    const f = await person(`zainab_${uniq()}`, 'Zainab Bello');
    await befriend(me, f);
    expect(await names(me, 'za')).toEqual([f.username]);
    expect(await names(me, 'bel')).toEqual([f.username]); // second word of the name
    expect((await search.people(me.id, 'za')).people[0]).toMatchObject({
      source: 'friend',
      relationship: 'friends',
    });
    expect(await names(me, 'ello')).toEqual([]); // not a prefix of any word
  });

  it('finds a stranger only by @username prefix of 3+ characters, never by name', async () => {
    const me = await person();
    const s = await person(`quincy_${uniq()}`, 'Obinna Okafor');
    expect(await names(me, 'qu')).toEqual([]);
    expect(await names(me, 'qui')).toEqual([s.username]);
    expect(await names(me, 'obinna')).toEqual([]);
    expect((await search.people(me.id, 'qui')).people[0]).toMatchObject({
      source: 'stranger',
      relationship: 'none',
    });
  });

  it('finds people you have played with by name, and contacts', async () => {
    const me = await person();
    const rival = await person(`rival_${uniq()}`, 'Chidi Eze');
    await play(me, rival, me);
    expect(await names(me, 'chi')).toEqual([rival.username]);
    const contact = await person(`kemi_${uniq()}`, 'Kemi Ade');
    await db.admin.query('INSERT INTO contact_links (owner_id, contact_user_id) VALUES ($1, $2)', [
      me.id,
      contact.id,
    ]);
    expect((await search.people(me.id, 'ke')).people[0]).toMatchObject({ source: 'contact' });
  });

  it('never returns blocked people (either way), disabled accounts or yourself', async () => {
    const me = await person(`hunter_${uniq()}`);
    const blockedByMe = await person(`hunter_a${uniq()}`);
    const blocksMe = await person(`hunter_b${uniq()}`);
    const disabled = await person(`hunter_c${uniq()}`);
    const visible = await person(`hunter_d${uniq()}`);
    await block(me, blockedByMe);
    await block(blocksMe, me);
    await db.admin.query('UPDATE users SET disabled_at = now() WHERE id = $1', [disabled.id]);
    expect(await names(me, 'hunter')).toEqual([visible.username]);
  });

  it('treats _ and % as plain characters', async () => {
    const me = await person();
    const a = await person(`wild_card${uniq()}`.slice(0, 20));
    await person(`wildxcard${uniq()}`.slice(0, 20));
    expect(await names(me, 'wild_c')).toEqual([a.username]);
    expect(await names(me, 'wil%')).toEqual([]);
  });

  it('puts friends first, caps results at 15 and exposes only public fields', async () => {
    const me = await person();
    const tag = uniq();
    for (let i = 0; i < 18; i++) await person(`crowd${tag}_${String(i).padStart(2, '0')}`);
    const friend = await person(`crowd${tag}_zz`);
    await befriend(me, friend);
    const r = await search.people(me.id, `crowd${tag}`);
    expect(r.people).toHaveLength(15);
    expect(r.people[0]!.username).toBe(friend.username);
    expect(Object.keys(r.people[0]!).sort()).toEqual([
      'avatar',
      'displayName',
      'id',
      'level',
      'mutualFriends',
      'relationship',
      'source',
      'username',
    ]);
    expect(JSON.stringify(r)).not.toMatch(/phone|hash/i);
  });

  it('counts mutual friends for people who are not your friends', async () => {
    const me = await person();
    const s = await person(`mutual_${uniq()}`);
    for (let i = 0; i < 2; i++) {
      const f = await person();
      await befriend(me, f);
      await befriend(s, f);
    }
    expect((await search.people(me.id, 'mutual')).people[0]!.mutualFriends).toBe(2);
  });

  it('stops after the daily search limit', async () => {
    await setConfig(db, 'people_searches_per_day', 3);
    try {
      const me = await person();
      for (let i = 0; i < 3; i++) await search.people(me.id, 'abc');
      await expect(search.people(me.id, 'abc')).rejects.toMatchObject({
        code: 'search_rate_limited',
      });
    } finally {
      await setConfig(db, 'people_searches_per_day', 600);
    }
  });
});

describe('profiles', () => {
  it('shows a stranger’s public side and nothing private', async () => {
    const me = await person();
    const s = await person(`shark_${uniq()}`);
    const friendOfBoth = await person();
    await befriend(me, friendOfBoth);
    await befriend(s, friendOfBoth);
    await play(s, friendOfBoth, s);
    const p = await profiles.get(me.id, s.username);
    expect(p).toMatchObject({
      username: s.username,
      relationship: 'none',
      inContacts: false,
      canRequest: true,
      recentGames: null,
      money: null,
      mutualFriends: { count: 1 },
      stats: { games: 1, wins: 1, winRate: 1 },
      headToHead: { wins: 0, losses: 0, draws: 0, last: null },
    });
    expect(p.badges.map((b) => b.slug)).toEqual(['first-win']);
    expect(p.playsMost[0]).toMatchObject({ gameName: 'Pig', played: 1, wins: 1 });
    expect(JSON.stringify(p)).not.toMatch(/phone|hash|birth/i);
  });

  it('shows friends their recent games (no amounts) and your head to head', async () => {
    const me = await fundedUser(db);
    const f = await fundedUser(db);
    await befriend(me, f);
    await play(me, f, f);
    await play(me, f, me);
    await play(me, f, me, { pool: 100_000 });
    const p = await profiles.get(me.id, f.username);
    expect(p.relationship).toBe('friends');
    expect(p.headToHead).toMatchObject({ wins: 2, losses: 1, draws: 0 });
    expect(p.headToHead!.last).toMatchObject({ mode: 'pool', result: 'win', netKobo: 100_000 });
    expect(p.recentGames).toHaveLength(3);
    expect(p.recentGames![0]).toMatchObject({ mode: 'pool', against: me.username, netKobo: null });
    expect(p.money).toBeNull();
    expect(p.canRequest).toBe(false);
  });

  it('gives you your own money and recent games on your own profile', async () => {
    const me = await fundedUser(db);
    const f = await fundedUser(db);
    await play(me, f, me, { pool: 200_000 });
    const p = await profiles.get(me.id, me.username);
    expect(p).toMatchObject({
      relationship: 'self',
      headToHead: null,
      money: { poolNetKobo: 200_000, bestPotKobo: 400_000 },
    });
    expect(p.recentGames![0]).toMatchObject({ result: 'win', netKobo: 200_000 });
    expect(p.xpForLevel).toBe(75);
  });

  it('looks like nobody exists when blocked either way, disabled or unknown', async () => {
    const me = await person();
    const a = await person();
    const b = await person();
    const c = await person();
    await block(me, a);
    await block(b, me);
    await db.admin.query('UPDATE users SET disabled_at = now() WHERE id = $1', [c.id]);
    for (const u of [a, b, c])
      await expect(profiles.get(me.id, u.username)).rejects.toMatchObject({
        code: 'user_not_found',
      });
    await expect(profiles.get(me.id, 'nobody_here')).rejects.toMatchObject({
      code: 'user_not_found',
    });
  });

  it('follows their request setting for canRequest', async () => {
    const me = await person();
    const closed = await person();
    const fof = await person();
    await db.admin.query(`UPDATE profiles SET request_policy = 'nobody' WHERE id = $1`, [
      closed.id,
    ]);
    await db.admin.query(`UPDATE profiles SET request_policy = 'fof' WHERE id = $1`, [fof.id]);
    expect((await profiles.get(me.id, closed.username)).canRequest).toBe(false);
    expect((await profiles.get(me.id, fof.username)).canRequest).toBe(false);
    const shared = await person();
    await befriend(me, shared);
    await befriend(fof, shared);
    expect((await profiles.get(me.id, fof.username)).canRequest).toBe(true);
  });

  it('lists every badge with locked ones empty', async () => {
    const me = await person();
    const o = await person();
    await play(me, o, me);
    const { badges } = await profiles.myBadges(me.id);
    expect(badges.map((b) => [b.slug, b.earnedAt !== null])).toEqual([
      ['first-win', true],
      ['streak-10', false],
      ['pool-shark', false],
      ['space-host', false],
      ['whot-master', false],
    ]);
  });
});

describe('leaderboards', () => {
  const xp = (u: TestUser, amount: number, at?: Date, matchId?: string) =>
    db.admin.query(
      `INSERT INTO xp_events (user_id, amount, reason, match_id, created_at) VALUES ($1, $2, 'win', $3, $4)`,
      [u.id, amount, matchId ?? null, at ?? new Date()],
    );

  it('knows when the Lagos week starts', () => {
    // Thursday 19 Nov 2026 -> Monday 16 Nov 00:00 Lagos = Sunday 23:00 UTC
    expect(lagosWeekStart(new Date('2026-11-19T12:00:00Z')).toISOString()).toBe(
      '2026-11-15T23:00:00.000Z',
    );
    // Sunday 23:30 UTC is already Monday 00:30 in Lagos: a new week
    expect(lagosWeekStart(new Date('2026-11-15T23:30:00Z')).toISOString()).toBe(
      '2026-11-15T23:00:00.000Z',
    );
    expect(lagosWeekStart(new Date('2026-11-15T22:30:00Z')).toISOString()).toBe(
      '2026-11-08T23:00:00.000Z',
    );
  });

  it('ranks you and your friends by XP this week, listing friends with none', async () => {
    const me = await person();
    const f1 = await person();
    const f2 = await person();
    const idle = await person();
    const stranger = await person();
    for (const f of [f1, f2, idle]) await befriend(me, f);
    await xp(me, 40);
    await xp(f1, 90);
    await xp(f2, 40);
    await xp(stranger, 500);
    await xp(f1, 1000, new Date(Date.now() - 20 * 86_400_000)); // an older week does not count
    const b = await boards.get(me.id, { scope: 'friends', metric: 'xp' });
    expect(b.rows.map((r) => [r.userId, r.rank, r.value])).toEqual([
      [f1.id, 1, 90],
      expect.arrayContaining([expect.any(String), 2, 40]),
      expect.arrayContaining([expect.any(String), 2, 40]),
      [idle.id, 4, 0],
    ]);
    expect(b.me).toMatchObject({ isMe: true, rank: 2, value: 40 });
    expect(b.above).toMatchObject({ userId: f1.id, value: 90 });
    expect(b.rows.every((r) => r.userId !== stranger.id)).toBe(true);
    expect(new Date(b.resetsAt).getTime() - new Date(b.weekStartsAt).getTime()).toBe(
      7 * 86_400_000,
    );
  });

  it('ranks everyone with XP on the global board, keeps you outside the top, and hides blocked people', async () => {
    const me = await person();
    const crowd: TestUser[] = [];
    for (let i = 0; i < 53; i++) {
      const u = await person();
      crowd.push(u);
      await xp(u, 5000 + i);
    }
    const blocked = await person();
    await xp(blocked, 99_999);
    await block(me, blocked);
    await xp(me, 1);
    const b = await boards.get(me.id, { scope: 'global', metric: 'xp' });
    expect(b.rows).toHaveLength(50);
    expect(b.rows[0]!.value).toBeLessThan(99_999);
    expect(b.rows.some((r) => r.userId === blocked.id)).toBe(false);
    expect(b.me).toMatchObject({ isMe: true, value: 1 });
    expect(b.me!.rank).toBeGreaterThan(50);
    expect(b.above!.rank).toBeLessThan(b.me!.rank);
    // someone with no XP this week is simply unranked
    const nobody = await person();
    expect((await boards.get(nobody.id, { scope: 'global', metric: 'xp' })).me).toBeNull();
  });

  it('filters by game', async () => {
    const me = await person();
    const f = await person();
    await befriend(me, f);
    const raceMatch = await createMatch(db, me.id, [me.id, f.id], { mode: 'free' });
    await db.admin.query(`UPDATE matches SET game_slug = 'test_race' WHERE id = $1`, [raceMatch]);
    await xp(me, 25, new Date(), raceMatch);
    await xp(f, 80); // no match: counts for "all games" only
    const all = await boards.get(me.id, { scope: 'friends', metric: 'xp' });
    expect(all.rows[0]).toMatchObject({ userId: f.id, value: 80 });
    const race = await boards.get(me.id, { scope: 'friends', metric: 'xp', game: 'test_race' });
    expect(race.rows[0]).toMatchObject({ userId: me.id, value: 25 });
    expect(race.rows[1]).toMatchObject({ userId: f.id, value: 0 });
  });

  it('ranks Pool net winnings among friends and treats the numbers as money', async () => {
    const me = await fundedUser(db);
    const f = await fundedUser(db);
    await befriend(me, f);
    await play(me, f, me, { pool: 300_000 });
    const b = await boards.get(me.id, { scope: 'friends', metric: 'pool' });
    expect(b.rows.map((r) => [r.userId, r.value])).toEqual([
      [me.id, 300_000],
      [f.id, -300_000],
    ]);
    expect(b.me!.rank).toBe(1);
  });
});

void randomUUID;
