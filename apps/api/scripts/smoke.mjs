// Boots the BUILT api (dist/main.js) against a throwaway embedded PostgreSQL and checks /health.
// Run `pnpm -F @dyce/api build` first. Used in CI after the build step.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { migrate } from '../db/migrator.ts';

const dataDir = await mkdtemp(join(tmpdir(), 'dyce-smoke-'));
const pgPort = 55000 + Math.floor(Math.random() * 500);
const apiPort = 56000 + Math.floor(Math.random() * 500);
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

let api;
let failed = false;
const fail = (msg) => {
  failed = true;
  console.error(`SMOKE FAIL: ${msg}`);
};

try {
  await db.initialise();
  await db.start();
  await db.createDatabase('dyce');
  const admin = new pg.Pool({
    connectionString: `postgres://postgres:postgres@127.0.0.1:${pgPort}/dyce`,
  });
  await migrate(admin);
  await admin.query(`CREATE ROLE dyce_app LOGIN PASSWORD 'dyce_app' IN ROLE dyce_api`);
  await admin.end();

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(apiPort),
    DATABASE_URL: `postgres://dyce_app:dyce_app@127.0.0.1:${pgPort}/dyce`,
    JWT_SECRET: 'x'.repeat(40),
    PHONE_HASH_SALT: 'y'.repeat(40),
  };

  // 1) missing config must stop the app before it listens
  const bad = spawn(process.execPath, ['dist/main.js'], {
    env: { ...env, JWT_SECRET: 'short' },
    stdio: 'pipe',
  });
  const badCode = await new Promise((resolve) => bad.on('exit', resolve));
  if (badCode === 0) fail('app started with an invalid JWT_SECRET');

  // 2) healthy boot, once with error reporting off and once on (a dummy DSN: events go nowhere, but the flag must not
  //    break startup), each with structured logs, the probes, the request id and a graceful SIGTERM.
  const variants = [
    { name: 'sentry off', extra: {}, expectSentry: 'off', drainMs: 0 },
    {
      name: 'sentry on (dummy DSN)',
      extra: { SENTRY_DSN: 'https://public@o0.ingest.sentry.io/0', SHUTDOWN_DRAIN_MS: '1500' },
      expectSentry: 'on',
      drainMs: 1500,
    },
  ];
  for (const v of variants) {
    api = spawn(process.execPath, ['dist/main.js'], {
      env: { ...env, LOG_FORMAT: 'json', RELEASE: 'smoke-test', ...v.extra },
      stdio: 'pipe',
    });
    let logs = '';
    api.stdout.on('data', (d) => (logs += d));
    api.stderr.on('data', (d) => (logs += d));
    const exited = new Promise((resolve) => api.on('exit', (code) => resolve(code)));

    const get = async (path, headers = {}) => {
      const res = await fetch(`http://127.0.0.1:${apiPort}${path}`, { headers });
      return { status: res.status, json: await res.json(), headers: res.headers };
    };
    let health;
    for (let i = 0; i < 80 && !health; i++) {
      try {
        health = await get('/health');
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!health) {
      fail(`[${v.name}] api never answered. logs:\n${logs}`);
      api.kill();
      continue;
    }
    if (health.status !== 200 || health.json.status !== 'ok' || health.json.db !== 'up')
      fail(`[${v.name}] unexpected /health: ${JSON.stringify(health)}`);

    const live = await get('/health/live');
    if (live.status !== 200) fail(`[${v.name}] /health/live -> ${live.status}`);
    const ready = await get('/health/ready', { 'x-request-id': 'smoke-request-0001' });
    if (ready.status !== 200 || ready.json.release !== 'smoke-test' || !ready.json.schema)
      fail(`[${v.name}] /health/ready unexpected: ${JSON.stringify(ready.json)}`);
    if (ready.headers.get('x-request-id') !== 'smoke-request-0001')
      fail(`[${v.name}] X-Request-Id was not echoed`);

    // Structured logs: every line parses as JSON; the startup line says whether Sentry is on.
    const lines = logs.split('\n').filter(Boolean);
    const bad = lines.find((l) => {
      try {
        JSON.parse(l);
        return false;
      } catch {
        return true;
      }
    });
    if (bad) fail(`[${v.name}] a log line is not JSON: ${bad}`);
    if (!lines.some((l) => l.includes(`"sentry":"${v.expectSentry}"`)))
      fail(`[${v.name}] startup log does not say sentry ${v.expectSentry}`);

    console.log(
      `SMOKE OK [${v.name}]: /health, /health/live, /health/ready, request id, JSON logs`,
    );

    // Graceful shutdown (SIGTERM cannot be delivered to a child on Windows; the Docker check covers it there).
    if (process.platform !== 'win32') {
      api.kill('SIGTERM');
      if (v.drainMs > 0) {
        await new Promise((r) => setTimeout(r, 300));
        try {
          const draining = await get('/health/ready');
          if (draining.status !== 503)
            fail(`[${v.name}] not draining after SIGTERM: ${draining.status}`);
        } catch {
          fail(`[${v.name}] server closed during the drain window instead of after it`);
        }
      }
      const code = await Promise.race([
        exited,
        new Promise((r) => setTimeout(() => r('timeout'), 15000)),
      ]);
      if (code !== 0) fail(`[${v.name}] did not exit 0 after SIGTERM (got ${code})`);
      else console.log(`SMOKE OK [${v.name}]: graceful shutdown`);
    } else {
      api.kill();
      await exited;
    }
    api = undefined;
  }
} finally {
  api?.kill();
  await db.stop().catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
process.exit(failed ? 1 : 0);
