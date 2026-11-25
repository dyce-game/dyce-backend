import { randomUUID } from 'node:crypto';
import {
  SEA_FLEET,
  anagramsDictionary,
  solveAnagrams,
  solveWordHuntBoard,
  wordHuntDictionary,
} from '@dyce/games';
import type { MatchView, RealtimeEvent } from '@dyce/shared';
import { MessagesService } from '../../src/chat/messages.service.ts';
import { ENGINES } from '../../src/matches/engines.ts';
import { MatchesService } from '../../src/matches/matches.service.ts';
import { FriendsService } from '../../src/social/friends.service.ts';
import { balanceOf, createTestDb, type TestDb, type TestUser } from '../testing/testDb.ts';
import { expectLedgerClean, fundedUser } from './helpers.ts';

/**
 * Pool for every async game (ADR-041), on the real match service, the real registry and real PostgreSQL.
 *
 * For each game that has Pool switched on by migration this plays a whole Pool match through settlement with the
 * game's own rules, checks both wallets before and after (a win pays the pot, a draw gives both stakes back), and
 * checks the ledger invariants. The same games also settle by resignation and by the turn clock (24 hours), and a
 * suspicious pair is held rather than paid on every path. A game is only in POOL_GAMES if its migration turned
 * Pool on, and a game whose Pool is switched on without being in this list fails the first test.
 */

/** Every game with Pool, and what it takes to play one match of it out. */
const POOL_GAMES = [
  'word-hunt',
  'cup-pong',
  'anagrams',
  'filler',
  'tanks',
  'mini-golf',
  'darts',
  'basketball',
  'archery',
  'eight-ball',
  'chess',
  'checkers',
  'ayo',
  'dots-and-boxes',
  'ludo',
  'sea-battle',
] as const;
/** Free only, with the reason (ADR-041). */
const FREE_ONLY = ['word-tiles'] as const;

const NAIRA = 100;
const clock = { t: Date.now() };
const now = () => new Date(clock.t++);
const jump = (ms: number) => void (clock.t += ms);
const HOUR = 3_600_000;

let db: TestDb;
let chat: MessagesService;
let friends: FriendsService;
let matches: MatchesService;
const publisher = { publish: (_users: readonly string[], _event: RealtimeEvent) => undefined };

beforeAll(async () => {
  db = await createTestDb();
  chat = new MessagesService(db.app, publisher, now);
  friends = new FriendsService(db.app, now);
  matches = new MatchesService(db.app, publisher, chat, now, { allowDevGames: false });
});
afterAll(async () => {
  await db.close();
});

const code = (c: string) => expect.objectContaining({ code: c });

async function pair() {
  const a = await fundedUser(db);
  const b = await fundedUser(db);
  await friends.sendRequest(a.id, b.id);
  await friends.accept(b.id, a.id);
  const conv = (await chat.openDirect(a.id, b.id)).id;
  return { a, b, conv };
}

async function minStake(slug: string): Promise<number> {
  const r = await db.admin.query<{ pool_min_stake_kobo: string | null }>(
    `SELECT pool_min_stake_kobo FROM games WHERE slug = $1`,
    [slug],
  );
  return Math.max(10_000, Number(r.rows[0]?.pool_min_stake_kobo ?? 0));
}

/** A Pool match, sent by a and accepted by b, with both stakes locked. */
async function poolMatch(
  slug: string,
  opts: { options?: Record<string, string | number | boolean>; stake?: number } = {},
) {
  const { a, b, conv } = await pair();
  const stake = opts.stake ?? (await minStake(slug));
  const m = await matches.create(a.id, {
    id: randomUUID(),
    conversationId: conv,
    gameSlug: slug,
    mode: 'pool',
    stakeKobo: stake,
    options: opts.options,
  });
  const live = await matches.accept(b.id, m.id);
  return { a, b, conv, stake, id: m.id, live };
}

const START = 200_000 * NAIRA;

// ---- strategies: how to play one whole match with only the game's own rules -----------------------------------

type Ctx = {
  /** The viewer's view of the match. */
  view: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  me: string;
  other: string;
  /** a (the creator, players[0]) or b */
  isA: boolean;
  /** How many moves this player has made so far. */
  mine: number;
  /** Moves made by anybody so far. */
  step: number;
};
/** Candidate actions in order of preference; the first one the server accepts is played. */
type Strategy = (c: Ctx) => unknown[];

const lines = (dots: number) => {
  const out: unknown[] = [];
  for (let r = 0; r < dots; r++)
    for (let c = 0; c < dots - 1; c++) out.push({ kind: 'line', dir: 'h', r, c });
  for (let r = 0; r < dots - 1; r++)
    for (let c = 0; c < dots; c++) out.push({ kind: 'line', dir: 'v', r, c });
  return out;
};

const WHITE = ['e2e4', 'f1c4', 'd1h5', 'h5f7'];
const BLACK = ['e7e5', 'b8c6', 'g8f6'];
const sq = (m: string) => ({
  kind: 'move',
  from: m.slice(0, 2),
  to: m.slice(2, 4),
});

const STRATEGIES: Record<string, Strategy> = {
  // Word games: a plays real words, b plays none, so a wins. (A solver is how a cheat would play too: see ADR-041.)
  'word-hunt': ({ view, isA }) => [
    { kind: 'start' },
    {
      kind: 'submit',
      words:
        isA && view.board ? solveWordHuntBoard(view.board, wordHuntDictionary).slice(0, 12) : [],
    },
  ],
  anagrams: ({ view, isA }) => [
    { kind: 'start' },
    {
      kind: 'submit',
      words: isA && view.letters ? solveAnagrams(view.letters, anagramsDictionary).slice(0, 8) : [],
    },
  ],
  'cup-pong': ({ step }) => [
    { kind: 'throw', aim: ((step * 37) % 200) - 100, power: 600 + ((step * 13) % 250) },
  ],
  filler: () => [0, 1, 2, 3, 4, 5].map((colour) => ({ kind: 'pick', colour })),
  tanks: ({ step }) => [
    {
      kind: 'fire',
      angle: 20 + ((step * 7) % 140),
      power: 30 + ((step * 11) % 70),
      weapon: 'shell',
    },
  ],
  'mini-golf': ({ step }) => [
    {
      kind: 'putt',
      dx: ((step * 53) % 1000) - 500 || 1,
      dy: -1000,
      power: 300 + ((step * 29) % 700),
    },
  ],
  darts: () => [{ kind: 'throw', x: 0, y: 0 }],
  basketball: ({ step }) => [{ kind: 'shoot', aim: 0, power: 500 + ((step * 17) % 400) }],
  archery: () => [{ kind: 'shoot', aimX: 0, aimY: 0, draw: 800 }],
  'eight-ball': ({ step }) => {
    const base = {
      kind: 'shoot',
      angle: (step * 1237) % 36000,
      power: 400 + ((step * 131) % 600),
      spinX: 0,
      spinY: 0,
    };
    const place = { x: 3000, y: 5600 };
    return [
      base,
      { ...base, place },
      ...[0, 1, 2, 3, 4, 5].flatMap((pocket) => [
        { ...base, call: { pocket } },
        { ...base, place, call: { pocket } },
      ]),
    ];
  },
  // Fool's mate for white: a mates in four moves, b has no way back.
  chess: ({ isA, mine }) => {
    const m = (isA ? WHITE : BLACK)[mine];
    return m ? [sq(m)] : [];
  },
  checkers: ({ view }) =>
    (view.legal ?? []).map((l: { path: number[] }) => ({ kind: 'move', path: l.path })),
  ayo: ({ view }) => (view.legal ?? []).map((pit: number) => ({ kind: 'sow', pit })),
  'dots-and-boxes': () => lines(5),
  ludo: ({ view }) => [
    { kind: 'roll' },
    ...(view.legal ?? []).map((token: number) => ({ kind: 'move', token })),
  ],
  'sea-battle': ({ view, other }) => {
    const done = new Set<number>(
      (view.boards?.[other]?.shots ?? []).map((s: { cell: number }) => s.cell),
    );
    const shots: { r: number; c: number }[] = [];
    for (let cell = 0; cell < 100 && shots.length < (view.shotsAllowed || 1); cell++) {
      if (!done.has(cell)) shots.push({ r: Math.floor(cell / 10), c: cell % 10 });
    }
    return [
      {
        kind: 'place',
        // Five ships stacked at the top left, so the same fixed firing order ends the game quickly.
        ships: SEA_FLEET.map((_, i) => ({ r: i, c: 0, dir: 'h' })),
      },
      { kind: 'fire', shots },
    ];
  },
};

const RETRYABLE = new Set(['illegal_move', 'invalid_action', 'not_your_turn']);

/** Plays until the engine ends the match. Returns the final view (a's) and how many moves it took. */
async function playOut(
  slug: string,
  a: TestUser,
  b: TestUser,
  id: string,
  maxMoves = 2500,
): Promise<{ final: MatchView; moves: number }> {
  const strategy = STRATEGIES[slug]!;
  let m = await matches.get(a.id, id);
  const own = { [a.id]: 0, [b.id]: 0 } as Record<string, number>;
  for (let step = 0; step < maxMoves && m.status === 'active'; step++) {
    const first = m.currentTurn === b.id ? [b, a] : [a, b];
    let moved = false;
    for (const u of first) {
      const v = await matches.get(u.id, id);
      const ctx: Ctx = {
        view: v.view as Ctx['view'],
        me: u.id,
        other: u === a ? b.id : a.id,
        isA: u === a,
        mine: own[u.id]!,
        step,
      };
      for (const action of strategy(ctx)) {
        jump(5_000); // people take a few seconds a move: the integrity layer reads the gaps (ADR-039)
        try {
          m = await matches.submitMove(u.id, id, {
            expectedVersion: v.stateVersion,
            action: action as never,
          });
          own[u.id]! += 1;
          moved = true;
          break;
        } catch (err) {
          const c = (err as { code?: string }).code;
          if (!c || !RETRYABLE.has(c)) throw err;
        }
      }
      if (moved) break;
    }
    if (!moved) throw new Error(`${slug}: nobody could move at step ${step}`);
  }
  const final = await matches.get(a.id, id);
  return { final, moves: own[a.id]! + own[b.id]! };
}

// ---- 1. Pool is on for exactly the games that were proven -----------------------------------------------------

describe('which games have Pool', () => {
  it('has Pool for exactly the proven games, and the drawer says so with each Pool minimum', async () => {
    const { games } = await matches.listGames();
    const withPool = games.filter((g) => g.supportsPool).map((g) => g.slug);
    expect(withPool.sort()).toEqual([...POOL_GAMES].sort());
    for (const slug of FREE_ONLY) {
      const g = games.find((x) => x.slug === slug);
      expect(g?.supportsPool).toBe(false);
    }
    // The minimum shown is the one in docs/GAMES.md.
    const wh = games.find((g) => g.slug === 'word-hunt');
    expect(wh?.poolMinKobo).toBe(20_000);
    expect(games.find((g) => g.slug === 'cup-pong')?.poolMinKobo).toBe(10_000);
    expect(games.find((g) => g.slug === 'chess')?.poolMinKobo).toBe(50_000);
  });

  it('refuses Pool for a Free-only game with pool_not_supported, and below the game minimum with invalid_stake', async () => {
    const { a, conv } = await pair();
    await expect(
      matches.create(a.id, {
        id: randomUUID(),
        conversationId: conv,
        gameSlug: 'word-tiles',
        mode: 'pool',
        stakeKobo: 50_000,
      }),
    ).rejects.toEqual(code('pool_not_supported'));
    await expect(
      matches.create(a.id, {
        id: randomUUID(),
        conversationId: conv,
        gameSlug: 'chess',
        mode: 'pool',
        stakeKobo: 20_000, // above the platform's Ð100 but under Chess's Ð500
      }),
    ).rejects.toEqual(code('invalid_stake'));
    await expectLedgerClean(db);
  });
});

// ---- 2. a whole Pool match per game, played through settlement ------------------------------------------------

describe('a Pool match played to the end settles correctly', () => {
  it.each(POOL_GAMES)(
    '%s',
    async (slug) => {
      const { a, b, stake, id, live } = await poolMatch(slug);
      // Both stakes are locked the moment the game starts.
      expect(live.status).toBe('active');
      expect(live.mode).toBe('pool');
      expect(live.potKobo).toBe(2 * stake);
      expect(await balanceOf(db, a.id)).toBe(START - stake);
      expect(await balanceOf(db, b.id)).toBe(START - stake);

      const { final, moves } = await playOut(slug, a, b, id);
      expect(moves).toBeGreaterThan(0);
      expect(final.status).toBe('finished');
      expect(final.currentTurn).toBeNull();
      expect(final.turnDeadlineAt).toBeNull();

      const ba = await balanceOf(db, a.id);
      const bb = await balanceOf(db, b.id);
      if (final.outcome?.draw) {
        // A draw gives both stakes back.
        expect([ba, bb]).toEqual([START, START]);
        expect(final.players.map((p) => p.payoutKobo)).toEqual([stake, stake]);
      } else {
        const winner = final.outcome!.winnerIds[0]!;
        expect(final.outcome!.winnerIds).toHaveLength(1);
        // The winner takes the pot; nothing is created or lost.
        expect(winner === a.id ? [ba, bb] : [bb, ba]).toEqual([START + stake, START - stake]);
        expect(final.players.find((p) => p.userId === winner)?.payoutKobo).toBe(2 * stake);
        expect(final.players.find((p) => p.userId !== winner)?.payoutKobo).toBe(0);
      }
      // Nothing is left locked in the escrow.
      const esc = await db.admin.query<{ status: string }>(
        `SELECT status FROM pool_escrows WHERE match_id = $1`,
        [id],
      );
      expect(esc.rows[0]?.status).toBe('settled');
      await expectLedgerClean(db);
    },
    180_000,
  );
});

// ---- 3. giving up, and the turn clock -------------------------------------------------------------------------

describe('resigning a Pool match', () => {
  it.each(POOL_GAMES)(
    '%s: the other player takes the pot',
    async (slug) => {
      const { a, b, stake, id } = await poolMatch(slug);
      const done = await matches.resign(b.id, id);
      expect(done.status).toBe('finished');
      expect(done.outcome?.winnerIds).toEqual([a.id]);
      expect(await balanceOf(db, a.id)).toBe(START + stake);
      expect(await balanceOf(db, b.id)).toBe(START - stake);
      // Resigning twice changes nothing.
      await matches.resign(b.id, id);
      expect(await balanceOf(db, a.id)).toBe(START + stake);
      await expectLedgerClean(db);
    },
    60_000,
  );
});

describe('the turn clock of a Pool match (24 hours)', () => {
  it.each(POOL_GAMES)(
    '%s: nobody moves for a day',
    async (slug) => {
      const { a, b, stake, id, live } = await poolMatch(slug);
      // The clock is set when the game starts and shown to both players.
      const due = new Date(live.turnDeadlineAt!).getTime();
      expect(due - clock.t).toBeGreaterThan(23 * HOUR);
      expect(due - clock.t).toBeLessThan(25 * HOUR);

      // Just before the deadline nothing happens.
      jump(23 * HOUR);
      expect(await matches.forfeitOverdueMatches()).toBe(0);
      expect((await matches.get(a.id, id)).status).toBe('active');

      const state = (await db.admin.query(`SELECT state FROM matches WHERE id = $1`, [id])).rows[0]
        .state;
      const current: string[] = ENGINES[slug]!.engine.currentPlayers(state);
      jump(2 * HOUR);
      expect(await matches.forfeitOverdueMatches()).toBeGreaterThanOrEqual(1);
      const done = await matches.get(a.id, id);
      if (current.length === 1) {
        // The one player on the clock forfeits: the other takes the pot.
        const loser = current[0]!;
        const winner = loser === a.id ? b.id : a.id;
        expect(done.status).toBe('finished');
        expect(done.outcome?.winnerIds).toEqual([winner]);
        const meta = (await db.admin.query(`SELECT live_meta FROM matches WHERE id = $1`, [id]))
          .rows[0].live_meta;
        expect(meta).toMatchObject({ forfeitedBy: loser, forfeitReason: 'timeout' });
        expect(await balanceOf(db, winner)).toBe(START + stake);
        expect(await balanceOf(db, loser)).toBe(START - stake);
      } else {
        // Both were due (a game where both play at once and nobody moved): every stake goes back.
        expect(done.status).toBe('cancelled');
        expect(await balanceOf(db, a.id)).toBe(START);
        expect(await balanceOf(db, b.id)).toBe(START);
      }
      // A second sweep, or a retry, changes nothing.
      expect(await matches.forfeitOverdueMatches()).toBe(0);
      await expectLedgerClean(db);
    },
    60_000,
  );
});

describe('the turn clock in detail', () => {
  const chessMove = (u: TestUser, id: string, v: number, mv: string) =>
    matches.submitMove(u.id, id, { expectedVersion: v, action: sq(mv) as never });

  it('restarts after every move, so a player who keeps moving never forfeits', async () => {
    const { a, b, id } = await poolMatch('chess');
    jump(23 * HOUR);
    await chessMove(a, id, 0, 'e2e4'); // b's clock starts now
    jump(23 * HOUR); // 46 hours since the game began, 23 since the last move
    expect(await matches.forfeitOverdueMatches()).toBe(0);
    const m = await chessMove(b, id, 1, 'e7e5');
    expect(m.status).toBe('active');
    expect(m.currentTurn).toBe(a.id);
    expect(new Date(m.turnDeadlineAt!).getTime() - clock.t).toBeGreaterThan(23 * HOUR);
  });

  it('settles a late move as a forfeit instead of applying it', async () => {
    const { a, b, stake, id } = await poolMatch('chess');
    jump(25 * HOUR);
    const late = await chessMove(a, id, 0, 'e2e4'); // a was on the clock
    expect(late.status).toBe('finished');
    expect(late.stateVersion).toBe(0); // the move was not played
    expect(late.outcome?.winnerIds).toEqual([b.id]);
    expect(await balanceOf(db, b.id)).toBe(START + stake);
    expect(await balanceOf(db, a.id)).toBe(START - stake);
    const moves = await db.admin.query(`SELECT 1 FROM match_moves WHERE match_id = $1`, [id]);
    expect(moves.rowCount).toBe(0);
    // The loser cannot move afterwards, and retrying changes nothing.
    await expect(chessMove(a, id, 0, 'e2e4')).rejects.toEqual(code('match_not_open'));
    expect(await balanceOf(db, b.id)).toBe(START + stake);
    await expectLedgerClean(db);
  });

  it('settles it when someone merely opens an overdue match', async () => {
    const { a, b, stake, id } = await poolMatch('checkers');
    jump(25 * HOUR);
    const seen = await matches.get(b.id, id);
    expect(seen.status).toBe('finished');
    expect(seen.outcome?.winnerIds).toEqual([b.id]);
    expect(await balanceOf(db, b.id)).toBe(START + stake);
    expect(await balanceOf(db, a.id)).toBe(START - stake);
    await expectLedgerClean(db);
  });

  it('resigning after the clock ran out is settled by the clock, not by the resignation', async () => {
    const { a, b, stake, id } = await poolMatch('chess');
    jump(25 * HOUR);
    // a was on the clock; b (not a) tries to resign. a still forfeits, b is the winner.
    const done = await matches.resign(b.id, id);
    expect(done.outcome?.winnerIds).toEqual([b.id]);
    expect(await balanceOf(db, b.id)).toBe(START + stake);
    expect(await balanceOf(db, a.id)).toBe(START - stake);
  });

  it('gives every stake back when both players were due and nobody moved', async () => {
    const { a, b, id } = await poolMatch('word-hunt');
    jump(25 * HOUR);
    // (matches left running by earlier tests in this file are overdue too)
    expect(await matches.forfeitOverdueMatches()).toBeGreaterThanOrEqual(1);
    const done = await matches.get(a.id, id);
    expect(done.status).toBe('cancelled');
    expect(done.players.map((p) => p.payoutKobo)).toEqual([done.stakeKobo, done.stakeKobo]);
    expect(await balanceOf(db, a.id)).toBe(START);
    expect(await balanceOf(db, b.id)).toBe(START);
    await expectLedgerClean(db);
  });

  it('forfeits the one who has not played when the other finished a Word Hunt round', async () => {
    const { a, b, stake, id } = await poolMatch('word-hunt');
    // a plays their round; b never opens the game
    let v = (await matches.get(a.id, id)).stateVersion;
    await matches.submitMove(a.id, id, { expectedVersion: v, action: { kind: 'start' } });
    jump(30_000);
    v = (await matches.get(a.id, id)).stateVersion;
    await matches.submitMove(a.id, id, {
      expectedVersion: v,
      action: { kind: 'submit', words: [] },
    });
    jump(23 * HOUR);
    expect(await matches.forfeitOverdueMatches()).toBe(0);
    jump(2 * HOUR);
    expect(await matches.forfeitOverdueMatches()).toBeGreaterThanOrEqual(1);
    const done = await matches.get(b.id, id);
    expect(done.outcome?.winnerIds).toEqual([a.id]);
    expect(await balanceOf(db, a.id)).toBe(START + stake);
    expect(await balanceOf(db, b.id)).toBe(START - stake);
    await expectLedgerClean(db);
  });

  it('never applies to a Free match, which has no clock', async () => {
    const { a, b, conv } = await pair();
    const m = await matches.create(a.id, {
      id: randomUUID(),
      conversationId: conv,
      gameSlug: 'chess',
      mode: 'free',
    });
    const live = await matches.accept(b.id, m.id);
    expect(live.turnDeadlineAt).toBeNull();
    jump(100 * HOUR);
    expect(await matches.forfeitOverdueMatches()).toBe(0);
    expect((await matches.get(a.id, m.id)).status).toBe('active');
  });

  it('can be sped up or slowed by config (pool_turn_hours)', async () => {
    await db.admin.query(
      `INSERT INTO app_config (key, value) VALUES ('pool_turn_hours', '2')
       ON CONFLICT (key) DO UPDATE SET value = '2'`,
    );
    try {
      const { a, id } = await poolMatch('checkers');
      jump(3 * HOUR);
      expect((await matches.get(a.id, id)).status).toBe('finished');
    } finally {
      await db.admin.query(`UPDATE app_config SET value = '24' WHERE key = 'pool_turn_hours'`);
    }
  });
});

describe('collusion checks run on every Pool settlement (ADR-039)', () => {
  /** Two friends who share a phone and a connection: a score of 85, over the hold line of 70. */
  async function colluders() {
    const p = await pair();
    const device = Buffer.from(randomUUID().replaceAll('-', ''), 'hex');
    const ip = Buffer.from(randomUUID().replaceAll('-', ''), 'hex');
    for (const u of [p.a, p.b]) {
      for (const [kind, value] of [
        ['device', device],
        ['ip', ip],
      ] as const) {
        await db.admin.query(
          `INSERT INTO user_fingerprints (user_id, kind, value_hash) VALUES ($1, $2, $3)`,
          [u.id, kind, value],
        );
      }
    }
    const stake = 50_000;
    const m = await matches.create(p.a.id, {
      id: randomUUID(),
      conversationId: p.conv,
      gameSlug: 'chess',
      mode: 'pool',
      stakeKobo: stake,
    });
    await matches.accept(p.b.id, m.id);
    return { ...p, stake, id: m.id };
  }

  it('holds a payout when the turn clock ends the match', async () => {
    const { a, b, stake, id } = await colluders();
    jump(25 * HOUR);
    expect(await matches.forfeitOverdueMatches()).toBeGreaterThanOrEqual(1);
    const done = await matches.get(a.id, id);
    expect(done.status).toBe('disputed');
    expect(done.outcome?.winnerIds).toEqual([b.id]);
    expect(done.players.map((p) => p.payoutKobo)).toEqual([null, null]);
    // Nothing moved: both stakes are still in the escrow, awaiting a person's decision.
    expect(await balanceOf(db, a.id)).toBe(START - stake);
    expect(await balanceOf(db, b.id)).toBe(START - stake);
    const hold = await db.admin.query(`SELECT status FROM integrity_holds WHERE match_id = $1`, [
      id,
    ]);
    expect(hold.rows[0]?.status).toBe('held');
    // A second sweep, or opening the match, does not pay or change anything.
    expect(await matches.forfeitOverdueMatches()).toBe(0);
    expect((await matches.get(b.id, id)).status).toBe('disputed');
    await expectLedgerClean(db);
  });

  it('holds a payout on a resignation and on a late move too', async () => {
    const one = await colluders();
    const resigned = await matches.resign(one.a.id, one.id);
    expect(resigned.status).toBe('disputed');

    const two = await colluders();
    jump(25 * HOUR);
    const late = await matches.submitMove(two.a.id, two.id, {
      expectedVersion: 0,
      action: sq('e2e4') as never,
    });
    expect(late.status).toBe('disputed');
    await expectLedgerClean(db);
  });

  it('a person can release the hold, and the pot is then paid as the clock decided', async () => {
    const { a, b, stake, id } = await colluders();
    jump(25 * HOUR);
    await matches.forfeitOverdueMatches();
    await db.admin.query(
      `SELECT resolve_integrity_hold((SELECT id FROM integrity_holds WHERE match_id = $1), 'release', 'test', 'ok')`,
      [id],
    );
    expect(await balanceOf(db, b.id)).toBe(START + stake);
    expect(await balanceOf(db, a.id)).toBe(START - stake);
    await expectLedgerClean(db);
  });
});

describe('per-match options (ADR-041)', () => {
  it('offers the variants in the catalogue, with whether each can be played for stakes', async () => {
    const { games } = await matches.listGames();
    const opt = (slug: string) => games.find((g) => g.slug === slug)?.options;
    expect(opt('ayo')).toEqual([
      expect.objectContaining({
        key: 'variant',
        default: 'ayo',
        choices: [
          expect.objectContaining({ value: 'ayo', pool: true }),
          expect.objectContaining({ value: 'kalah', label: 'Mancala (Kalah)', pool: true }),
        ],
      }),
    ]);
    expect(opt('darts')?.[0]?.choices.find((c) => c.value === 'clock')?.pool).toBe(false);
    expect(opt('sea-battle')?.[0]?.choices.map((c) => c.value)).toEqual([false, true]);
    expect(opt('chess')).toBeUndefined();
  });

  it('creates Mancala (Kalah) on the Ayo board, plays it, and shows it on the card', async () => {
    const { a, b, conv } = await pair();
    const made = await matches.create(a.id, {
      id: randomUUID(),
      conversationId: conv,
      gameSlug: 'ayo',
      mode: 'free',
      options: { variant: 'kalah' },
    });
    expect(made.options).toEqual({ variant: 'kalah' });
    expect(made.variantLabel).toBe('Mancala (Kalah)');
    const live = await matches.accept(b.id, made.id);
    expect((live.view as { variant: string }).variant).toBe('kalah');
    const card = (await chat.messages(a.id, conv)).messages.find((m) => m.id === made.id);
    expect(card?.payload).toMatchObject({ gameSlug: 'ayo', variantLabel: 'Mancala (Kalah)' });
    // The default is the default: no label, nothing stored.
    const plain = await matches.create(a.id, {
      id: randomUUID(),
      conversationId: conv,
      gameSlug: 'ayo',
      mode: 'free',
    });
    expect(plain.options).toEqual({});
    expect(plain.variantLabel).toBeNull();
    const plainLive = await matches.accept(b.id, plain.id);
    expect((plainLive.view as { variant: string }).variant).toBe('ayo');
    // Kalah can be played: a first legal move goes through.
    const kview = (await matches.get(a.id, made.id)).view as { legal: number[] };
    const after = await matches.submitMove(a.id, made.id, {
      expectedVersion: 0,
      action: { kind: 'sow', pit: kview.legal[0]! },
    });
    expect(after.stateVersion).toBe(1);
  });

  it('plays a Pool Mancala match through settlement, the variant kept to the end', async () => {
    const { a, b, stake, id, live } = await poolMatch('ayo', { options: { variant: 'kalah' } });
    expect((live.view as { variant: string }).variant).toBe('kalah');
    const { final } = await playOut('ayo', a, b, id);
    expect(final.status).toBe('finished');
    expect(final.variantLabel).toBe('Mancala (Kalah)');
    const sum = (await balanceOf(db, a.id)) + (await balanceOf(db, b.id));
    expect(sum).toBe(2 * START); // nothing created or lost
    if (!final.outcome?.draw) {
      expect(await balanceOf(db, final.outcome!.winnerIds[0]!)).toBe(START + stake);
    }
    await expectLedgerClean(db);
  }, 120_000);

  it('plays Sea Battle salvo (several shots a turn) through a Pool settlement', async () => {
    const { a, b, id, live } = await poolMatch('sea-battle', { options: { salvo: true } });
    expect((live.view as { salvo: boolean }).salvo).toBe(true);
    expect(live.variantLabel).toBe('Salvo');
    const { final } = await playOut('sea-battle', a, b, id);
    expect(final.status).toBe('finished');
    await expectLedgerClean(db);
  }, 120_000);

  it('keeps Around the clock free: it cannot be sent as Pool, but Darts 501 can', async () => {
    const { a, conv } = await pair();
    const base = { conversationId: conv, gameSlug: 'darts' };
    await expect(
      matches.create(a.id, {
        ...base,
        id: randomUUID(),
        mode: 'pool',
        stakeKobo: 20_000,
        options: { variant: 'clock' },
      }),
    ).rejects.toEqual(code('pool_not_supported'));
    const free = await matches.create(a.id, {
      ...base,
      id: randomUUID(),
      mode: 'free',
      options: { variant: 'clock' },
    });
    expect(free.variantLabel).toBe('Around the clock');
    const pool = await matches.create(a.id, {
      ...base,
      id: randomUUID(),
      mode: 'pool',
      stakeKobo: 20_000,
      options: { variant: '501' },
    });
    expect(pool.options).toEqual({}); // 501 is the default
    await expectLedgerClean(db);
  });

  it('refuses options the game does not offer, values it does not have, and a changed retry', async () => {
    const { a, conv } = await pair();
    const make = (
      slug: string,
      options: Record<string, string | number | boolean>,
      id = randomUUID(),
    ) => matches.create(a.id, { id, conversationId: conv, gameSlug: slug, mode: 'free', options });
    await expect(make('chess', { variant: 'kalah' })).rejects.toEqual(code('invalid_options'));
    await expect(make('ayo', { variant: 'checkers' })).rejects.toEqual(code('invalid_options'));
    await expect(make('ayo', { seeds: 6 })).rejects.toEqual(code('invalid_options'));
    await expect(make('sea-battle', { salvo: 'yes' })).rejects.toEqual(code('invalid_options'));

    // A retry of the same create with the same options is the same match; with other options it is refused.
    const id = randomUUID();
    const first = await make('ayo', { variant: 'kalah' }, id);
    const again = await make('ayo', { variant: 'kalah' }, id);
    expect(again.id).toBe(first.id);
    await expect(make('ayo', { variant: 'ayo' }, id)).rejects.toEqual(code('message_id_taken'));
  });
});
