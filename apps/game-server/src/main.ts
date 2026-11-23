import pg from 'pg';
import { z } from 'zod';
import { captureException, flushSentry, initSentry, makeLogger, redactConsole } from './ops.ts';
import { createGameServer } from './server.ts';

const optionalInt = (def: number) => z.coerce.number().int().positive().default(def);

// Logging and error reporting come up before configuration is validated, so a bad config is logged and reported.
const logger = makeLogger(process.env);
redactConsole();

process.on('unhandledRejection', (reason) => {
  logger.entry('error', { msg: 'unhandled rejection', error: reason });
  captureException(reason);
});
process.on('uncaughtException', (err) => {
  logger.entry('error', { msg: 'uncaught exception', error: err });
  captureException(err);
  void flushSentry().finally(() => process.exit(1));
});

const sentryOn = await initSentry(process.env);
logger.entry('info', { msg: 'starting', sentry: sentryOn ? 'on' : 'off' });

const parsed = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(2567),
    DATABASE_URL: z.string().min(1),
    JWT_SECRET: z.string().min(32),
    INTERNAL_SECRET: z.string().min(32),
    /** How long a seat may be offline before it forfeits (SPEC: 60 s). */
    RECONNECT_SECONDS: optionalInt(60),
    /** How long seats have to connect after a room is created. */
    JOIN_GRACE_SECONDS: optionalInt(90),
    /** On SIGTERM: answer 503 on /health/ready and refuse new rooms for this long before closing. */
    SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(0).max(60_000).default(0),
    /** Hard stop: exit even if graceful shutdown has not finished. */
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(25_000),
  })
  .safeParse(process.env);
if (!parsed.success) {
  const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  logger.entry('error', { msg: 'failed to start', error: `Invalid environment: ${problems}` });
  await flushSentry();
  process.exit(1);
}
const env = parsed.data;

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });
let draining = false;
const server = createGameServer({
  pool,
  jwtSecret: env.JWT_SECRET,
  internalSecret: env.INTERNAL_SECRET,
  options: {
    reconnectMs: env.RECONNECT_SECONDS * 1000,
    joinGraceMs: env.JOIN_GRACE_SECONDS * 1000,
  },
  isReady: () => !draining,
  log: (msg, extra) => {
    logger.legacy(msg, extra);
    if (extra instanceof Error) captureException(extra);
  },
});

const port = await server.listen(env.PORT);
logger.entry('info', { msg: `dyce-game-server listening on :${port}`, port });

/**
 * SIGTERM -> readiness flips to "draining" (the API stops sending rooms here) -> wait SHUTDOWN_DRAIN_MS -> close.
 * Match state is saved after every move, so closing loses no moves; open rooms are re-created from the database when
 * the API next asks, and each seat's reconnect clock starts over (docs/RUNBOOK.md "Game-server restarts").
 */
let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.entry('info', { msg: 'shutting down', signal, drainMs: env.SHUTDOWN_DRAIN_MS });
  setTimeout(() => {
    logger.entry('error', { msg: 'graceful shutdown timed out; exiting' });
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS).unref();
  draining = true;
  if (env.SHUTDOWN_DRAIN_MS > 0) await new Promise((r) => setTimeout(r, env.SHUTDOWN_DRAIN_MS));
  await server.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
  await flushSentry();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
