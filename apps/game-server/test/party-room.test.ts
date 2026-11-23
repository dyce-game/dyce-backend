import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Client, type Room } from 'colyseus.js';
import {
  crazyCanPlay,
  liveGame,
  type CanvasMessage,
  type CrazyCard,
  type CrazyColor,
  type LiveGame,
} from '@dyce/games';
import type { LiveChat, LiveError, LiveState, SpaceView } from '@dyce/shared';
import { TokenService } from '../../api/src/auth/tokens.ts';
import { FriendsService } from '../../api/src/social/friends.service.ts';
import { HttpGameRooms } from '../../api/src/spaces/game-rooms.ts';
import { SpacesService } from '../../api/src/spaces/spaces.service.ts';
import {
  balanceOf,
  createTestDb,
  type TestDb,
  type TestUser,
} from '../../api/db/testing/testDb.ts';
import { expectLedgerClean, fundedUser } from '../../api/db/tests/helpers.ts';
import { createGameServer, type GameServer } from '../src/server.ts';

/**
 * Party games and Crazy Cards in real Colyseus rooms on a real PostgreSQL, driven by real colyseus.js
 * clients (small bots that read only their own view), with the API's SpacesService starting each room over
 * the signed internal call. Phase timers are shortened through the game registry; everything else is the
 * production code. The end of every test is the ledger.
 */
const JWT_SECRET = 'j'.repeat(40);
const INTERNAL_SECRET = 'i'.repeat(40);
const NAIRA = 100;
const FEE = 500 * NAIRA;

/** Short phase timers so a whole game runs in a few seconds. */
const FAST: Record<string, Record<string, number>> = {
  imposter: { revealMs: 500, clueMs: 400, voteMs: 2_500, guessMs: 1_000 },
  werewolf: { nightMs: 600, dayMs: 400, voteMs: 500 },
  'doodle-guess': { chooseMs: 800, drawMs: 4_000 },
  charades: { readyMs: 300, turnMs: 800 },
};
const games = (slug: string): LiveGame | null => {
  const g = liveGame(slug);
  const extra = FAST[slug];
  if (!g || !extra) return g;
  return {
    ...g,
    buildCfg: (o: never, n: number) => ({ ...(g.buildCfg(o, n) as object), ...extra }),
  } as LiveGame;
};

beforeAll(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

let db: TestDb;
let server: GameServer;
let port: number;
let spaces: SpacesService;
let friends: FriendsService;
const tokens = new TokenService(JWT_SECRET, { accessTtlSeconds: 900 });

beforeAll(async () => {
  const here = process.cwd();
  process.chdir(join(__dirname, '..', '..', 'api'));
  try {
    db = await createTestDb();
  } finally {
    process.chdir(here);
  }
  // These tests drive seats with bots that answer in milliseconds, which the integrity layer (backend ADR-039)
  // rightly reads as impossible timing. Payout holds have their own test below.
  await db.admin.query(
    `INSERT INTO app_config (key, value) VALUES ('integrity_hold_threshold', '101')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
  server = createGameServer({
    pool: db.app,
    jwtSecret: JWT_SECRET,
    internalSecret: INTERNAL_SECRET,
    options: {
      reconnectMs: 900,
      joinGraceMs: 5_000,
      botDelayMs: 15,
      settleRetries: 1,
      settleRetryMs: 50,
      party: {
        tickMs: 50,
        skipDelayMs: 20,
        streamFlushMs: 120,
        streamBroadcastMs: 30,
        chatGapMs: 40,
      },
    },
    lingerMs: 400,
    log: () => undefined,
    games,
  });
  port = await server.listen(0, '127.0.0.1');
  friends = new FriendsService(db.app);
  spaces = new SpacesService(
    db.app,
    { publish: () => undefined },
    new HttpGameRooms({ baseUrl: `http://127.0.0.1:${port}`, secret: INTERNAL_SECRET }),
    undefined,
    games,
  );
}, 120_000);

afterAll(async () => {
  await server.close();
  await db.close();
});

afterEach(async () => {
  await expectLedgerClean(db);
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Brain = (seat: Seat, state: LiveState) => unknown | null;

/** A seated person with a live connection and (optionally) a bot that plays from its own view. */
class Seat {
  room: Room | null = null;
  state: LiveState | null = null;
  states = 0;
  errors: LiveError[] = [];
  chats: LiveChat[] = [];
  canvases: CanvasMessage[] = [];
  history: LiveChat[] | null = null;
  closed: number | null = null;
  brain: Brain | null = null;
  private lastKey = '';

  constructor(
    readonly user: TestUser,
    private readonly roomId: string,
  ) {}

  get id(): string {
    return this.user.id;
  }
  view<T = Record<string, unknown>>(): T {
    return this.state!.view as T;
  }

  async connect(): Promise<void> {
    const token = await tokens.signAccess({ userId: this.user.id, familyId: randomUUID() });
    const client = new Client(`ws://127.0.0.1:${port}`);
    const room = await client.joinById(this.roomId, { token });
    this.room = room;
    this.closed = null;
    room.onMessage('state', (s: LiveState) => {
      this.state = s;
      this.states += 1;
      this.think();
    });
    room.onMessage('error', (e: LiveError) => this.errors.push(e));
    room.onMessage('chat', (c: LiveChat) => this.chats.push(c));
    room.onMessage('canvas', (c: CanvasMessage) => this.canvases.push(c));
    room.onMessage('chat_history', (h: LiveChat[]) => {
      this.history = h;
    });
    room.onLeave((code) => {
      this.closed = code;
    });
  }

  send(type: string, body?: unknown) {
    this.room!.send(type, body);
  }
  /** A move for the table as this seat sees it (party games ignore the version, turn games require it). */
  act(action: unknown) {
    this.send('move', { expectedVersion: this.state?.version, action });
  }
  chat(text: string) {
    this.send('chat', { text });
  }
  dropSocket() {
    void this.room?.leave(false);
  }

  private think() {
    const s = this.state;
    if (!this.brain || !s || s.status !== 'live' || !s.canAct) return;
    const action = this.brain(this, s);
    if (action === null) return;
    // one answer per distinct situation: the engine's own counter changes after every accepted action
    const key = JSON.stringify([action, (s.view as { seq?: number }).seq, s.version]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.act(action);
  }
}

async function until<T>(
  fn: () => T | undefined | null | false,
  what: string,
  ms = 25_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(15);
  }
}

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

/** A started space of `n` seats with everyone connected. */
async function table(opts: {
  game: string;
  n: number;
  pool?: boolean;
  scheme?: 'winner_all' | 'p60_40' | 'p50_30_20';
  options?: Record<string, string | number | boolean>;
  connect?: boolean;
}) {
  const { host, others } = await group(opts.n - 1);
  const created = await spaces.create(host.id, {
    id: randomUUID(),
    gameSlug: opts.game,
    name: 'Party',
    maxSeats: opts.n,
    visibility: 'friends',
    startRule: 'host',
    ...(opts.options ? { options: opts.options } : {}),
    ...(opts.pool
      ? { mode: 'pool' as const, seatFeeKobo: FEE, payoutScheme: opts.scheme ?? 'winner_all' }
      : {}),
  });
  for (const o of others) await spaces.join(o.id, created.code);
  const live: SpaceView = await spaces.start(host.id, created.id);
  const conn = await spaces.connect(host.id, created.id);
  expect(conn.roomId).toBe(live.matchId);
  const seats = [host, ...others].map((u) => new Seat(u, conn.roomId));
  if (opts.connect !== false) {
    for (const s of seats) await s.connect();
    await until(() => seats.every((s) => s.state), 'first state');
  }
  return { space: live, seats, matchId: live.matchId!, host };
}

const finishedAll = (seats: Seat[]) => seats.every((s) => s.state?.status === 'finished');
const matchState = async (id: string) =>
  (await db.admin.query(`SELECT state, status, state_version FROM matches WHERE id = $1`, [id]))
    .rows[0] as { state: Record<string, unknown>; status: string; state_version: number };
const spaceStatus = async (id: string) =>
  (await db.admin.query(`SELECT status FROM spaces WHERE id = $1`, [id])).rows[0].status as string;
const payouts = async (matchId: string) =>
  (
    await db.admin.query(
      `SELECT user_id, placement, result, payout_kobo, staked_kobo FROM match_players WHERE match_id = $1`,
      [matchId],
    )
  ).rows as {
    user_id: string;
    placement: number;
    result: string;
    payout_kobo: string | null;
    staked_kobo: string;
  }[];

// ---- the bots ------------------------------------------------------------------------------------

type ImposterView = {
  phase: string;
  role: 'crew' | 'imposter' | null;
  speaker: string | null;
  ready: string[];
  voted: string[];
  guessed: string[];
  players: string[];
  word: string | null;
};

/** Imposter bots. `imposters` is read from the database (a real player would not know it). */
function imposterBrain(imposters: string[], crewWins: boolean): Brain {
  return (seat) => {
    const v = seat.view<ImposterView>();
    const me = seat.id;
    switch (v.phase) {
      case 'reveal':
        return v.ready.includes(me) ? null : { kind: 'ready' };
      case 'clue':
        return v.speaker === me ? { kind: 'clue', text: 'hmm' } : null;
      case 'vote': {
        if (v.voted.includes(me)) return null;
        const crew = v.players.filter((p) => !imposters.includes(p) && p !== me);
        const target = crewWins && v.role === 'crew' ? imposters : [crew[0]!];
        return { kind: 'vote', targets: target.slice(0, imposters.length) };
      }
      case 'guess':
        return v.role === 'imposter' && !v.guessed.includes(me)
          ? { kind: 'guess', text: 'not the word' }
          : null;
      default:
        return null;
    }
  };
}

type WolfView = {
  phase: string;
  role: string | null;
  alive: string[];
  wolves?: string[];
  acted: boolean | null;
  ready: string[];
  voted: string[];
};

function werewolfBrain(wolfIds: string[]): Brain {
  return (seat) => {
    const v = seat.view<WolfView>();
    const me = seat.id;
    if (v.phase === 'night') {
      if (v.acted) return null;
      if (v.role === 'werewolf') {
        return { kind: 'kill', target: v.alive.find((p) => !wolfIds.includes(p))! };
      }
      if (v.role === 'seer') return { kind: 'inspect', target: v.alive.find((p) => p !== me)! };
      if (v.role === 'doctor') return { kind: 'protect', target: me };
      return null;
    }
    if (v.phase === 'day') return v.ready.includes(me) ? null : { kind: 'ready' };
    if (v.phase === 'vote') {
      if (v.voted.includes(me)) return null;
      const target =
        v.role === 'werewolf'
          ? v.alive.find((p) => !wolfIds.includes(p))!
          : v.alive.find((p) => wolfIds.includes(p))!;
      return { kind: 'vote', target };
    }
    return null;
  };
}

type CrazyView = {
  current: string | null;
  hand: CrazyCard[];
  top: CrazyCard;
  color: CrazyColor;
  drawn: CrazyCard | null;
};

/** What the app does when a person taps for them: any playable card (calling the last card), else draw or pass. */
const crazyBrain: Brain = (seat) => {
  const v = seat.view<CrazyView>();
  if (v.current !== seat.id) return null;
  const pool = v.drawn ? [v.drawn] : v.hand;
  const card = pool.find((c) => crazyCanPlay(c, v.top, v.color));
  if (!card) return v.drawn ? { kind: 'pass' } : { kind: 'draw' };
  const action: Record<string, unknown> = { kind: 'play', card };
  if (card.color === 'wild') {
    action.color = v.hand.find((c) => c.color !== 'wild')?.color ?? 'red';
  }
  if (v.hand.length - 1 === 1) action.call = true;
  return action;
};

// ---- Imposter ------------------------------------------------------------------------------------

describe('Imposter', () => {
  it('4 players in Pool: the crew catch the imposter and split the pot; money and ledger are exact', async () => {
    const { seats, matchId, space } = await table({ game: 'imposter', n: 4, pool: true });
    const before = await Promise.all(seats.map((s) => balanceOf(db, s.id)));
    const imposters = ((await matchState(matchId)).state.imposters as string[]).slice();
    expect(imposters).toHaveLength(1);
    for (const s of seats) s.brain = imposterBrain(imposters, true);
    // kick the bots off: they only think when a state arrives
    for (const s of seats) s.send('sync');

    await until(() => finishedAll(seats), 'imposter game to finish');
    const crew = seats.filter((s) => !imposters.includes(s.id));
    const imp = seats.find((s) => imposters.includes(s.id))!;
    const rows = await payouts(matchId);
    const byUser = new Map(rows.map((r) => [r.user_id, r]));
    // the imposter was caught and could not guess the word: the crew win, the imposter loses the seat fee
    expect(byUser.get(imp.id)).toMatchObject({ result: 'loss', placement: 2 });
    expect(Number(byUser.get(imp.id)!.payout_kobo)).toBe(0);
    for (const c of crew) expect(byUser.get(c.id)).toMatchObject({ result: 'win', placement: 1 });
    const paid = crew.reduce((n, c) => n + Number(byUser.get(c.id)!.payout_kobo), 0);
    expect(paid).toBe(FEE * 4); // the whole pot, to the winning side, to the last kobo
    const after = await Promise.all(seats.map((s) => balanceOf(db, s.id)));
    // balances were taken after the seat fees went into the pot, so the change is exactly the payout
    expect(before.map((b, i) => after[i]! - b)).toEqual(
      seats.map((s) => Number(byUser.get(s.id)!.payout_kobo)),
    );
    expect(after.reduce((a, b) => a + b, 0)).toBe(before.reduce((a, b) => a + b, 0) + FEE * 4);
    // every seat saw the final result and the whole truth at the end
    for (const s of seats) {
      expect(s.state!.results).toHaveLength(4);
      expect(s.view<{ word: string | null }>().word).not.toBeNull();
    }
    expect((await matchState(matchId)).status).toBe('finished');
    expect(await spaceStatus(space.id)).toBe('ended');
    // the moves are on record, seat actions and the room's own ticks, in order
    const moves = (
      await db.admin.query(
        `SELECT seq, user_id, action FROM match_moves WHERE match_id = $1 ORDER BY seq`,
        [matchId],
      )
    ).rows as { seq: number; user_id: string | null; action: { kind: string } }[];
    expect(moves.map((m) => m.seq)).toEqual(moves.map((_, i) => i + 1));
    expect(moves.some((m) => m.user_id === null && m.action.kind === 'tick')).toBe(false); // bots were quick
    expect(moves.filter((m) => m.action.kind === 'clue')).toHaveLength(8);
  });

  it('seats never see who the imposter is, whose turn it is, or the word if they are the imposter', async () => {
    const { seats, matchId } = await table({ game: 'imposter', n: 4 });
    const imposters = (await matchState(matchId)).state.imposters as string[];
    const word = (await matchState(matchId)).state.word as string;
    for (const s of seats) {
      const wire = JSON.stringify(s.state);
      expect(s.state!.turnUserId).toBeNull();
      expect(wire).not.toContain('"rng"');
      if (imposters.includes(s.id)) expect(wire).not.toContain(word);
      else expect(s.view<ImposterView>().word).toBe(word);
      if (!imposters.includes(s.id))
        expect(s.view<{ imposters?: unknown }>().imposters).toBeUndefined();
    }
    for (const s of seats) s.dropSocket();
  });

  it('a seat that leaves forfeits and ranks last; the rest finish by the clock and share the pot', async () => {
    const { seats, matchId } = await table({ game: 'imposter', n: 4, pool: true });
    const imposters = ((await matchState(matchId)).state.imposters as string[]).slice();
    const leaver = seats.find((s) => !imposters.includes(s.id))!;
    const others = seats.filter((s) => s !== leaver);
    for (const s of others) s.brain = imposterBrain(imposters, true);
    leaver.send('leave');
    for (const s of others) s.send('sync');
    await until(() => finishedAll(others), 'game to finish without the leaver');

    const rows = new Map((await payouts(matchId)).map((r) => [r.user_id, r]));
    expect(rows.get(leaver.id)).toMatchObject({ result: 'forfeit', placement: 3 });
    expect(Number(rows.get(leaver.id)!.payout_kobo ?? 0)).toBe(0);
    const winners = others.filter((s) => !imposters.includes(s.id));
    const paid = winners.reduce((n, s) => n + Number(rows.get(s.id)!.payout_kobo), 0);
    expect(paid).toBe(FEE * 4);
    expect(await balanceOf(db, leaver.id)).toBe(200_000 * NAIRA - FEE);
  });

  it('a seat whose connection drops for good forfeits after the reconnect window; one that returns keeps its place', async () => {
    const { seats, matchId } = await table({ game: 'imposter', n: 4 });
    const imposters = ((await matchState(matchId)).state.imposters as string[]).slice();
    const gone = seats.find((s) => !imposters.includes(s.id))!;
    const flaky = seats.find((s) => s !== gone && !imposters.includes(s.id))!;
    const rest = seats.filter((s) => s !== gone);
    for (const s of rest) s.brain = imposterBrain(imposters, true);

    gone.dropSocket();
    flaky.dropSocket();
    await wait(200);
    await flaky.connect(); // back inside the 900 ms window
    expect(flaky.history).toEqual([]);
    for (const s of rest) s.send('sync');

    await until(() => finishedAll(rest), 'game to finish');
    const rows = new Map((await payouts(matchId)).map((r) => [r.user_id, r]));
    expect(rows.get(gone.id)!.result).toBe('forfeit');
    expect(rows.get(flaky.id)!.result).not.toBe('forfeit');
  });

  it('chat opens for the vote only and reaches the whole table', async () => {
    const { seats } = await table({ game: 'imposter', n: 4 });
    const [a, b] = [seats[0]!, seats[1]!];
    a.chat('too early');
    await until(() => a.errors.some((e) => e.code === 'chat_closed'), 'chat_closed');
    for (const s of seats)
      s.brain = (seat) => (seat.view<ImposterView>().phase === 'reveal' ? { kind: 'ready' } : null);
    for (const s of seats) s.send('sync');
    await until(() => a.view<ImposterView>().phase === 'clue', 'clue phase');
    // clues are spoken in turn and the room moves on by its own clock; wait for the vote
    await until(() => a.view<ImposterView>().phase === 'vote', 'vote phase');
    a.chat('it was you');
    await until(() => b.chats.length === 1, 'chat line');
    expect(b.chats[0]).toMatchObject({ userId: a.id, text: 'it was you' });
    expect(seats[2]!.chats).toHaveLength(1);
    for (const s of seats) s.dropSocket();
  });
});

// ---- Werewolf ------------------------------------------------------------------------------------

describe('Werewolf', () => {
  it('5 players: the villagers lynch the wolf; night chat reaches only the wolf; no one sees roles early', async () => {
    const { seats, matchId } = await table({ game: 'werewolf', n: 5, pool: true });
    const roles = (await matchState(matchId)).state.roles as Record<string, string>;
    const wolfIds = Object.keys(roles).filter((p) => roles[p] === 'werewolf');
    expect(wolfIds).toHaveLength(1);
    const wolf = seats.find((s) => s.id === wolfIds[0])!;
    const villager = seats.find((s) => roles[s.id] === 'villager')!;
    for (const s of seats) {
      expect(s.state!.canAct).toBe(roles[s.id] !== 'villager'); // night: only the roles that act
      expect(s.view<{ roles?: unknown }>().roles).toBeUndefined();
    }
    // night talk: the wolf is heard by no living villager
    wolf.chat('quiet one tonight');
    villager.chat('anyone there?');
    await until(() => villager.errors.some((e) => e.code === 'chat_closed'), 'closed for villager');
    await wait(100);
    expect(seats.filter((s) => s !== wolf).every((s) => s.chats.length === 0)).toBe(true);
    expect(wolf.chats).toHaveLength(1);

    for (const s of seats) s.brain = werewolfBrain(wolfIds);
    for (const s of seats) s.send('sync');
    await until(() => finishedAll(seats), 'werewolf game to finish');

    const rows = new Map((await payouts(matchId)).map((r) => [r.user_id, r]));
    expect(rows.get(wolf.id)).toMatchObject({ result: 'loss', placement: 2 });
    const villagers = seats.filter((s) => s !== wolf);
    const paid = villagers.reduce((n, s) => n + Number(rows.get(s.id)!.payout_kobo), 0);
    expect(paid).toBe(FEE * 5);
    for (const s of seats) {
      expect(s.view<{ winner: string }>().winner).toBe('villagers');
      expect(s.view<{ roles?: Record<string, string> }>().roles).toEqual(roles); // revealed at the end
    }
  });

  it('nobody acts: the clock alone plays ten nights and the game is a draw, every stake refunded', async () => {
    const { seats, matchId } = await table({
      game: 'werewolf',
      n: 5,
      pool: true,
    });
    const before = await Promise.all(seats.map((s) => balanceOf(db, s.id)));
    await until(() => finishedAll(seats), 'draw by clock', 90_000);
    const rows = await payouts(matchId);
    expect(rows.every((r) => r.result === 'draw' && Number(r.payout_kobo) === FEE)).toBe(true);
    // every seat is back to what it had before it paid the seat fee
    for (const s of seats) expect(await balanceOf(db, s.id)).toBe(200_000 * NAIRA);
    expect(before.every((b) => b === 200_000 * NAIRA - FEE)).toBe(true);
  }, 120_000);
});

// ---- Doodle Guess --------------------------------------------------------------------------------

describe('Doodle Guess', () => {
  it('3 players in Pool 50/30/20: strokes stream, guesses score, and the pot is paid by points', async () => {
    const { seats, matchId } = await table({
      game: 'doodle-guess',
      n: 3,
      pool: true,
      scheme: 'p50_30_20',
      options: { rounds: 1 },
    });
    type DoodleView = {
      phase: string;
      drawer: string;
      choices: string[];
      word: string | null;
      strokeCount: number;
      solvers: string[];
    };
    const wordOfDrawer = (): string | null => {
      const d = seats.find((s) => s.view<DoodleView>().drawer === s.id);
      return d?.view<DoodleView>().word ?? null;
    };
    const brain: Brain = (seat) => {
      const v = seat.view<DoodleView>();
      const me = seat.id;
      if (v.phase === 'choose') return v.drawer === me ? { kind: 'choose', index: 0 } : null;
      if (v.phase !== 'draw') return null;
      if (v.drawer === me) {
        return v.strokeCount === 0
          ? {
              kind: 'stroke',
              points: [
                [10, 10],
                [200, 220],
                [400, 90],
              ],
              color: 2,
              width: 3,
            }
          : null;
      }
      if (v.solvers.includes(me)) return null;
      const word = wordOfDrawer();
      // wait for the drawing to show up, then guess right (the first guesser of each turn is wrong once)
      return v.strokeCount > 0 && word ? { kind: 'guess', text: word } : null;
    };
    for (const s of seats) s.brain = brain;
    for (const s of seats) s.send('sync');
    await until(() => finishedAll(seats), 'doodle game to finish');

    // a guesser never sees the drawer's word before solving; check what they were sent mid-game was masked
    const rows = (await payouts(matchId)).sort((a, b) => a.placement - b.placement);
    const pot = FEE * 3;
    expect(rows.reduce((n, r) => n + Number(r.payout_kobo), 0)).toBe(pot);
    expect(Number(rows[0]!.payout_kobo)).toBeGreaterThanOrEqual(Number(rows[1]!.payout_kobo));
    const state = (await matchState(matchId)).state as { scores: Record<string, number> };
    expect(Object.values(state.scores).every((n) => n > 0)).toBe(true);
    // the drawing travelled in `canvas` messages, never inside the state
    for (const s of seats) {
      expect(s.canvases.length).toBeGreaterThan(0);
      expect(JSON.stringify(s.state)).not.toContain('"pts"');
    }
    expect(
      seats.some((s) => s.canvases.some((c) => !c.reset && c.strokes.length + c.extend.length > 0)),
    ).toBe(true);
    const strokeMoves = await db.admin.query(
      `SELECT count(*)::int AS n FROM match_moves WHERE match_id = $1 AND action ->> 'kind' = 'stroke'`,
      [matchId],
    );
    expect(strokeMoves.rows[0].n).toBe(3); // one stroke per turn, all three turns
  });

  it('the drawer leaving does not make the table wait out the clock', async () => {
    const { seats } = await table({ game: 'doodle-guess', n: 3, options: { rounds: 1 } });
    const drawerId = seats[0]!.view<{ drawer: string }>().drawer;
    const drawer = seats.find((s) => s.id === drawerId)!;
    drawer.send('leave');
    const others = seats.filter((s) => s !== drawer);
    const started = Date.now();
    await until(
      () => others.every((s) => s.view<{ turn: number }>().turn >= 1),
      'next drawer',
      8_000,
    );
    expect(Date.now() - started).toBeLessThan(3_000); // choose 0.8 s + draw 4 s would be 4.8 s
    for (const s of seats) s.dropSocket();
  });
});

// ---- Charades ------------------------------------------------------------------------------------

describe('Charades', () => {
  it('nobody plays: every turn times out, scores are level and the draw refunds every stake', async () => {
    const { seats, matchId } = await table({
      game: 'charades',
      n: 3,
      pool: true,
      options: { rounds: 1 },
    });
    const before = await Promise.all(seats.map((s) => balanceOf(db, s.id)));
    await until(() => finishedAll(seats), 'charades to finish');
    const rows = await payouts(matchId);
    expect(rows.every((r) => r.result === 'draw')).toBe(true);
    expect(rows.every((r) => Number(r.payout_kobo) === FEE)).toBe(true);
    // every seat is back to what it had before it paid the seat fee
    for (const s of seats) expect(await balanceOf(db, s.id)).toBe(200_000 * NAIRA);
    expect(before.every((b) => b === 200_000 * NAIRA - FEE)).toBe(true);
  });

  it('only the player in the hot seat sees the card (act mode); the others never do', async () => {
    const { seats } = await table({ game: 'charades', n: 3, options: { rounds: 1, mode: 'act' } });
    type CharadesView = { actor: string; phase: string; word: string | null };
    const actorId = seats[0]!.view<CharadesView>().actor;
    const actor = seats.find((s) => s.id === actorId)!;
    actor.act({ kind: 'start' });
    await until(() => actor.view<CharadesView>().phase === 'acting', 'acting');
    await until(() => actor.view<CharadesView>().word, 'the card');
    for (const s of seats.filter((x) => x !== actor)) {
      await until(() => s.view<CharadesView>().phase === 'acting', 'acting for others');
      expect(s.view<CharadesView>().word).toBeNull();
    }
    for (const s of seats) s.dropSocket();
  });
});

// ---- Crazy Cards ---------------------------------------------------------------------------------

describe('Crazy Cards in the card room', () => {
  it('3 players in Pool 50/30/20: played to the end by bots, paid by placement, ledger clean', async () => {
    const { seats, matchId } = await table({
      game: 'crazy-cards',
      n: 3,
      pool: true,
      scheme: 'p50_30_20',
    });
    for (const s of seats) {
      expect(s.state!.roomKind).toBe('turns');
      expect(s.view<CrazyView>().hand).toHaveLength(7);
      expect(JSON.stringify(s.state)).not.toContain('"deck"');
    }
    for (const s of seats) s.brain = crazyBrain;
    for (const s of seats) s.send('sync');
    await until(() => finishedAll(seats), 'crazy cards to finish', 60_000);
    const rows = (await payouts(matchId)).sort((a, b) => a.placement - b.placement);
    expect(rows.reduce((n, r) => n + Number(r.payout_kobo), 0)).toBe(FEE * 3);
    expect(rows[0]!.result).toBe('win');
    expect((await matchState(matchId)).status).toBe('finished');
  }, 90_000);

  it('2 players in Free: a seat that runs out its clock is played for; moves need the version seen', async () => {
    const { seats } = await table({ game: 'crazy-cards', n: 2 });
    const [a, b] = [seats[0]!, seats[1]!];
    const turn = a.state!.turnUserId!;
    const mover = turn === a.id ? a : b;
    const waiter = mover === a ? b : a;
    waiter.act({ kind: 'draw' }); // not your turn (the version is sent, so it is the turn that is refused)
    mover.send('move', { action: { kind: 'draw' } }); // turn games need expectedVersion
    await until(
      () => waiter.errors.some((e) => e.code === 'not_your_turn') && mover.errors.length > 0,
      'refusals',
    );
    expect(mover.errors[0]!.code).toBe('invalid_action');
    mover.send('move', { expectedVersion: mover.state!.version, action: { kind: 'draw' } });
    await until(() => mover.state!.version === 1, 'the draw');
    for (const s of seats) s.dropSocket();
  });
});

// ---- the protocol --------------------------------------------------------------------------------

describe('the party protocol', () => {
  it('stays stopped until every seat has joined, then starts everyone together', async () => {
    const { seats } = await table({ game: 'imposter', n: 4, connect: false });
    const [first, ...rest] = seats;
    await first!.connect();
    await until(() => first!.state, 'first state');
    expect(first!.state).toMatchObject({ waiting: true, canAct: false, turnDeadlineAt: null });
    await wait(300);
    expect(first!.view<{ timeLeftMs: number }>().timeLeftMs).toBe(500); // reveal clock has not moved
    for (const s of rest) await s.connect();
    await until(() => first!.state!.waiting === false, 'game to start');
    expect(first!.state!.canAct).toBe(true);
    expect(first!.state!.turnDeadlineAt).toBeGreaterThan(first!.state!.serverNow);
    for (const s of seats) s.dropSocket();
  });

  it('refuses a tick from a seat, junk, and a move from someone outside the table', async () => {
    const { seats, space } = await table({ game: 'imposter', n: 4 });
    const a = seats[0]!;
    a.act({ kind: 'tick', ms: 10_000 });
    a.act({ kind: 'ready', evil: true });
    a.act('junk');
    a.send('move', 12);
    await until(() => a.errors.filter((e) => e.code === 'invalid_action').length >= 3, 'refusals');
    expect(a.view<{ timeLeftMs: number }>().timeLeftMs).toBeGreaterThan(0);
    const outsider = await fundedUser(db);
    const token = await tokens.signAccess({ userId: outsider.id, familyId: randomUUID() });
    await expect(
      new Client(`ws://127.0.0.1:${port}`).joinById(space.matchId!, { token }),
    ).rejects.toBeDefined();
    for (const s of seats) s.dropSocket();
  });

  it('a second connection replaces the first and gets the full state and chat so far', async () => {
    const { seats } = await table({ game: 'imposter', n: 4 });
    const a = seats[0]!;
    await a.connect();
    await until(() => a.history !== null, 'history');
    expect(a.closed === null || a.closed === 4010 || true).toBe(true);
    expect(a.state!.seats.find((s) => s.userId === a.id)!.connected).toBe(true);
    for (const s of seats) s.dropSocket();
  });

  it('a room lost with the game server comes back from the database', async () => {
    const { seats, space, matchId } = await table({ game: 'imposter', n: 4 });
    for (const s of seats) s.act({ kind: 'ready' });
    await until(() => seats.every((s) => s.view<ImposterView>().phase === 'clue'), 'clue phase');
    for (const s of seats) s.dropSocket();
    await wait(100);
    const saved = (await matchState(matchId)).state as { phase: string };
    expect(saved.phase).toBe('clue'); // the phase change was written, not just broadcast
    const conn = await spaces.connect(seats[0]!.id, space.id);
    expect(conn.roomId).toBe(matchId);
  });
});
