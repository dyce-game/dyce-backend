import { randomUUID } from 'node:crypto';
import { solveWordHuntBoard, wordHuntDictionary, wordHuntTotalScore } from '@dyce/games';
import type { MatchView, RealtimeEvent } from '@dyce/shared';
import { MessagesService } from '../../src/chat/messages.service.ts';
import { WORD_HUNT_GRACE_MS } from '../../src/matches/engines.ts';
import { MatchesService } from '../../src/matches/matches.service.ts';
import { FriendsService } from '../../src/social/friends.service.ts';
import { createTestDb, createUser, type TestDb, type TestUser } from '../testing/testDb.ts';

/**
 * Word Hunt on the real match service and the real registry entry: the catalogue row, hidden grid and
 * words, both players acting at the same time, the server clock rule, and one winner for both players.
 * (The engine's own rules are tested in packages/games.)
 */

const T0 = new Date('2026-11-15T10:00:00Z').getTime();
const clock = { t: T0 };
/** Every read of the clock moves it 1 ms so rows stay ordered; `jump` moves it on purpose. */
const now = () => new Date(clock.t++);
const jump = (ms: number) => void (clock.t += ms);

let db: TestDb;
let chat: MessagesService;
let friends: FriendsService;
let matches: MatchesService;
const published: { users: readonly string[]; event: RealtimeEvent }[] = [];
const publisher = {
  publish: (users: readonly string[], event: RealtimeEvent) =>
    void published.push({ users, event }),
};

beforeAll(async () => {
  db = await createTestDb();
  chat = new MessagesService(db.app, publisher, now);
  friends = new FriendsService(db.app, now);
  matches = new MatchesService(db.app, publisher, chat, now, { allowDevGames: false });
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  clock.t = T0;
  published.length = 0;
});

const code = (c: string) => expect.objectContaining({ code: c });

type WhView = {
  players: string[];
  roundMs: number;
  board: string[] | null;
  status: Record<string, 'idle' | 'playing' | 'done'>;
  scores: Record<string, number | null>;
  words: Record<string, string[] | null>;
  rejected: number | null;
  possibleWords: number | null;
  possibleScore: number | null;
};
const view = (m: MatchView) => m.view as WhView;

async function friendsWithChat() {
  const a = await createUser(db);
  const b = await createUser(db);
  await friends.sendRequest(a.id, b.id);
  await friends.accept(b.id, a.id);
  const conv = (await chat.openDirect(a.id, b.id)).id;
  return { a, b, conv };
}

/** Two friends who have accepted a Word Hunt: both can start at once. */
async function started() {
  const { a, b, conv } = await friendsWithChat();
  const m = await matches.create(a.id, {
    id: randomUUID(),
    conversationId: conv,
    gameSlug: 'word-hunt',
    mode: 'free',
  });
  await matches.accept(b.id, m.id);
  const state = (await db.admin.query('SELECT state FROM matches WHERE id = $1', [m.id])).rows[0]
    .state as { board: string[] };
  const solved = solveWordHuntBoard(state.board, wordHuntDictionary);
  return { a, b, id: m.id, solved };
}

const start = (u: TestUser, id: string, v: number) =>
  matches.submitMove(u.id, id, { expectedVersion: v, action: { kind: 'start' } });
const submit = (u: TestUser, id: string, v: number, words: string[]) =>
  matches.submitMove(u.id, id, { expectedVersion: v, action: { kind: 'submit', words } });

describe('catalogue', () => {
  it('lists Word Hunt (enabled, 2D, async, Free only for now)', async () => {
    const { games } = await matches.listGames();
    expect(games.find((g) => g.slug === 'word-hunt')).toEqual({
      slug: 'word-hunt',
      name: 'Word Hunt',
      dimension: '2d',
      sync: 'async',
      minPlayers: 2,
      maxPlayers: 2,
      categories: ['word'],
      supportsPool: false,
    });
  });
});

describe('playing a round', () => {
  it('hides the grid until you start, and both players can start at once', async () => {
    const { a, b, id } = await started();
    const before = view(await matches.get(a.id, id));
    expect(before.board).toBeNull();
    expect(before.status).toEqual({ [a.id]: 'idle', [b.id]: 'idle' });

    const afterA = await start(a, id, 0);
    expect(view(afterA).board).toHaveLength(16);
    // b has not started: still no grid for b, even though a has
    expect(view(await matches.get(b.id, id)).board).toBeNull();

    // b starts while a is still playing: there is no turn order
    const afterB = await start(b, id, 1);
    expect(view(afterB).board).toEqual(view(afterA).board);
    expect(afterB.status).toBe('active');
  });

  it('refuses a submit before start, and a second start', async () => {
    const { a, id } = await started();
    await expect(submit(a, id, 0, ['SEA'])).rejects.toEqual(code('illegal_move'));
    await start(a, id, 0);
    await expect(start(a, id, 1)).rejects.toEqual(code('illegal_move'));
  });

  it("keeps a player's words private until the viewer has finished too", async () => {
    const { a, b, id, solved } = await started();
    await start(a, id, 0);
    await start(b, id, 1);
    const words = solved.slice(0, 3);
    const doneA = await submit(a, id, 2, words);

    // a sees their own words; b (still playing) sees only that a is done and a's score
    expect(view(doneA).words[a.id]).toEqual(words);
    const bView = view(await matches.get(b.id, id));
    expect(bView.words[a.id]).toBeNull();
    expect(bView.scores[a.id]).toBe(wordHuntTotalScore(words));
    expect(bView.scores[b.id]).toBeNull();
    expect(bView.possibleWords).toBeNull();
    expect(JSON.stringify(bView)).not.toContain('seed');
  });

  it('scores both players, finishes the match and gives both the same winner', async () => {
    const { a, b, id, solved } = await started();
    const best = solved.slice(0, 6);
    const few = solved.slice(0, 2);
    await start(a, id, 0);
    await start(b, id, 1);
    await submit(b, id, 2, few);
    const done = await submit(a, id, 3, best);

    expect(done.status).toBe('finished');
    const oa = (await matches.get(a.id, id)).outcome;
    const ob = (await matches.get(b.id, id)).outcome;
    expect(oa).toEqual(ob);
    expect(oa).toEqual({ winnerIds: [a.id], draw: false });

    // once over, both can read both word lists and the possible total
    for (const u of [a, b]) {
      const v = view(await matches.get(u.id, id));
      expect(v.words[a.id]).toEqual(best);
      expect(v.words[b.id]).toEqual(few);
      expect(v.possibleWords).toBe(solved.length);
    }
    const rows = (
      await db.admin.query(
        'SELECT user_id, result, placement FROM match_players WHERE match_id = $1',
        [id],
      )
    ).rows;
    expect(rows.find((r) => r.user_id === a.id)).toMatchObject({ result: 'win', placement: 1 });
    expect(rows.find((r) => r.user_id === b.id)).toMatchObject({ result: 'loss', placement: 2 });
  });

  it('is a draw on equal scores', async () => {
    const { a, b, id, solved } = await started();
    const words = solved.slice(0, 4);
    await start(a, id, 0);
    await start(b, id, 1);
    await submit(a, id, 2, words);
    const done = await submit(b, id, 3, [...words].reverse());
    expect(done.outcome).toEqual({ winnerIds: [], draw: true });
  });
});

describe('the dictionary and the grid are checked on the server', () => {
  it('drops words that are not words or not on the grid, and counts duplicates once', async () => {
    const { a, b, id, solved } = await started();
    const real = solved[0] as string;
    await start(a, id, 0);
    await start(b, id, 1);
    const done = await submit(a, id, 2, [real, real.toLowerCase(), 'ZZZZQQQ', 'XQXQX']);
    const v = view(done);
    expect(v.words[a.id]).toEqual([real]);
    expect(v.scores[a.id]).toBe(wordHuntTotalScore([real]));
    expect(v.rejected).toBe(2);
  });

  it('refuses a malformed submit (not letters)', async () => {
    const { a, id } = await started();
    await start(a, id, 0);
    await expect(submit(a, id, 1, ['no spaces', '12'])).rejects.toEqual(code('invalid_action'));
  });
});

describe('the round clock (server side)', () => {
  it('accepts a submit inside the round plus the grace period', async () => {
    const { a, b, id, solved } = await started();
    await start(a, id, 0);
    await start(b, id, 1);
    jump(80_000 + WORD_HUNT_GRACE_MS - 5_000);
    const words = solved.slice(0, 3);
    const done = await submit(a, id, 2, words);
    expect(view(done).words[a.id]).toEqual(words);
  });

  it('scores a late submit as zero, and the match still ends for both', async () => {
    const { a, b, id, solved } = await started();
    await start(a, id, 0);
    await start(b, id, 1);
    await submit(b, id, 2, solved.slice(0, 2));
    jump(80_000 + WORD_HUNT_GRACE_MS + 5_000);
    const done = await submit(a, id, 3, solved.slice(0, 6));

    expect(done.status).toBe('finished');
    expect(view(done).words[a.id]).toEqual([]);
    expect(view(done).scores[a.id]).toBe(0);
    expect(done.outcome).toEqual({ winnerIds: [b.id], draw: false });
    // the stored move is the one that was applied, so the match can be replayed
    const moves = (
      await db.admin.query(
        'SELECT action FROM match_moves WHERE match_id = $1 AND user_id = $2 ORDER BY seq',
        [id, a.id],
      )
    ).rows;
    expect(moves[1]?.action).toEqual({ kind: 'submit', words: [] });
  });

  it('measures each player from their own start', async () => {
    const { a, b, id, solved } = await started();
    await start(a, id, 0);
    jump(70_000); // a is 70 s in, b has not started
    await start(b, id, 1);
    jump(70_000); // a is 140 s in (late); b is 70 s in (on time)
    const bDone = await submit(b, id, 2, solved.slice(0, 3));
    expect(view(bDone).words[b.id]).toHaveLength(3);
    const aDone = await submit(a, id, 3, solved.slice(0, 3));
    expect(view(aDone).words[a.id]).toEqual([]);
  });
});

describe('retries and concurrency', () => {
  it('a repeated submit after a lost response is acknowledged, not applied twice', async () => {
    const { a, b, id, solved } = await started();
    await start(a, id, 0);
    await start(b, id, 1);
    const words = solved.slice(0, 3);
    await submit(a, id, 2, words);
    const again = await submit(a, id, 2, words);
    expect(view(again).words[a.id]).toEqual(words);
    const n = (
      await db.admin.query('SELECT count(*) AS n FROM match_moves WHERE match_id = $1', [id])
    ).rows[0].n;
    expect(Number(n)).toBe(3);
  });

  it('two players submitting at the same moment: one lands, the other retries on the new version', async () => {
    const { a, b, id, solved } = await started();
    await start(a, id, 0);
    await start(b, id, 1);
    const wa = solved.slice(0, 2);
    const wb = solved.slice(0, 3);
    const results = await Promise.allSettled([submit(a, id, 2, wa), submit(b, id, 2, wb)]);
    const lost = results.findIndex((r) => r.status === 'rejected');
    if (lost >= 0) {
      expect((results[lost] as PromiseRejectedResult).reason).toEqual(code('stale_version'));
      const loser = lost === 0 ? a : b;
      const current = await matches.get(loser.id, id);
      const done = await submit(loser, id, current.stateVersion, lost === 0 ? wa : wb);
      expect(done.status).toBe('finished');
    } else {
      expect((await matches.get(a.id, id)).status).toBe('finished');
    }
  });
});
