// Real-process check of the live rooms: the BUILT API and the BUILT game server, each its own process,
// talking over real HTTP and WebSockets to a throwaway embedded PostgreSQL, with people who sign in with
// the dev OTP code and play through colyseus.js bots that only read their own view.
//
//   pnpm -F @dyce/shared build && pnpm -F @dyce/games build && pnpm -F @dyce/api build \
//     && pnpm -F @dyce/game-server build && pnpm -F @dyce/game-server e2e
//
// Covers what the Jest suites bypass: the Nest controllers, pipes and modules (spaces, quick match), the
// signed API -> game-server room call, real JWTs in the room, and the real phase timers' defaults.
//   1. a 4-player Imposter round in Pool (options sent over HTTP), paid to the crew
//   2. a 5-player Werewolf game (Free)
//   3. a 3-player Crazy Cards game in Pool, 50/30/20
//   4. a quick-match pair: queue, found, accept, play to the end, Pool settled; realtime events seen
// and after each one the ledger invariants.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from 'colyseus.js';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = join(here, '..', '..', 'api');
const gameDir = join(here, '..');
process.chdir(apiDir); // the migrator reads db/migrations relative to the API
const { migrate } = await import(pathToFileURL(join(apiDir, 'db', 'migrator.ts')).href);
const { crazyCanPlay } = await import('@dyce/games');

const NAIRA = 100;
const FEE = 500 * NAIRA;
const dataDir = await mkdtemp(join(tmpdir(), 'dyce-live-e2e-'));
const pgPort = 55100 + Math.floor(Math.random() * 400);
const apiPort = 56100 + Math.floor(Math.random() * 400);
const gamePort = 57100 + Math.floor(Math.random() * 400);
const JWT_SECRET = 'j'.repeat(48);
const INTERNAL_SECRET = 'i'.repeat(48);
const OTP = '123456';
const base = `http://127.0.0.1:${apiPort}`;
const db = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'postgres',
  port: pgPort,
  persistent: false,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: () => {},
  onError: () => {},
});

const procs = [];
let logs = '';
let step = 'setup';
let failed = false;
let admin;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, { body, token, ip = '10.0.0.1' } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}
const ok = async (p, what) => {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
};

let userN = 0;
async function signUp() {
  const n = ++userN;
  const phone = `0803 555 ${String(1000 + n)}`;
  const ip = `10.1.${Math.floor(n / 200)}.${n % 200}`;
  await ok(
    call('POST', '/auth/otp/request', { body: { phone, country: 'NG' }, ip }),
    'otp request',
  );
  const s = await ok(
    call('POST', '/auth/otp/verify', { body: { phone, country: 'NG', code: OTP }, ip }),
    'otp verify',
  );
  const token = s.accessToken;
  await ok(
    call('POST', '/profile', {
      token,
      ip,
      body: { username: `e2e_${n}`, displayName: `Player ${n}` },
    }),
    'profile',
  );
  await ok(call('POST', '/profile/age-gate', { token, ip, body: { birthYear: 1990 } }), 'age gate');
  await ok(call('POST', '/onboarding/welcome-bonus', { token, ip }), 'welcome bonus');
  return { id: s.userId, token, ip, n };
}
const befriend = async (a, b) => {
  await ok(
    call('POST', '/friends/requests', { token: a.token, ip: a.ip, body: { userId: b.id } }),
    'friend request',
  );
  await ok(
    call('POST', `/friends/requests/${a.id}/accept`, { token: b.token, ip: b.ip }),
    'accept friend',
  );
};
const balance = async (u) =>
  (await ok(call('GET', '/wallet', { token: u.token, ip: u.ip }), 'wallet')).balanceKobo;
const ledgerClean = async (what) => {
  const r = await admin.query('SELECT * FROM ledger_check_invariants(false)');
  assert.deepEqual(r.rows, [], `ledger invariants broken after ${what}`);
};

// ---- bots -----------------------------------------------------------------------------------------
class Bot {
  constructor(user, brain) {
    this.user = user;
    this.brain = brain;
    this.state = null;
    this.errors = [];
    this.last = '';
  }
  async join(conn) {
    const client = new Client(conn.url);
    this.room = await client.joinById(conn.roomId, { token: this.user.token });
    this.room.onMessage('state', (s) => {
      this.state = s;
      this.first ??= s;
      if (!this.brain || s.status !== 'live' || !s.canAct) return;
      const action = this.brain(this, s);
      if (action === null || action === undefined) return;
      const key = JSON.stringify([action, s.version, s.view?.seq]);
      if (key === this.last) return;
      this.last = key;
      this.room.send('move', { expectedVersion: s.version, action });
    });
    this.room.onMessage('error', (e) => this.errors.push(e));
    this.room.onMessage('chat', () => {});
    this.room.onMessage('chat_history', () => {});
  }
  get view() {
    return this.state?.view;
  }
}

async function until(fn, what, ms = 90_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const imposterBrain = (imposters) => (bot, s) => {
  const v = s.view;
  const me = bot.user.id;
  if (v.phase === 'reveal') return v.ready.includes(me) ? null : { kind: 'ready' };
  if (v.phase === 'clue') return v.speaker === me ? { kind: 'clue', text: 'hmm' } : null;
  if (v.phase === 'vote') {
    if (v.voted.includes(me)) return null;
    const others = v.players.filter((p) => !imposters.includes(p) && p !== me);
    return { kind: 'vote', targets: v.role === 'crew' ? imposters : [others[0]] };
  }
  if (v.phase === 'guess')
    return v.role === 'imposter' && !v.guessed.includes(me)
      ? { kind: 'guess', text: 'nope' }
      : null;
  return null;
};
const werewolfBrain = (wolves) => (bot, s) => {
  const v = s.view;
  const me = bot.user.id;
  if (v.phase === 'night') {
    if (v.acted) return null;
    if (v.role === 'werewolf')
      return { kind: 'kill', target: v.alive.find((p) => !wolves.includes(p)) };
    if (v.role === 'seer') return { kind: 'inspect', target: v.alive.find((p) => p !== me) };
    if (v.role === 'doctor') return { kind: 'protect', target: me };
    return null;
  }
  if (v.phase === 'day') return v.ready.includes(me) ? null : { kind: 'ready' };
  if (v.phase === 'vote') {
    if (v.voted.includes(me)) return null;
    const target =
      v.role === 'werewolf'
        ? v.alive.find((p) => !wolves.includes(p))
        : v.alive.find((p) => wolves.includes(p));
    return { kind: 'vote', target };
  }
  return null;
};
const crazyBrain = (bot, s) => {
  const v = s.view;
  if (v.current !== bot.user.id) return null;
  const pool = v.drawn ? [v.drawn] : v.hand;
  const card = pool.find((c) => crazyCanPlay(c, v.top, v.color));
  if (!card) return v.drawn ? { kind: 'pass' } : { kind: 'draw' };
  const a = { kind: 'play', card };
  if (card.color === 'wild') a.color = v.hand.find((c) => c.color !== 'wild')?.color ?? 'red';
  if (v.hand.length - 1 === 1) a.call = true;
  return a;
};

/** Host opens a space over HTTP, the others join by code, the host starts it, everyone connects. */
async function openTable({ gameSlug, host, others, ...rest }) {
  const space = await ok(
    call('POST', '/spaces', {
      token: host.token,
      ip: host.ip,
      body: {
        id: randomUUID(),
        name: `${gameSlug} night`,
        gameSlug,
        maxSeats: others.length + 1,
        visibility: 'friends',
        startRule: 'host',
        ...rest,
      },
    }),
    `create ${gameSlug}`,
  );
  for (const o of others)
    await ok(
      call('POST', '/spaces/join', { token: o.token, ip: o.ip, body: { code: space.code } }),
      'join',
    );
  const live = await ok(
    call('POST', `/spaces/${space.id}/start`, { token: host.token, ip: host.ip }),
    'start',
  );
  assert.equal(live.status, 'live');
  return { space: live, users: [host, ...others] };
}
async function seat(space, users, brains) {
  const bots = [];
  for (const [i, u] of users.entries()) {
    const conn = await ok(
      call('POST', `/spaces/${space.id}/connect`, { token: u.token, ip: u.ip }),
      'connect',
    );
    assert.equal(conn.matchId, space.matchId);
    const bot = new Bot(u, null);
    await bot.join(conn);
    bots.push(bot);
    bot.brain = brains[i] ?? brains[0];
  }
  await until(() => bots.every((b) => b.state), 'first states');
  return bots;
}
const play = async (bots, what) => {
  for (const b of bots) {
    b.brain && b.room.send('sync');
  }
  await until(() => bots.every((b) => b.state?.status === 'finished'), `${what} to finish`);
  // The table shows "finished" a moment before the server has written the result and the payout to the database (the
  // players see it first, the money follows): wait for the match row to close before anything reads the database.
  const ids = bots.map((b) => b.user.id);
  await until(
    async () =>
      (
        await admin.query(
          `SELECT 1 FROM matches m JOIN match_players mp ON mp.match_id = m.id
            WHERE mp.user_id = ANY($1::uuid[]) AND m.status = 'active' LIMIT 1`,
          [ids],
        )
      ).rowCount === 0,
    `${what} to be settled in the database`,
  );
  // A bot answers every state it sees, so it can send a move a moment after the table moved on: those
  // races are refused politely (not your turn, wrong phase, game over). Anything else is a bug.
  for (const b of bots) {
    const bad = b.errors.filter(
      (e) => !/^(not_your_turn|illegal_move:|stale_version|not_running)/.test(e.code),
    );
    assert.deepEqual(bad, [], `${what}: a bot was refused for a real reason`);
  }
};
const matchRow = async (id) =>
  (await admin.query('SELECT state, status FROM matches WHERE id = $1', [id])).rows[0];

try {
  await db.initialise();
  await db.start();
  await db.createDatabase('dyce');
  admin = new pg.Pool({
    connectionString: `postgres://postgres:postgres@127.0.0.1:${pgPort}/dyce`,
  });
  await migrate(admin);
  await admin.query(`CREATE ROLE dyce_app LOGIN PASSWORD 'dyce_app' IN ROLE dyce_api`);
  // The bots here answer faster than a person can, which the anti-cheat treats as a signal (apps/api/db/migrations/0025):
  // on a fast machine that is enough to HOLD a Pool payout for a moderator. This script proves the rooms and the money,
  // not the anti-cheat (that has its own database tests), so the hold threshold is raised out of reach.
  await admin.query(`UPDATE app_config SET value = '1000' WHERE key = 'integrity_hold_threshold'`);

  const dbUrl = `postgres://dyce_app:dyce_app@127.0.0.1:${pgPort}/dyce`;
  const spawnProc = (cwd, env) => {
    const p = spawn(process.execPath, ['dist/main.js'], {
      cwd,
      env: { ...process.env, ...env },
      stdio: 'pipe',
    });
    p.stdout.on('data', (d) => (logs += d));
    p.stderr.on('data', (d) => (logs += d));
    procs.push(p);
    return p;
  };
  spawnProc(gameDir, { PORT: String(gamePort), DATABASE_URL: dbUrl, JWT_SECRET, INTERNAL_SECRET });
  spawnProc(apiDir, {
    NODE_ENV: 'test',
    PORT: String(apiPort),
    DATABASE_URL: dbUrl,
    JWT_SECRET,
    PHONE_HASH_SALT: 'p'.repeat(48),
    INTERNAL_SECRET,
    GAME_SERVER_URL: `http://127.0.0.1:${gamePort}`,
    GAME_SERVER_PUBLIC_URL: `ws://127.0.0.1:${gamePort}`,
    OTP_TEST_CODE: OTP,
    TRUST_PROXY_HOPS: '1',
  });
  await until(
    async () => {
      try {
        return (
          (await fetch(`${base}/health`)).ok &&
          (await fetch(`http://127.0.0.1:${gamePort}/health`)).ok
        );
      } catch {
        return false;
      }
    },
    'both servers to come up',
    60_000,
  );

  // ---- 1. Imposter, Pool, 4 players ------------------------------------------------------------------
  step = 'imposter';
  {
    const [host, ...others] = [await signUp(), await signUp(), await signUp(), await signUp()];
    for (const o of others) await befriend(host, o);
    const before = await Promise.all([host, ...others].map(balance));
    const bad = await call('POST', '/spaces', {
      token: host.token,
      ip: host.ip,
      body: {
        id: randomUUID(),
        name: 'x',
        gameSlug: 'imposter',
        maxSeats: 4,
        options: { clueRounds: 9 },
      },
    });
    assert.equal(bad.status, 422, `options should be refused: ${bad.text}`);
    assert.equal(bad.json.code, 'invalid_options');
    const sides = await call('POST', '/spaces', {
      token: host.token,
      ip: host.ip,
      body: {
        id: randomUUID(),
        name: 'x',
        gameSlug: 'imposter',
        maxSeats: 4,
        mode: 'pool',
        seatFeeKobo: FEE,
        payoutScheme: 'p50_30_20',
      },
    });
    assert.equal(sides.json?.code, 'invalid_payout', sides.text);
    const { space, users } = await openTable({
      gameSlug: 'imposter',
      host,
      others,
      mode: 'pool',
      seatFeeKobo: FEE,
      payoutScheme: 'winner_all',
      options: { clueRounds: 1 },
    });
    assert.equal(space.options.clueRounds, 1);
    const m0 = await matchRow(space.matchId);
    const imposters = m0.state.imposters;
    assert.equal(m0.state.clueRounds, 1);
    const bots = await seat(space, users, [imposterBrain(imposters)]);
    await play(bots, 'imposter');
    const rows = (
      await admin.query(
        'SELECT user_id, result, payout_kobo FROM match_players WHERE match_id = $1',
        [space.matchId],
      )
    ).rows;
    const winners = rows.filter((r) => r.result === 'win');
    assert.equal(winners.length, 3, 'the three crew win');
    assert.equal(
      winners.reduce((n, r) => n + Number(r.payout_kobo), 0),
      FEE * 4,
    );
    const after = await Promise.all(users.map(balance));
    assert.equal(
      after.reduce((a, b) => a + b, 0),
      before.reduce((a, b) => a + b, 0),
      'money is only moved, never made',
    );
    assert.equal(
      after[users.findIndex((u) => imposters.includes(u.id))],
      before[users.findIndex((u) => imposters.includes(u.id))] - FEE,
    );
    await ledgerClean('imposter');
    for (const b of bots) b.room.leave();
    console.log(
      'ok  Imposter, 4 players, Pool: crew paid',
      winners.map((r) => r.payout_kobo).join('/'),
    );
  }

  // ---- 2. Werewolf, Free, 5 players -------------------------------------------------------------------
  step = 'werewolf';
  {
    const users5 = [await signUp(), await signUp(), await signUp(), await signUp(), await signUp()];
    const [host, ...others] = users5;
    for (const o of others) await befriend(host, o);
    const { space, users } = await openTable({ gameSlug: 'werewolf', host, others });
    const roles = (await matchRow(space.matchId)).state.roles;
    const wolves = Object.keys(roles).filter((p) => roles[p] === 'werewolf');
    const bots = await seat(space, users, [werewolfBrain(wolves)]);
    for (const b of bots) {
      assert.equal(b.first.turnUserId, null, 'party rooms never say whose turn it is');
      assert.equal(b.first.view.roles, undefined, 'roles are secret until the end');
    }
    await play(bots, 'werewolf');
    assert.equal(bots[0].view.winner, 'villagers');
    await ledgerClean('werewolf');
    for (const b of bots) b.room.leave();
    console.log('ok  Werewolf, 5 players, Free: villagers lynched the wolf');
  }

  // ---- 3. Crazy Cards, Pool 50/30/20, 3 players -------------------------------------------------------
  step = 'crazy cards';
  {
    const [host, ...others] = [await signUp(), await signUp(), await signUp()];
    for (const o of others) await befriend(host, o);
    const { space, users } = await openTable({
      gameSlug: 'crazy-cards',
      host,
      others,
      mode: 'pool',
      seatFeeKobo: FEE,
      payoutScheme: 'p50_30_20',
    });
    const bots = await seat(space, users, [crazyBrain]);
    // Seven each, dealt by the server. The first bot to connect sees the untouched deal; a bot that connects after the table
    // has already moved can legitimately see more (the first player may have played a Wild Draw Four on it), so the exact
    // count is asserted only for a first view taken at the same version as the first bot's.
    for (const b of bots) {
      if (b.first.version === bots[0].first.version) assert.equal(b.first.view.hand.length, 7);
      else
        assert.ok(
          b.first.view.hand.length >= 7,
          'a late joiner holds at least the seven it was dealt',
        );
    }
    await play(bots, 'crazy cards');
    const rows = (
      await admin.query(
        'SELECT placement, payout_kobo FROM match_players WHERE match_id = $1 ORDER BY placement',
        [space.matchId],
      )
    ).rows;
    assert.equal(
      rows.reduce((n, r) => n + Number(r.payout_kobo), 0),
      FEE * 3,
      `crazy cards payouts (match is ${JSON.stringify(await matchRow(space.matchId).then((m) => m.status))}; rows ${JSON.stringify(rows)})`,
    );
    await ledgerClean('crazy cards');
    for (const b of bots) b.room.leave();
    console.log(
      'ok  Crazy Cards, 3 players, Pool 50/30/20: paid',
      rows.map((r) => r.payout_kobo).join('/'),
    );
  }

  // ---- 4. Quick match, Pool ------------------------------------------------------------------------
  step = 'quick match';
  {
    const [a, b] = [await signUp(), await signUp()];
    // not friends: strangers
    assert.equal((await call('GET', '/quick-match')).status, 401);
    const state0 = await ok(
      call('GET', '/quick-match', { token: a.token, ip: a.ip }),
      'quick match state',
    );
    assert.deepEqual(state0.games.map((g) => g.slug).sort(), ['crazy-cards', 'whot']);
    let r = await call('POST', '/quick-match', {
      token: a.token,
      ip: a.ip,
      body: { gameSlug: 'imposter' },
    });
    assert.equal(r.json?.code, 'quick_match_unavailable', r.text);
    r = await call('POST', '/quick-match', {
      token: a.token,
      ip: a.ip,
      body: { gameSlug: 'nope-game' },
    });
    assert.equal(r.json?.code, 'game_not_found', r.text);
    r = await call('POST', '/quick-match', {
      token: a.token,
      ip: a.ip,
      body: { gameSlug: 'whot', mode: 'pool', stakeKobo: 5 },
    });
    assert.equal(r.json?.code, 'invalid_stake', r.text);
    r = await call('POST', '/quick-match', {
      token: a.token,
      ip: a.ip,
      body: { gameSlug: 'whot', mode: 'banana' },
    });
    assert.equal(r.status, 422, r.text);

    // live events for A over the real /realtime socket
    const events = [];
    const ws = new WebSocket(`ws://127.0.0.1:${apiPort}/realtime`);
    ws.onmessage = (m) => events.push(JSON.parse(m.data));
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });
    ws.send(JSON.stringify({ type: 'auth', token: a.token }));

    const beforeA = await balance(a);
    const t1 = await ok(
      call('POST', '/quick-match', {
        token: a.token,
        ip: a.ip,
        body: { gameSlug: 'crazy-cards', mode: 'pool', stakeKobo: FEE },
      }),
      'join a',
    );
    assert.equal(t1.status, 'searching');
    const again = await ok(
      call('POST', '/quick-match', {
        token: a.token,
        ip: a.ip,
        body: { gameSlug: 'crazy-cards', mode: 'pool', stakeKobo: FEE },
      }),
      'join a again',
    );
    assert.equal(again.id, t1.id, 'a repeat is the same search');
    const t2 = await ok(
      call('POST', '/quick-match', {
        token: b.token,
        ip: b.ip,
        body: { gameSlug: 'crazy-cards', mode: 'pool', stakeKobo: FEE },
      }),
      'join b',
    );
    assert.equal(t2.status, 'found', 'the second person finds the first at once');
    assert.equal(t2.opponent.username, `e2e_${a.n}`);
    assert.equal(await balance(a), beforeA - FEE, 'the stake is locked when the match is found');
    await until(
      () => events.some((e) => e.type === 'quick_match' && e.ticket.status === 'found'),
      'the found event over /realtime',
      10_000,
    );

    // a skips the first time? no: both accept
    await ok(
      call('POST', `/quick-match/${t1.id}/accept`, { token: a.token, ip: a.ip }),
      'a accepts',
    );
    const done = await ok(
      call('POST', `/quick-match/${t2.id}/accept`, { token: b.token, ip: b.ip }),
      'b accepts',
    );
    assert.equal(done.status, 'playing');
    const mine = await ok(call('GET', '/quick-match', { token: a.token, ip: a.ip }), 'state');
    assert.equal(mine.ticket.status, 'playing');
    const space = await ok(
      call('GET', `/spaces/${done.spaceId}`, { token: a.token, ip: a.ip }),
      'space',
    );
    assert.equal(space.quickMatch, true);
    assert.equal(space.status, 'live');
    const convs = await admin.query(
      `SELECT count(*)::int AS n FROM conversation_members x JOIN conversation_members y ON y.conversation_id = x.conversation_id AND y.user_id = $2 WHERE x.user_id = $1`,
      [a.id, b.id],
    );
    assert.equal(convs.rows[0].n, 0, 'strangers who play get no chat');
    ws.close();

    const bots = await seat(space, [a, b], [crazyBrain]);
    await play(bots, 'quick match');
    const rows = (
      await admin.query(
        'SELECT user_id, result, payout_kobo FROM match_players WHERE match_id = $1',
        [space.matchId],
      )
    ).rows;
    assert.equal(
      rows.reduce((n, r) => n + Number(r.payout_kobo), 0),
      FEE * 2,
    );
    assert.equal(rows.filter((r) => r.result === 'win').length, 1);
    await ledgerClean('quick match');
    for (const x of bots) x.room.leave();
    console.log(
      'ok  Quick match: Pool 2 x',
      FEE / NAIRA,
      'paid',
      rows.map((r) => r.payout_kobo).join('/'),
    );
  }
} catch (err) {
  failed = true;
  console.error(`LIVE E2E FAIL at step "${step}":`, err);
  console.error('--- server logs (tail) ---\n' + logs.split('\n').slice(-40).join('\n'));
} finally {
  for (const p of procs) p.kill();
  await admin?.end().catch(() => undefined);
  await db.stop().catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  if (!failed) console.log('live e2e passed');
  process.exit(failed ? 1 : 0);
}
