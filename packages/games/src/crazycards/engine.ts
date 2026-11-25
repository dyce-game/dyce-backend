import { z } from 'zod';
import type { GameEngine, GameResult, PlayerId, ValidateResult } from '../contract.ts';
import { nextInt, seedRng, shuffle, type RngState } from '../rng.ts';
import { assertPlayers } from '../party/common.ts';

/**
 * Crazy Cards: our own name for the colour-and-number shedding card game (2–6 players, one round, first
 * to play out wins). Never ship the trademarked name. Rules decided here are in docs/DECISIONS.md (ADR-023).
 *
 * Deck: 108 cards. Four colours, each with one 0, two of every 1–9 and two each of Skip, Reverse and
 * Draw Two (25 × 4 = 100), plus four Wild and four Wild Draw Four.
 *
 * Play: match the colour in force or the value of the top card; Wilds go on anything and name a colour.
 * Skip: next player misses a turn. Reverse: direction flips (with 2 players it works as Skip). Draw Two:
 * next player draws 2 and misses a turn. Wild Draw Four: next player draws 4 and misses a turn (legal at
 * any time, no challenge). No stacking. A player with nothing to play (or who wants to) draws one card; if
 * that card is playable they may play it or `pass`, otherwise the turn passes by itself.
 *
 * "Last card": the play that leaves exactly one card must carry `call: true`, otherwise the player draws 2.
 * The app sends the flag from a tap or automatically. Going out needs no call.
 */
export type CrazyColor = 'red' | 'yellow' | 'green' | 'blue';
export const CRAZY_COLORS: readonly CrazyColor[] = ['red', 'yellow', 'green', 'blue'];
export type CrazyValue =
  | '0'
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | 'skip'
  | 'reverse'
  | 'draw_two'
  | 'wild'
  | 'draw_four';
export type CrazyCard = { color: CrazyColor | 'wild'; value: CrazyValue };

export type CrazyCardsCfg = {
  /** Cards dealt to each player. Default 7. */
  handSize?: number;
};

export type CrazyEffect = 'skip' | 'reverse' | 'draw_two' | 'wild' | 'draw_four' | null;

/** What just happened, so renderers can animate it. `seq` increases on every action. */
export type CrazyEvent = {
  seq: number;
  by: PlayerId;
  kind: 'play' | 'draw' | 'pass';
  card: CrazyCard | null;
  /** Cards `by` drew (a draw, or the missed-call penalty). Never says which cards. */
  drew: number;
  effect: CrazyEffect;
  /** Colour in force after this action. */
  color: CrazyColor;
  /** Who drew the cards a Draw Two / Draw Four forced, and how many. */
  victim: PlayerId | null;
  victimDrew: number;
  missedCall: boolean;
};

export type CrazyCardsState = {
  players: PlayerId[];
  hands: Record<PlayerId, CrazyCard[]>;
  /** Draw pile; the next card drawn is index 0. Hidden. */
  deck: CrazyCard[];
  /** Discard pile; the last element is the card in play. */
  pile: CrazyCard[];
  turn: number;
  /** 1 clockwise, -1 the other way. */
  dir: 1 | -1;
  /** Colour in force (the top card's, or the one a Wild named). */
  color: CrazyColor;
  /** The card the current player has just drawn and may still play (or pass). */
  drawn: CrazyCard | null;
  /** Consecutive draws that found nothing to draw. */
  stalled: number;
  winner: PlayerId | null;
  endReason: 'out' | 'blocked' | null;
  last: CrazyEvent | null;
  seq: number;
  rng: RngState;
};

export type CrazyCardsAction =
  | { kind: 'play'; card: CrazyCard; color?: CrazyColor; call?: boolean }
  | { kind: 'draw' }
  | { kind: 'pass' };

const colorSchema = z.enum(['red', 'yellow', 'green', 'blue']);
const cardSchema = z.object({
  color: z.enum(['red', 'yellow', 'green', 'blue', 'wild']),
  value: z.enum([
    '0',
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
    'skip',
    'reverse',
    'draw_two',
    'wild',
    'draw_four',
  ]),
});

export const crazyCardsActionSchema: z.ZodType<CrazyCardsAction> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('play'),
    card: cardSchema,
    color: colorSchema.optional(),
    call: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('draw') }),
  z.object({ kind: z.literal('pass') }),
]);

// ---------------------------------------------------------------------------------------------
// Deck and helpers

/** The 108-card deck in a fixed order. */
export function crazyCardsDeck(): CrazyCard[] {
  const deck: CrazyCard[] = [];
  for (const color of CRAZY_COLORS) {
    deck.push({ color, value: '0' });
    for (const value of [
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      'skip',
      'reverse',
      'draw_two',
    ] as const) {
      deck.push({ color, value }, { color, value });
    }
  }
  for (let i = 0; i < 4; i++) deck.push({ color: 'wild', value: 'wild' });
  for (let i = 0; i < 4; i++) deck.push({ color: 'wild', value: 'draw_four' });
  return deck;
}

/** Scoring value of a card left in hand: number = face, action = 20, wild = 50. */
export function crazyCardPoints(c: CrazyCard): number {
  if (c.color === 'wild') return 50;
  if (c.value === 'skip' || c.value === 'reverse' || c.value === 'draw_two') return 20;
  return Number(c.value);
}

const sameCard = (a: CrazyCard, b: CrazyCard): boolean =>
  a.color === b.color && a.value === b.value;
const isNumber = (c: CrazyCard): boolean => c.color !== 'wild' && /^[0-9]$/.test(c.value);
const topOf = (s: { pile: CrazyCard[] }): CrazyCard => s.pile[s.pile.length - 1] as CrazyCard;

/** May `card` be played now? Pure so renderers can highlight playable cards from `view()`. */
export function crazyCanPlay(card: CrazyCard, top: CrazyCard, color: CrazyColor): boolean {
  if (card.color === 'wild') return true;
  return card.color === color || card.value === top.value;
}

function effectOf(card: CrazyCard): CrazyEffect {
  switch (card.value) {
    case 'skip':
      return 'skip';
    case 'reverse':
      return 'reverse';
    case 'draw_two':
      return 'draw_two';
    case 'wild':
      return 'wild';
    case 'draw_four':
      return 'draw_four';
    default:
      return null;
  }
}

type Work = Omit<CrazyCardsState, 'hands'> & { hands: Record<PlayerId, CrazyCard[]> };

function clone(s: CrazyCardsState): Work {
  const hands: Record<PlayerId, CrazyCard[]> = {};
  for (const p of s.players) hands[p] = [...(s.hands[p] ?? [])];
  return { ...s, hands, deck: [...s.deck], pile: [...s.pile], players: [...s.players] };
}

/** Draw up to `n` cards for `p`, reshuffling the discard pile (all but the top card) if needed. */
function drawCards(w: Work, p: PlayerId, n: number): CrazyCard[] {
  const hand = w.hands[p] ?? [];
  const got: CrazyCard[] = [];
  for (let i = 0; i < n; i++) {
    if (w.deck.length === 0 && w.pile.length > 1) {
      const top = w.pile[w.pile.length - 1] as CrazyCard;
      const [shuffled, rng] = shuffle(w.rng, w.pile.slice(0, -1));
      w.deck = shuffled;
      w.pile = [top];
      w.rng = rng;
    }
    const card = w.deck.shift();
    if (card === undefined) break;
    hand.push(card);
    got.push(card);
  }
  w.hands[p] = hand;
  return got;
}

const handPoints = (hand: readonly CrazyCard[]): number =>
  hand.reduce((sum, c) => sum + crazyCardPoints(c), 0);

// ---------------------------------------------------------------------------------------------
// Engine

export const crazyCardsEngine: GameEngine<CrazyCardsState, CrazyCardsAction, CrazyCardsCfg> = {
  slug: 'crazy-cards',
  actionSchema: crazyCardsActionSchema,
  timers: { turnMs: 25_000 },

  init(players, seed, cfg) {
    assertPlayers(players, 2, 6);
    const handSize = cfg?.handSize ?? 7;
    if (!Number.isInteger(handSize) || handSize < 1 || handSize * players.length > 60) {
      throw new Error('Invalid handSize');
    }

    const [deck, rng0] = shuffle(seedRng(seed), crazyCardsDeck());
    const hands: Record<PlayerId, CrazyCard[]> = Object.fromEntries(players.map((p) => [p, []]));
    for (let r = 0; r < handSize; r++) {
      for (const p of players) hands[p]!.push(deck.shift() as CrazyCard);
    }

    // The starter must be a number card: anything else found on top goes to the bottom.
    const starterIdx = deck.findIndex(isNumber);
    const skipped = deck.splice(0, starterIdx);
    const starter = deck.shift() as CrazyCard;
    deck.push(...skipped);

    const [first, rng] = nextInt(rng0, players.length);
    return {
      players: [...players],
      hands,
      deck,
      pile: [starter],
      turn: first,
      dir: 1,
      color: starter.color as CrazyColor,
      drawn: null,
      stalled: 0,
      winner: null,
      endReason: null,
      last: null,
      seq: 0,
      rng,
    };
  },

  currentPlayers(s) {
    if (s.endReason !== null) return [];
    const p = s.players[s.turn];
    return p === undefined ? [] : [p];
  },

  validate(s, by, a): ValidateResult {
    if (s.endReason !== null) return { ok: false, code: 'game_over' };
    if (s.players[s.turn] !== by) return { ok: false, code: 'not_your_turn' };
    if (a.kind === 'draw') return s.drawn ? { ok: false, code: 'already_drew' } : { ok: true };
    if (a.kind === 'pass') return s.drawn ? { ok: true } : { ok: false, code: 'draw_first' };

    const hand = s.hands[by] ?? [];
    if (!hand.some((c) => sameCard(c, a.card))) return { ok: false, code: 'card_not_in_hand' };
    if (s.drawn && !sameCard(s.drawn, a.card)) return { ok: false, code: 'only_drawn_card' };
    if (!crazyCanPlay(a.card, topOf(s), s.color)) return { ok: false, code: 'card_not_playable' };
    if (a.card.color === 'wild') {
      if (a.color === undefined) return { ok: false, code: 'color_required' };
    } else if (a.color !== undefined) {
      return { ok: false, code: 'color_not_allowed' };
    }
    return { ok: true };
  },

  apply(s, by, a) {
    const w = clone(s);
    w.seq = s.seq + 1;
    const n = w.players.length;
    const step = (from: number, k: number): number => (((from + w.dir * k) % n) + n) % n;
    const event = (e: Partial<CrazyEvent> & Pick<CrazyEvent, 'kind'>): CrazyEvent => ({
      seq: w.seq,
      by,
      card: null,
      drew: 0,
      effect: null,
      color: w.color,
      victim: null,
      victimDrew: 0,
      missedCall: false,
      ...e,
    });

    if (a.kind === 'draw') {
      const got = drawCards(w, by, 1);
      w.stalled = got.length === 0 ? w.stalled + 1 : 0;
      const card = got[0];
      if (card !== undefined && crazyCanPlay(card, topOf(w), w.color)) {
        w.drawn = card; // the same player may play it or pass
      } else {
        w.drawn = null;
        w.turn = step(w.turn, 1);
        if (w.stalled >= n) w.endReason = 'blocked';
      }
      w.last = event({ kind: 'draw', drew: got.length });
      return w;
    }

    if (a.kind === 'pass') {
      w.drawn = null;
      w.turn = step(w.turn, 1);
      w.last = event({ kind: 'pass' });
      return w;
    }

    // play
    const hand = w.hands[by] as CrazyCard[];
    const idx = hand.findIndex((c) => sameCard(c, a.card));
    const [card] = hand.splice(idx, 1) as [CrazyCard];
    w.pile.push(card);
    w.drawn = null;
    w.stalled = 0;
    w.color = card.color === 'wild' ? (a.color as CrazyColor) : card.color;

    const effect = effectOf(card);
    if (hand.length === 0) {
      w.winner = by;
      w.endReason = 'out';
      w.last = event({ kind: 'play', card, effect });
      return w;
    }

    let drew = 0;
    let missedCall = false;
    if (hand.length === 1 && a.call !== true) {
      missedCall = true;
      drew = drawCards(w, by, 2).length;
    }

    let victim: PlayerId | null = null;
    let victimDrew = 0;
    if (effect === 'skip') {
      w.turn = step(w.turn, 2);
    } else if (effect === 'reverse') {
      w.dir = (w.dir === 1 ? -1 : 1) as 1 | -1;
      w.turn = n === 2 ? w.turn : step(w.turn, 1);
    } else if (effect === 'draw_two' || effect === 'draw_four') {
      victim = w.players[step(w.turn, 1)] as PlayerId;
      victimDrew = drawCards(w, victim, effect === 'draw_two' ? 2 : 4).length;
      w.turn = step(w.turn, 2);
    } else {
      w.turn = step(w.turn, 1);
    }
    w.last = event({ kind: 'play', card, drew, effect, victim, victimDrew, missedCall });
    return w;
  },

  isTerminal(s) {
    return s.endReason !== null;
  },

  result(s): GameResult {
    if (s.endReason === null) return { placements: [], draw: false };
    const rest = s.players.filter((p) => p !== s.winner);
    const groups = new Map<number, PlayerId[]>();
    for (const p of rest) {
      const pts = handPoints(s.hands[p] ?? []);
      groups.set(pts, [...(groups.get(pts) ?? []), p]);
    }
    const ranked = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, ps]) => ps);
    const placements = s.winner === null ? ranked : [[s.winner], ...ranked];
    return { placements, draw: (placements[0]?.length ?? 0) > 1 };
  },

  view(s, viewer) {
    const over = s.endReason !== null;
    const counts: Record<PlayerId, number> = {};
    for (const p of s.players) counts[p] = s.hands[p]?.length ?? 0;
    const hand = viewer === 'spectator' ? [] : [...(s.hands[viewer] ?? [])];
    return {
      players: s.players,
      current: over ? null : (s.players[s.turn] ?? null),
      turn: s.turn,
      dir: s.dir,
      /** Your own cards; empty for spectators. */
      hand,
      counts,
      deckCount: s.deck.length,
      pileCount: s.pile.length,
      top: topOf(s),
      color: s.color,
      /** Only the player to move sees that they drew a playable card (it is also in their hand). */
      drawn: viewer !== 'spectator' && s.players[s.turn] === viewer ? s.drawn : null,
      winner: s.winner,
      endReason: s.endReason,
      last: s.last,
      // Hands are shown once the game is over (final scoring), never the deck order or RNG.
      hands: over ? s.hands : undefined,
      points: over
        ? Object.fromEntries(s.players.map((p) => [p, handPoints(s.hands[p] ?? [])]))
        : undefined,
    };
  },
};

// ---------------------------------------------------------------------------------------------
// Helpers for bots, timeouts and tests (they read state, so server/bot use only)

const ALL_CARDS_KEY = (c: CrazyCard): string => `${c.color}:${c.value}`;

/** Every legal action for `by`: plays first (a Wild offers one per colour; leaving 1 card is offered with and without the call), then draw / pass. */
export function crazyCardsLegalActions(s: CrazyCardsState, by: PlayerId): CrazyCardsAction[] {
  if (s.endReason !== null || s.players[s.turn] !== by) return [];
  const hand = s.hands[by] ?? [];
  const seen = new Set<string>();
  const out: CrazyCardsAction[] = [];
  const left = hand.length - 1;
  for (const card of hand) {
    const key = ALL_CARDS_KEY(card);
    if (seen.has(key)) continue;
    seen.add(key);
    if (s.drawn && !sameCard(s.drawn, card)) continue;
    if (!crazyCanPlay(card, topOf(s), s.color)) continue;
    const calls: (boolean | undefined)[] = left === 1 ? [true, false] : [undefined];
    for (const call of calls) {
      const extra = call === undefined ? {} : { call };
      if (card.color === 'wild') {
        for (const color of CRAZY_COLORS) out.push({ kind: 'play', card, color, ...extra });
      } else {
        out.push({ kind: 'play', card, ...extra });
      }
    }
  }
  out.push(s.drawn ? { kind: 'pass' } : { kind: 'draw' });
  return out;
}

/**
 * A sensible move for a timed-out or bot player: play the first legal card that is not a Wild (a Wild
 * only if nothing else works) naming the colour held most, always making the call; otherwise draw (or
 * pass after a draw that found nothing playable).
 */
export function crazyCardsAutoAction(s: CrazyCardsState, by: PlayerId): CrazyCardsAction {
  const hand = s.hands[by] ?? [];
  const plays = crazyCardsLegalActions(s, by).filter(
    (a): a is Extract<CrazyCardsAction, { kind: 'play' }> => a.kind === 'play' && a.call !== false,
  );
  const ordinary = plays.find((a) => a.card.color !== 'wild');
  if (ordinary) return ordinary;
  const wild = plays[0];
  if (wild) {
    // Colour held most; ties go to the earlier colour in CRAZY_COLORS.
    let best: CrazyColor = 'red';
    let bestCount = -1;
    for (const color of CRAZY_COLORS) {
      const count = hand.filter((c) => c.color === color).length;
      if (count > bestCount) {
        best = color;
        bestCount = count;
      }
    }
    return { kind: 'play', card: wild.card, color: best, call: true };
  }
  return s.drawn ? { kind: 'pass' } : { kind: 'draw' };
}
