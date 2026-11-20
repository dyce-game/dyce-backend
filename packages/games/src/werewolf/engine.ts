import { z } from 'zod';
import type { GameEngine, GameResult, PlayerId, ValidateResult } from '../contract.ts';
import { nextInt, seedRng, shuffle, type RngState } from '../rng.ts';
import {
  ROOM_ACTOR,
  assertPlayers,
  sideResult,
  tickSchema,
  type TickAction,
} from '../party/common.ts';

/**
 * Werewolf / Mafia (5–12 players, live). Rules decided here are in docs/DECISIONS.md (ADR-023).
 *
 * Roles: werewolves (1 for 5–6 players, 2 for 7–9, 3 for 10–12), one seer, one doctor, the rest
 * villagers. Night: each werewolf names a victim (the most-named is killed; a tie is broken by the seeded
 * RNG), the seer inspects one player (learns werewolf or not), the doctor protects one player (self
 * allowed, same player on consecutive nights allowed). The night ends when every living actor has acted
 * or the timer runs out. Day: everyone alive discusses (outside the engine) and may press `ready` to
 * end it early. Vote: each living player names someone or abstains; a strict plurality is lynched, a tie
 * lynches nobody. A dead player's role is revealed and they spectate with everyone's roles visible.
 *
 * Villagers (incl. seer and doctor, alive or dead) win when no werewolf is left; werewolves win when they
 * are at least as many as everyone else alive. If `maxNights` nights pass without either, the game is a
 * draw (Pool: every stake is refunded). Time is an explicit `tick` from the room.
 */
export type WerewolfRole = 'villager' | 'werewolf' | 'seer' | 'doctor';
export type WerewolfPhase = 'night' | 'day' | 'vote' | 'over';

export type WerewolfCfg = {
  /** Werewolves. Default by table size (see above). */
  wolves?: number;
  /** Nights before the game is called a draw. Default 10. */
  maxNights?: number;
  nightMs?: number;
  dayMs?: number;
  voteMs?: number;
};

export type WerewolfLogEntry =
  | { kind: 'night'; night: number; killed: PlayerId | null; role: WerewolfRole | null }
  | {
      kind: 'lynch';
      night: number;
      lynched: PlayerId | null;
      role: WerewolfRole | null;
      /** Who each living player voted for (null = abstained). */
      votes: Record<PlayerId, PlayerId | null>;
    };

export type WerewolfState = {
  players: PlayerId[];
  /** Hidden until a player dies (their own entry becomes public) or the game ends. */
  roles: Record<PlayerId, WerewolfRole>;
  /** In order of death. */
  dead: PlayerId[];
  phase: WerewolfPhase;
  /** 1-based number of the current (or last) night. */
  night: number;
  timeLeftMs: number;
  /** This night's werewolf choices (wolf → victim). Hidden. */
  kills: Record<PlayerId, PlayerId>;
  /** This night's seer and doctor choices. Hidden. */
  inspected: PlayerId | null;
  protected: PlayerId | null;
  /** What the seer has learned, night by night. Hidden from everyone else. */
  seerLog: { night: number; target: PlayerId; werewolf: boolean }[];
  ready: PlayerId[];
  votes: Record<PlayerId, PlayerId | null>;
  log: WerewolfLogEntry[];
  winner: 'villagers' | 'werewolves' | 'draw' | null;
  maxNights: number;
  ms: { night: number; day: number; vote: number };
  seq: number;
  rng: RngState;
};

export type WerewolfAction =
  | { kind: 'kill'; target: PlayerId }
  | { kind: 'inspect'; target: PlayerId }
  | { kind: 'protect'; target: PlayerId }
  | { kind: 'ready' }
  | { kind: 'vote'; target: PlayerId | null }
  | TickAction;

const id = z.string().min(1).max(64);
export const werewolfActionSchema: z.ZodType<WerewolfAction> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('kill'), target: id }),
  z.object({ kind: z.literal('inspect'), target: id }),
  z.object({ kind: z.literal('protect'), target: id }),
  z.object({ kind: z.literal('ready') }),
  z.object({ kind: z.literal('vote'), target: id.nullable() }),
  tickSchema,
]);

export const defaultWolves = (players: number): number => (players <= 6 ? 1 : players <= 9 ? 2 : 3);

const aliveOf = (s: WerewolfState): PlayerId[] => s.players.filter((p) => !s.dead.includes(p));
const wolvesOf = (s: WerewolfState): PlayerId[] =>
  s.players.filter((p) => s.roles[p] === 'werewolf');
const isAlive = (s: WerewolfState, p: PlayerId): boolean =>
  s.players.includes(p) && !s.dead.includes(p);

/** Living players who still owe a night action. */
function nightPending(s: WerewolfState): PlayerId[] {
  const out: PlayerId[] = [];
  for (const p of aliveOf(s)) {
    const r = s.roles[p];
    if (r === 'werewolf' && s.kills[p] === undefined) out.push(p);
    if (r === 'seer' && s.inspected === null) out.push(p);
    if (r === 'doctor' && s.protected === null) out.push(p);
  }
  return out;
}

type Work = WerewolfState;
const copy = (s: WerewolfState): Work => ({
  ...s,
  players: [...s.players],
  roles: { ...s.roles },
  dead: [...s.dead],
  kills: { ...s.kills },
  seerLog: [...s.seerLog],
  ready: [...s.ready],
  votes: { ...s.votes },
  log: [...s.log],
  ms: { ...s.ms },
});

function startNight(w: Work): void {
  w.phase = 'night';
  w.timeLeftMs = w.ms.night;
  w.kills = {};
  w.inspected = null;
  w.protected = null;
}

function startDay(w: Work): void {
  w.phase = 'day';
  w.timeLeftMs = w.ms.day;
  w.ready = [];
  w.votes = {};
}

function finish(w: Work, winner: 'villagers' | 'werewolves' | 'draw'): void {
  w.winner = winner;
  w.phase = 'over';
  w.timeLeftMs = 0;
}

/** Villagers win with no wolves left; wolves win when they equal or outnumber the rest. */
function checkWin(w: Work): boolean {
  const alive = aliveOf(w);
  const wolves = alive.filter((p) => w.roles[p] === 'werewolf').length;
  if (wolves === 0) {
    finish(w, 'villagers');
    return true;
  }
  if (wolves >= alive.length - wolves) {
    finish(w, 'werewolves');
    return true;
  }
  return false;
}

function resolveNight(w: Work): void {
  // Wolves' victim: most named; ties broken by the seeded RNG so the room never has to choose.
  const counts = new Map<PlayerId, number>();
  for (const t of Object.values(w.kills)) counts.set(t, (counts.get(t) ?? 0) + 1);
  const top = Math.max(0, ...counts.values());
  const tied = w.players.filter((p) => counts.get(p) === top && top > 0);
  let victim: PlayerId | null = null;
  if (tied.length === 1) victim = tied[0] as PlayerId;
  else if (tied.length > 1) {
    const [i, rng] = nextInt(w.rng, tied.length);
    w.rng = rng;
    victim = tied[i] as PlayerId;
  }
  if (victim !== null && victim === w.protected) victim = null;

  if (victim !== null) w.dead.push(victim);
  w.log.push({
    kind: 'night',
    night: w.night,
    killed: victim,
    role: victim === null ? null : (w.roles[victim] as WerewolfRole),
  });
  w.kills = {};
  w.inspected = null;
  w.protected = null;
  if (!checkWin(w)) startDay(w);
}

function resolveVote(w: Work): void {
  const alive = aliveOf(w);
  const counts = new Map<PlayerId, number>();
  for (const v of alive) {
    const t = w.votes[v];
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const top = Math.max(0, ...counts.values());
  const leaders = alive.filter((p) => counts.get(p) === top && top > 0);
  const lynched = leaders.length === 1 ? (leaders[0] as PlayerId) : null;
  const votes: Record<PlayerId, PlayerId | null> = {};
  for (const v of alive) votes[v] = w.votes[v] ?? null;
  if (lynched !== null) w.dead.push(lynched);
  w.log.push({
    kind: 'lynch',
    night: w.night,
    lynched,
    role: lynched === null ? null : (w.roles[lynched] as WerewolfRole),
    votes,
  });
  w.votes = {};
  w.ready = [];
  if (checkWin(w)) return;
  if (w.night >= w.maxNights) {
    finish(w, 'draw');
    return;
  }
  w.night += 1;
  startNight(w);
}

function timeout(w: Work): void {
  if (w.phase === 'night') resolveNight(w);
  else if (w.phase === 'day') {
    w.phase = 'vote';
    w.timeLeftMs = w.ms.vote;
    w.votes = {};
  } else if (w.phase === 'vote') resolveVote(w);
}

export const werewolfEngine: GameEngine<WerewolfState, WerewolfAction, WerewolfCfg> = {
  slug: 'werewolf',
  actionSchema: werewolfActionSchema,
  timers: { turnMs: 30_000, matchMs: 1_500_000 },

  init(players, seed, cfg) {
    assertPlayers(players, 5, 12);
    const wolves = cfg?.wolves ?? defaultWolves(players.length);
    if (!Number.isInteger(wolves) || wolves < 1 || wolves * 2 >= players.length) {
      throw new Error('Invalid number of werewolves');
    }
    const maxNights = cfg?.maxNights ?? 10;
    if (!Number.isInteger(maxNights) || maxNights < 1 || maxNights > 30) {
      throw new Error('Invalid maxNights');
    }
    const [seats, rng] = shuffle(seedRng(seed), players);
    const roles: Record<PlayerId, WerewolfRole> = {};
    seats.forEach((p, i) => {
      roles[p] =
        i < wolves ? 'werewolf' : i === wolves ? 'seer' : i === wolves + 1 ? 'doctor' : 'villager';
    });
    const ms = {
      night: cfg?.nightMs ?? 30_000,
      day: cfg?.dayMs ?? 60_000,
      vote: cfg?.voteMs ?? 30_000,
    };
    return {
      players: [...players],
      roles,
      dead: [],
      phase: 'night',
      night: 1,
      timeLeftMs: ms.night,
      kills: {},
      inspected: null,
      protected: null,
      seerLog: [],
      ready: [],
      votes: {},
      log: [],
      winner: null,
      maxNights,
      ms,
      seq: 0,
      rng,
    };
  },

  currentPlayers(s) {
    switch (s.phase) {
      case 'night':
        return nightPending(s);
      case 'day':
        return aliveOf(s).filter((p) => !s.ready.includes(p));
      case 'vote':
        return aliveOf(s).filter((p) => s.votes[p] === undefined);
      default:
        return [];
    }
  },

  validate(s, by, a): ValidateResult {
    if (s.phase === 'over') return { ok: false, code: 'game_over' };
    if (a.kind === 'tick')
      return by === ROOM_ACTOR ? { ok: true } : { ok: false, code: 'room_only' };
    if (!s.players.includes(by)) return { ok: false, code: 'not_a_player' };
    if (!isAlive(s, by)) return { ok: false, code: 'you_are_dead' };
    const role = s.roles[by];

    switch (a.kind) {
      case 'kill':
      case 'inspect':
      case 'protect': {
        if (s.phase !== 'night') return { ok: false, code: 'wrong_phase' };
        const need: WerewolfRole =
          a.kind === 'kill' ? 'werewolf' : a.kind === 'inspect' ? 'seer' : 'doctor';
        if (role !== need) return { ok: false, code: 'wrong_role' };
        if (!isAlive(s, a.target)) return { ok: false, code: 'invalid_target' };
        if (a.kind === 'kill' && s.roles[a.target] === 'werewolf')
          return { ok: false, code: 'invalid_target' };
        if (a.kind === 'inspect' && a.target === by) return { ok: false, code: 'invalid_target' };
        const done =
          a.kind === 'kill'
            ? s.kills[by] !== undefined
            : a.kind === 'inspect'
              ? s.inspected !== null
              : s.protected !== null;
        return done ? { ok: false, code: 'already_acted' } : { ok: true };
      }
      case 'ready':
        if (s.phase !== 'day') return { ok: false, code: 'wrong_phase' };
        return s.ready.includes(by) ? { ok: false, code: 'already_ready' } : { ok: true };
      case 'vote':
        if (s.phase !== 'vote') return { ok: false, code: 'wrong_phase' };
        if (s.votes[by] !== undefined) return { ok: false, code: 'already_voted' };
        if (a.target !== null) {
          if (a.target === by) return { ok: false, code: 'cannot_vote_self' };
          if (!isAlive(s, a.target)) return { ok: false, code: 'invalid_target' };
        }
        return { ok: true };
    }
  },

  apply(s, by, a) {
    const w = copy(s);
    w.seq = s.seq + 1;

    if (a.kind === 'tick') {
      w.timeLeftMs -= a.ms;
      if (w.timeLeftMs <= 0) timeout(w);
      return w;
    }
    if (a.kind === 'kill') w.kills[by] = a.target;
    else if (a.kind === 'inspect') {
      w.inspected = a.target;
      w.seerLog.push({
        night: w.night,
        target: a.target,
        werewolf: w.roles[a.target] === 'werewolf',
      });
    } else if (a.kind === 'protect') w.protected = a.target;
    else if (a.kind === 'ready') {
      w.ready.push(by);
      if (aliveOf(w).every((p) => w.ready.includes(p))) timeout(w);
      return w;
    } else {
      w.votes[by] = a.target;
      if (aliveOf(w).every((p) => w.votes[p] !== undefined)) resolveVote(w);
      return w;
    }
    // A night action: close the night once every living actor has acted.
    if (nightPending(w).length === 0) resolveNight(w);
    return w;
  },

  isTerminal(s) {
    return s.phase === 'over';
  },

  result(s): GameResult {
    if (s.winner === null) return { placements: [], draw: false };
    if (s.winner === 'draw') return { placements: [[...s.players]], draw: true };
    const wolves = wolvesOf(s);
    const rest = s.players.filter((p) => !wolves.includes(p));
    return s.winner === 'werewolves' ? sideResult(wolves, rest) : sideResult(rest, wolves);
  },

  view(s, viewer) {
    const over = s.phase === 'over';
    const isPlayer = viewer !== 'spectator' && s.players.includes(viewer);
    const role = isPlayer ? (s.roles[viewer] as WerewolfRole) : null;
    const dead = isPlayer && !isAlive(s, viewer);
    const seesAllRoles = over || dead;
    const wolf = role === 'werewolf';
    const acted =
      !isPlayer || dead
        ? null
        : role === 'werewolf'
          ? s.kills[viewer] !== undefined
          : role === 'seer'
            ? s.inspected !== null
            : role === 'doctor'
              ? s.protected !== null
              : null;
    const composition: Record<WerewolfRole, number> = {
      werewolf: 0,
      seer: 0,
      doctor: 0,
      villager: 0,
    };
    for (const p of s.players) composition[s.roles[p] as WerewolfRole] += 1;
    const revealed: Record<PlayerId, WerewolfRole> = {};
    for (const p of s.dead) revealed[p] = s.roles[p] as WerewolfRole;
    return {
      players: s.players,
      phase: s.phase,
      night: s.night,
      timeLeftMs: s.timeLeftMs,
      alive: aliveOf(s),
      dead: s.dead,
      composition,
      /** Your role (null for a spectator). */
      role,
      /** Roles of the dead, which everyone may see. */
      revealed,
      /** Every role: only for the dead (who spectate) and once the game is over. */
      roles: seesAllRoles ? s.roles : undefined,
      /** Werewolves know each other and see each other's night choices. */
      wolves: wolf ? wolvesOf(s) : undefined,
      wolfTargets: wolf && !dead ? s.kills : undefined,
      inspecting: role === 'seer' ? s.inspected : undefined,
      seerLog: role === 'seer' ? s.seerLog : undefined,
      protecting: role === 'doctor' ? s.protected : undefined,
      /** Whether you have used your night action (never says anything about anyone else's). */
      acted,
      ready: s.phase === 'day' ? s.ready : [],
      voted: s.phase === 'vote' ? Object.keys(s.votes) : [],
      myVote: isPlayer && s.phase === 'vote' ? (s.votes[viewer] ?? null) : null,
      log: s.log,
      winner: s.winner,
      seq: s.seq,
    };
  },
};
