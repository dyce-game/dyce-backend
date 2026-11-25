// Usage: DATABASE_URL=postgres://... pnpm -F @dyce/api db:migrate
//
// Migrations need the OWNER role, the running API must not have it. Where both are set (a production machine has the
// API's DATABASE_URL and the owner's MIGRATION_DATABASE_URL as secrets) MIGRATION_DATABASE_URL wins, so
// `node db/migrate.ts` is the same command everywhere, including Fly's release_command (apps/api/fly.staging.toml).
import pg from 'pg';
import { migrate } from './migrator.ts';

const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL or DATABASE_URL is required');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url });
try {
  const { applied, skipped } = await migrate(pool);
  console.log(`migrations: ${applied.length} applied, ${skipped.length} already up to date`);
  for (const f of applied) console.log(`  + ${f}`);
} finally {
  await pool.end();
}
