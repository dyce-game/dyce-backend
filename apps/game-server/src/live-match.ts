import type { TurnGame } from '@dyce/games';
import { computeOutcome } from './outcome.ts';
import type { LiveResultRow, LiveSeat, LiveState } from '@dyce/shared';
import type { FinalOutcome, LiveMatchStore, LoadedMatch } from './store.ts';

/** Timers and the clock, injected so tests run instantly. */
export type Scheduler = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export const realScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export type LiveMatchOptions = {
  /** How long a seat may stay disconnected before it forfeits. */
  reconnectMs: number;
  /** How long a seat has to show up at all after the room is created. */
  joinGraceMs: number;
  /** Pause before the room plays for a seat that is out of the game, so everyone sees each card. */
  botDelayMs: number;
  /** Tries (with a pause between) to settle a finished match before giving up until the next restart. */
  settleRetries: number;
  settleRetryMs: number;
  /** Party rooms only (all optional; see PartyMatch for the defaults). */
  party?: Partial<PartyOptions>;
};

export const DEFAULT_OPTIONS: LiveMatchOptions = {
  reconnectMs: 60_000,
  joinGraceMs: 90_000,
  botDelayMs: 700,
  settleRetries: 5,
  settleRetryMs: 3_000,
};

/** Timing knobs of a party room. Tests shrink them; production uses the defaults. */
export type PartyOptions = {
  /** Real time between engine ticks; defaults to the game's own (1 s). */
  tickMs: number;
  /** Pause between ticks while the clock is only waiting for seats that left (a skip-ahead). */
  skipDelayMs: number;
  /** Streams (strokes) reach the database at most this often. */
  streamFlushMs: number;
  /** Streams reach the other seats at most this often. */
  streamBroadcastMs: number;
  /** Smallest gap between two chat lines from one seat. */
  chatGapMs: number;
  /** Actions a seat may send in a burst, and the rate it earns them back per second. */
  actionBurst: number;
  actionPerSecond: number;
};

export type MoveRefusal =
  | 'not_running'
  | 'not_seated'
  | 'forfeited'
  | 'stale_version'
  | 'not_your_turn'
  | 'invalid_action'
  | 'illegal_move'
  | 'busy'
  | 'waiting'
  | 'rate_limited'
  | 'chat_closed';

export type MoveResult = { ok: true } | { ok: false; code: MoveRefusal; reason?: string };

/**
 * One running live match, with no I/O of its own: the room feeds it moves and connection changes, and it
 * decides what the engine says, when time runs out, who forfeits, who won, and what to persist.
 *
 * The server decides everything. A move is checked against the action schema, the version the player
 * saw, whose turn it is and the engine's own `validate` before it is applied, persisted and broadcast.
 * Everything that changes state goes through one queue, so two moves (or a move and a timeout) can never
 * interleave across an `await`.
 *
 * Players who leave (an explicit `leave`, or no connection for `reconnectMs`) forfeit: they come last, the
 * pot never goes to them, and when only one player is left that player wins at once. A forfeited seat
 * that is still in the engine's turn order is played automatically with the game's `autoAction`. A seat
 * that runs out its turn clock is auto-played the same way, whether or not it is connected.
 */
export class LiveMatch {
  state: unknown;
  version: number;
  status: 'live' | 'finished' = 'live';
  results: LiveResultRow[] | null = null;
  /** Epoch ms when the room will move for the current player, or null. */
  turnDeadlineAt: number | null = null;

  private readonly seats: { userId: string; seat: number }[];
  private readonly forfeited: string[];
  private readonly connected = new Set<string>();
  private readonly dropTimers = new Map<string, unknown>();
  private turnTimer: unknown = null;
  private botTimer: unknown = null;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private finishing = false;

  constructor(
    private readonly loaded: LoadedMatch,
    private readonly game: TurnGame,
    private readonly store: LiveMatchStore,
    private readonly sched: Scheduler,
    private readonly onChange: (match: LiveMatch) => void,
    private readonly opts: LiveMatchOptions = DEFAULT_OPTIONS,
    private readonly onError: (err: unknown) => void = () => undefined,
  ) {
    this.state = loaded.state;
    this.version = loaded.version;
    this.seats = loaded.players;
    this.forfeited = [...loaded.forfeited];
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
  hasSeat(userId: string): boolean {
    return this.seats.some((s) => s.userId === userId);
  }

  /** Begins the clocks: the turn timer, and the grace every seat gets to connect. */
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
    this.fire(() => this.advance());
  }

  /** Stops every timer. The room calls this when it is disposed. */
  dispose(): void {
    this.disposed = true;
    this.clearTurn();
    if (this.botTimer !== null) this.sched.clearTimeout(this.botTimer);
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
    } else {
      this.connected.delete(userId);
      if (this.status === 'live' && !this.isForfeited(userId)) {
        this.armDrop(userId, this.opts.reconnectMs);
      }
    }
    this.onChange(this);
  }

  /** The seat left the game on purpose, or was gone too long. */
  forfeit(userId: string): Promise<void> {
    return this.enqueue(() => this.forfeitLocked(userId));
  }

  // ---- moves ----------------------------------------------------------------------------------

  async submit(userId: string, expectedVersion: number, action: unknown): Promise<MoveResult> {
    return this.enqueue(async () => {
      if (this.status !== 'live') return { ok: false, code: 'not_running' } as const;
      if (!this.hasSeat(userId)) return { ok: false, code: 'not_seated' } as const;
      if (this.isForfeited(userId)) return { ok: false, code: 'forfeited' } as const;
      const { engine } = this.game;
      let parsed = action;
      if (engine.actionSchema) {
        const p = engine.actionSchema.safeParse(action);
        if (!p.success) return { ok: false, code: 'invalid_action' } as const;
        parsed = p.data;
      }
      if (expectedVersion !== this.version) return { ok: false, code: 'stale_version' } as const;
      if (!engine.currentPlayers(this.state).includes(userId)) {
        return { ok: false, code: 'not_your_turn' } as const;
      }
      const verdict = engine.validate(this.state, userId, parsed);
      if (!verdict.ok) return { ok: false, code: 'illegal_move', reason: verdict.code } as const;
      await this.applyLocked(userId, parsed);
      return { ok: true } as const;
    });
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
    const turn =
      this.status === 'live' ? (this.game.engine.currentPlayers(this.state)[0] ?? null) : null;
    return {
      matchId: this.loaded.matchId,
      spaceId: this.loaded.spaceId,
      gameSlug: this.loaded.gameSlug,
      mode: this.loaded.mode,
      version: this.version,
      status: this.status,
      view: this.game.engine.view(this.state, userId),
      seats: this.seatsView(),
      turnUserId: turn,
      turnDeadlineAt: turn ? this.turnDeadlineAt : null,
      roomKind: 'turns',
      canAct: turn === userId && !this.isForfeited(userId),
      waiting: false,
      serverNow: this.sched.now(),
      results: this.results,
    };
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

  /** Runs `fn` after everything queued before it, whatever happened to that. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Queues work started by a timer: nobody awaits it, so failures go to `onError` instead of crashing. */
  private fire(fn: () => Promise<void>): void {
    this.enqueue(fn).catch((err: unknown) => this.onError(err));
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

  private clearTurn(): void {
    if (this.turnTimer !== null) this.sched.clearTimeout(this.turnTimer);
    this.turnTimer = null;
    this.turnDeadlineAt = null;
  }

  /** Applies a validated action: engine, then persist, then the next turn's clock (or the end). */
  private async applyLocked(by: string, action: unknown): Promise<void> {
    const { engine } = this.game;
    const next = engine.apply(this.state, by, action);
    const seq = this.version + 1;
    const over = engine.isTerminal(next);
    const nextTurn = over ? null : (engine.currentPlayers(next)[0] ?? null);
    const deadline = nextTurn ? new Date(this.sched.now() + this.game.turnMs) : null;
    await this.store.saveMove({
      matchId: this.loaded.matchId,
      seq,
      userId: by,
      action,
      state: next,
      currentTurn: nextTurn,
      turnDeadline: deadline,
    });
    this.state = next;
    this.version = seq;
    await this.advance();
  }

  /** After any change: end the game, or start the next turn's clock (or play for a seat that is out). */
  private async advance(): Promise<void> {
    if (this.disposed) return;
    this.clearTurn();
    if (this.game.engine.isTerminal(this.state)) {
      await this.finishLocked();
      return;
    }
    if (this.activeCount() <= 1) {
      await this.finishLocked();
      return;
    }
    const turn = this.game.engine.currentPlayers(this.state)[0];
    if (turn === undefined) {
      this.onChange(this);
      return;
    }
    if (this.isForfeited(turn)) {
      // Nobody is behind this seat: play for it after a short beat so the others can follow along.
      this.onChange(this);
      this.botTimer = this.sched.setTimeout(() => {
        this.botTimer = null;
        this.fire(() => this.autoPlay(turn, this.version));
      }, this.opts.botDelayMs);
      return;
    }
    this.turnDeadlineAt = this.sched.now() + this.game.turnMs;
    this.turnTimer = this.sched.setTimeout(() => {
      this.turnTimer = null;
      this.fire(() => this.autoPlay(turn, this.version));
    }, this.game.turnMs);
    this.onChange(this);
  }

  /** The seat ran out of time (or is out of the game): the game's own sensible move is played for it. */
  private async autoPlay(turn: string, atVersion: number): Promise<void> {
    if (this.disposed || this.status !== 'live') return;
    if (this.version !== atVersion) return; // the seat moved first
    const { engine } = this.game;
    if (engine.currentPlayers(this.state)[0] !== turn) return;
    const action = this.game.autoAction(this.state, turn);
    const verdict = engine.validate(this.state, turn, action);
    if (!verdict.ok) {
      // Cannot happen with a correct autoAction; never leave a table stuck on it.
      throw new Error(`autoAction produced an illegal move: ${verdict.code}`);
    }
    await this.applyLocked(turn, action);
  }

  private activeCount(): number {
    return this.seats.filter((s) => !this.isForfeited(s.userId)).length;
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
    await this.advance();
  }

  private outcome(): FinalOutcome {
    return computeOutcome(this.game.engine, this.state, this.seats, this.forfeited);
  }

  private async finishLocked(): Promise<void> {
    if (this.status === 'finished' || this.finishing) return;
    this.finishing = true;
    this.clearTurn();
    if (this.botTimer !== null) this.sched.clearTimeout(this.botTimer);
    this.botTimer = null;
    for (const h of this.dropTimers.values()) this.sched.clearTimeout(h);
    this.dropTimers.clear();

    const outcome = this.outcome();
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.opts.settleRetries; attempt++) {
      try {
        this.results = await this.store.finish(this.loaded.matchId, outcome, this.state);
        this.status = 'finished';
        this.finishing = false;
        this.onChange(this);
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
    // The match stays 'active' in the database; the next time anyone connects the room is rebuilt from
    // it and tries again. Players keep seeing the table until then.
    throw lastError instanceof Error ? lastError : new Error('settlement failed');
  }
}
