import { z } from 'zod';
import type { GameEngine, GameResult, PlayerId, ValidateResult } from '../contract.ts';
import { nextInt, seedRng, shuffle, type RngState } from '../rng.ts';

/**
 * Whot! (Nigerian rules, 2–6 players, one round, first to play out wins). Rules decided here are
 * recorded in docs/DECISIONS.md (ADR-013).
 *
 * Deck: the standard 54 cards. 5 shapes (circle, triangle: 12 each; cross, square: 9 each; star: 7)
 * plus five Whot (20) cards.
 *
 * Specials: 1 Hold On (play again) · 2 Pick Two · 5 Pick Three · 8 Suspension (next player skipped)
 * · 14 General Market (everyone else picks one, you play again) · 20 Whot (play on anything, name a
 * shape). A Pick Two / Pick Three is answered by playing another card of the same number (the penalty
 * stacks and moves on) or by drawing the whole penalty.
 *
 * "Last card" / "Check up": the play that leaves one card must carry `call: true` (last card), and the
 * play that goes out must carry `call: true` (check up). Forgetting costs 2 cards (and a missed "check
 * up" means you have not won). The app sends the flag from a tap or automatically.
 */
export type WhotShape = 'circle' | 'triangle' | 'cross' | 'square' | 'star';
export const WHOT_SHAPES: readonly WhotShape[] = ['circle', 'triangle', 'cross', 'square', 'star'];
export type WhotCard = { shape: WhotShape | 'whot'; n: number };

export type WhotCfg = {
  /** Cards dealt to each player. Default 6 for 2–4 players, 5 for 5–6. */
  handSize?: number;
};

export type WhotEffect =
  'hold_on' | 'pick_two' | 'pick_three' | 'suspension' | 'general_market' | 'whot' | null;

/** What just happened, so renderers can animate the transition. `seq` increases on every action. */
export type WhotEvent = {
  seq: number;
  by: PlayerId;
  kind: 'play' | 'draw';
  card: WhotCard | null;
  /** Cards `by` drew (a draw action, or a missed-call penalty). Never says which cards. */
  drew: number;
  effect: WhotEffect;
  /** Shape named by a Whot. */
  requested: WhotShape | null;
  /** Players who each picked one card because of a General Market. */
  marketed: PlayerId[];
  missedCall: 'last_card' | 'check_up' | null;
};

export type WhotState = {
  players: PlayerId[];
  hands: Record<PlayerId, WhotCard[]>;
  /** Draw pile; the next card drawn is index 0. Hidden. */
  market: WhotCard[];
  /** Discard pile; the last element is the card in play. */
  pile: WhotCard[];
  turn: number;
  /** Shape the last Whot asked for; null otherwise. */
  requested: WhotShape | null;
  /** Unanswered Pick Two / Pick Three chain the current player faces. */
  pending: { n: number; total: number } | null;
  /** Consecutive draws that found nothing to draw (market and pile exhausted). */
  stalled: number;
  winner: PlayerId | null;
  endReason: 'out' | 'blocked' | null;
  last: WhotEvent | null;
  seq: number;
  rng: RngState;
};

export type WhotAction =
  { kind: 'play'; card: WhotCard; shape?: WhotShape; call?: boolean } | { kind: 'draw' };

const cardSchema = z.object({
  shape: z.enum(['circle', 'triangle', 'cross', 'square', 'star', 'whot']),
  n: z.number().int().min(1).max(20),
});

export const whotActionSchema: z.ZodType<WhotAction> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('play'),
    card: cardSchema,
    shape: z.enum(['circle', 'triangle', 'cross', 'square', 'star']).optional(),
    call: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('draw') }),
]);

// ---------------------------------------------------------------------------------------------
// Deck and helpers

const SHAPE_NUMBERS: Record<WhotShape, readonly number[]> = {
  circle: [1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14],
  triangle: [1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14],
  cross: [1, 2, 3, 5, 7, 10, 11, 13, 14],
  square: [1, 2, 3, 5, 7, 10, 11, 13, 14],
  star: [1, 2, 3, 4, 5, 7, 8],
};

export const WHOT_SPECIAL_NUMBERS: readonly number[] = [1, 2, 5, 8, 14, 20];

/** The 54-card deck in a fixed order. */
export function whotDeck(): WhotCard[] {
  const deck: WhotCard[] = [];
  for (const shape of WHOT_SHAPES) {
    for (const n of SHAPE_NUMBERS[shape]) deck.push({ shape, n });
  }
  for (let i = 0; i < 5; i++) deck.push({ shape: 'whot', n: 20 });
  return deck;
}

export const whotCardPoints = (c: WhotCard): number => c.n;
const sameCard = (a: WhotCard, b: WhotCard): boolean => a.shape === b.shape && a.n === b.n;
const isSpecial = (c: WhotCard): boolean => WHOT_SPECIAL_NUMBERS.includes(c.n);

/** May `card` be played now? Pure so renderers can highlight playable cards from `view()`. */
export function whotCanPlay(
  card: WhotCard,
  top: WhotCard,
  requested: WhotShape | null,
  pending: { n: number } | null,
): boolean {
  if (pending) return card.n === pending.n;
  if (card.shape === 'whot') return true;
  if (requested) return card.shape === requested;
  return card.shape === top.shape || card.n === top.n;
}

const defaultHandSize = (players: number): number => (players <= 4 ? 6 : 5);

function effectOf(card: WhotCard): WhotEffect {
  switch (card.n) {
    case 1:
      return 'hold_on';
    case 2:
      return 'pick_two';
    case 5:
      return 'pick_three';
    case 8:
      return 'suspension';
    case 14:
      return 'general_market';
    case 20:
      return 'whot';
    default:
      return null;
  }
}

/** A mutable working copy, only ever created inside `apply`. */
type Work = Omit<WhotState, 'hands'> & { hands: Record<PlayerId, WhotCard[]> };

function clone(s: WhotState): Work {
  const hands: Record<PlayerId, WhotCard[]> = {};
  for (const p of s.players) hands[p] = [...(s.hands[p] ?? [])];
  return { ...s, hands, market: [...s.market], pile: [...s.pile], players: [...s.players] };
}

/** Draw up to `n` cards for `p`, reshuffling the discard pile (all but the top card) if needed. */
function drawCards(w: Work, p: PlayerId, n: number): number {
  const hand = w.hands[p] ?? [];
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    if (w.market.length === 0 && w.pile.length > 1) {
      const top = w.pile[w.pile.length - 1] as WhotCard;
      const [shuffled, rng] = shuffle(w.rng, w.pile.slice(0, -1));
      w.market = shuffled;
      w.pile = [top];
      w.rng = rng;
    }
    const card = w.market.shift();
    if (card === undefined) break;
    hand.push(card);
    drawn++;
  }
  w.hands[p] = hand;
  return drawn;
}

const topOf = (s: { pile: WhotCard[] }): WhotCard => s.pile[s.pile.length - 1] as WhotCard;

function handPoints(hand: readonly WhotCard[]): number {
  return hand.reduce((sum, c) => sum + whotCardPoints(c), 0);
}

// ---------------------------------------------------------------------------------------------
// Engine

export const whotEngine: GameEngine<WhotState, WhotAction, WhotCfg> = {
  slug: 'whot',
  actionSchema: whotActionSchema,
  timers: { turnMs: 25_000 },

  init(players, seed, cfg) {
    if (players.length < 2 || players.length > 6) throw new Error('Whot needs 2 to 6 players');
    if (new Set(players).size !== players.length) throw new Error('Duplicate players');
    const handSize = cfg?.handSize ?? defaultHandSize(players.length);
    if (!Number.isInteger(handSize) || handSize < 1 || handSize * players.length > 40) {
      throw new Error('Invalid handSize');
    }

    const [market, rng0] = shuffle(seedRng(seed), whotDeck());

    const hands: Record<PlayerId, WhotCard[]> = Object.fromEntries(players.map((p) => [p, []]));
    for (let r = 0; r < handSize; r++) {
      for (const p of players) hands[p]!.push(market.shift() as WhotCard);
    }

    // The starter card must be an ordinary card: specials found on top go to the bottom.
    const starterIdx = market.findIndex((c) => !isSpecial(c));
    const skipped = market.splice(0, starterIdx);
    const starter = market.shift() as WhotCard;
    market.push(...skipped);

    const [first, rng] = nextInt(rng0, players.length);

    return {
      players: [...players],
      hands,
      market,
      pile: [starter],
      turn: first,
      requested: null,
      pending: null,
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
    if (a.kind === 'draw') return { ok: true };

    const hand = s.hands[by] ?? [];
    if (!hand.some((c) => sameCard(c, a.card))) return { ok: false, code: 'card_not_in_hand' };
    if (!whotCanPlay(a.card, topOf(s), s.requested, s.pending)) {
      return { ok: false, code: s.pending ? 'must_defend_or_draw' : 'card_not_playable' };
    }
    if (a.card.shape === 'whot') {
      if (a.shape === undefined) return { ok: false, code: 'shape_required' };
    } else if (a.shape !== undefined) {
      return { ok: false, code: 'shape_not_allowed' };
    }
    return { ok: true };
  },

  apply(s, by, a) {
    const w = clone(s);
    w.seq = s.seq + 1;
    const n = w.players.length;
    const advance = (k: number): number => (w.turn + k) % n;

    if (a.kind === 'draw') {
      const want = w.pending ? w.pending.total : 1;
      const drew = drawCards(w, by, want);
      w.pending = null;
      w.stalled = drew === 0 ? w.stalled + 1 : 0;
      w.turn = advance(1);
      w.last = {
        seq: w.seq,
        by,
        kind: 'draw',
        card: null,
        drew,
        effect: null,
        requested: null,
        marketed: [],
        missedCall: null,
      };
      if (w.stalled >= n) w.endReason = 'blocked';
      return w;
    }

    // play
    const hand = w.hands[by] as WhotCard[];
    const idx = hand.findIndex((c) => sameCard(c, a.card));
    const [card] = hand.splice(idx, 1) as [WhotCard];
    w.pile.push(card);
    w.stalled = 0;
    w.requested = card.shape === 'whot' ? (a.shape ?? null) : null;

    const called = a.call === true;
    let missedCall: WhotEvent['missedCall'] = null;
    let drew = 0;
    if (hand.length === 0) {
      if (called) {
        w.winner = by;
        w.endReason = 'out';
        w.pending = null;
        w.last = {
          seq: w.seq,
          by,
          kind: 'play',
          card,
          drew: 0,
          effect: effectOf(card),
          requested: w.requested,
          marketed: [],
          missedCall: null,
        };
        return w;
      }
      missedCall = 'check_up';
    } else if (hand.length === 1 && !called) {
      missedCall = 'last_card';
    }
    if (missedCall !== null) drew = drawCards(w, by, 2);

    const effect = effectOf(card);
    const marketed: PlayerId[] = [];
    if (effect === 'pick_two' || effect === 'pick_three') {
      w.pending = { n: card.n, total: (w.pending?.total ?? 0) + (card.n === 2 ? 2 : 3) };
      w.turn = advance(1);
    } else {
      w.pending = null;
      if (effect === 'hold_on') {
        // play again: turn stays
      } else if (effect === 'suspension') {
        w.turn = advance(2);
      } else if (effect === 'general_market') {
        for (let k = 1; k < n; k++) {
          const p = w.players[(w.turn + k) % n] as PlayerId;
          if (drawCards(w, p, 1) > 0) marketed.push(p);
        }
      } else {
        w.turn = advance(1);
      }
    }

    w.last = {
      seq: w.seq,
      by,
      kind: 'play',
      card,
      drew,
      effect,
      requested: w.requested,
      marketed,
      missedCall,
    };
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
    const current = over ? null : (s.players[s.turn] ?? null);
    return {
      players: s.players,
      current,
      turn: s.turn,
      /** Your own cards; empty for spectators. */
      hand: viewer === 'spectator' ? [] : [...(s.hands[viewer] ?? [])],
      counts,
      marketCount: s.market.length,
      pileCount: s.pile.length,
      top: topOf(s),
      requested: s.requested,
      pending: s.pending,
      winner: s.winner,
      endReason: s.endReason,
      last: s.last,
      // Everything is shown once the game is over (final scoring), never the market order or RNG.
      hands: over ? s.hands : undefined,
      points: over
        ? Object.fromEntries(s.players.map((p) => [p, handPoints(s.hands[p] ?? [])]))
        : undefined,
    };
  },
};

// ---------------------------------------------------------------------------------------------
// Helpers for bots, timeouts and tests (they read state, so server/bot use only)

/** Every legal action for `by`: plays first (a Whot offers one per shape, and with/without `call`), then draw. */
export function whotLegalActions(s: WhotState, by: PlayerId): WhotAction[] {
  if (s.endReason !== null || s.players[s.turn] !== by) return [];
  const hand = s.hands[by] ?? [];
  const seen = new Set<string>();
  const out: WhotAction[] = [];
  const left = hand.length - 1;
  for (const card of hand) {
    const key = `${card.shape}:${card.n}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!whotCanPlay(card, topOf(s), s.requested, s.pending)) continue;
    // When the play leaves 0 or 1 cards the call matters, so offer it both ways (to exercise the penalty).
    const calls: (boolean | undefined)[] = left <= 1 ? [true, false] : [undefined];
    for (const call of calls) {
      const extra = call === undefined ? {} : { call };
      if (card.shape === 'whot') {
        for (const shape of WHOT_SHAPES) out.push({ kind: 'play', card, shape, ...extra });
      } else {
        out.push({ kind: 'play', card, ...extra });
      }
    }
  }
  out.push({ kind: 'draw' });
  return out;
}

/**
 * A sensible move for a timed-out or bot player: play the first legal card that is not a Whot (a Whot
 * only if nothing else works), naming the shape it holds most of, always making the call; otherwise draw.
 */
export function whotAutoAction(s: WhotState, by: PlayerId): WhotAction {
  const hand = s.hands[by] ?? [];
  const legal = whotLegalActions(s, by).filter(
    (a): a is Extract<WhotAction, { kind: 'play' }> => a.kind === 'play' && a.call !== false,
  );
  const ordinary = legal.find((a) => a.card.shape !== 'whot');
  if (ordinary) return ordinary;
  const whot = legal[0];
  if (whot && whot.card.shape === 'whot') {
    const counts = new Map<WhotShape, number>();
    for (const c of hand) {
      if (c.shape !== 'whot') counts.set(c.shape, (counts.get(c.shape) ?? 0) + 1);
    }
    // Most-held shape; ties go to the earlier shape in WHOT_SHAPES (no reliance on sort stability).
    let best: WhotShape = 'circle';
    let bestCount = -1;
    for (const shape of WHOT_SHAPES) {
      const n = counts.get(shape) ?? 0;
      if (n > bestCount) {
        best = shape;
        bestCount = n;
      }
    }
    return { kind: 'play', card: whot.card, shape: best, call: true };
  }
  return { kind: 'draw' };
}
