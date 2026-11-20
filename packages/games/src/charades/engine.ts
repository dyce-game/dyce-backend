import { z } from 'zod';
import type { GameEngine, GameResult, PlayerId, ValidateResult } from '../contract.ts';
import { seedRng, shuffle, type RngState } from '../rng.ts';
import {
  ROOM_ACTOR,
  assertPlayers,
  placementsByScore,
  tickSchema,
  type TickAction,
} from '../party/common.ts';
import {
  DEFAULT_CHARADES_PACK_IDS,
  WORD_PACKS_VERSION,
  charadesPrompts,
  type CharadesPrompt,
} from '../party/words.ts';

/**
 * Charades (3–10 players, live). Rules decided here are in docs/DECISIONS.md (ADR-023).
 *
 * Teams: 4+ players play in 2 teams (up to 4 with `teams`, at least 2 players each); with 3 players
 * (or `solo: true`) everyone is their own team. Turns alternate between teams; each team's players take
 * turns being the player in the hot seat, and every team gets `rounds × biggest team` turns, so teams
 * of different sizes get the same number of turns.
 *
 * A turn: the player presses `start` (or the ready timer forfeits the turn), then has `turnMs` and up to
 * `cardsPerTurn` cards. Each card is either `got_it` (a point for the team) or `skip` (no point, up to
 * `maxSkips` per turn). In `act` mode the player acts the card out (only they see it) and their team
 * guesses in chat; the player awards the card with `got_it`, naming who guessed it when they can. In
 * solo play the guesser must be named and scores a point too. In `headsup` mode the phone is held on the
 * forehead: the player cannot see the card but everybody else can, and the player's tilt sends
 * `got_it` / `skip`. Highest team score wins; equal scores share a placement (all equal: a draw).
 * Time is an explicit `tick` from the room.
 */
export type CharadesMode = 'act' | 'headsup';
export type CharadesPhase = 'ready' | 'acting' | 'over';

export type CharadesCfg = {
  mode?: CharadesMode;
  /** Number of teams (2–4). Default 2 for 4+ players. */
  teams?: number;
  /** Everyone is their own team. Default true for 3 players. */
  solo?: boolean;
  /** Times round the table. Default 2. */
  rounds?: number;
  /** Charades pack ids (see party/words.ts). Default: all. */
  packs?: string[];
  turnMs?: number;
  readyMs?: number;
  cardsPerTurn?: number;
  maxSkips?: number;
};

export type CharadesEvent = {
  seq: number;
  kind: 'start' | 'got_it' | 'skip' | 'time_up' | 'forfeit';
  /** The player in the hot seat. */
  by: PlayerId;
  guesser: PlayerId | null;
  /** The card that was just resolved (got_it, skip). */
  text: string | null;
};

export type CharadesState = {
  players: PlayerId[];
  teams: PlayerId[][];
  solo: boolean;
  mode: CharadesMode;
  /** Who is in the hot seat on each turn. */
  schedule: PlayerId[];
  turn: number;
  phase: CharadesPhase;
  timeLeftMs: number;
  /** The card on screen (acting only). Hidden from whoever must not see it. */
  card: CharadesPrompt | null;
  /** Cards resolved so far this turn. */
  resolved: number;
  skipsLeft: number;
  /** One score per team. */
  scores: number[];
  deck: CharadesPrompt[];
  used: CharadesPrompt[];
  packVersion: string;
  ms: { turn: number; ready: number };
  cardsPerTurn: number;
  maxSkips: number;
  last: CharadesEvent | null;
  seq: number;
  rng: RngState;
};

export type CharadesAction =
  { kind: 'start' } | { kind: 'got_it'; guesser?: PlayerId } | { kind: 'skip' } | TickAction;

export const charadesActionSchema: z.ZodType<CharadesAction> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('start') }),
  z.object({ kind: z.literal('got_it'), guesser: z.string().min(1).max(64).optional() }),
  z.object({ kind: z.literal('skip') }),
  tickSchema,
]);

const teamIndex = (s: Pick<CharadesState, 'teams'>, p: PlayerId): number =>
  s.teams.findIndex((t) => t.includes(p));

const actorOf = (s: CharadesState): PlayerId | null =>
  s.phase === 'over' ? null : (s.schedule[s.turn] ?? null);

type Work = CharadesState;
const copy = (s: CharadesState): Work => ({
  ...s,
  scores: [...s.scores],
  deck: [...s.deck],
  used: [...s.used],
  ms: { ...s.ms },
});

/** Take the next card; when the deck is empty, the used ones are reshuffled back in. */
function drawCard(w: Work): CharadesPrompt {
  if (w.deck.length === 0) {
    const [shuffled, rng] = shuffle(w.rng, w.used);
    w.deck = shuffled;
    w.used = [];
    w.rng = rng;
  }
  const card = w.deck.shift() as CharadesPrompt;
  w.used.push(card);
  return card;
}

/** Close the turn (time up, cards used up, or forfeited) and set up the next one. */
function nextTurn(w: Work): void {
  w.card = null;
  w.resolved = 0;
  w.turn += 1;
  if (w.turn >= w.schedule.length) {
    w.phase = 'over';
    w.timeLeftMs = 0;
  } else {
    w.phase = 'ready';
    w.timeLeftMs = w.ms.ready;
  }
}

function resolveCard(
  w: Work,
  by: PlayerId,
  kind: 'got_it' | 'skip',
  guesser: PlayerId | null,
): void {
  const text = w.card?.t ?? null;
  w.resolved += 1;
  w.last = { seq: w.seq, kind, by, guesser, text };
  if (w.resolved >= w.cardsPerTurn) nextTurn(w);
  else w.card = drawCard(w);
}

export const charadesEngine: GameEngine<CharadesState, CharadesAction, CharadesCfg> = {
  slug: 'charades',
  actionSchema: charadesActionSchema,
  timers: { turnMs: 60_000, matchMs: 1_800_000 },

  init(players, seed, cfg) {
    assertPlayers(players, 3, 10);
    const mode = cfg?.mode ?? 'act';
    if (mode !== 'act' && mode !== 'headsup') throw new Error('Invalid mode');
    const rounds = cfg?.rounds ?? 2;
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5)
      throw new Error('rounds must be 1 to 5');
    const cardsPerTurn = cfg?.cardsPerTurn ?? 8;
    if (!Number.isInteger(cardsPerTurn) || cardsPerTurn < 1 || cardsPerTurn > 30) {
      throw new Error('Invalid cardsPerTurn');
    }
    const maxSkips = cfg?.maxSkips ?? 3;
    if (!Number.isInteger(maxSkips) || maxSkips < 0 || maxSkips > 30) {
      throw new Error('Invalid maxSkips');
    }
    const solo = cfg?.solo ?? players.length < 4;
    const teamCount = solo ? players.length : (cfg?.teams ?? 2);
    if (
      !solo &&
      (!Number.isInteger(teamCount) ||
        teamCount < 2 ||
        teamCount > 4 ||
        teamCount * 2 > players.length)
    ) {
      throw new Error('Invalid number of teams');
    }
    const prompts = charadesPrompts(cfg?.packs ?? [...DEFAULT_CHARADES_PACK_IDS]);
    if (prompts.length < 10) throw new Error('Charades needs at least 10 prompts');

    const [seats, r1] = shuffle(seedRng(seed), players);
    const teams: PlayerId[][] = Array.from({ length: teamCount }, () => []);
    seats.forEach((p, i) => teams[i % teamCount]!.push(p));

    const schedule: PlayerId[] = [];
    if (solo) {
      for (let r = 0; r < rounds; r++) schedule.push(...seats);
    } else {
      const biggest = Math.max(...teams.map((t) => t.length));
      for (let k = 0; k < rounds * biggest; k++) {
        for (const t of teams) schedule.push(t[k % t.length] as PlayerId);
      }
    }

    const [deck, rng] = shuffle(r1, prompts);
    const ms = { turn: cfg?.turnMs ?? 60_000, ready: cfg?.readyMs ?? 20_000 };
    return {
      players: [...players],
      teams,
      solo,
      mode,
      schedule,
      turn: 0,
      phase: 'ready',
      timeLeftMs: ms.ready,
      card: null,
      resolved: 0,
      skipsLeft: maxSkips,
      scores: teams.map(() => 0),
      deck,
      used: [],
      packVersion: WORD_PACKS_VERSION,
      ms,
      cardsPerTurn,
      maxSkips,
      last: null,
      seq: 0,
      rng,
    };
  },

  currentPlayers(s) {
    const p = actorOf(s);
    return p === null ? [] : [p];
  },

  validate(s, by, a): ValidateResult {
    if (s.phase === 'over') return { ok: false, code: 'game_over' };
    if (a.kind === 'tick')
      return by === ROOM_ACTOR ? { ok: true } : { ok: false, code: 'room_only' };
    if (!s.players.includes(by)) return { ok: false, code: 'not_a_player' };
    if (actorOf(s) !== by) return { ok: false, code: 'not_your_turn' };

    switch (a.kind) {
      case 'start':
        return s.phase === 'ready' ? { ok: true } : { ok: false, code: 'already_started' };
      case 'skip':
        if (s.phase !== 'acting') return { ok: false, code: 'not_started' };
        return s.skipsLeft > 0 ? { ok: true } : { ok: false, code: 'no_skips_left' };
      case 'got_it': {
        if (s.phase !== 'acting') return { ok: false, code: 'not_started' };
        if (s.mode === 'headsup') {
          return a.guesser === undefined
            ? { ok: true }
            : { ok: false, code: 'guesser_not_allowed' };
        }
        if (a.guesser === undefined)
          return s.solo ? { ok: false, code: 'guesser_required' } : { ok: true };
        if (a.guesser === by || !s.players.includes(a.guesser))
          return { ok: false, code: 'invalid_guesser' };
        if (!s.solo && teamIndex(s, a.guesser) !== teamIndex(s, by))
          return { ok: false, code: 'invalid_guesser' };
        return { ok: true };
      }
    }
  },

  apply(s, by, a) {
    const w = copy(s);
    w.seq = s.seq + 1;

    if (a.kind === 'tick') {
      w.timeLeftMs -= a.ms;
      if (w.timeLeftMs <= 0) {
        const actor = w.schedule[w.turn] as PlayerId;
        w.last = {
          seq: w.seq,
          kind: w.phase === 'ready' ? 'forfeit' : 'time_up',
          by: actor,
          guesser: null,
          text: null,
        };
        nextTurn(w);
      }
      return w;
    }
    if (a.kind === 'start') {
      w.phase = 'acting';
      w.timeLeftMs = w.ms.turn;
      w.skipsLeft = w.maxSkips;
      w.resolved = 0;
      w.card = drawCard(w);
      w.last = { seq: w.seq, kind: 'start', by, guesser: null, text: null };
      return w;
    }
    if (a.kind === 'skip') {
      w.skipsLeft -= 1;
      resolveCard(w, by, 'skip', null);
      return w;
    }
    const team = teamIndex(w, by);
    w.scores[team] = (w.scores[team] ?? 0) + 1;
    const guesser = a.guesser ?? null;
    if (w.solo && guesser !== null) {
      const g = teamIndex(w, guesser);
      w.scores[g] = (w.scores[g] ?? 0) + 1;
    }
    resolveCard(w, by, 'got_it', guesser);
    return w;
  },

  isTerminal(s) {
    return s.phase === 'over';
  },

  result(s): GameResult {
    if (s.phase !== 'over') return { placements: [], draw: false };
    const res = placementsByScore(s.players, (p) => s.scores[teamIndex(s, p)] ?? 0);
    return res;
  },

  view(s, viewer) {
    const actor = actorOf(s);
    const isActor = viewer !== 'spectator' && viewer === actor;
    // Act mode: only the actor sees the card. Heads-up: every other player does. Spectators never do.
    const seesCard = viewer !== 'spectator' && (s.mode === 'act' ? isActor : !isActor);
    return {
      players: s.players,
      teams: s.teams,
      solo: s.solo,
      mode: s.mode,
      phase: s.phase,
      timeLeftMs: s.timeLeftMs,
      turn: s.turn,
      turns: s.schedule.length,
      actor,
      actorTeam: actor === null ? null : teamIndex(s, actor),
      scores: s.scores,
      category: s.card?.c ?? null,
      /** The card text, only for those allowed to see it (see the rules above). Null otherwise. */
      word: s.phase === 'acting' && seesCard ? (s.card?.t ?? null) : null,
      cardNo: s.phase === 'acting' ? s.resolved + 1 : null,
      cardsPerTurn: s.cardsPerTurn,
      skipsLeft: s.phase === 'acting' ? s.skipsLeft : null,
      last: s.last,
    };
  },
};
