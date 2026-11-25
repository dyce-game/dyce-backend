import { randomUUID } from 'node:crypto';
import {
  createMatch,
  createTestDb,
  createUser,
  ensureGame,
  type TestDb,
  type TestUser,
} from '../testing/testDb.ts';
import { expectPermissionDenied, fundedUser, setConfig } from './helpers.ts';

/**
 * XP, levels, streaks and badges (ADR-023). They are written by a trigger when a match turns `finished`, so every
 * finishing path (async matches, the game server) is covered by finishing through `settle_match` here, the same
 * call both of them make after writing placements.
 */
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  await ensureGame(db);
});
afterAll(async () => {
  await db.close();
});

type Result = 'win' | 'loss' | 'draw' | 'forfeit';

/** Writes placements the way the match code does, then settles. Free matches simply become `finished`. */
async function finish(
  matchId: string,
  results: [TestUser, Result][],
  opts: { finishedAt?: string } = {},
) {
  if (opts.finishedAt) {
    await db.admin.query('UPDATE matches SET finished_at = $2 WHERE id = $1', [
      matchId,
      opts.finishedAt,
    ]);
  }
  for (const [u, r] of results) {
    await db.app.query(
      `UPDATE match_players SET placement = $3, result = $4::match_result WHERE match_id = $1 AND user_id = $2`,
      [matchId, u.id, r === 'win' || r === 'draw' ? 1 : 2, r],
    );
  }
  await db.app.query('SELECT settle_match($1)', [matchId]);
}

const freeMatch = (a: TestUser, b: TestUser) =>
  createMatch(db, a.id, [a.id, b.id], { mode: 'free' });

const profile = async (u: TestUser) =>
  (
    await db.admin.query<{ level: number; xp: number }>(
      'SELECT level, xp FROM profiles WHERE id = $1',
      [u.id],
    )
  ).rows[0]!;
const xpRows = async (u: TestUser) =>
  (
    await db.admin.query<{ reason: string; amount: number }>(
      'SELECT reason, amount FROM xp_events WHERE user_id = $1 ORDER BY reason',
      [u.id],
    )
  ).rows;
const badges = async (u: TestUser) =>
  (
    await db.admin.query<{ badge_slug: string }>(
      'SELECT badge_slug FROM user_badges WHERE user_id = $1 ORDER BY 1',
      [u.id],
    )
  ).rows.map((r) => r.badge_slug);
const notes = async (u: TestUser, kind: string) =>
  (
    await db.admin.query('SELECT payload FROM notifications WHERE user_id = $1 AND kind = $2', [
      u.id,
      kind,
    ])
  ).rows;

describe('XP for a 1v1 game', () => {
  it('pays 25 for a win, 10 for playing and 5 for the first game of the day', async () => {
    const a = await createUser(db);
    const b = await createUser(db);
    await finish(await freeMatch(a, b), [
      [a, 'win'],
      [b, 'loss'],
    ]);
    expect(await xpRows(a)).toEqual([
      { reason: 'daily_first', amount: 5 },
      { reason: 'win', amount: 25 },
    ]);
    expect(await xpRows(b)).toEqual([
      { reason: 'daily_first', amount: 5 },
      { reason: 'play', amount: 10 },
    ]);
    expect(await profile(a)).toEqual({ level: 1, xp: 30 });
    expect(await profile(b)).toEqual({ level: 1, xp: 15 });
  });

  it('pays the daily 5 once a day, and a draw counts as playing', async () => {
    const a = await createUser(db);
    const b = await createUser(db);
    await finish(await freeMatch(a, b), [
      [a, 'draw'],
      [b, 'draw'],
    ]);
    await finish(await freeMatch(a, b), [
      [a, 'win'],
      [b, 'loss'],
    ]);
    expect((await xpRows(a)).map((r) => r.reason)).toEqual(['daily_first', 'play', 'win']);
    expect((await profile(a)).xp).toBe(5 + 10 + 25);
  });

  it('gives a forfeit nothing, and counts a finished match only once', async () => {
    const a = await createUser(db);
    const b = await createUser(db);
    const m = await freeMatch(a, b);
    await finish(m, [
      [a, 'win'],
      [b, 'forfeit'],
    ]);
    expect(await xpRows(b)).toEqual([]);
    const before = await profile(a);
    // settling again (a retry) must not pay twice
    await db.app.query('SELECT settle_match($1)', [m]);
    expect(await profile(a)).toEqual(before);
    expect(await xpRows(a)).toHaveLength(2);
  });

  it('does not pay for a match that is still going or was cancelled', async () => {
    const a = await createUser(db);
    const b = await createUser(db);
    const m = await freeMatch(a, b);
    await db.admin.query(`UPDATE matches SET status = 'cancelled' WHERE id = $1`, [m]);
    expect(await xpRows(a)).toEqual([]);
  });
});

describe('levels', () => {
  it('needs 75 x level XP per level and carries the surplus over', async () => {
    const a = await createUser(db);
    const b = await createUser(db);
    // 30 + 25 + 25 = 80: level 2 with 5 over; level 2 then needs 150
    for (let i = 0; i < 3; i++)
      await finish(await freeMatch(a, b), [
        [a, 'win'],
        [b, 'loss'],
      ]);
    expect(await profile(a)).toEqual({ level: 2, xp: 5 });
    const up = await notes(a, 'level_up');
    expect(up).toHaveLength(1);
    expect(up[0]!.payload).toEqual({ level: 2 });
    await db.admin.query('SELECT xp_for_level(8) AS n').then((r) => expect(r.rows[0].n).toBe(600));
  });
});

describe('anti-farming caps', () => {
  it('stops paying the same pair after the daily pair limit', async () => {
    await setConfig(db, 'xp_pair_games_per_day', 2);
    try {
      const a = await createUser(db);
      const b = await createUser(db);
      for (let i = 0; i < 4; i++)
        await finish(await freeMatch(a, b), [
          [a, 'win'],
          [b, 'loss'],
        ]);
      expect((await xpRows(a)).filter((r) => r.reason === 'win')).toHaveLength(2);
      // someone else is still paid
      const c = await createUser(db);
      await finish(await freeMatch(a, c), [
        [a, 'win'],
        [c, 'loss'],
      ]);
      expect((await xpRows(a)).filter((r) => r.reason === 'win')).toHaveLength(3);
    } finally {
      await setConfig(db, 'xp_pair_games_per_day', 5);
    }
  });

  it('stops paying one person after the daily match limit', async () => {
    await setConfig(db, 'xp_games_per_day', 2);
    try {
      const a = await createUser(db);
      for (let i = 0; i < 4; i++) {
        const other = await createUser(db);
        await finish(await freeMatch(a, other), [
          [a, 'win'],
          [other, 'loss'],
        ]);
      }
      expect((await xpRows(a)).filter((r) => r.reason === 'win')).toHaveLength(2);
    } finally {
      await setConfig(db, 'xp_games_per_day', 30);
    }
  });
});

describe('Spaces', () => {
  it('pays 60 / 30 / 15 by placement and gives the host of a 4-seat space the Space Host badge', async () => {
    const host = await createUser(db);
    const [p2, p3, p4] = [await createUser(db), await createUser(db), await createUser(db)];
    const m = await createMatch(db, host.id, [host.id, p2.id, p3.id, p4.id], { mode: 'free' });
    const space = randomUUID();
    await db.admin.query(
      `INSERT INTO spaces (id, code, name, host_id, game_slug, max_seats, status)
       VALUES ($1, $2, 'Friday', $3, '_example', 4, 'live')`,
      [space, `DY-${Math.floor(1000 + Math.random() * 8999)}`, host.id],
    );
    await db.admin.query('UPDATE matches SET space_id = $2 WHERE id = $1', [m, space]);
    const placements: [TestUser, number, Result][] = [
      [p2, 1, 'win'],
      [host, 2, 'loss'],
      [p3, 3, 'loss'],
      [p4, 4, 'loss'],
    ];
    for (const [u, place, r] of placements) {
      await db.admin.query(
        `UPDATE match_players SET placement = $3, result = $4::match_result WHERE match_id = $1 AND user_id = $2`,
        [m, u.id, place, r],
      );
    }
    await db.app.query('SELECT settle_match($1)', [m]);
    const amount = async (u: TestUser) =>
      (await xpRows(u)).find((r) => r.reason === 'space_place')!.amount;
    expect(await amount(p2)).toBe(60);
    expect(await amount(host)).toBe(30);
    expect(await amount(p3)).toBe(15);
    expect(await amount(p4)).toBe(15);
    expect(await badges(host)).toEqual(['space-host']);
    expect(await badges(p2)).toEqual(['first-win']);
  });
});

describe('streaks', () => {
  const streak = async (u: TestUser) =>
    (
      await db.admin.query<{ current: number; best: number }>(
        'SELECT current, best FROM streaks WHERE user_id = $1',
        [u.id],
      )
    ).rows[0];

  it('counts consecutive Lagos days with a win, resets after a gap and keeps the best', async () => {
    const a = await createUser(db);
    const b = await createUser(db);
    const win = async (iso: string) =>
      finish(
        await freeMatch(a, b),
        [
          [a, 'win'],
          [b, 'loss'],
        ],
        { finishedAt: iso },
      );
    await win('2026-11-10T09:00:00Z');
    expect(await streak(a)).toEqual({ current: 1, best: 1 });
    await win('2026-11-10T15:00:00Z'); // same day: no change
    expect(await streak(a)).toEqual({ current: 1, best: 1 });
    await win('2026-11-11T09:00:00Z');
    expect(await streak(a)).toEqual({ current: 2, best: 2 });
    await win('2026-11-14T09:00:00Z'); // two days missed
    expect(await streak(a)).toEqual({ current: 1, best: 2 });
  });

  it('a loss never extends a streak', async () => {
    const a = await createUser(db);
    const b = await createUser(db);
    await finish(await freeMatch(a, b), [
      [b, 'win'],
      [a, 'loss'],
    ]);
    expect(await streak(a)).toBeUndefined();
    expect(await streak(b)).toEqual({ current: 1, best: 1 });
  });

  it('awards 10 Streak at ten days in a row, once', async () => {
    const a = await createUser(db);
    const b = await createUser(db);
    for (let d = 1; d <= 10; d++) {
      const day = String(d).padStart(2, '0');
      await finish(
        await freeMatch(a, b),
        [
          [a, 'win'],
          [b, 'loss'],
        ],
        { finishedAt: `2026-10-${day}T10:00:00Z` },
      );
    }
    expect(await badges(a)).toEqual(['first-win', 'streak-10']);
    expect(await notes(a, 'badge_earned')).toHaveLength(2);
  });
});

describe('badges', () => {
  it('grants First Win exactly once, with one notification', async () => {
    const a = await createUser(db);
    const b = await createUser(db);
    await finish(await freeMatch(a, b), [
      [a, 'win'],
      [b, 'loss'],
    ]);
    await finish(await freeMatch(a, b), [
      [a, 'win'],
      [b, 'loss'],
    ]);
    expect(await badges(a)).toEqual(['first-win']);
    expect(await badges(b)).toEqual([]);
    expect(await notes(a, 'badge_earned')).toEqual([
      { payload: { badge: 'first-win', badgeName: 'First Win' } },
    ]);
  });

  it('grants Pool Shark after five Pool wins', async () => {
    const a = await fundedUser(db, { adult: true });
    const b = await fundedUser(db, { adult: true });
    for (let i = 0; i < 5; i++) {
      const m = await createMatch(db, a.id, [a.id, b.id], { mode: 'pool', stake: 10_000 });
      await db.app.query('SELECT stake_pool($1, $2, 10000, $3)', [m, a.id, `s:${m}:a`]);
      await db.app.query('SELECT stake_pool($1, $2, 10000, $3)', [m, b.id, `s:${m}:b`]);
      await finish(m, [
        [a, 'win'],
        [b, 'loss'],
      ]);
      if (i < 4) expect(await badges(a)).not.toContain('pool-shark');
    }
    expect(await badges(a)).toContain('pool-shark');
  });
});

describe('who can write progress', () => {
  it('the API role cannot insert XP, streaks or badges directly', async () => {
    const a = await createUser(db);
    await expectPermissionDenied(
      db.app.query(`INSERT INTO xp_events (user_id, amount, reason) VALUES ($1, 9999, 'cheat')`, [
        a.id,
      ]),
    );
    await expectPermissionDenied(
      db.app.query(`INSERT INTO user_badges (user_id, badge_slug) VALUES ($1, 'first-win')`, [
        a.id,
      ]),
    );
    await expectPermissionDenied(
      db.app.query(`INSERT INTO streaks (user_id, current, best) VALUES ($1, 99, 99)`, [a.id]),
    );
  });
});
