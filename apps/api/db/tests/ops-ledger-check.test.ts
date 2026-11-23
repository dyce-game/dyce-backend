import { LedgerCheckRunner } from '../../src/ops/ledger-check.ts';
import { LedgerRepo } from '../../src/ledger/ledger.repo.ts';
import type { Alert } from '../../src/ops/alerts.ts';
import { createTestDb, type TestDb } from '../testing/testDb.ts';
import { expectPermissionDenied, fundedUser } from './helpers.ts';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

function runner(alerts: Alert[], freeze = true) {
  return new LedgerCheckRunner({
    pool: db.app,
    ledger: new LedgerRepo(db.app),
    alerts: { send: (a) => (alerts.push(a), Promise.resolve()) },
    log: { entry: () => undefined },
    freeze,
  });
}

describe('nightly ledger check (real database)', () => {
  it('records a clean run through the API role and raises no alert', async () => {
    await fundedUser(db);
    const alerts: Alert[] = [];
    expect(await runner(alerts).run()).toBe('clean');
    const rows = await db.admin.query('SELECT status, problem_count FROM ledger_check_runs');
    expect(rows.rows).toEqual([{ status: 'clean', problem_count: 0 }]);
    expect(alerts).toEqual([]);
  });

  it('finds a planted wallet mismatch, freezes Pool, alerts critically and records the run', async () => {
    const u = await fundedUser(db);
    await db.admin.query('UPDATE wallets SET balance_kobo = balance_kobo + 5 WHERE user_id = $1', [
      u.id,
    ]);
    const alerts: Alert[] = [];
    expect(await runner(alerts).run()).toBe('problems');
    expect(alerts[0]).toMatchObject({ severity: 'critical', title: 'LEDGER INVARIANT FAILED' });
    expect(alerts[0]!.body).toContain(u.id);

    const frozen = await db.admin.query('SELECT pool_frozen FROM profiles WHERE id = $1', [u.id]);
    expect(frozen.rows[0].pool_frozen).toBe(true);
    const run = await db.admin.query(
      "SELECT problem_count, frozen, detail FROM ledger_check_runs WHERE status = 'problems'",
    );
    expect(run.rows[0].frozen).toBe(true);
    expect(run.rows[0].detail[0]).toMatchObject({ problem: 'wallet_mismatch', ref: u.id });

    // repair so the rest of the file sees a clean ledger
    await db.admin.query('UPDATE wallets SET balance_kobo = balance_kobo - 5 WHERE user_id = $1', [
      u.id,
    ]);
  });

  it('only one runner at a time: a second concurrent run is skipped', async () => {
    const holder = await db.app.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(727002)');
      expect(await runner([]).run()).toBe('skipped');
    } finally {
      await holder.query('SELECT pg_advisory_unlock(727002)');
      holder.release();
    }
  });

  it('the history is append-only for the API role', async () => {
    await expectPermissionDenied(db.app.query("UPDATE ledger_check_runs SET status = 'clean'"));
    await expectPermissionDenied(db.app.query('DELETE FROM ledger_check_runs'));
  });

  it('rejects rows that contradict themselves (a "clean" run with problems)', async () => {
    await expect(
      db.admin.query("INSERT INTO ledger_check_runs (status, problem_count) VALUES ('clean', 2)"),
    ).rejects.toThrow(/check/i);
  });
});
