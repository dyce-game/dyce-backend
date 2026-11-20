import { z } from 'zod';
import type { GameEngine, GameResult, PlayerId, ValidateResult } from '../contract.ts';
import { nextInt, seedRng, shuffle, type RngState } from '../rng.ts';
import {
  ROOM_ACTOR,
  assertPlayers,
  isCleanText,
  normaliseText,
  sideResult,
  tickSchema,
  tidyText,
  type TickAction,
} from '../party/common.ts';
import { DEFAULT_PACK_IDS, WORD_PACKS_VERSION, packLabel, packWords } from '../party/words.ts';

/**
 * Imposter (4–10 players, live). Everyone but the imposter(s) is told the same secret word. Players give
 * one-word clues in turn, then everyone votes for who they think the imposter(s) are. Rules decided here
 * are in docs/DECISIONS.md (ADR-023).
 *
 * Phases: `reveal` (see your role; everyone presses ready, or the timer ends it) → `clue` (`clueRounds`
 * rounds, one clue each per round in a seeded order) → `vote` (each player names exactly as many suspects
 * as there are imposters) → `guess` (only if every imposter was caught) → `over`.
 *
 * Voting: the top-N vote getters are accused (N = number of imposters); a tie across the cut accuses
 * only those strictly above it. If the accused are exactly the imposters, each imposter gets one guess at
 * the secret word: a correct guess steals the round. Otherwise the imposters win. Crew win when every
 * imposter is caught and nobody guesses the word. Time is an explicit `tick` from the room.
 */
export type ImposterPhase = 'reveal' | 'clue' | 'vote' | 'guess' | 'over';

export type ImposterCfg = {
  /** 1 or 2. Default: 1 for up to 7 players, 2 for 8 or more. */
  imposters?: number;
  /** Word pack ids (see party/words.ts). Default: all. */
  packs?: string[];
  /** Rounds of clues (each player speaks once per round). Default 2. */
  clueRounds?: number;
  revealMs?: number;
  clueMs?: number;
  voteMs?: number;
  guessMs?: number;
};

export type ImposterClue = { round: number; by: PlayerId; text: string | null };

export type ImposterState = {
  players: PlayerId[];
  imposters: PlayerId[];
  /** The secret word. Hidden from imposters and spectators until the game is over. */
  word: string;
  packLabel: string;
  packVersion: string;
  phase: ImposterPhase;
  /** Order players give clues in (a seeded shuffle of `players`). */
  order: PlayerId[];
  clueRounds: number;
  /** Index into `clues` slots: round * players + position. */
  slot: number;
  clues: ImposterClue[];
  ready: PlayerId[];
  /** Each voter's suspects; present once they voted. */
  votes: Record<PlayerId, PlayerId[]>;
  accused: PlayerId[];
  /** Imposters who already used their guess, with what they said. */
  guesses: Record<PlayerId, string>;
  winner: 'crew' | 'imposters' | null;
  timeLeftMs: number;
  ms: { reveal: number; clue: number; vote: number; guess: number };
  seq: number;
  rng: RngState;
};

export type ImposterAction =
  | { kind: 'ready' }
  | { kind: 'clue'; text: string }
  | { kind: 'vote'; targets: PlayerId[] }
  | { kind: 'guess'; text: string }
  | TickAction;

export const imposterActionSchema: z.ZodType<ImposterAction> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready') }),
  z.object({ kind: z.literal('clue'), text: z.string().min(1).max(60) }),
  z.object({
    kind: z.literal('vote'),
    targets: z.array(z.string().min(1).max(64)).min(1).max(2),
  }),
  z.object({ kind: z.literal('guess'), text: z.string().min(1).max(60) }),
  tickSchema,
]);

export const IMPOSTER_CLUE_MAX_WORDS = 3;

const defaultImposters = (n: number): number => (n >= 8 ? 2 : 1);

/** Clue slots left: every player speaks `clueRounds` times. */
const totalSlots = (s: Pick<ImposterState, 'order' | 'clueRounds'>): number =>
  s.order.length * s.clueRounds;

const speakerOf = (s: ImposterState): PlayerId | null =>
  s.phase === 'clue' ? (s.order[s.slot % s.order.length] ?? null) : null;

function tallyVotes(s: ImposterState): Record<PlayerId, number> {
  const tally: Record<PlayerId, number> = Object.fromEntries(s.players.map((p) => [p, 0]));
  for (const targets of Object.values(s.votes))
    for (const t of targets) tally[t] = (tally[t] ?? 0) + 1;
  return tally;
}

/** Top-N by votes; a tie across the cut leaves out everyone tied there. Players with no votes are never accused. */
export function imposterAccused(
  tally: Record<PlayerId, number>,
  players: readonly PlayerId[],
  n: number,
): PlayerId[] {
  const groups = new Map<number, PlayerId[]>();
  for (const p of players) {
    const v = tally[p] ?? 0;
    if (v > 0) groups.set(v, [...(groups.get(v) ?? []), p]);
  }
  const ranked = [...groups.entries()].sort((a, b) => b[0] - a[0]);
  const out: PlayerId[] = [];
  for (const [, ps] of ranked) {
    if (out.length + ps.length > n) break;
    out.push(...ps);
  }
  return out;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x) => b.includes(x));

type Work = ImposterState;
const copy = (s: ImposterState): Work => ({
  ...s,
  imposters: [...s.imposters],
  order: [...s.order],
  clues: [...s.clues],
  ready: [...s.ready],
  votes: { ...s.votes },
  accused: [...s.accused],
  guesses: { ...s.guesses },
  ms: { ...s.ms },
});

function enter(w: Work, phase: ImposterPhase): void {
  w.phase = phase;
  w.timeLeftMs =
    phase === 'reveal' || phase === 'clue' || phase === 'vote' || phase === 'guess'
      ? w.ms[phase]
      : 0;
}

function finish(w: Work, winner: 'crew' | 'imposters'): void {
  w.winner = winner;
  enter(w, 'over');
}

function closeVote(w: Work): void {
  w.accused = imposterAccused(tallyVotes(w), w.players, w.imposters.length);
  if (sameSet(w.accused, w.imposters)) enter(w, 'guess');
  else finish(w, 'imposters');
}

function closeGuesses(w: Work): void {
  const word = normaliseText(w.word);
  const stolen = Object.values(w.guesses).some((g) => normaliseText(g) === word);
  finish(w, stolen ? 'imposters' : 'crew');
}

function advanceClue(w: Work): void {
  w.slot += 1;
  if (w.slot >= totalSlots(w)) enter(w, 'vote');
  else w.timeLeftMs = w.ms.clue;
}

/** The phase's timer ran out (or the room advanced it): fill in what is missing and move on. */
function timeout(w: Work): void {
  switch (w.phase) {
    case 'reveal':
      enter(w, 'clue');
      break;
    case 'clue': {
      const by = w.order[w.slot % w.order.length] as PlayerId;
      w.clues.push({ round: Math.floor(w.slot / w.order.length) + 1, by, text: null });
      advanceClue(w);
      break;
    }
    case 'vote':
      closeVote(w);
      break;
    case 'guess':
      closeGuesses(w);
      break;
    default:
      break;
  }
}

export const imposterEngine: GameEngine<ImposterState, ImposterAction, ImposterCfg> = {
  slug: 'imposter',
  actionSchema: imposterActionSchema,
  timers: { turnMs: 20_000, matchMs: 600_000 },

  init(players, seed, cfg) {
    assertPlayers(players, 4, 10);
    const count = cfg?.imposters ?? defaultImposters(players.length);
    if (count !== 1 && count !== 2) throw new Error('Imposter needs 1 or 2 imposters');
    if (count * 2 >= players.length) throw new Error('Too many imposters for this table');
    const clueRounds = cfg?.clueRounds ?? 2;
    if (!Number.isInteger(clueRounds) || clueRounds < 1 || clueRounds > 5) {
      throw new Error('clueRounds must be 1 to 5');
    }
    const packs = cfg?.packs ?? [...DEFAULT_PACK_IDS];
    const words = packWords(packs);
    if (words.length === 0) throw new Error('Empty word pack');

    let rng = seedRng(seed);
    const [wi, r1] = nextInt(rng, words.length);
    const [seats, r2] = shuffle(r1, players);
    const [order, r3] = shuffle(r2, players);
    rng = r3;
    const imposters = seats.slice(0, count);
    const ms = {
      reveal: cfg?.revealMs ?? 10_000,
      clue: cfg?.clueMs ?? 20_000,
      vote: cfg?.voteMs ?? 45_000,
      guess: cfg?.guessMs ?? 20_000,
    };
    return {
      players: [...players],
      imposters: players.filter((p) => imposters.includes(p)),
      word: words[wi] as string,
      packLabel: packLabel(packs),
      packVersion: WORD_PACKS_VERSION,
      phase: 'reveal',
      order,
      clueRounds,
      slot: 0,
      clues: [],
      ready: [],
      votes: {},
      accused: [],
      guesses: {},
      winner: null,
      timeLeftMs: ms.reveal,
      ms,
      seq: 0,
      rng,
    };
  },

  currentPlayers(s) {
    switch (s.phase) {
      case 'reveal':
        return s.players.filter((p) => !s.ready.includes(p));
      case 'clue': {
        const p = speakerOf(s);
        return p === null ? [] : [p];
      }
      case 'vote':
        return s.players.filter((p) => s.votes[p] === undefined);
      case 'guess':
        return s.imposters.filter((p) => s.guesses[p] === undefined);
      default:
        return [];
    }
  },

  validate(s, by, a): ValidateResult {
    if (s.phase === 'over') return { ok: false, code: 'game_over' };
    if (a.kind === 'tick')
      return by === ROOM_ACTOR ? { ok: true } : { ok: false, code: 'room_only' };
    if (!s.players.includes(by)) return { ok: false, code: 'not_a_player' };

    switch (a.kind) {
      case 'ready':
        if (s.phase !== 'reveal') return { ok: false, code: 'wrong_phase' };
        return s.ready.includes(by) ? { ok: false, code: 'already_ready' } : { ok: true };
      case 'clue': {
        if (s.phase !== 'clue') return { ok: false, code: 'wrong_phase' };
        if (speakerOf(s) !== by) return { ok: false, code: 'not_your_turn' };
        const text = tidyText(a.text);
        if (text.length === 0) return { ok: false, code: 'empty_clue' };
        if (text.split(' ').length > IMPOSTER_CLUE_MAX_WORDS)
          return { ok: false, code: 'clue_too_long' };
        if (!isCleanText(text)) return { ok: false, code: 'not_allowed' };
        return { ok: true };
      }
      case 'vote': {
        if (s.phase !== 'vote') return { ok: false, code: 'wrong_phase' };
        if (s.votes[by] !== undefined) return { ok: false, code: 'already_voted' };
        if (a.targets.length !== s.imposters.length)
          return { ok: false, code: 'wrong_target_count' };
        if (new Set(a.targets).size !== a.targets.length)
          return { ok: false, code: 'duplicate_target' };
        for (const t of a.targets) {
          if (!s.players.includes(t)) return { ok: false, code: 'unknown_target' };
          if (t === by) return { ok: false, code: 'cannot_vote_self' };
        }
        return { ok: true };
      }
      case 'guess': {
        if (s.phase !== 'guess') return { ok: false, code: 'wrong_phase' };
        if (!s.imposters.includes(by)) return { ok: false, code: 'not_an_imposter' };
        if (s.guesses[by] !== undefined) return { ok: false, code: 'already_guessed' };
        if (normaliseText(a.text).length === 0) return { ok: false, code: 'empty_guess' };
        return { ok: true };
      }
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
    if (a.kind === 'ready') {
      w.ready.push(by);
      if (w.ready.length === w.players.length) enter(w, 'clue');
    } else if (a.kind === 'clue') {
      w.clues.push({ round: Math.floor(w.slot / w.order.length) + 1, by, text: tidyText(a.text) });
      advanceClue(w);
    } else if (a.kind === 'vote') {
      w.votes[by] = [...a.targets];
      if (w.players.every((p) => w.votes[p] !== undefined)) closeVote(w);
    } else {
      w.guesses[by] = tidyText(a.text);
      if (w.imposters.every((p) => w.guesses[p] !== undefined)) closeGuesses(w);
    }
    return w;
  },

  isTerminal(s) {
    return s.phase === 'over';
  },

  result(s): GameResult {
    if (s.winner === null) return { placements: [], draw: false };
    const imp = s.players.filter((p) => s.imposters.includes(p));
    const crew = s.players.filter((p) => !s.imposters.includes(p));
    return s.winner === 'imposters' ? sideResult(imp, crew) : sideResult(crew, imp);
  },

  view(s, viewer) {
    const over = s.phase === 'over';
    const isImposter = viewer !== 'spectator' && s.imposters.includes(viewer);
    const isPlayer = viewer !== 'spectator' && s.players.includes(viewer);
    const votesIn = Object.keys(s.votes);
    const revealVotes = s.phase === 'guess' || over;
    return {
      players: s.players,
      phase: s.phase,
      timeLeftMs: s.timeLeftMs,
      imposterCount: s.imposters.length,
      packLabel: s.packLabel,
      /** 'crew' | 'imposter' for a player; null for a spectator until the game is over. */
      role: isPlayer ? (isImposter ? 'imposter' : 'crew') : null,
      /** The word, for crew; imposters and spectators only see it when the game is over. */
      word: over || (isPlayer && !isImposter) ? s.word : null,
      /** Imposters see each other. */
      partners: isImposter ? s.imposters.filter((p) => p !== viewer) : [],
      imposters: over ? s.imposters : undefined,
      order: s.order,
      speaker: speakerOf(s),
      round: s.phase === 'clue' ? Math.floor(s.slot / s.order.length) + 1 : null,
      clueRounds: s.clueRounds,
      clues: s.clues,
      ready: s.ready,
      voted: votesIn,
      myVote: isPlayer ? (s.votes[viewer] ?? null) : null,
      votes: revealVotes ? s.votes : undefined,
      tally: revealVotes ? tallyVotes(s) : undefined,
      accused: revealVotes ? s.accused : [],
      guessed: Object.keys(s.guesses),
      guesses: over ? s.guesses : undefined,
      winner: s.winner,
      seq: s.seq,
    };
  },
};
