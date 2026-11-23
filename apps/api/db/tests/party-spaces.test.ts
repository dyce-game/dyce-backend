import { randomUUID } from 'node:crypto';
import type { RealtimeEvent } from '@dyce/shared';
import { SpacesService, type GameRooms } from '../../src/spaces/spaces.service.ts';
import { FriendsService } from '../../src/social/friends.service.ts';
import { balanceOf, createTestDb, type TestDb, type TestUser } from '../testing/testDb.ts';
import { expectLedgerClean, fundedUser } from './helpers.ts';

/**
 * The new live games as Spaces (ADR-025): who may create what, per-game options, seat limits up to 12, the
 * payout schemes party games allow, and what a started party match looks like in the database.
 */
const NAIRA = 100;
const FEE = 500 * NAIRA;

let db: TestDb;
let friends: FriendsService;
let spaces: SpacesService;
const roomCalls: string[] = [];
const rooms: GameRooms = {
  publicUrl: 'ws://game.test',
  async ensureRoom(matchId) {
    roomCalls.push(matchId);
    return { roomId: `room-${matchId}` };
  },
};

beforeAll(async () => {
  db = await createTestDb();
  friends = new FriendsService(db.app);
  spaces = new SpacesService(
    db.app,
    { publish: (_u: readonly string[], _e: RealtimeEvent) => undefined },
    rooms,
  );
});
afterAll(async () => {
  await db.close();
});
afterEach(async () => {
  roomCalls.length = 0;
  await expectLedgerClean(db);
});

const code = (c: string) => expect.objectContaining({ code: c });

async function group(n: number) {
  const host = await fundedUser(db);
  const others: TestUser[] = [];
  for (let i = 0; i < n; i++) {
    const u = await fundedUser(db);
    await friends.sendRequest(host.id, u.id);
    await friends.accept(u.id, host.id);
    others.push(u);
  }
  return { host, others };
}

type Opts = Partial<Parameters<SpacesService['create']>[1]>;
const make = (host: TestUser, gameSlug: string, maxSeats: number, o: Opts = {}) =>
  spaces.create(host.id, {
    id: randomUUID(),
    gameSlug,
    name: 'Party',
    maxSeats,
    visibility: 'friends',
    startRule: 'host',
    ...o,
  });

async function filled(gameSlug: string, n: number, o: Opts = {}) {
  const { host, others } = await group(n - 1);
  const sp = await make(host, gameSlug, n, o);
  for (const u of others) await spaces.join(u.id, sp.code);
  return { host, others, sp };
}

const matchRow = async (id: string) =>
  (
    await db.admin.query(
      `SELECT status, state, state_version, current_turn, turn_deadline, mode, payout_scheme
         FROM matches WHERE id = $1`,
      [id],
    )
  ).rows[0];

describe('creating a party space', () => {
  it.each([
    ['imposter', 4, 10],
    ['werewolf', 5, 12],
    ['charades', 3, 10],
    ['doodle-guess', 3, 8],
    ['crazy-cards', 2, 4],
  ])('%s takes %i to %i seats and refuses anything else', async (slug, min, max) => {
    const host = await fundedUser(db);
    await expect(make(host, slug, min - 1)).rejects.toEqual(code('invalid_seats'));
    await expect(make(host, slug, max + 1)).rejects.toEqual(code('invalid_seats'));
    const lo = await make(host, slug, min);
    const hi = await make(host, slug, max);
    expect(lo).toMatchObject({ gameSlug: slug, minSeats: min, maxSeats: min, quickMatch: false });
    expect(hi.maxSeats).toBe(max);
  });

  it('checks per-game options and keeps the valid ones on the space', async () => {
    const host = await fundedUser(db);
    await expect(make(host, 'imposter', 5, { options: { clueRounds: 9 } })).rejects.toEqual(
      code('invalid_options'),
    );
    await expect(make(host, 'imposter', 5, { options: { cheat: true } })).rejects.toEqual(
      code('invalid_options'),
    );
    await expect(make(host, 'werewolf', 6, { options: { wolves: 2 } })).rejects.toEqual(
      code('invalid_options'),
    );
    await expect(make(host, 'charades', 4, { options: { mode: 'mime' } })).rejects.toEqual(
      code('invalid_options'),
    );
    const sp = await make(host, 'charades', 4, { options: { mode: 'headsup', rounds: 1 } });
    expect(sp.options).toEqual({ mode: 'headsup', rounds: 1 });
  });

  it('side games pay the winning side equally: only winner takes all in Pool', async () => {
    const host = await fundedUser(db);
    for (const slug of ['imposter', 'werewolf']) {
      const seats = slug === 'imposter' ? 5 : 6;
      for (const scheme of ['p60_40', 'p50_30_20'] as const) {
        await expect(
          make(host, slug, seats, { mode: 'pool', seatFeeKobo: FEE, payoutScheme: scheme }),
        ).rejects.toEqual(code('invalid_payout'));
      }
      const ok = await make(host, slug, seats, { mode: 'pool', seatFeeKobo: FEE });
      expect(ok.payoutScheme).toBe('winner_all');
      await spaces.close(host.id, ok.id);
    }
    // point games take any scheme
    const doodle = await make(host, 'doodle-guess', 4, {
      mode: 'pool',
      seatFeeKobo: FEE,
      payoutScheme: 'p50_30_20',
    });
    expect(doodle.payoutScheme).toBe('p50_30_20');
  });
});

describe('starting a party space', () => {
  it('needs the game’s own minimum and is idempotent', async () => {
    const { host, others } = await group(2);
    const sp = await make(host, 'imposter', 6);
    for (const u of others) await spaces.join(u.id, sp.code);
    await expect(spaces.start(host.id, sp.id)).rejects.toEqual(code('not_enough_players'));
  });

  it('an 8-seat Werewolf starts with the roles dealt, no "whose turn" and no turn clock in the database', async () => {
    const { host, sp } = await filled('werewolf', 8);
    const live = await spaces.start(host.id, sp.id);
    expect(live.status).toBe('live');
    const m = await matchRow(live.matchId!);
    expect(m.status).toBe('active');
    expect(m.current_turn).toBeNull(); // would give away who has a night role
    expect(m.turn_deadline).toBeNull();
    const roles = Object.values(m.state.roles as Record<string, string>);
    expect(roles.filter((r) => r === 'werewolf')).toHaveLength(2);
    expect(roles.filter((r) => r === 'seer')).toHaveLength(1);
    expect(roles.filter((r) => r === 'doctor')).toHaveLength(1);
    expect(roomCalls).toEqual([live.matchId]);
    await spaces.start(host.id, sp.id);
    expect(roomCalls).toHaveLength(1);
  });

  it('a 12-seat Werewolf has three wolves', async () => {
    const { host, sp } = await filled('werewolf', 12);
    const live = await spaces.start(host.id, sp.id);
    const roles = Object.values(
      (await matchRow(live.matchId!)).state.roles as Record<string, string>,
    );
    expect(roles.filter((r) => r === 'werewolf')).toHaveLength(3);
  });

  it('applies the host’s options to the engine', async () => {
    const { host, sp } = await filled('imposter', 5, { options: { clueRounds: 1 } });
    const live = await spaces.start(host.id, sp.id);
    expect((await matchRow(live.matchId!)).state.clueRounds).toBe(1);
    const two = await filled('charades', 4, { options: { mode: 'headsup', rounds: 1 } });
    const l2 = await spaces.start(two.host.id, two.sp.id);
    expect((await matchRow(l2.matchId!)).state).toMatchObject({ mode: 'headsup' });
  });

  it('Crazy Cards runs like Whot!: a turn and a turn clock are stored', async () => {
    const { host, sp } = await filled('crazy-cards', 3);
    const live = await spaces.start(host.id, sp.id);
    const m = await matchRow(live.matchId!);
    expect(m.current_turn).not.toBeNull();
    expect(m.turn_deadline).not.toBeNull();
    expect(Object.keys(m.state.hands)).toHaveLength(3);
  });

  it('Pool: every seat fee is escrowed on sitting down and a closed space gives them all back', async () => {
    const { host, others } = await group(3);
    const sp = await make(host, 'imposter', 4, { mode: 'pool', seatFeeKobo: FEE });
    for (const u of others) await spaces.join(u.id, sp.code);
    const m = (await db.admin.query(`SELECT id FROM matches WHERE space_id = $1`, [sp.id])).rows[0]
      .id;
    for (const u of [host, ...others])
      expect(await balanceOf(db, u.id)).toBe(200_000 * NAIRA - FEE);
    await spaces.close(host.id, sp.id);
    for (const u of [host, ...others]) expect(await balanceOf(db, u.id)).toBe(200_000 * NAIRA);
    expect((await matchRow(m)).status).toBe('cancelled');
  });
});
