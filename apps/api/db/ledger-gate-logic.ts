// Pure launch-gate logic: "ledger invariant clean for 14 days" (Dyce/docs/BUILD_PLAN.md, Phase 5).
// Kept apart from the CLI (ledger-gate.ts) so tests can import it without `import.meta`.
// Erasable TypeScript only: the production image runs these files with plain `node`.

export type RunRow = {
  ran_at: Date;
  status: 'clean' | 'problems' | 'error';
  problem_count: number;
};

export type GateResult = {
  passed: boolean;
  requiredDays: number;
  /** Start of the current unbroken clean streak, or null if there is none. */
  cleanSince: Date | null;
  cleanDays: number;
  cleanRunsInStreak: number;
  lastRunAt: Date | null;
  reasons: string[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The streak is broken by any run that is not clean, and by a hole in the record: no run for more than
 * `maxGapHours` means the job was not running, and nothing was being checked. The gate also fails if the
 * latest run is older than that (the job has stopped).
 */
export function evaluateGate(
  runs: readonly RunRow[],
  now: Date,
  requiredDays = 14,
  maxGapHours = 36,
): GateResult {
  const maxGap = maxGapHours * 60 * 60 * 1000;
  const sorted = [...runs].sort((a, b) => a.ran_at.getTime() - b.ran_at.getTime());
  const reasons: string[] = [];
  const last = sorted[sorted.length - 1] ?? null;

  let streak: RunRow[] = [];
  for (const run of sorted) {
    if (run.status !== 'clean') {
      streak = [];
      continue;
    }
    const prev = streak[streak.length - 1];
    if (prev && run.ran_at.getTime() - prev.ran_at.getTime() > maxGap) streak = [];
    streak.push(run);
  }

  const cleanSince = streak[0]?.ran_at ?? null;
  const cleanDays = cleanSince ? (now.getTime() - cleanSince.getTime()) / DAY_MS : 0;

  if (!last) reasons.push('no runs recorded: the nightly job has never run');
  else {
    if (last.status !== 'clean')
      reasons.push(`latest run (${last.ran_at.toISOString()}) is ${last.status}`);
    if (now.getTime() - last.ran_at.getTime() > maxGap)
      reasons.push(`latest run is older than ${maxGapHours}h: the job has stopped`);
  }
  if (cleanDays < requiredDays)
    reasons.push(`clean streak is ${cleanDays.toFixed(1)} days, ${requiredDays} required`);

  return {
    passed: reasons.length === 0,
    requiredDays,
    cleanSince,
    cleanDays: Math.round(cleanDays * 10) / 10,
    cleanRunsInStreak: streak.length,
    lastRunAt: last?.ran_at ?? null,
    reasons,
  };
}
