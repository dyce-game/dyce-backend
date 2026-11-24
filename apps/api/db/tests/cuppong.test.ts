import { randomUUID } from 'node:crypto';
import type { MatchView, RealtimeEvent } from '@dyce/shared';
import { MessagesService } from '../../src/chat/messages.service.ts';
import { MatchesService } from '../../src/matches/matches.service.ts';
import { FriendsService } from '../../src/social/friends.service.ts';
import { createTestDb, createUser, type TestDb, type TestUser } from '../testing/testDb.ts';

/**
 * Cup Pong on the real match service and the real registry entry: the catalogue row, turns, the server
 * deciding every throw, and one winner for both players. (The physics and rules are tested in
 * packages/games.)
 */

const T0 = new Date('2026-11-15T10:00:00Z').getTime();
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

type CpView = {
  players: [string, string];
  racks: Record<string, { id: number; x: number; z: number }[]>;
  turn: 0 | 1;
  round: number;
  ballsLeft: number;
  thrown: Record<string, number>;
  sunk: Record<string, number>;
  last: {
    seq: number;
    by: string;
    input: { aim: number; power: number };
    sunk: number | null;
  } | null;
  over: boolean;
  winner: string | null;
  rng?: unknown;
};
const view = (m: MatchView) => m.view as CpView;

async function started() {
  const a = await createUser(db);
  const b = await createUser(db);
  await friends.sendRequest(a.id, b.id);
  await friends.accept(b.id, a.id);
  const conv = (await chat.openDirect(a.id, b.id)).id;
  const m = await matches.create(a.id, {
    id: randomUUID(),
    conversationId: conv,
    gameSlug: 'cup-pong',
    mode: 'free',
  });
  await matches.accept(b.id, m.id);
  return { a, b, id: m.id };
}

const throwBall = (u: TestUser, id: string, v: number, aim: number, power: number) =>
  matches.submitMove(u.id, id, { expectedVersion: v, action: { kind: 'throw', aim, power } });

describe('catalogue', () => {
  it('lists Cup Pong (enabled, 3D, async, Free or Pool)', async () => {
    const { games } = await matches.listGames();
    expect(games.find((g) => g.slug === 'cup-pong')).toEqual({
      slug: 'cup-pong',
      name: 'Cup Pong',
      dimension: '3d',
      sync: 'async',
      minPlayers: 2,
      maxPlayers: 2,
      categories: ['sports'],
      supportsPool: true,
      poolMinKobo: 10_000,
    });
  });
});

describe('playing a game', () => {
  it('starts with the creator to throw, ten cups each, and no hidden RNG in the view', async () => {
    const { a, b, id } = await started();
    const m = await matches.get(b.id, id);
    const v = view(m);
    expect(m.currentTurn).toBe(a.id);
    expect(v.racks[a.id]).toHaveLength(10);
    expect(v.racks[b.id]).toHaveLength(10);
    expect(v.ballsLeft).toBe(3);
    expect(v).not.toHaveProperty('rng');
  });

  it('refuses a throw out of turn and an input outside the legal range', async () => {
    const { a, b, id } = await started();
    await expect(throwBall(b, id, 0, 0, 500)).rejects.toEqual(code('not_your_turn'));
    await expect(throwBall(a, id, 0, 9999, 500)).rejects.toBeDefined();
    await expect(throwBall(a, id, 0, 0, -1)).rejects.toBeDefined();
  });

  it('keeps the turn for three balls, then passes it; the server records what it simulated', async () => {
    const { a, b, id } = await started();
    let m = await throwBall(a, id, 0, 0, 540);
    expect(m.currentTurn).toBe(a.id);
    expect(view(m).ballsLeft).toBe(2);
    expect(view(m).last?.input).toEqual({ aim: 0, power: 540 });
    m = await throwBall(a, id, m.stateVersion, 0, 540);
    m = await throwBall(a, id, m.stateVersion, 0, 540);
    expect(m.currentTurn).toBe(b.id);
    expect(view(m).ballsLeft).toBe(3);
    expect(view(m).thrown[a.id]).toBe(3);
  });

  it('plays to a result with one winner, the same on both screens', async () => {
    const { a, b, id } = await started();
    let m = await matches.get(a.id, id);
    // Swing the aim a little each ball so the shots differ; the server's jitter does the rest.
    for (let i = 0; i < 400 && m.status === 'active'; i++) {
      const mover = m.currentTurn === a.id ? a : b;
      m = await throwBall(mover, id, m.stateVersion, ((i * 37) % 120) - 60, 520 + ((i * 11) % 60));
    }
    expect(m.status).toBe('finished');
    const forA = await matches.get(a.id, id);
    const forB = await matches.get(b.id, id);
    expect(forA.outcome).toEqual(forB.outcome);
    expect(forA.view).toEqual(forB.view);
    expect(view(forA).over).toBe(true);
    if (forA.outcome?.draw) expect(view(forA).winner).toBeNull();
    else expect(forA.outcome?.winnerIds).toEqual([view(forA).winner]);
  });
});
