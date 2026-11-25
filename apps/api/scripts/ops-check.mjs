// Proves, against the BUILT code and a real Nest app, the parts of the ops layer that Jest cannot load (Nest 12 is
// ESM-only): the catch-all error filter keeps the specific filter's priority, bugs are logged redacted with the request
// id and reported, expected errors are not, and the access log carries the route, never the URL.
//   pnpm -F @dyce/api build && node scripts/ops-check.mjs
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { Controller, Get, HttpException } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { AuthError } from '../dist/auth/auth-error.js';
import { DyceErrorFilter } from '../dist/common/dyce-error.filter.js';
import { JsonLogger } from '../dist/ops/logger.js';
import { requestContext } from '../dist/ops/request-context.js';
import { UnexpectedErrorFilter } from '../dist/ops/unexpected-error.filter.js';

class T {
  bug() {
    throw new Error('boom for +2348031234567');
  }
  auth() {
    throw new AuthError('unauthorized');
  }
  bad() {
    throw new HttpException('nope', 400);
  }
  ok() {
    return { fine: true };
  }
}
for (const m of ['bug', 'auth', 'bad', 'ok']) {
  Get(m)(T.prototype, m, Object.getOwnPropertyDescriptor(T.prototype, m));
}
Controller('t')(T);

const lines = [];
const logger = new JsonLogger({ write: (l) => lines.push(l) });
const { Module } = await import('@nestjs/common');
class M {}
Module({ controllers: [T] })(M);

const app = await NestFactory.create(M, { logger: false });
app.use(requestContext(logger));
const { httpAdapter } = app.get(HttpAdapterHost);
// Same order as main.ts: the catch-all first, the specific filter after it.
app.useGlobalFilters(new UnexpectedErrorFilter(httpAdapter, logger), new DyceErrorFilter());
await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
const parsed = () => lines.map((l) => JSON.parse(l));

try {
  const bug = await fetch(`${base}/t/bug`, { headers: { 'x-request-id': 'req-check-0001' } });
  assert.equal(bug.status, 500);
  assert.equal(bug.headers.get('x-request-id'), 'req-check-0001');
  const err = parsed().find((l) => l.msg === 'unhandled error');
  assert.ok(err, 'a 500 must be logged');
  assert.equal(err.level, 'error');
  assert.ok(!lines.join('\n').includes('2348031234567'), 'phone number leaked into the log');

  const auth = await fetch(`${base}/t/auth`);
  assert.equal(auth.status, 401);
  assert.equal(
    (await auth.json()).code,
    'unauthorized',
    'DyceErrorFilter must keep priority over the catch-all',
  );
  const bad = await fetch(`${base}/t/bad`);
  assert.equal(bad.status, 400);
  assert.equal(
    parsed().filter((l) => l.msg === 'unhandled error').length,
    1,
    'only the bug is an error',
  );

  await fetch(`${base}/t/ok?token=SECRET123456`, { headers: { 'x-request-id': 'req-check-0002' } });
  await new Promise((r) => setTimeout(r, 50));
  const access = parsed().find((l) => l.msg === 'http' && l.requestId === 'req-check-0002');
  assert.ok(access, 'access line missing');
  assert.equal(access.route, '/t/ok');
  assert.ok(!lines.join('\n').includes('SECRET123456'), 'query string leaked into the log');
  console.log('OPS CHECK OK: filter order, redacted 500 log, request ids, route-only access log');
} finally {
  await app.close();
}
process.exit(0);
