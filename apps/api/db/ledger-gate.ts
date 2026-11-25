// Launch gate: "ledger invariant clean for 14 days" (Dyce/docs/BUILD_PLAN.md, Phase 5).
// Reads the audit rows the nightly job writes to `ledger_check_runs` and says whether the gate is met.
//
//   DATABASE_URL=postgres://... node db/ledger-gate.ts            (add --json for machines)
//   exit code 0 = gate met, 1 = not met, 2 = could not read
//
// Self-contained and written as erasable TypeScript so the production image can run it with plain `node`.
import { pathToFileURL } from 'node:url';
import { evaluateGate, type RunRow } from './ledger-gate-logic.ts';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url });
  try {
    const r = await pool.query<RunRow>(
      `SELECT ran_at, status, problem_count FROM ledger_check_runs
        WHERE ran_at > now() - interval '120 days' ORDER BY ran_at`,
    );
    const result = evaluateGate(r.rows, new Date());
    if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(
        `ledger gate: ${result.passed ? 'MET' : 'NOT MET'} (${result.cleanDays} of ${result.requiredDays} clean days, ` +
          `${result.cleanRunsInStreak} runs in streak, last run ${result.lastRunAt?.toISOString() ?? 'never'})`,
      );
      for (const reason of result.reasons) console.log(`  - ${reason}`);
    }
    process.exitCode = result.passed ? 0 : 1;
  } catch (err) {
    console.error(`could not read ledger_check_runs: ${(err as Error).message}`);
    process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
