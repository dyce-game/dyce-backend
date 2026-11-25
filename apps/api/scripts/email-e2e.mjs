// End-to-end email sign-in over real HTTP against the BUILT api, a throwaway embedded PostgreSQL and a LOCAL MOCK of
// Resend (ADR-044). Run `pnpm -F @dyce/api build` first. It uses the real Resend driver (EMAIL_DRIVER=resend, with
// RESEND_BASE_URL pointing at the mock), so it proves what we send to Resend (URL, key, idempotency key, body) and
// what the app can do with the answer, without a Resend account, an API key or a network.
//
// It does NOT prove delivery to a real inbox: that needs a real Resend account and a verified domain
// (docs/SETUP_GUIDE.md section 4).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { migrate } from '../db/migrator.ts';

const dataDir = await mkdtemp(join(tmpdir(), 'dyce-email-e2e-'));
const pgPort = 55900 + Math.floor(Math.random() * 90);
const apiPort = 56900 + Math.floor(Math.random() * 90);
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

// ---- the mock Resend ----------------------------------------------------------------------------------------------
const received = [];
let mockMode = 'ok'; // 'ok' | 'reject' | 'flaky'
let flakyLeft = 0;
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.setHeader('content-type', 'application/json');
    if (req.method !== 'POST' || req.url !== '/emails') {
      res.statusCode = 404;
      return res.end('{}');
    }
    if (mockMode === 'reject') {
      res.statusCode = 422;
      return res.end(JSON.stringify({ name: 'validation_error', message: 'Invalid `to` field' }));
    }
    if (mockMode === 'flaky' && flakyLeft > 0) {
      flakyLeft -= 1;
      res.statusCode = 503;
      return res.end('{}');
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ id: `mock_${received.length}` }));
  });
});
// port 0 = the OS picks a free port (fixed ranges can be reserved on Windows)
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const mockPort = mock.address().port;

const KEY = 're_mock_key_123';
const baseEnv = (extra = {}) => ({
  ...process.env,
  NODE_ENV: 'test',
  PORT: String(apiPort),
  DATABASE_URL: `postgres://dyce_app:dyce_app@127.0.0.1:${pgPort}/dyce`,
  JWT_SECRET: 'j'.repeat(48),
  PHONE_HASH_SALT: 'p'.repeat(48),
  EMAIL_AUTH_ENABLED: 'true',
  EMAIL_DRIVER: 'resend',
  RESEND_API_KEY: KEY,
  EMAIL_FROM: 'Dyce <login@mail.example.com>',
  EMAIL_REPLY_TO: 'support@example.com',
  RESEND_BASE_URL: `http://127.0.0.1:${mockPort}`,
  // lets each call below pretend to come from its own address, so the per-IP limits are tested on purpose, once
  TRUST_PROXY_HOPS: '1',
  ...extra,
});

let api;
let logs = '';
let step = 'setup';
let failed = false;
const base = `http://127.0.0.1:${apiPort}`;

let ipCounter = 0;
async function call(method, path, { body, token, ip } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip ?? `198.51.100.${++ipCounter}`,
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

const codeFrom = (mail) => /\b(\d{6})\b/.exec(JSON.parse(mail.body).text)[1];

async function waitForApi() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('API did not start:\n' + logs.slice(-1500));
}

try {
  await db.initialise();
  await db.start();
  await db.createDatabase('dyce');
  const admin = new pg.Pool({
    connectionString: `postgres://postgres:postgres@127.0.0.1:${pgPort}/dyce`,
  });
  await migrate(admin);
  await admin.query(`CREATE ROLE dyce_app LOGIN PASSWORD 'dyce_app' IN ROLE dyce_api`);

  // ---- production safety -----------------------------------------------------------------------------------------
  step = 'production refuses the console email driver while email sign-in is on';
  const unsafe = spawn(process.execPath, ['dist/main.js'], {
    env: baseEnv({
      NODE_ENV: 'production',
      SMS_DRIVER: 'real',
      TERMII_API_KEY: 'k',
      TERMII_SENDER_ID: 'Dyce',
      PUSH_DRIVER: 'expo',
      INTEGRITY_DRIVER: 'store',
      EMAIL_DRIVER: 'console',
    }),
    stdio: 'pipe',
  });
  let unsafeOut = '';
  unsafe.stderr.on('data', (d) => (unsafeOut += d));
  unsafe.stdout.on('data', (d) => (unsafeOut += d));
  const unsafeCode = await new Promise((resolve) => unsafe.on('exit', resolve));
  assert.notEqual(unsafeCode, 0, 'production booted with the console email driver');
  assert.match(unsafeOut, /EMAIL_DRIVER/);

  // ---- boot with Resend ------------------------------------------------------------------------------------------
  api = spawn(process.execPath, ['dist/main.js'], { env: baseEnv(), stdio: 'pipe' });
  api.stdout.on('data', (d) => (logs += d));
  api.stderr.on('data', (d) => (logs += d));
  await waitForApi();

  step = 'methods';
  const methods = await call('GET', '/auth/methods');
  assert.equal(methods.status, 200);
  assert.deepEqual(methods.json, { phone: true, email: true });

  step = 'validation';
  for (const bad of ['', 'nope', 'a@b', 'x@@y.com']) {
    const r = await call('POST', '/auth/email/otp/request', { body: { email: bad } });
    assert.ok([422].includes(r.status), `bad address ${JSON.stringify(bad)} gave ${r.status}`);
  }
  assert.equal(received.length, 0, 'an invalid address reached Resend');

  // ---- request: exactly what Resend is sent -----------------------------------------------------------------------
  step = 'request sends one well-formed email through Resend';
  const email = `E2E.Person${Date.now()}@Example.COM`;
  const normal = email.toLowerCase();
  const req = await call('POST', '/auth/email/otp/request', { body: { email } });
  assert.equal(req.status, 202, req.text);
  assert.deepEqual(req.json, { resendAfterSeconds: 30, expiresInSeconds: 300 });
  assert.equal(received.length, 1);
  const sent = received[0];
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, '/emails');
  assert.equal(sent.headers.authorization, `Bearer ${KEY}`);
  assert.match(String(sent.headers['idempotency-key']), /^otp-[0-9a-f-]{36}$/);
  const payload = JSON.parse(sent.body);
  assert.equal(payload.from, 'Dyce <login@mail.example.com>');
  assert.deepEqual(payload.to, [normal]);
  assert.equal(payload.reply_to, 'support@example.com');
  assert.match(payload.subject, /^\d{6} is your Dyce code$/);
  assert.ok(payload.html.includes(codeFrom(sent)) && payload.text.includes(codeFrom(sent)));
  assert.ok(!/<a\s/i.test(payload.html), 'the email has a link');

  step = 'the server log never has the address or the code';
  assert.ok(!logs.includes(normal) && !logs.includes('e2e.person'), 'log leaked the address');
  assert.ok(!logs.includes(codeFrom(sent)), 'log leaked the code');

  // ---- verify: new account, then the same account again ---------------------------------------------------------------
  step = 'wrong code, then the right one signs up';
  const wrong = codeFrom(sent) === '000000' ? '111111' : '000000';
  const bad = await call('POST', '/auth/email/otp/verify', { body: { email, code: wrong } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'otp_invalid');
  assert.equal(bad.json.attemptsRemaining, 4);
  const ok = await call('POST', '/auth/email/otp/verify', {
    body: { email, code: codeFrom(sent) },
  });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.isNewUser, true);
  assert.equal(ok.json.nextStep, 'username');
  const token = ok.json.accessToken;

  step = '/me says how the person signs in, with a masked address';
  const me = await call('GET', '/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.json.signIn.phone, false);
  assert.match(me.json.signIn.emailHint, /^e•+@example\.com$/);
  assert.ok(!me.text.includes('person'), '/me leaked the address');

  step = 'only hashes are stored';
  const row = await admin.query(
    'SELECT phone_hash, email_hash, email_hint FROM users WHERE id = $1',
    [ok.json.userId],
  );
  assert.equal(row.rows[0].phone_hash, null);
  assert.ok(Buffer.isBuffer(row.rows[0].email_hash));
  const dump =
    JSON.stringify((await admin.query('SELECT * FROM users')).rows) +
    JSON.stringify((await admin.query('SELECT * FROM otp_challenges')).rows);
  assert.ok(!dump.toLowerCase().includes('e2e.person'), 'the address is stored in the clear');

  step = 'logging in again (a different spelling) reaches the same account';
  await admin.query("UPDATE otp_challenges SET created_at = created_at - interval '1 hour'"); // skip the resend cooldown
  const again = await call('POST', '/auth/email/otp/request', {
    body: { email: normal.toUpperCase() },
  });
  assert.equal(again.status, 202, again.text);
  const login = await call('POST', '/auth/email/otp/verify', {
    body: { email: normal, code: codeFrom(received.at(-1)) },
  });
  assert.equal(login.status, 200);
  assert.equal(login.json.isNewUser, false);
  assert.equal(login.json.userId, ok.json.userId);

  // ---- failure handling ---------------------------------------------------------------------------------------------
  step = 'a provider rejection becomes email_failed and does not use up the limit';
  mockMode = 'reject';
  const rejectEmail = `reject${Date.now()}@example.com`;
  const rej = await call('POST', '/auth/email/otp/request', { body: { email: rejectEmail } });
  assert.equal(rej.status, 502);
  assert.equal(rej.json.code, 'email_failed');
  assert.ok(!logs.includes(rejectEmail), 'log leaked the address on failure');
  mockMode = 'ok';
  const after = await call('POST', '/auth/email/otp/request', { body: { email: rejectEmail } });
  assert.equal(after.status, 202, 'the failed attempt used up the resend limit');

  step = 'a flaky provider is retried with the same idempotency key';
  mockMode = 'flaky';
  flakyLeft = 2;
  const before = received.length;
  const flakyEmail = `flaky${Date.now()}@example.com`;
  const fl = await call('POST', '/auth/email/otp/request', { body: { email: flakyEmail } });
  assert.equal(fl.status, 202, fl.text);
  const attempts = received.slice(before);
  assert.equal(attempts.length, 3);
  assert.equal(new Set(attempts.map((a) => a.headers['idempotency-key'])).size, 1);
  mockMode = 'ok';

  // ---- adding an email to a phone account ---------------------------------------------------------------------------
  step = 'a signed-in account can add an email, and is told if it is taken';
  const taken = await call('POST', '/me/email/request', {
    token,
    body: { email: `x${Date.now()}@example.com` },
  });
  assert.equal(taken.status, 202, taken.text);
  const noAuth = await call('POST', '/me/email/request', { body: { email: 'a@example.com' } });
  assert.equal(noAuth.status, 401);

  step = 'one address asking over and over is slowed down (5 a minute per IP)';
  const same = '203.0.113.9';
  const codes = [];
  for (let i = 0; i < 7; i++) {
    const r = await call('POST', '/auth/email/otp/request', {
      ip: same,
      body: { email: `burst${i}.${Date.now()}@example.com` },
    });
    codes.push(r.status);
  }
  assert.deepEqual(codes.slice(0, 5), [202, 202, 202, 202, 202]);
  assert.ok(
    codes.slice(5).every((c) => c === 429),
    `expected 429 after five, got ${codes}`,
  );

  // ---- switched off --------------------------------------------------------------------------------------------------
  step = 'EMAIL_AUTH_ENABLED=false hides and refuses email sign-in';
  api.kill();
  await new Promise((r) => setTimeout(r, 300));
  logs = '';
  api = spawn(process.execPath, ['dist/main.js'], {
    env: baseEnv({ EMAIL_AUTH_ENABLED: 'false', EMAIL_DRIVER: 'console' }),
    stdio: 'pipe',
  });
  api.stdout.on('data', (d) => (logs += d));
  api.stderr.on('data', (d) => (logs += d));
  await waitForApi();
  const off = await call('GET', '/auth/methods');
  assert.deepEqual(off.json, { phone: true, email: false });
  const refused = await call('POST', '/auth/email/otp/request', {
    body: { email: 'a.b@example.com' },
  });
  assert.equal(refused.status, 404);
  assert.equal(refused.json.code, 'email_auth_disabled');

  await admin.end();
  console.log('EMAIL E2E OK');
} catch (err) {
  failed = true;
  console.error(`EMAIL E2E FAILED at step "${step}":`, err.message);
  console.error('--- last server logs ---\n' + logs.slice(-1500));
} finally {
  api?.kill();
  mock.close();
  await db.stop().catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
process.exit(failed ? 1 : 0);
