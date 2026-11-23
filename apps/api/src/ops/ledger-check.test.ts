import { evaluateGate, type RunRow } from '../../db/ledger-gate-logic.ts';
import { WebhookAlerts, type Alert } from './alerts.ts';
import { LedgerCheckRunner, type LedgerProblem } from './ledger-check.ts';

function setup(opts: {
  problems?: LedgerProblem[];
  throws?: Error;
  lock?: boolean;
  freeze?: boolean;
  heartbeatUrl?: string;
}) {
  const alerts: Alert[] = [];
  const inserts: unknown[][] = [];
  const reports: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const heartbeats: string[] = [];
  const client = {
    query: jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes('pg_try_advisory_xact_lock')
          ? { rows: [{ ok: opts.lock ?? true }] }
          : { rows: [] },
      ),
    ),
    release: jest.fn(),
  };
  const pool = {
    connect: () => Promise.resolve(client),
    query: jest.fn((_sql: string, params: unknown[]) => {
      inserts.push(params);
      return Promise.resolve({ rows: [] });
    }),
  };
  const checkInvariants = jest.fn((_freeze: boolean) =>
    opts.throws ? Promise.reject(opts.throws) : Promise.resolve(opts.problems ?? []),
  );
  const runner = new LedgerCheckRunner({
    pool: pool as never,
    ledger: { checkInvariants },
    alerts: { send: (a) => (alerts.push(a), Promise.resolve()) },
    log: { entry: (_l, f) => void logs.push(f) },
    freeze: opts.freeze ?? true,
    heartbeatUrl: opts.heartbeatUrl,
    report: (m) => void reports.push(m),
    fetchImpl: ((url: string) => (
      heartbeats.push(url),
      Promise.resolve(new Response('ok'))
    )) as never,
  });
  return { runner, alerts, inserts, reports, client, checkInvariants, logs, heartbeats };
}

describe('LedgerCheckRunner', () => {
  it('records a clean run and pings the heartbeat, with no alert', async () => {
    const t = setup({ heartbeatUrl: 'https://hc.example/ping/abc' });
    expect(await t.runner.run()).toBe('clean');
    expect(t.inserts[0]![0]).toBe('clean');
    expect(t.alerts).toEqual([]);
    expect(t.heartbeats).toEqual(['https://hc.example/ping/abc']);
    expect(t.client.release).toHaveBeenCalled();
  });

  it('alerts critically, reports, records and does NOT ping the heartbeat on a problem', async () => {
    const t = setup({
      problems: [{ problem: 'wallet_mismatch', ref: 'u-1', detail: 'cached=1 ledger=2' }],
      heartbeatUrl: 'https://hc.example/ping/abc',
    });
    expect(await t.runner.run()).toBe('problems');
    expect(t.inserts[0]).toEqual(['problems', 1, true, expect.any(String), null]);
    expect(t.alerts[0]).toMatchObject({ severity: 'critical', title: 'LEDGER INVARIANT FAILED' });
    expect(t.alerts[0]!.body).toContain('wallet_mismatch x1');
    expect(t.reports).toEqual(['LEDGER INVARIANT FAILED']);
    expect(t.heartbeats).toEqual([]);
    expect(t.checkInvariants).toHaveBeenCalledWith(true);
  });

  it('treats a check that cannot run as critical too (no check means no gate)', async () => {
    const t = setup({ throws: new Error('connection refused') });
    expect(await t.runner.run()).toBe('error');
    expect(t.inserts[0]![0]).toBe('error');
    expect(t.alerts[0]).toMatchObject({ severity: 'critical' });
  });

  it('skips quietly when another instance holds the lock', async () => {
    const t = setup({ lock: false });
    expect(await t.runner.run()).toBe('skipped');
    expect(t.checkInvariants).not.toHaveBeenCalled();
    expect(t.alerts).toEqual([]);
  });
});

describe('WebhookAlerts', () => {
  it('posts redacted text and never throws', async () => {
    const bodies: string[] = [];
    const errors: unknown[] = [];
    const ok = new WebhookAlerts('https://hooks.example/x', {
      service: 'dyce-api',
      environment: 'production',
      fetchImpl: ((_u: string, init: RequestInit) => (
        bodies.push(String(init.body)),
        Promise.resolve(new Response('ok'))
      )) as never,
    });
    await ok.send({ severity: 'critical', title: 'boom', body: 'user +2348031234567' });
    expect(bodies[0]).toContain('[CRITICAL] dyce-api/production: boom');
    expect(bodies[0]).not.toContain('2348031234567');

    const failing = new WebhookAlerts('https://hooks.example/x', {
      service: 's',
      environment: 'e',
      onError: (e) => void errors.push(e),
      fetchImpl: (() => Promise.reject(new Error('network down'))) as never,
    });
    await expect(failing.send({ severity: 'info', title: 't' })).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});

describe('evaluateGate', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = new Date('2026-12-20T03:00:00Z');
  const nightly = (n: number, status: RunRow['status'] = 'clean'): RunRow[] =>
    Array.from({ length: n }, (_, i) => ({
      ran_at: new Date(now.getTime() - (n - 1 - i) * day - 30 * 60 * 1000),
      status,
      problem_count: status === 'clean' ? 0 : 1,
    }));

  it('passes after 14 days of nightly clean runs, fails before', () => {
    expect(evaluateGate(nightly(15), now).passed).toBe(true);
    const short = evaluateGate(nightly(10), now);
    expect(short.passed).toBe(false);
    expect(short.reasons.join()).toContain('14 required');
  });

  it('is broken by any problem run', () => {
    const runs = nightly(20);
    runs[10] = { ...runs[10]!, status: 'problems', problem_count: 2 };
    const r = evaluateGate(runs, now);
    expect(r.passed).toBe(false);
    expect(r.cleanRunsInStreak).toBe(9);
  });

  it('is broken by a missed night (a hole in the record is not clean)', () => {
    const runs = nightly(20).filter((_, i) => i !== 8 && i !== 9);
    expect(evaluateGate(runs, now).passed).toBe(false);
  });

  it('fails when the job has stopped, or never ran', () => {
    const stale = nightly(20).map((r) => ({
      ...r,
      ran_at: new Date(r.ran_at.getTime() - 3 * day),
    }));
    expect(evaluateGate(stale, now).reasons.join()).toContain('job has stopped');
    expect(evaluateGate([], now).reasons.join()).toContain('never run');
  });
});
