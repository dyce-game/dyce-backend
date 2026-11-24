import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { SEA_FLEET, wordTilesWordSet, type GameEngine } from '@dyce/games';
import type { MatchView, RealtimeEvent } from '@dyce/shared';
import { MessagesService } from '../../src/chat/messages.service.ts';
import { ENGINES, loadWordTilesWordSet } from '../../src/matches/engines.ts';
import { MatchesService } from '../../src/matches/matches.service.ts';
import { FriendsService } from '../../src/social/friends.service.ts';
import { createTestDb, createUser, type TestDb, type TestUser } from '../testing/testDb.ts';
import { fundedUser } from './helpers.ts';

/**
 * The Phase 4 catalogue (migration 0020) on the real match service and the real registry: every game with
 * an engine has a `games` row, the rows are disabled until their board ships, the Pool minimums are
 * enforced, and every registered game can be created, accepted and played through one illegal and one legal
 * move. The rules themselves are tested in packages/games.
 */

const T0 = new Date('2026-11-21T10:00:00Z').getTime();
const clock = { t: T0 };
const now = () => new Date(clock.t++);

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
beforeEach(() => {
  clock.t = T0;
});

const code = (c: string) => expect.objectContaining({ code: c });

async function chatOf(a: TestUser, b: TestUser): Promise<string> {
  await friends.sendRequest(a.id, b.id);
  await friends.accept(b.id, a.id);
  return (await chat.openDirect(a.id, b.id)).id;
}

const setEnabled = (slug: string, enabled: boolean, pool = false) =>
  db.admin.query(`UPDATE games SET enabled = $2, supports_pool = $3 WHERE slug = $1`, [
    slug,
    enabled,
    pool,
  ]);

/** All 23 games of docs/GAMES.md: [slug, Pool minimum in kobo]. */
const CATALOGUE: readonly [string, number][] = [
  ['cup-pong', 10_000],
  ['eight-ball', 20_000],
  ['darts', 20_000],
  ['basketball', 20_000],
  ['archery', 10_000],
  ['mini-golf', 10_000],
  ['tanks', 10_000],
  ['sea-battle', 50_000],
  ['chess', 50_000],
  ['checkers', 20_000],
  ['ayo', 20_000],
  ['ludo', 50_000],
  ['dots-and-boxes', 10_000],
  ['word-tiles', 20_000],
  ['word-hunt', 20_000],
  ['anagrams', 10_000],
  ['filler', 10_000],
  ['crazy-cards', 20_000],
  ['whot', 20_000],
  ['charades', 20_000],
  ['imposter', 30_000],
  ['werewolf', 50_000],
  ['doodle-guess', 10_000],
];
/** Already enabled by earlier migrations (Pig, Word Hunt, Cup Pong) or live (Spaces). */
const SHIPPED = new Set([
  'cup-pong',
  'word-hunt',
  'crazy-cards',
  'whot',
  'charades',
  'imposter',
  'werewolf',
  'doodle-guess',
]);
const NEW_ASYNC = CATALOGUE.map(([slug]) => slug).filter((s) => !SHIPPED.has(s));

/** Games whose board has shipped have a `0021_enable_<slug>.sql` migration; the rest stay disabled. */
const ENABLED_BY_MIGRATION = new Set(
  readdirSync('db/migrations')
    .filter((f) => f.startsWith('0021_enable_') && f.endsWith('.sql'))
    .map((f) => f.slice('0021_enable_'.length, -'.sql'.length)),
);
const STILL_DISABLED = NEW_ASYNC.filter((s) => !ENABLED_BY_MIGRATION.has(s));

describe('the catalogue rows', () => {
  it('has a row for each of the 23 games, with the Pool minimum from docs/GAMES.md', async () => {
    const r = await db.admin.query<{ slug: string; pool_min_stake_kobo: string }>(
      `SELECT slug, pool_min_stake_kobo FROM games WHERE slug = ANY($1)`,
      [CATALOGUE.map(([s]) => s)],
    );
    expect(r.rows).toHaveLength(23);
    const got = Object.fromEntries(r.rows.map((x) => [x.slug, Number(x.pool_min_stake_kobo)]));
    expect(got).toEqual(Object.fromEntries(CATALOGUE));
  });

  it('keeps a game disabled and hidden until its enable migration, and lists it after', async () => {
    const rows = await db.admin.query<{ slug: string; enabled: boolean; sync: string }>(
      `SELECT slug, enabled, sync FROM games WHERE slug = ANY($1)`,
      [NEW_ASYNC],
    );
    expect(rows.rows).toHaveLength(NEW_ASYNC.length);
    const { games } = await matches.listGames();
    const listed = games.map((g) => g.slug);
    for (const row of rows.rows) {
      expect(row.sync).toBe('async');
      expect(row.enabled).toBe(ENABLED_BY_MIGRATION.has(row.slug));
      if (row.enabled) expect(listed).toContain(row.slug);
      else expect(listed).not.toContain(row.slug);
    }
    expect(listed).toEqual(expect.arrayContaining(['word-hunt', 'cup-pong']));
  });

  it('refuses to create a disabled game', async () => {
    const a = await createUser(db);
    const b = await createUser(db);
    const conv = await chatOf(a, b);
    for (const slug of STILL_DISABLED) {
      await expect(
        matches.create(a.id, {
          id: randomUUID(),
          conversationId: conv,
          gameSlug: slug,
          mode: 'free',
        }),
      ).rejects.toEqual(code('game_not_found'));
    }
  });

  it('refuses an enabled row that has no engine in the registry', async () => {
    await db.admin.query(
      `INSERT INTO games (slug, name, dimension, sync, min_players, max_players, enabled)
       VALUES ('no-engine', 'No engine', '2d', 'async', 2, 2, true)`,
    );
    const a = await createUser(db);
    const b = await createUser(db);
    const conv = await chatOf(a, b);
    await expect(
      matches.create(a.id, {
        id: randomUUID(),
        conversationId: conv,
        gameSlug: 'no-engine',
        mode: 'free',
      }),
    ).rejects.toEqual(code('game_not_found'));
    const { games } = await matches.listGames();
    expect(games.map((g) => g.slug)).not.toContain('no-engine');
  });

  it('registers each engine under its own slug, and every row under a registry entry', async () => {
    for (const [slug, entry] of Object.entries(ENGINES)) {
      expect((entry.engine as GameEngine<unknown, unknown, unknown>).slug).toBe(slug);
    }
    for (const slug of NEW_ASYNC) expect(ENGINES[slug]).toBeDefined();
  });

  it('shows a game in the drawer, with its Pool minimum, once its row is enabled', async () => {
    await setEnabled('chess', true);
    try {
      const { games } = await matches.listGames();
      expect(games.find((g) => g.slug === 'chess')).toEqual({
        slug: 'chess',
        name: 'Chess',
        dimension: '2d',
        sync: 'async',
        minPlayers: 2,
        maxPlayers: 2,
        categories: ['board'],
        supportsPool: false,
        poolMinKobo: 50_000,
      });
    } finally {
      await setEnabled('chess', false);
    }
  });
});

describe('Pool minimums', () => {
  it('asks for the higher of the platform minimum and the game minimum', async () => {
    await setEnabled('chess', true, true);
    try {
      const a = await fundedUser(db);
      const b = await fundedUser(db);
      const conv = await chatOf(a, b);
      const make = (stakeKobo: number) =>
        matches.create(a.id, {
          id: randomUUID(),
          conversationId: conv,
          gameSlug: 'chess',
          mode: 'pool',
          stakeKobo,
        });
      await expect(make(20_000)).rejects.toEqual(code('invalid_stake')); // above the platform's Ð100, below Chess's Ð500
      const ok = await make(50_000);
      expect(ok.stakeKobo).toBe(50_000);
      // The other person may not counter below it either (0 = play free is fine).
      await expect(matches.counter(b.id, ok.id, { stakeKobo: 20_000 })).rejects.toEqual(
        code('invalid_stake'),
      );
      const free = await matches.counter(b.id, ok.id, { stakeKobo: 0 });
      expect(free.status).toBe('countered');
    } finally {
      await setEnabled('chess', false);
    }
  });
});

// ---- one illegal and one legal move per game ----------------------------------------------------------

type Ctx = { view: Record<string, any>; a: string; b: string }; // eslint-disable-line @typescript-eslint/no-explicit-any
type Plan = { illegal: (c: Ctx) => unknown; legal: (c: Ctx) => unknown };

const PLANS: Record<string, Plan> = {
  chess: {
    illegal: () => ({ kind: 'move', from: 'e2', to: 'e5' }),
    legal: () => ({ kind: 'move', from: 'e2', to: 'e4' }),
  },
  checkers: {
    illegal: () => ({ kind: 'move', path: [0, 9] }),
    legal: ({ view }) => ({ kind: 'move', path: view.legal[0].path }),
  },
  ayo: {
    illegal: () => ({ kind: 'sow', pit: 11 }), // the other player's pit
    legal: ({ view }) => ({ kind: 'sow', pit: view.legal[0] }),
  },
  'dots-and-boxes': {
    illegal: () => ({ kind: 'line', dir: 'h', r: 0, c: 9 }),
    legal: () => ({ kind: 'line', dir: 'h', r: 0, c: 0 }),
  },
  ludo: {
    illegal: () => ({ kind: 'move', token: 0 }), // before rolling
    legal: () => ({ kind: 'roll' }),
  },
  'sea-battle': {
    illegal: () => ({
      kind: 'place',
      ships: SEA_FLEET.map(() => ({ r: 0, c: 0, dir: 'h' })), // all on top of each other
    }),
    legal: () => ({
      kind: 'place',
      ships: SEA_FLEET.map((_, i) => ({ r: i * 2, c: 0, dir: 'h' })),
    }),
  },
  'word-tiles': {
    illegal: () => ({ kind: 'play', tiles: [{ r: 0, c: 0, letter: 'Q' }] }), // off the star
    legal: () => ({ kind: 'pass' }),
  },
  anagrams: {
    illegal: () => ({ kind: 'submit', words: ['cat'] }), // before pressing start
    legal: () => ({ kind: 'start' }),
  },
  filler: {
    illegal: ({ view }) => ({ kind: 'pick', colour: view.cells[48] }), // your own colour
    legal: ({ view }) => ({
      kind: 'pick',
      colour: [0, 1, 2, 3, 4, 5].find((c) => c !== view.cells[48] && c !== view.cells[7]),
    }),
  },
  'mini-golf': {
    illegal: () => ({ kind: 'putt', dx: 0, dy: 0, power: 500 }),
    legal: () => ({ kind: 'putt', dx: 0, dy: -1000, power: 500 }),
  },
  tanks: {
    illegal: () => ({ kind: 'fire', angle: 45, power: 0, weapon: 'shell' }),
    legal: () => ({ kind: 'fire', angle: 45, power: 50, weapon: 'shell' }),
  },
  'eight-ball': {
    illegal: () => ({
      kind: 'shoot',
      angle: 0,
      power: 500,
      spinX: 0,
      spinY: 0,
      place: { x: 20_000, y: 5_600 }, // past the head string on the break
    }),
    legal: () => ({ kind: 'shoot', angle: 0, power: 800, spinX: 0, spinY: 0 }),
  },
  darts: {
    illegal: () => ({ kind: 'throw', x: 99_999, y: 0 }),
    legal: () => ({ kind: 'throw', x: 0, y: 0 }),
  },
  basketball: {
    illegal: () => ({ kind: 'shoot', aim: 0, power: 5_000 }),
    legal: () => ({ kind: 'shoot', aim: 0, power: 500 }),
  },
  archery: {
    illegal: () => ({ kind: 'shoot', aimX: 0, aimY: 0, draw: -1 }),
    legal: () => ({ kind: 'shoot', aimX: 0, aimY: 0, draw: 800 }),
  },
};

describe('every new game can be created, accepted and played', () => {
  it('has a plan for every new game', () => {
    expect(Object.keys(PLANS).sort()).toEqual([...NEW_ASYNC].sort());
  });

  it.each(NEW_ASYNC)('%s', async (slug) => {
    await setEnabled(slug, true);
    try {
      const a = await createUser(db);
      const b = await createUser(db);
      const conv = await chatOf(a, b);
      const m = await matches.create(a.id, {
        id: randomUUID(),
        conversationId: conv,
        gameSlug: slug,
        mode: 'free',
      });
      expect(m.status).toBe('invited');
      expect((await matches.listGames()).games.map((g) => g.slug)).toContain(slug);

      const started: MatchView = await matches.accept(b.id, m.id);
      expect(started.status).toBe('active');
      expect(started.stateVersion).toBe(0);

      const ctx: Ctx = {
        view: (await matches.get(a.id, m.id)).view as Ctx['view'],
        a: a.id,
        b: b.id,
      };
      const plan = PLANS[slug] as Plan;

      // An illegal move is refused (by the action schema or by the rules) and changes nothing.
      await expect(
        matches.submitMove(a.id, m.id, { expectedVersion: 0, action: plan.illegal(ctx) as never }),
      ).rejects.toEqual(
        expect.objectContaining({ code: expect.stringMatching(/^(illegal_move|invalid_action)$/) }),
      );
      expect((await matches.get(a.id, m.id)).stateVersion).toBe(0);

      // A legal one is applied.
      const after = await matches.submitMove(a.id, m.id, {
        expectedVersion: 0,
        action: plan.legal(ctx) as never,
      });
      expect(after.stateVersion).toBe(1);
      expect(after.status).toBe('active');
    } finally {
      await setEnabled(slug, false);
    }
  });
});

describe('Word Tiles dictionary check (the injected word set)', () => {
  const rackOf = (m: MatchView) => (m.view as { rack: string[] }).rack;

  async function started() {
    const a = await createUser(db);
    const b = await createUser(db);
    const conv = await chatOf(a, b);
    const m = await matches.create(a.id, {
      id: randomUUID(),
      conversationId: conv,
      gameSlug: 'word-tiles',
      mode: 'free',
    });
    await matches.accept(b.id, m.id);
    return { a, b, id: m.id, rack: rackOf(await matches.get(a.id, m.id)) };
  }

  /** Every ordering of 2 or 3 rack letters, as the word they spell. */
  function spellings(rack: string[]): string[] {
    const real = rack.filter((l) => l !== '?');
    const out: string[] = [];
    for (let i = 0; i < real.length; i++)
      for (let j = 0; j < real.length; j++) {
        if (i === j) continue;
        out.push(real[i]! + real[j]!);
        for (let k = 0; k < real.length; k++) {
          if (k !== i && k !== j) out.push(real[i]! + real[j]! + real[k]!);
        }
      }
    return out;
  }
  const play = (word: string) => ({
    kind: 'play',
    // Across the centre star, one tile per letter.
    tiles: [...word].map((letter, i) => ({ r: 7, c: 7 + i, letter })),
  });

  beforeAll(() => setEnabled('word-tiles', true));
  afterAll(() => setEnabled('word-tiles', false));

  it('refuses a word that is not in the dictionary and accepts one that is', async () => {
    const real = (w: string) => wordTilesWordSet.has(w);
    // A fresh rack until it holds both a word and a non-word (almost always the first).
    for (let tries = 0; tries < 25; tries++) {
      const { a, id, rack } = await started();
      const all = spellings(rack);
      const bad = all.find((w) => !real(w));
      const good = all.find((w) => real(w));
      if (!bad || !good) continue;
      await expect(
        matches.submitMove(a.id, id, { expectedVersion: 0, action: play(bad) as never }),
      ).rejects.toEqual(
        expect.objectContaining({ code: 'illegal_move', details: expect.anything() }),
      );
      const ok = await matches.submitMove(a.id, id, {
        expectedVersion: 0,
        action: play(good) as never,
      });
      expect(ok.stateVersion).toBe(1);
      return;
    }
    throw new Error('no rack with both a word and a non-word in 25 tries');
  });

  it('loads a bigger list once from a file, only when asked, and needs both settings', () => {
    expect(loadWordTilesWordSet({})).toBe(wordTilesWordSet);
    expect(() => loadWordTilesWordSet({ WORD_TILES_WORDLIST_ID: 'x' })).toThrow(/both/);
  });
});

describe('Anagrams clock (screenAction)', () => {
  it('turns a submit later than the round plus grace into an empty one', async () => {
    await setEnabled('anagrams', true);
    try {
      const a = await createUser(db);
      const b = await createUser(db);
      const conv = await chatOf(a, b);
      const m = await matches.create(a.id, {
        id: randomUUID(),
        conversationId: conv,
        gameSlug: 'anagrams',
        mode: 'free',
      });
      await matches.accept(b.id, m.id);
      await matches.submitMove(a.id, m.id, { expectedVersion: 0, action: { kind: 'start' } });
      clock.t += 60_000 + 10_000 + 1; // past the round and the grace
      const done = await matches.submitMove(a.id, m.id, {
        expectedVersion: 1,
        action: { kind: 'submit', words: ['cat', 'tea'] },
      });
      const v = done.view as {
        scores: Record<string, number | null>;
        words: Record<string, string[] | null>;
      };
      expect(v.scores[a.id]).toBe(0);
      const stored = await db.admin.query(
        `SELECT action FROM match_moves WHERE match_id = $1 AND seq = 2`,
        [m.id],
      );
      expect(stored.rows[0].action).toEqual({ kind: 'submit', words: [] });
    } finally {
      await setEnabled('anagrams', false);
    }
  });
});

void fundedUser;
