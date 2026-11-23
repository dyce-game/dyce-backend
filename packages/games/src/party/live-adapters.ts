import type { PlayerId } from '../contract.ts';
import { isCleanText, tidyText } from './common.ts';

/**
 * Small pure helpers the live registry uses for the party games: who may talk to whom, and text limits.
 * They read engine state but never change it. The room (apps/game-server) is the only caller.
 */
export type PartyBlockersFn = (state: unknown) => PlayerId[];
export type PartyChatFn = (state: unknown, from: PlayerId) => PlayerId[] | null;

export const CHAT_MAX_CHARS = 200;

export function clampInt(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

/** A chat line the room may relay: trimmed, short, and not on the blocklist. Null when it is not. */
export function cleanChatText(raw: string): string | null {
  const text = tidyText(raw);
  if (text.length === 0 || text.length > CHAT_MAX_CHARS) return null;
  return isCleanText(text) ? text : null;
}

type ImposterLike = { phase: string; players: PlayerId[] };
type WerewolfLike = {
  phase: string;
  players: PlayerId[];
  dead: PlayerId[];
  roles: Record<PlayerId, string>;
};
type CharadesLike = { phase: string; players: PlayerId[]; schedule: PlayerId[]; turn: number };

/**
 * The people who hear a line typed by `from` right now, or null when `from` may not talk.
 *
 * - Imposter: talk while voting and once it is over (never during clues or the imposter's guess, where it
 *   could leak the word).
 * - Werewolf: at night only the living werewolves talk (to each other); by day the living talk to everyone.
 *   The dead talk only to the dead, and may listen to everyone (they spectate with every role visible).
 *   When the game is over everyone talks to everyone.
 * - Charades: everyone but the person acting (their team guesses out loud or in chat).
 * - Doodle Guess: no chat; a guess is an engine action.
 */
export function chatAudienceFor(
  game: 'imposter' | 'werewolf' | 'charades',
  state: unknown,
  from: PlayerId,
): PlayerId[] | null {
  if (game === 'imposter') {
    const s = state as ImposterLike;
    if (!s.players.includes(from)) return null;
    return s.phase === 'vote' || s.phase === 'over' ? [...s.players] : null;
  }
  if (game === 'werewolf') {
    const s = state as WerewolfLike;
    if (!s.players.includes(from)) return null;
    if (s.phase === 'over') return [...s.players];
    const dead = s.dead;
    if (dead.includes(from)) return [...dead];
    if (s.phase === 'night') {
      if (s.roles[from] !== 'werewolf') return null;
      const wolves = s.players.filter((p) => s.roles[p] === 'werewolf' && !dead.includes(p));
      return [...wolves, ...dead];
    }
    return [...s.players];
  }
  const s = state as CharadesLike;
  if (!s.players.includes(from)) return null;
  if (s.phase === 'acting' && s.schedule[s.turn] === from) return null;
  return [...s.players];
}

// ---------------------------------------------------------------------------------------------
// Streams: the part of a view that is large and grows (Doodle Guess strokes) travels as deltas

export type CanvasStroke = { id: number; color: number; width: number; pts: [number, number][] };

/**
 * The `canvas` message of Doodle Guess. A client keeps `strokes` and applies each message in order with
 * `applyCanvas`: `reset: true` replaces everything (join, a new turn, undo, clear); otherwise `extend` adds
 * points to strokes it already has, then `strokes` are appended.
 */
export type CanvasMessage = {
  /** The turn the canvas belongs to; a new turn starts empty. */
  turn: number;
  reset: boolean;
  strokes: CanvasStroke[];
  extend: { id: number; pts: [number, number][] }[];
};

/** What the room remembers a seat has been sent, so it only sends the difference. */
export type CanvasCursor = { turn: number; ids: number[]; counts: number[] };

type CanvasState = { turn: number; strokes: CanvasStroke[] };

/** Takes the strokes out of a Doodle Guess view (they go in `canvas` messages) and leaves their count. */
export function splitDoodleView(view: unknown): { rest: unknown; stream: CanvasState } {
  const v = view as { turn?: number; strokes?: CanvasStroke[] } & Record<string, unknown>;
  const strokes = v.strokes ?? [];
  const { strokes: _omit, ...rest } = v;
  void _omit;
  return {
    rest: { ...rest, strokeCount: strokes.length },
    stream: { turn: v.turn ?? 0, strokes },
  };
}

/** The message that brings a seat from `cursor` to `now`, or null when it already has everything. */
export function diffCanvas(
  cursor: CanvasCursor | null,
  now: CanvasState,
): { msg: CanvasMessage | null; cursor: CanvasCursor } {
  const next: CanvasCursor = {
    turn: now.turn,
    ids: now.strokes.map((s) => s.id),
    counts: now.strokes.map((s) => s.pts.length),
  };
  const full = (): { msg: CanvasMessage; cursor: CanvasCursor } => ({
    msg: { turn: now.turn, reset: true, strokes: now.strokes, extend: [] },
    cursor: next,
  });
  if (!cursor || cursor.turn !== now.turn) return full();
  const n = cursor.ids.length;
  if (now.strokes.length < n) return full();
  for (let i = 0; i < n; i++) {
    const s = now.strokes[i]!;
    // Stroke ids never repeat, so a changed id or a shorter stroke means undo or clear.
    if (s.id !== cursor.ids[i] || s.pts.length < cursor.counts[i]!) return full();
  }
  const extend: CanvasMessage['extend'] = [];
  for (let i = 0; i < n; i++) {
    const s = now.strokes[i]!;
    if (s.pts.length > cursor.counts[i]!)
      extend.push({ id: s.id, pts: s.pts.slice(cursor.counts[i]) });
  }
  const added = now.strokes.slice(n);
  if (extend.length === 0 && added.length === 0) return { msg: null, cursor: next };
  return { msg: { turn: now.turn, reset: false, strokes: added, extend }, cursor: next };
}

/** Applies a `canvas` message to the strokes a client already has. Pure: returns the new list. */
export function applyCanvas(strokes: readonly CanvasStroke[], msg: CanvasMessage): CanvasStroke[] {
  if (msg.reset) return msg.strokes.map((s) => ({ ...s, pts: [...s.pts] }));
  const out = strokes.map((s) => {
    const more = msg.extend.find((e) => e.id === s.id);
    return more ? { ...s, pts: [...s.pts, ...more.pts] } : s;
  });
  return [...out, ...msg.strokes.map((s) => ({ ...s, pts: [...s.pts] }))];
}
