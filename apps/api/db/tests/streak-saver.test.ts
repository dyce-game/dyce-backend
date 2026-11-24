import { StreakService } from '../../src/progress/streak.service.ts';
import {
  createMatch,
  createTestDb,
  createUser,
  ensureGame,
  type TestDb,
  type TestUser,
} from '../testing/testDb.ts';
import { expectPermissionDenied } from './helpers.ts';

/**
 * Streak lost and the streak saver (SPEC section 9, ADR-042) on real PostgreSQL. A streak is consecutive Lagos days
 * with a win; it ends when a whole day passes without one; the person then has the next Lagos day to win one Free
 * game, which brings the old length back. Used once, then not offered again for a week. Days are placed by writing
 * the match's `finished_at` (the award trigger reads it), the same way progress.test.ts does.
 */
let db: TestDb;
let streaks: StreakService;
beforeAll(async () => {
  db = await createTestDb();
  await ensureGame(db);
  streaks = new StreakService(db.app);
});
afterAll(async () => {
  await db.close();
});

const DAY = 86_400_000;
/** Noon in Lagos (11:00 UTC) `n` days ago, safely inside that Lagos day; `n = 0` is now. */
function noon(n: number): string {
  if (n === 0) return new Date().toISOString();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }); // YYYY-MM-DD, Lagos
  return new Date(Date.parse(`${today}T11:00:00Z`) - n * DAY).toISOString();
}
/** The Lagos date `n` days ago, YYYY-MM-DD. */
const lagosDay = async (n: number): Promise<string> =>
  (
    await db.admin.query<{ d: string }>(
      `SELECT ((now() AT TIME ZONE 'Africa/Lagos')::date - $1::int)::text AS d`,
      [n],
    )
  ).rows[0]!.d;

type Result = 'win' | 'loss';
/** A two-player match finished at `at`: placements as the match code writes them, then settled. */
async function play(
  a: TestUser,
  b: TestUser,
  winner: TestUser | null,
  at: string,
  mode: 'free' | 'pool' = 'free',
): Promise<string> {
  const id = await createMatch(db, a.id, [a.id, b.id], { mode });
  await db.admin.query('UPDATE matches SET finished_at = $2 WHERE id = $1', [id, at]);
  for (const u of [a, b]) {
    const r: Result = u === winner ? 'win' : 'loss';
    await db.app.query(
      `UPDATE match_players SET placement = $3, result = $4::match_result WHERE match_id = $1 AND user_id = $2`,
      [id, u.id, r === 'win' ? 1 : 2, r],
    );
  }
  await db.app.query('SELECT settle_match($1)', [id]);
  return id;
}

const row = async (u: TestUser) =>
  (
    await db.admin.query<{
      current: number;
      best: number;
      last_win_date: string | null;
      lost_length: number | null;
      saver_expires_at: Date | null;
      saver_used_at: Date | null;
    }>(
      `SELECT current, best, last_win_date::text, lost_length, saver_expires_at, saver_used_at
         FROM streaks WHERE user_id = $1`,
      [u.id],
    )
  ).rows[0];

/** A person who won on each of the given days-ago, against a throwaway opponent (a friend of nobody). */
async function winner(daysAgo: number[]): Promise<{ me: TestUser; foe: TestUser }> {
  const me = await createUser(db);
  const foe = await createUser(db);
  for (const n of daysAgo) await play(me, foe, me, noon(n));
  return { me, foe };
}

const notifications = async (u: TestUser) =>
  (
    await db.admin.query<{
      kind: string;
      payload: Record<string, unknown>;
      actor_id: string | null;
    }>(
      `SELECT kind, payload, actor_id FROM notifications WHERE user_id = $1 AND kind = 'streak_lost'`,
      [u.id],
    )
  ).rows;

describe('keeping a streak', () => {
  it('counts consecutive days, and a streak stays alive through the day after the last win', async () => {
    const { me } = await winner([4, 3, 2, 1]);
    expect(await row(me)).toMatchObject({ current: 4, best: 4 });
    const s = await streaks.get(me.id);
    expect(s).toMatchObject({ current: 4, best: 4, wonToday: false, lost: null });
  });

  it('says a win today keeps it', async () => {
    const { me, foe } = await winner([2, 1]);
    await play(me, foe, me, new Date().toISOString());
    expect(await streaks.get(me.id)).toMatchObject({ current: 3, wonToday: true, lost: null });
  });
});

describe('a streak that ended', () => {
  it('is noticed when the person looks: the length, the day it ended and the saver on offer', async () => {
    // won on days -5..-2, nothing yesterday or today: it ended yesterday
    const { me } = await winner([5, 4, 3, 2]);
    const s = await streaks.get(me.id);
    expect(s.current).toBe(0);
    expect(s.best).toBe(4);
    expect(s.lost).toMatchObject({
      length: 4,
      endedOn: await lagosDay(1),
      brokenBy: null,
      saverAvailable: true,
      seen: false,
    });
    // the 24 hours end at the next Lagos midnight: between 0 and 24 hours from now
    const left = new Date(s.lost!.saverExpiresAt!).getTime() - Date.now();
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(DAY);
    // one notification, and asking again changes nothing
    expect(await notifications(me)).toHaveLength(1);
    expect(await streaks.get(me.id)).toEqual(s);
    expect(await notifications(me)).toHaveLength(1);
    expect(await row(me)).toMatchObject({ current: 0, lost_length: 4 });
  });

  it('names the person who beat them on the day it ended', async () => {
    const { me, foe } = await winner([4, 3, 2]);
    await play(me, foe, foe, noon(1)); // lost to foe yesterday
    const s = await streaks.get(me.id);
    expect(s.lost?.length).toBe(3);
    expect(s.lost?.brokenBy).toMatchObject({ id: foe.id, username: foe.username });
    expect((await notifications(me))[0]).toMatchObject({ actor_id: foe.id });
  });

  it('is noticed by the hourly sweep without anyone opening the app, once', async () => {
    const { me } = await winner([6, 5, 4, 3]);
    const n = await streaks.sweep();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await row(me)).toMatchObject({ current: 0, lost_length: 4 });
    const note = (await notifications(me))[0]!;
    expect(note.payload).toMatchObject({ length: 4, saver: true });
    await streaks.sweep();
    expect(await notifications(me)).toHaveLength(1);
  });

  it('a single-day streak just starts again: no screen, no saver', async () => {
    const { me } = await winner([3]);
    const s = await streaks.get(me.id);
    expect(s).toMatchObject({ current: 0, lost: null });
    expect(await notifications(me)).toHaveLength(0);
  });

  it('the person can say they have seen it; it then stays seen', async () => {
    const { me } = await winner([4, 3, 2]);
    expect((await streaks.get(me.id)).lost?.seen).toBe(false);
    await streaks.markSeen(me.id);
    await streaks.markSeen(me.id);
    expect((await streaks.get(me.id)).lost?.seen).toBe(true);
  });
});

describe('the streak saver', () => {
  it('a Free win inside the 24 hours brings the old length back', async () => {
    const { me, foe } = await winner([5, 4, 3, 2]);
    expect((await streaks.get(me.id)).lost?.saverAvailable).toBe(true);
    await play(me, foe, me, new Date().toISOString(), 'free');
    const s = await streaks.get(me.id);
    expect(s).toMatchObject({ current: 4, best: 4, wonToday: true, lost: null });
    const r = (await row(me))!;
    expect(r.saver_used_at).not.toBeNull();
    expect(r.lost_length).toBeNull();
    expect(r.saver_expires_at).toBeNull();
    // and tomorrow's win makes it one longer (the restoring win was today's)
    await play(me, foe, me, new Date().toISOString());
    expect((await row(me))!.current).toBe(4); // a second win the same day changes nothing
  });

  it('works even when nobody looked first (the win itself notices the loss)', async () => {
    const { me, foe } = await winner([5, 4, 3, 2]);
    // no get() and no sweep: straight to a win
    await play(me, foe, me, new Date().toISOString());
    expect(await row(me)).toMatchObject({ current: 4, lost_length: null });
  });

  it('a loss, a draw or a Pool win does not use it; a Free win afterwards still does', async () => {
    const { me, foe } = await winner([5, 4, 3, 2]);
    await streaks.get(me.id);
    await play(me, foe, foe, new Date().toISOString()); // lost today
    expect(await row(me)).toMatchObject({ current: 0, lost_length: 4 });
    await play(me, foe, null, new Date().toISOString()); // nobody won
    expect(await row(me)).toMatchObject({ current: 0, lost_length: 4 });
    await play(me, foe, me, new Date().toISOString(), 'pool'); // a Pool win is a win, not the saver's win
    expect(await row(me)).toMatchObject({ current: 1, lost_length: 4 });
    expect((await streaks.get(me.id)).lost?.saverAvailable).toBe(true);
    await play(me, foe, me, new Date().toISOString(), 'free');
    expect(await row(me)).toMatchObject({ current: 4, lost_length: null });
  });

  it('is gone after the 24 hours: a later win starts a streak of one', async () => {
    // it ended three days ago; the saver day (two days ago) is over
    const { me, foe } = await winner([8, 7, 6, 5]);
    const s = await streaks.get(me.id);
    expect(s.lost).toBeNull(); // too old to show
    await play(me, foe, me, new Date().toISOString());
    expect(await row(me)).toMatchObject({ current: 1, best: 4 });
  });

  it('is used once: a second loss within the cooldown offers no saver', async () => {
    const { me, foe } = await winner([5, 4, 3, 2]);
    await play(me, foe, me, new Date().toISOString()); // restored, saver used just now
    expect((await row(me))!.saver_used_at).not.toBeNull();
    // time passes: pretend the streak (now 4, last win today) ended again 3 days later
    await db.admin.query(
      `UPDATE streaks SET last_win_date = last_win_date - 3 WHERE user_id = $1`,
      [me.id],
    );
    const s = await streaks.get(me.id);
    expect(s.lost).toMatchObject({ length: 4, saverAvailable: false, saverExpiresAt: null });
    expect((await notifications(me)).at(-1)?.payload).toMatchObject({ saver: false });
    // after the cooldown a saver is offered again
    await db.admin.query(
      `UPDATE streaks SET saver_used_at = now() - interval '8 days', current = 3,
              last_win_date = (now() AT TIME ZONE 'Africa/Lagos')::date - 2,
              lost_length = NULL, lost_on = NULL, saver_expires_at = NULL WHERE user_id = $1`,
      [me.id],
    );
    expect((await streaks.get(me.id)).lost).toMatchObject({ length: 3, saverAvailable: true });
  });
});

describe('who can change a streak', () => {
  it('only the award trigger: the API role cannot write streaks or call the rules directly', async () => {
    const { me } = await winner([3, 2]);
    await expectPermissionDenied(
      db.app.query(`UPDATE streaks SET current = 99 WHERE user_id = $1`, [me.id]),
    );
    await expectPermissionDenied(db.app.query(`SELECT _streak_win($1, now(), true)`, [me.id]));
    await expectPermissionDenied(db.app.query(`SELECT _streak_roll($1)`, [me.id]));
    expect((await row(me))!.current).toBe(2);
  });

  it('reading the streak of a person with no wins is an empty one', async () => {
    const nobody = await createUser(db);
    expect(await streaks.get(nobody.id)).toEqual({
      current: 0,
      best: 0,
      wonToday: false,
      lost: null,
      friendsBest: null,
    });
  });

  it('shows the longest streak among friends', async () => {
    const { me } = await winner([3, 2]);
    const friend = await winner([3, 2, 1]);
    const [lo, hi] = me.id < friend.me.id ? [me.id, friend.me.id] : [friend.me.id, me.id];
    await db.admin.query(
      `INSERT INTO friendships (user_low, user_high, requested_by, status) VALUES ($1, $2, $3, 'accepted')`,
      [lo, hi, me.id],
    );
    const s = await streaks.get(me.id);
    expect(s.friendsBest).toMatchObject({ username: friend.me.username, length: 3 });
  });
});
