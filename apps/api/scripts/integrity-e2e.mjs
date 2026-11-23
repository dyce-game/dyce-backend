// Integrity layer over real HTTP against the BUILT api and a throwaway embedded PostgreSQL (ADR-039):
// the moderation API (off without its role and tokens, 401 without a valid one, audited actions), the device
// challenge, the production safety check, and that rate limits count signed-in people by account.
// Run `pnpm -F @dyce/api build` first.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { migrate } from '../db/migrator.ts';

const dataDir = await mkdtemp(join(tmpdir(), 'dyce-integrity-'));
const pgPort = 55100 + Math.floor(Math.random() * 400);
const apiPort = 56100 + Math.floor(Math.random() * 400);
const pgdb = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'postgres',
  port: pgPort,
  persistent: false,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: () => {},
  onError: () => {},
});

const TOKEN = 'm'.repeat(40);
const baseEnv = (extra = {}) => ({
  ...process.env,
  NODE_ENV: 'test',
  PORT: String(apiPort),
  DATABASE_URL: `postgres://dyce_app:dyce_app@127.0.0.1:${pgPort}/dyce`,
  JWT_SECRET: 'j'.repeat(48),
  PHONE_HASH_SALT: 'p'.repeat(48),
  ...extra,
});
const base = `http://127.0.0.1:${apiPort}`;

let api;
let logs = '';
let step = 'setup';
let failed = false;

async function call(method, path, { body, token, headers } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
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

async function boot(env) {
  logs = '';
  api = spawn(process.execPath, ['dist/main.js'], { env: baseEnv(env), stdio: 'pipe' });
  api.stdout.on('data', (d) => (logs += d));
  api.stderr.on('data', (d) => (logs += d));
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error('API did not start');
}

async function stop() {
  api?.kill();
  await new Promise((r) => setTimeout(r, 500));
}

async function signIn(phone) {
  const mark = logs.length;
  const req = await call('POST', '/auth/otp/request', { body: { phone, country: 'NG' } });
  assert.equal(req.status, 202, `otp request: ${req.text}`);
  let code = null;
  for (let i = 0; i < 40 && !code; i++) {
    code = /code is (\d{6})/.exec(logs.slice(mark))?.[1] ?? null;
    if (!code) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(code, 'OTP never appeared in the server log');
  const v = await call('POST', '/auth/otp/verify', { body: { phone, country: 'NG', code } });
  assert.equal(v.status, 200, v.text);
  return v.json;
}

try {
  await pgdb.initialise();
  await pgdb.start();
  await pgdb.createDatabase('dyce');
  const admin = new pg.Pool({
    connectionString: `postgres://postgres:postgres@127.0.0.1:${pgPort}/dyce`,
  });
  await migrate(admin);
  await admin.query(`CREATE ROLE dyce_app LOGIN PASSWORD 'dyce_app' IN ROLE dyce_api`);
  await admin.query(
    `CREATE ROLE dyce_moderator LOGIN PASSWORD 'dyce_moderator' IN ROLE dyce_admin`,
  );

  // ---- production safety -------------------------------------------------------------------------
  step = 'production refuses the pass-everything device check';
  const unsafe = spawn(process.execPath, ['dist/main.js'], {
    env: baseEnv({
      NODE_ENV: 'production',
      SMS_DRIVER: 'real',
      PUSH_DRIVER: 'expo',
      TERMII_API_KEY: 'k',
      TERMII_SENDER_ID: 'Dyce',
      INTEGRITY_DRIVER: 'dev',
    }),
    stdio: 'pipe',
  });
  let unsafeOut = '';
  unsafe.stderr.on('data', (d) => (unsafeOut += d));
  unsafe.stdout.on('data', (d) => (unsafeOut += d));
  assert.notEqual(await new Promise((resolve) => unsafe.on('exit', resolve)), 0);
  assert.match(unsafeOut, /INTEGRITY_DRIVER/);

  // ---- moderation is off without its role and tokens ----------------------------------------------
  step = 'moderation off by default';
  await boot({});
  let r = await call('GET', '/admin/moderation/reports', { token: TOKEN });
  assert.equal(
    r.status,
    404,
    'admin routes must not exist without ADMIN_DATABASE_URL and ADMIN_TOKENS',
  );
  await stop();

  // ---- moderation on --------------------------------------------------------------------------------
  step = 'moderation on';
  await boot({
    ADMIN_DATABASE_URL: `postgres://dyce_moderator:dyce_moderator@127.0.0.1:${pgPort}/dyce`,
    ADMIN_TOKENS: `amaka:${TOKEN}`,
  });
  r = await call('GET', '/admin/moderation/reports');
  assert.equal(r.status, 401);
  assert.equal(r.json.code, 'unauthorized');
  r = await call('GET', '/admin/moderation/reports', { token: 'x'.repeat(40) });
  assert.equal(r.status, 401);
  r = await call('GET', '/admin/moderation/reports', { token: TOKEN });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, []);

  // a user's own access token is not an admin token
  step = 'users are not admins';
  const a = await signIn('0803 555 0101');
  r = await call('GET', '/admin/moderation/reports', { token: a.accessToken });
  assert.equal(r.status, 401);

  step = 'acting on a report';
  const reporter = (await admin.query(`SELECT id FROM users ORDER BY created_at LIMIT 1`)).rows[0]
    .id;
  await admin.query(
    `INSERT INTO profiles (id, username, display_name) VALUES ($1, 'ada_o', 'Ada')`,
    [reporter],
  );
  const target = randomUUID();
  await admin.query(
    `INSERT INTO users (id, phone_hash) VALUES ($1, decode(repeat('ab', 32), 'hex'))`,
    [target],
  );
  await admin.query(
    `INSERT INTO profiles (id, username, display_name) VALUES ($1, 'bad_guy', 'Bad')`,
    [target],
  );
  const reportId = randomUUID();
  await admin.query(
    `INSERT INTO reports (id, reporter_id, target_user_id, reason) VALUES ($1, $2, $3, 'abuse')`,
    [reportId, reporter, target],
  );
  r = await call('GET', '/admin/moderation/reports', { token: TOKEN });
  assert.equal(r.json.length, 1);
  assert.equal(r.json[0].target, 'bad_guy');
  r = await call('POST', `/admin/moderation/reports/${reportId}/action`, {
    token: TOKEN,
    body: { action: 'mute', hours: 2, note: 'rude' },
  });
  assert.equal(r.status, 200, r.text);
  r = await call('POST', `/admin/moderation/reports/${reportId}/action`, {
    token: TOKEN,
    body: { action: 'dismiss' },
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'report_resolved');
  r = await call('POST', `/admin/moderation/reports/not-a-uuid/action`, {
    token: TOKEN,
    body: { action: 'warn' },
  });
  assert.equal(r.status, 422);
  r = await call('GET', '/admin/moderation/audit', { token: TOKEN });
  assert.ok(
    r.json.some((x) => x.admin === 'amaka' && x.action === 'report_mute'),
    r.text,
  );
  const muted = await admin.query(`SELECT muted_until FROM users WHERE id = $1`, [target]);
  assert.ok(muted.rows[0].muted_until, 'the sanction was not applied');
  const notes = await admin.query(`SELECT kind, payload FROM notifications WHERE user_id = $1`, [
    reporter,
  ]);
  assert.deepEqual(
    notes.rows.map((n) => [n.kind, n.payload.outcome]),
    [['report_outcome', 'actioned']],
  );

  // ---- the device challenge ---------------------------------------------------------------------------
  step = 'device challenge';
  r = await call('POST', '/integrity/challenge');
  assert.equal(r.status, 401);
  r = await call('POST', '/integrity/challenge', { token: a.accessToken });
  assert.equal(r.status, 200);
  assert.ok(r.json.challenge.length >= 40 && Date.parse(r.json.expiresAt) > Date.now());
  const again = await call('POST', '/integrity/challenge', { token: a.accessToken });
  assert.equal(again.json.challenge, r.json.challenge, 'the nonce is stable inside its window');

  // ---- rate limits count signed-in people by account ---------------------------------------------------
  step = 'per-account rate limits';
  const b = await signIn('0803 555 0102');
  // /integrity/challenge allows 20 a minute. a spends theirs; b, on the same address, is untouched.
  let limited = 0;
  for (let i = 0; i < 25; i++) {
    const x = await call('POST', '/integrity/challenge', { token: a.accessToken });
    if (x.status === 429) limited++;
  }
  assert.ok(limited >= 4, `expected the account to be limited, got ${limited} refusals`);
  r = await call('POST', '/integrity/challenge', { token: b.accessToken });
  assert.equal(r.status, 200, 'a neighbour on the same address must not share the allowance');
  // a forged token does not borrow anyone's allowance: it falls back to the address
  r = await call('POST', '/integrity/challenge', { token: a.accessToken + 'x' });
  assert.equal(r.status, 401);

  await admin.end();
  console.log('INTEGRITY E2E OK');
} catch (err) {
  failed = true;
  console.error(`INTEGRITY E2E FAILED at step "${step}":`, err.message);
  console.error('--- last server logs ---\n' + logs.slice(-1500));
} finally {
  api?.kill();
  await pgdb.stop().catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
process.exit(failed ? 1 : 0);
