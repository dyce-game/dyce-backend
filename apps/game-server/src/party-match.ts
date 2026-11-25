import { MAX_TICK_MS, ROOM_ACTOR, cleanChatText, isRoomOnlyAction } from '@dyce/games';
import type { PartyGame } from '@dyce/games';
import type { LiveChat, LiveResultRow, LiveSeat, LiveState } from '@dyce/shared';
import {
  DEFAULT_OPTIONS,
  type LiveMatchOptions,
  type MoveResult,
  type PartyOptions,
  type Scheduler,
} from './live-match.ts';
import { computeOutcome } from './outcome.ts';
import type { FinalOutcome, LiveMatchStore, LoadedMatch } from './store.ts';

export const DEFAULT_PARTY_OPTIONS: PartyOptions = {
  tickMs: 1000,
  skipDelayMs: 250,
  streamFlushMs: 1500,
  streamBroadcastMs: 150,
  chatGapMs: 600,
  actionBurst: 30,
  actionPerSecond: 15,
};

/** What the room does with what a party match produces. All per seat: nothing is broadcast as one blob. */
export type PartyEvents = {
  /** A seat's own state changed (already de-duplicated: only sent when something that seat sees differs). */
  state(userId: string, state: LiveState): void;
  chat(userId: string, chat: LiveChat): void;
  /** Games with a streamed part (the Doodle canvas): what this seat is missing of it, never the whole again. */
  stream(userId: string, message: unknown): void;
  /** The match finished and settled (the room starts closing the table). */
  finished(match: PartyMatch): void;
};

type PendingMove = { seq: number; userId: string | null; action: unknown };
type ChatEntry = { msg: LiveChat; audience: ReadonlySet<string> };

const CHAT_KEEP = 60;
const CHAT_HISTORY = 40;

/** JSON of `value` with the clock fields (`timeLeftMs`, `seq`) zeroed at the top level only. */
function withoutClock(value: unknown): string {
  const root = value;
  return JSON.stringify(value, function (this: unknown, k: string, v: unknown) {
    return this === root && (k === 'timeLeftMs' || k === 'seq') ? 0 : v;
  });
}

const phaseOf = (state: unknown): unknown => (state as { phase?: unknown }).phase;
const timeLeftOf = (state: unknown): number => {
  const t = (state as { timeLeftMs?: unknown }).timeLeftMs;
  return typeof t === 'number' && t > 0 ? t : 0;
};

/**
 * One running party match (Imposter, Werewolf, Charades, Doodle Guess): phases with timers, many people
 * acting at once. Like `LiveMatch` it has no network or clock of its own, the room feeds it moves and
 * connection changes and the scheduler is injected.
 *
 * - **Time.** The engines read no clock. This class sends them `{ kind: 'tick', ms }` as `ROOM_ACTOR` for
 *   the real time that passed (every `tickMs`, or in 250 ms steps while the clock is only waiting for seats
 *   that left). A seat can never send a tick.
 * - **Starting.** Clocks stay stopped until every seat has connected once; seats that never show up within
 *   the join grace forfeit and the game starts without them.
 * - **Who sees what.** `stateFor` is the engine's own `view()` for that seat. A seat is only sent a new
 *   state when something it can see changed (the countdown is not a change: clients count down from
 *   `turnDeadlineAt`), and streams (Doodle strokes) are sent at most every `streamBroadcastMs`.
 * - **Persistence.** Every player action is a `match_moves` row and the new state is saved with it in one
 *   transaction before anyone is told. A tick is saved only when it changed something (a phase ended, a
 *   silent seat was filled in); a tick that only moved a clock is not. Streams (strokes) are batched into
 *   one transaction every `streamFlushMs`, so a crash can lose a second or two of a drawing, never a vote.
 * - **Leaving.** A seat that leaves (or is gone for the reconnect window) forfeits: it ranks last and never
 *   takes money. The engine is not told; its timers fill in what the seat would have done, and when the
 *   clock is only waiting on forfeited seats it is run forward quickly. One player left wins at once.
 * - **Money** is never touched here: `store.finish` calls `settle_match` (see PgLiveMatchStore).
 */
export class PartyMatch {
  state: unknown;
  version: number;
  status: 'live' | 'finished' = 'live';
  results: LiveResultRow[] | null = null;

  private readonly p: PartyOptions;
  private readonly seats: { userId: string; seat: number }[];
  private readonly forfeited: string[];
  private readonly connected = new Set<string>();
  private readonly everConnected = new Set<string>();
  private readonly dropTimers = new Map<string, unknown>();
  private readonly lastSent = new Map<string, string>();
  private readonly cursors = new Map<string, unknown>();
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly lastChatAt = new Map<string, number>();
  private readonly chatLog: ChatEntry[] = [];
  private chatSeq = 0;
  private pending: PendingMove[] = [];
  private flushTimer: unknown = null;
  private broadcastTimer: unknown = null;
  private tickTimer: unknown = null;
  private tickSkip = false;
  private lastTickAt = 0;
  private gate = false;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private finishing = false;

  constructor(
    private readonly loaded: LoadedMatch,
    private readonly game: PartyGame,
    private readonly store: LiveMatchStore,
    private readonly sched: Scheduler,
    private readonly events: PartyEvents,
    private readonly opts: LiveMatchOptions = DEFAULT_OPTIONS,
    private readonly onError: (err: unknown) => void = () => undefined,
  ) {
    this.state = loaded.state;
    this.version = loaded.version;
    this.seats = loaded.players;
    this.forfeited = [...loaded.forfeited];
    this.p = { ...DEFAULT_PARTY_OPTIONS, tickMs: game.tickMs, ...opts.party };
  }

  get matchId(): string {
    return this.loaded.matchId;
  }
  get spaceId(): string {
    return this.loaded.spaceId;
  }
  get mode(): 'free' | 'pool' {
    return this.loaded.mode;
  }
  /** True once every seat has arrived (or been given up on) and the game clocks are running. */
  get running(): boolean {
    return this.gate;
  }
  hasSeat(userId: string): boolean {
    return this.seats.some((s) => s.userId === userId);
  }

  /** Starts the join grace for absent seats; the clocks start when everyone is here. */
  start(): void {
    if (this.game.engine.isTerminal(this.state)) {
      // Recovering a match that ended but was never settled (the server went down in between).
      this.fire(() => this.finishLocked());
      return;
    }
    for (const s of this.seats) {
      if (!this.isForfeited(s.userId) && !this.connected.has(s.userId)) {
        this.armDrop(s.userId, this.opts.joinGraceMs);
      }
    }
    this.openGateIfReady();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
    for (const h of this.dropTimers.values()) this.sched.clearTimeout(h);
    this.dropTimers.clear();
  }

  // ---- connections ----------------------------------------------------------------------------

  setConnected(userId: string, connected: boolean): void {
    if (!this.hasSeat(userId)) return;
    const drop = this.dropTimers.get(userId);
    if (drop !== undefined) {
      this.sched.clearTimeout(drop);
      this.dropTimers.delete(userId);
    }
    if (connected) {
      this.connected.add(userId);
      this.everConnected.add(userId);
      this.lastSent.delete(userId); // a fresh connection always gets a full state
      this.cursors.delete(userId); // and the whole canvas
    } else {
      this.connected.delete(userId);
      if (this.status === 'live' && !this.isForfeited(userId)) {
        this.armDrop(userId, this.opts.reconnectMs);
      }
    }
    this.openGateIfReady();
    this.sendChanged();
  }

  forfeit(userId: string): Promise<void> {
    return this.enqueue(() => this.forfeitLocked(userId));
  }

  // ---- moves ----------------------------------------------------------------------------------

  /** `expectedVersion` is ignored: several seats act at once, so "the version you saw" cannot be required. */
  submit(
    userId: string,
    _expectedVersion: number | undefined,
    action: unknown,
  ): Promise<MoveResult> {
    return this.enqueue(async () => {
      if (this.status !== 'live') return { ok: false, code: 'not_running' } as const;
      if (!this.hasSeat(userId)) return { ok: false, code: 'not_seated' } as const;
      if (this.isForfeited(userId)) return { ok: false, code: 'forfeited' } as const;
      if (!this.gate) return { ok: false, code: 'waiting' } as const;
      if (!this.takeToken(userId)) return { ok: false, code: 'rate_limited' } as const;
      const { engine } = this.game;
      const schema = engine.actionSchema;
      let parsed = action;
      if (schema) {
        const r = schema.safeParse(action);
        if (!r.success) return { ok: false, code: 'invalid_action' } as const;
        parsed = r.data;
      }
      // The clock belongs to the room: a seat can never send a tick.
      if (typeof parsed !== 'object' || parsed === null) {
        return { ok: false, code: 'invalid_action' } as const;
      }
      if (isRoomOnlyAction(parsed as { kind: string })) {
        return { ok: false, code: 'invalid_action' } as const;
      }
      if (!engine.currentPlayers(this.state).includes(userId)) {
        return { ok: false, code: 'not_your_turn' } as const;
      }
      const verdict = engine.validate(this.state, userId, parsed);
      if (!verdict.ok) return { ok: false, code: 'illegal_move', reason: verdict.code } as const;
      await this.applyLocked(userId, parsed);
      return { ok: true } as const;
    });
  }

  /** A line of table talk for the people the game lets this seat talk to right now. */
  chat(userId: string, raw: string): MoveResult {
    if (!this.hasSeat(userId)) return { ok: false, code: 'not_seated' };
    if (this.isForfeited(userId)) return { ok: false, code: 'forfeited' };
    const now = this.sched.now();
    const last = this.lastChatAt.get(userId) ?? 0;
    if (now - last < this.p.chatGapMs) return { ok: false, code: 'rate_limited' };
    const text = cleanChatText(typeof raw === 'string' ? raw : '');
    if (text === null) return { ok: false, code: 'invalid_action' };
    const audience = this.game.chatAudience(this.state, userId);
    if (audience === null) return { ok: false, code: 'chat_closed' };
    this.lastChatAt.set(userId, now);
    const msg: LiveChat = { id: ++this.chatSeq, userId, text, at: now };
    const set = new Set([...audience, userId]);
    this.chatLog.push({ msg, audience: set });
    if (this.chatLog.length > CHAT_KEEP) this.chatLog.splice(0, this.chatLog.length - CHAT_KEEP);
    for (const u of set) if (this.connected.has(u)) this.events.chat(u, msg);
    return { ok: true };
  }

  /** The recent lines this seat was allowed to hear, for a seat that just (re)connected. */
  chatHistoryFor(userId: string): LiveChat[] {
    return this.chatLog
      .filter((e) => e.audience.has(userId))
      .slice(-CHAT_HISTORY)
      .map((e) => e.msg);
  }

  // ---- what clients see -----------------------------------------------------------------------

  seatsView(): LiveSeat[] {
    return this.seats.map((s) => ({
      userId: s.userId,
      seat: s.seat,
      connected: this.connected.has(s.userId),
      forfeited: this.isForfeited(s.userId),
    }));
  }

  /** What `userId` sees right now: the engine's own view, never the raw state. */
  stateFor(userId: string): LiveState {
    const live = this.status === 'live';
    const running = live && this.gate;
    const now = this.sched.now();
    return {
      matchId: this.loaded.matchId,
      spaceId: this.loaded.spaceId,
      gameSlug: this.loaded.gameSlug,
      mode: this.loaded.mode,
      version: this.version,
      status: this.status,
      view: this.game.engine.view(this.state, userId),
      seats: this.seatsView(),
      // Whose turn it is would give roles away (Werewolf night): party rooms never say.
      turnUserId: null,
      turnDeadlineAt: running ? now + timeLeftOf(this.state) : null,
      roomKind: 'party',
      canAct:
        running &&
        !this.isForfeited(userId) &&
        this.game.engine.currentPlayers(this.state).includes(userId),
      waiting: live && !this.gate,
      serverNow: now,
      results: this.results,
    };
  }

  /** Sends `userId` its state now (a join, a sync, after a refusal), whether or not it changed. */
  sendState(userId: string): void {
    this.sendTo(userId, true);
  }

  /** Resolves when everything queued so far has run (tests, shutdown). */
  idle(): Promise<void> {
    return this.queue.then(
      () => undefined,
      () => undefined,
    );
  }

  // ---- internals ------------------------------------------------------------------------------

  private isForfeited(userId: string): boolean {
    return this.forfeited.includes(userId);
  }

  private activeCount(): number {
    return this.seats.filter((s) => !this.isForfeited(s.userId)).length;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private fire(fn: () => Promise<void>): void {
    this.enqueue(fn).catch((err: unknown) => this.onError(err));
  }

  /** A seat may send `actionBurst` actions at once and earns `actionPerSecond` more every second. */
  private takeToken(userId: string): boolean {
    const now = this.sched.now();
    const b = this.buckets.get(userId) ?? { tokens: this.p.actionBurst, at: now };
    b.tokens = Math.min(
      this.p.actionBurst,
      b.tokens + ((now - b.at) / 1000) * this.p.actionPerSecond,
    );
    b.at = now;
    this.buckets.set(userId, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private armDrop(userId: string, ms: number): void {
    const old = this.dropTimers.get(userId);
    if (old !== undefined) this.sched.clearTimeout(old);
    this.dropTimers.set(
      userId,
      this.sched.setTimeout(() => {
        this.dropTimers.delete(userId);
        this.fire(() => this.forfeitLocked(userId));
      }, ms),
    );
  }

  private clearTimers(): void {
    for (const h of [this.tickTimer, this.flushTimer, this.broadcastTimer]) {
      if (h !== null) this.sched.clearTimeout(h);
    }
    this.tickTimer = this.flushTimer = this.broadcastTimer = null;
  }

  /** The clocks start once every seat that is still in has connected at least once. */
  private openGateIfReady(): void {
    if (this.gate || this.disposed || this.status !== 'live') return;
    if (this.game.engine.isTerminal(this.state)) return;
    const missing = this.seats.some(
      (s) => !this.isForfeited(s.userId) && !this.everConnected.has(s.userId),
    );
    if (missing) return;
    this.gate = true;
    this.lastTickAt = this.sched.now();
    this.scheduleTick();
    this.sendChanged();
  }

  /** The seats the clock is waiting for have all left: run it forward instead of making the others wait. */
  private skippable(): boolean {
    const blockers = this.game.blockers(this.state);
    return blockers.length > 0 && blockers.every((p) => this.isForfeited(p));
  }

  private scheduleTick(): void {
    if (this.disposed || this.status !== 'live' || !this.gate) return;
    if (this.game.engine.isTerminal(this.state)) return;
    if (this.tickTimer !== null) this.sched.clearTimeout(this.tickTimer);
    this.tickSkip = this.skippable();
    const delay = this.tickSkip ? this.p.skipDelayMs : this.p.tickMs;
    this.tickTimer = this.sched.setTimeout(() => {
      this.tickTimer = null;
      this.enqueue(async () => {
        try {
          await this.tickLocked();
        } finally {
          this.scheduleTick();
        }
      }).catch((err: unknown) => this.onError(err));
    }, delay);
  }

  /** After a change that may have started or ended a skip-ahead, switch the tick pace without starving it. */
  private rearmIfPaceChanged(): void {
    if (this.tickTimer !== null && this.skippable() !== this.tickSkip) this.scheduleTick();
  }

  /** Feeds the engine the real time that passed since the last tick. */
  private async tickLocked(): Promise<void> {
    if (this.disposed || this.status !== 'live' || !this.gate) return;
    const { engine } = this.game;
    if (engine.isTerminal(this.state)) return;
    const now = this.sched.now();
    const skip = this.skippable();
    let ms = skip
      ? Math.max(1, Math.min(MAX_TICK_MS, timeLeftOf(this.state)))
      : now - this.lastTickAt;
    this.lastTickAt = now;
    if (ms < 1) return;

    const before = this.state;
    let next = before;
    let applied = 0;
    while (ms > 0 && !engine.isTerminal(next)) {
      const slice = Math.min(ms, MAX_TICK_MS);
      const tick = { kind: 'tick', ms: slice };
      if (!engine.validate(next, ROOM_ACTOR, tick).ok) break;
      next = engine.apply(next, ROOM_ACTOR, tick);
      applied += slice;
      ms -= slice;
    }
    if (next === before) return;

    const over = engine.isTerminal(next);
    if (!over && withoutClock(next) === withoutClock(before)) {
      // Only a clock moved (and perhaps a Doodle hint appeared): nothing to save.
      this.state = next;
      this.sendChanged();
      return;
    }
    const seq = this.version + 1;
    await this.store.saveMoves({
      matchId: this.loaded.matchId,
      moves: [...this.pending, { seq, userId: null, action: { kind: 'tick', ms: applied } }],
      state: next,
    });
    this.state = next;
    this.version = seq;
    this.pending = [];
    this.clearFlush();
    this.afterChange();
    if (over) await this.finishLocked();
  }

  /** A seat's action: engine, then persist, then tell people (streams are batched instead). */
  private async applyLocked(by: string, action: unknown): Promise<void> {
    const { engine } = this.game;
    const prev = this.state;
    const next = engine.apply(prev, by, action);
    const seq = this.version + 1;
    const move: PendingMove = { seq, userId: by, action };
    const over = engine.isTerminal(next);

    if (this.game.streamy(action) && !over) {
      this.state = next;
      this.version = seq;
      this.pending.push(move);
      this.armFlush();
      this.armBroadcast();
      return;
    }
    await this.store.saveMoves({
      matchId: this.loaded.matchId,
      moves: [...this.pending, move],
      state: next,
    });
    this.state = next;
    this.version = seq;
    this.pending = [];
    this.clearFlush();
    if (phaseOf(prev) !== phaseOf(next)) this.lastTickAt = this.sched.now();
    this.afterChange();
    if (over) await this.finishLocked();
  }

  private afterChange(): void {
    this.clearBroadcast();
    this.sendChanged();
    this.rearmIfPaceChanged();
  }

  private armFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = this.sched.setTimeout(() => {
      this.flushTimer = null;
      this.fire(() => this.flushLocked());
    }, this.p.streamFlushMs);
  }

  private clearFlush(): void {
    if (this.flushTimer !== null) this.sched.clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  /** Writes the batched stream moves. A failure leaves them queued for the next flush. */
  private async flushLocked(): Promise<void> {
    if (this.pending.length === 0 || this.status !== 'live') return;
    const moves = this.pending;
    await this.store.saveMoves({ matchId: this.loaded.matchId, moves, state: this.state });
    this.pending = this.pending.filter((m) => m.seq > moves[moves.length - 1]!.seq);
  }

  private armBroadcast(): void {
    if (this.broadcastTimer !== null) return;
    this.broadcastTimer = this.sched.setTimeout(() => {
      this.broadcastTimer = null;
      this.sendChanged();
    }, this.p.streamBroadcastMs);
  }

  private clearBroadcast(): void {
    if (this.broadcastTimer !== null) this.sched.clearTimeout(this.broadcastTimer);
    this.broadcastTimer = null;
  }

  /** Tells every connected seat whose view differs from what it last got. */
  private sendChanged(): void {
    for (const userId of this.connected) this.sendTo(userId, false);
  }

  /**
   * Sends `userId` what changed for it. A streamed part of the view (the Doodle canvas) is taken out of the
   * `state` (so a stroke never re-sends the whole drawing) and goes in its own message, as the difference
   * from what this seat last got.
   */
  private sendTo(userId: string, force: boolean): void {
    if (this.disposed) return;
    const s = this.stateFor(userId);
    const stream = this.game.stream;
    let streamed: unknown = null;
    if (stream) {
      const split = stream.split(s.view);
      s.view = split.rest;
      streamed = split.stream;
    }
    const { view, ...rest } = s;
    const key = JSON.stringify([
      { ...rest, serverNow: 0, version: 0, turnDeadlineAt: 0 },
      withoutClock(view),
    ]);
    if (force || this.lastSent.get(userId) !== key) {
      this.lastSent.set(userId, key);
      this.events.state(userId, s);
    }
    if (stream && streamed !== null) {
      const d = stream.diff(force ? null : (this.cursors.get(userId) ?? null), streamed);
      this.cursors.set(userId, d.cursor);
      if (d.msg !== null) this.events.stream(userId, d.msg);
    }
  }

  private async forfeitLocked(userId: string): Promise<void> {
    if (this.status !== 'live' || !this.hasSeat(userId) || this.isForfeited(userId)) return;
    const drop = this.dropTimers.get(userId);
    if (drop !== undefined) {
      this.sched.clearTimeout(drop);
      this.dropTimers.delete(userId);
    }
    this.forfeited.push(userId);
    await this.store.saveForfeits(this.loaded.matchId, this.forfeited);
    if (this.game.engine.isTerminal(this.state) || this.activeCount() <= 1) {
      await this.finishLocked();
      return;
    }
    this.openGateIfReady();
    this.sendChanged();
    this.rearmIfPaceChanged();
  }

  private async finishLocked(): Promise<void> {
    if (this.status === 'finished' || this.finishing) return;
    this.finishing = true;
    this.clearTimers();
    for (const h of this.dropTimers.values()) this.sched.clearTimeout(h);
    this.dropTimers.clear();
    // Whatever strokes are still waiting go down with the final state (best effort: the result matters more).
    if (this.pending.length > 0) {
      try {
        await this.store.saveMoves({
          matchId: this.loaded.matchId,
          moves: this.pending,
          state: this.state,
        });
        this.pending = [];
      } catch {
        this.pending = [];
      }
    }

    const outcome: FinalOutcome = computeOutcome(
      this.game.engine,
      this.state,
      this.seats,
      this.forfeited,
    );
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.opts.settleRetries; attempt++) {
      try {
        this.results = await this.store.finish(this.loaded.matchId, outcome, this.state);
        this.status = 'finished';
        this.finishing = false;
        this.sendChanged();
        this.events.finished(this);
        return;
      } catch (err) {
        lastError = err;
        if (this.disposed) break;
        await new Promise<void>((resolve) =>
          this.sched.setTimeout(resolve, this.opts.settleRetryMs),
        );
      }
    }
    this.finishing = false;
    // Stays 'active' in the database: the next time anyone connects the room is rebuilt and tries again.
    throw lastError instanceof Error ? lastError : new Error('settlement failed');
  }
}
