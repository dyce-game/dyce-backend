import { WORD_HUNT_WORDS } from '../wordhunt/words.ts';

/**
 * Word Tiles dictionary (the default word set the server registers).
 *
 * SOURCE AND LICENCE: the Word Hunt list (original work for Dyce, see wordhunt/words.ts, 3-8 letters)
 * plus the short list below, which the project wrote for this game: common two-letter English words. Both
 * are original, so there is no external licence to carry. Nothing is copied or filtered from a tournament
 * word list.
 *
 * LIMITS: the combined list is small (about 5 500 words, nothing over 10 letters), so real players will
 * sometimes be refused a word that is valid English, and long board words are rare. This is a rule of the
 * game ("the server's dictionary decides"), not a bug, but it is why a bigger list should replace it before
 * Pool is switched on for Word Tiles.
 *
 * LOADING A LARGER LIST WITHOUT BREAKING DETERMINISM: the engine never reads a global list. It is built
 * with `createWordTilesEngine(wordSet)` where the word set is injected and has an `id` that is copied into
 * every match's state (`state.dict`). To use a bigger list (e.g. the public-domain ENABLE list, or SOWPODS
 * if its licence allows), the server loads the file at start-up, builds `makeWordSet(words, 'enable-1')` and
 * registers a SECOND engine entry for it. Matches already in play keep validating against the id they
 * started with, so the registry must hold every id that still has live matches; only new matches take the
 * new id. The word set is only consulted by `validate`/`apply` for a play; it is never part of the state,
 * so state hashes do not depend on it, but whether a play is legal does, which is why the id is pinned.
 */
export const WORD_TILES_DICT_ID = 'dyce-v1';

const TWO = `
am an as at be by do go he hi if in is it me my no of oh on or ox so to up us we ah ay ow er hm ma pa
`;

export const WORD_TILES_WORDS: readonly string[] = Array.from(
  new Set(
    [TWO, WORD_HUNT_WORDS.join(' ')]
      .join(' ')
      .split(/\s+/)
      .map((w) => w.trim().toUpperCase())
      .filter((w) => /^[A-Z]{2,15}$/.test(w)),
  ),
).sort();
