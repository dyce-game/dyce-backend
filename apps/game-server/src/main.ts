import pg from 'pg';
import { z } from 'zod';
import { createGameServer } from './server.ts';

const optionalInt = (def: number) => z.coerce.number().int().positive().default(def);

const env = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(2567),
    DATABASE_URL: z.string().min(1),
    JWT_SECRET: z.string().min(32),
    INTERNAL_SECRET: z.string().min(32),
    /** How long a seat may be offline before it forfeits (SPEC: 60 s). */
    RECONNECT_SECONDS: optionalInt(60),
    /** How long seats have to connect after a room is created. */
    JOIN_GRACE_SECONDS: optionalInt(90),
  })
  .parse(process.env);

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });
const server = createGameServer({
  pool,
  jwtSecret: env.JWT_SECRET,
  internalSecret: env.INTERNAL_SECRET,
  options: {
    reconnectMs: env.RECONNECT_SECONDS * 1000,
    joinGraceMs: env.JOIN_GRACE_SECONDS * 1000,
  },
});

const port = await server.listen(env.PORT);
console.log(`dyce-game-server listening on :${port}`);

async function shutdown(): Promise<void> {
  await server.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
