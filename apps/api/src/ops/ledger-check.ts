import type pg from 'pg';
import { pingHeartbeat, type AlertSink } from './alerts.ts';

export type LedgerProblem = { problem: string; ref: string; detail: string };
export type LedgerCheckOutcome = 'clean' | 'problems' | 'error' | 'skipped';

type Logger = { entry(level: 'info' | 'warn' | 'error', fields: Record<string, unknown>): void };

export type LedgerCheckDeps = {
  pool: Pick<pg.Pool, 'connect' | 'query'>;
  ledger: { checkInvariants(freeze: boolean): Promise<LedgerProblem[]> };
  alerts: AlertSink;
  log: Logger;
  /** Freeze Pool for users whose cached balance disagrees with the ledger (ledger_check_invariants(true)). */
  freeze: boolean;
  /** Pinged after a CLEAN run only: the monitor alerts when pings stop (job not running, or not clean). */
  heartbeatUrl?: string | undefined;
  /** Reports to Sentry when configured; injected so this class stays testable. */
  report?: (message: string, extra: Record<string, unknown>) => void;
  fetchImpl?: typeof fetch;
};

/** Arbitrary constant: one API instance runs the check at a time (migrator uses 727001). */
const LOCK_KEY = 727_002;
const MAX_DETAIL_ROWS = 50;

/**
 * The nightly money check (BUILD_PLAN Phase 5 gate: "ledger invariant clean for 14 days"). Runs
 * `ledger_check_invariants`, records every run in `ledger_check_runs` (so the gate is auditable), and raises
 * a critical alert on any problem or if the check itself cannot run. Safe with several API instances: an
 * advisory lock lets only one of them run at a time.
 */
export class LedgerCheckRunner {
  constructor(private readonly deps: LedgerCheckDeps) {}

  async run(): Promise<LedgerCheckOutcome> {
    const { pool, log } = this.deps;
    const client = await pool.connect();
    try {
      // A TRANSACTION-scoped lock, held for the whole check: it is released by COMMIT or by the connection dying, and
      // it stays correct behind a transaction-mode connection pooler (a session lock would leak there).
      await client.query('BEGIN');
      const lock = await client.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_xact_lock($1) AS ok',
        [LOCK_KEY],
      );
      if (!lock.rows[0]?.ok) {
        log.entry('info', { msg: 'ledger check skipped: another instance is running it' });
        await client.query('ROLLBACK').catch(() => undefined);
        return 'skipped';
      }
      try {
        return await this.runLocked();
      } finally {
        await client.query('COMMIT').catch(() => undefined);
      }
    } finally {
      client.release();
    }
  }

  private async runLocked(): Promise<LedgerCheckOutcome> {
    const { ledger, alerts, log, freeze, report } = this.deps;
    let problems: LedgerProblem[];
    try {
      problems = await ledger.checkInvariants(freeze);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.entry('error', { msg: 'ledger check failed to run', error: message });
      await this.record('error', [], false, message);
      report?.('ledger invariant check could not run', { error: message });
      await alerts.send({
        severity: 'critical',
        title: 'ledger invariant check could not run',
        body: `No money check happened tonight. Error: ${message}. See docs/RUNBOOK.md "Money bugs".`,
      });
      return 'error';
    }

    if (problems.length === 0) {
      await this.record('clean', [], false, null);
      log.entry('info', { msg: 'ledger check clean' });
      await pingHeartbeat(
        this.deps.heartbeatUrl,
        (err) => log.entry('warn', { msg: 'heartbeat ping failed', error: String(err) }),
        this.deps.fetchImpl,
      );
      return 'clean';
    }

    const frozen = freeze && problems.some((p) => p.problem === 'wallet_mismatch');
    const kinds = countBy(problems.map((p) => p.problem));
    await this.record('problems', problems, frozen, null);
    log.entry('error', { msg: 'LEDGER INVARIANT FAILED', kinds, frozen });
    report?.('LEDGER INVARIANT FAILED', { kinds, frozen });
    await alerts.send({
      severity: 'critical',
      title: 'LEDGER INVARIANT FAILED',
      body:
        `${problems.length} problem(s): ${Object.entries(kinds)
          .map(([k, n]) => `${k} x${n}`)
          .join(', ')}. ` +
        (frozen ? 'Pool is frozen for affected users. ' : '') +
        `First refs: ${problems
          .slice(0, 5)
          .map((p) => `${p.problem}:${p.ref}`)
          .join(', ')}. Start docs/RUNBOOK.md "Money bugs" now.`,
    });
    return 'problems';
  }

  private async record(
    status: 'clean' | 'problems' | 'error',
    problems: LedgerProblem[],
    frozen: boolean,
    error: string | null,
  ): Promise<void> {
    try {
      await this.deps.pool.query(
        `INSERT INTO ledger_check_runs (status, problem_count, frozen, detail, error)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [
          status,
          problems.length,
          frozen,
          JSON.stringify(problems.slice(0, MAX_DETAIL_ROWS)),
          error,
        ],
      );
    } catch (err) {
      // The check result still reaches the alert; losing the audit row must not hide it.
      this.deps.log.entry('error', {
        msg: 'could not record ledger check run',
        error: String(err),
      });
    }
  }
}

function countBy(items: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[i] = (out[i] ?? 0) + 1;
  return out;
}
