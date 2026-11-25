import type { LiveResultRow } from '@dyce/shared';
import type { Scheduler } from './live-match.ts';
import type { FinalOutcome, LiveMatchStore, LoadedMatch } from './store.ts';

/** Test support: time that only moves when the test says so, and a store that keeps everything in memory. */
export class FakeScheduler implements Scheduler {
  t = 1_000_000;
  private seq = 0;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  now = () => this.t;
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + ms, fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== h);
  }
  get pendingTimers(): number {
    return this.timers.length;
  }
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      await flush();
      const due = this.timers
        .filter((x) => x.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = target;
    await flush();
  }
}

export const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

export class MemoryStore implements LiveMatchStore {
  moves: { seq: number; userId: string | null; action: unknown }[] = [];
  /** Every state written alongside moves (turn games write one per move, party games one per batch). */
  saves = 0;
  lastState: unknown = null;
  forfeits: string[] = [];
  finished: { outcome: FinalOutcome; state: unknown }[] = [];
  failFinish = 0;
  failSave = 0;
  async load(): Promise<LoadedMatch | null> {
    return null;
  }
  async saveMove(m: {
    seq: number;
    userId: string;
    action: unknown;
    state: unknown;
  }): Promise<void> {
    this.moves.push({ seq: m.seq, userId: m.userId, action: m.action });
    this.saves += 1;
    this.lastState = m.state;
  }
  async saveMoves(m: {
    moves: { seq: number; userId: string | null; action: unknown }[];
    state: unknown;
  }): Promise<void> {
    if (this.failSave > 0) {
      this.failSave -= 1;
      throw new Error('db down');
    }
    this.moves.push(...m.moves);
    this.saves += 1;
    this.lastState = m.state;
  }
  async saveForfeits(_id: string, forfeited: string[]): Promise<void> {
    this.forfeits = [...forfeited];
  }
  async finish(_id: string, outcome: FinalOutcome, state: unknown): Promise<LiveResultRow[]> {
    if (this.failFinish > 0) {
      this.failFinish -= 1;
      throw new Error('db down');
    }
    this.finished.push({ outcome, state });
    return outcome.placements.flatMap((g, i) =>
      g.map((userId) => ({
        userId,
        placement: i + 1,
        result: outcome.forfeited.includes(userId)
          ? ('forfeit' as const)
          : outcome.draw
            ? ('draw' as const)
            : i === 0
              ? ('win' as const)
              : ('loss' as const),
        payoutKobo: null,
      })),
    );
  }
}
