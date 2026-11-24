/**
 * The objectionable-text filter (Apple App Review guideline 1.2: "a method for filtering objectionable material from
 * being posted"). It is checked on the server for every name and message a person can publish, and the same function
 * is shared with the app so a name can be refused before it is sent.
 *
 * It is deliberately small and conservative: it blocks slurs, sexual-exploitation terms and calls to self-harm
 * everywhere, and ordinary profanity in NAMES (usernames, display names, group, space and poll titles), where there
 * is no conversation around the word. It does not try to read tone: people swearing at each other are handled by
 * Report and Block, and by the moderation queue.
 *
 * It is NOT a complete list and never will be. The seed lists below are a starting point for the trust-and-safety
 * owner to extend from reports (docs/BACKLOG.md). Matching looks through spacing, punctuation, repeated letters,
 * accents and look-alike digits ("f.u.c.k", "fuuuck", "sh1t"), and is written to leave real words and names alone
 * ("Nigeria", "Niger", "Scunthorpe", "class", "Kikelomo", "Pedro" are tested).
 */
export const CONTENT_BLOCKED = 'That wording is not allowed on Dyce.';

export type ContentContext = 'name' | 'message';
export type ContentVerdict = { ok: true } | { ok: false; severity: 'severe' | 'profane' };

/** Look-alike digits and symbols folded to the letter they stand for. */
const LOOKALIKE: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'i',
  '€': 'e',
  '£': 'l',
};

/** Zero-width and soft-hyphen characters people hide inside a word. */
const INVISIBLE = new RegExp('[\u200B-\u200F\u2060\uFEFF\u00AD]', 'g');

/** Letters only, in order, the way each word is written once separators and look-alikes are folded away. */
function fold(text: string): { tokens: string[]; squashed: string } {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '').replace(INVISIBLE, '').toLowerCase();
  let out = '';
  for (const ch of plain) out += LOOKALIKE[ch] ?? ch;
  const tokens = out.split(/[^a-z]+/).filter(Boolean);
  return { tokens, squashed: tokens.join('') };
}

/**
 * Each entry is a regular expression over LETTERS only. `+` after a letter lets it be repeated ("fuuuck").
 *  - substring: matched inside the text with the spaces and punctuation removed. Only for strings that are never
 *    part of an ordinary word.
 *  - token: must be a whole word (its own run of letters), so a name or word that merely contains it is left alone.
 */
const SEVERE_SUBSTRING = [
  'n+i+g{2,}', // the n-word and its variants (not Nigeria, Niger or Nigerian)
  'f+a+g{2,}o+t+',
  'c+h+i+l+d+p+o+r+n+',
  'k+i+l+l+y+o+u+r+s+e+l+f+',
  'g+o+k+i+l+l+y+o+u+r+s+e+l+f+',
];
const SEVERE_TOKEN = [
  'k+i+k+e+s?',
  'c+h+i+n+k+s?',
  't+r+a+n+n+(y|i+e+s)',
  'r+e+t+a+r+d+(s|e+d+)?',
  'p+a*e+d+o+(s|p+h+i+l+e+s?)?',
  'r+a+p+i+s+t+s?',
  'k+y+s+',
  's+p+i+c+s?',
  'c+o+o+n+s?',
];
/** Matched inside any single word of a name ("fuckyou", "bigbitch"), not across words. */
const PROFANE_INSIDE_WORD = [
  'f+u+c+k+',
  's+h+i+t+(h+e+a+d+|f+a+c+e+)',
  'b+i+t+c+h+',
  'a+s+s+h+o+l+e+',
  'p+u+s+s+y+',
  'w+h+o+r+e+s?',
  'd+i+c+k+h+e+a+d+',
  'a+s+h+a+w+o+',
  'o+l+o+s+h+o+',
];
/** Matched across the name with spaces and punctuation removed, to catch "f.u.c.k". Only the clearest ones. */
const PROFANE_SPACED_OUT = ['f+u+c+k+', 'm+o+t+h+e+r+f+u+c+k+e+r+'];
const PROFANE_TOKEN = [
  's+h+i+t+(s|t+y|e)?',
  'c+u+n+t+s?',
  's+l+u+t+s?',
  'b+a+s+t+a+r+d+s?',
  'w+a+n+k+e+r+s?',
  'p+o+r+n+o?',
];

const compile = (parts: string[], mode: 'sub' | 'token') =>
  new RegExp(mode === 'sub' ? `(?:${parts.join('|')})` : `^(?:${parts.join('|')})$`);

const severeSub = compile(SEVERE_SUBSTRING, 'sub');
const severeTok = compile(SEVERE_TOKEN, 'token');
const profaneInside = compile(PROFANE_INSIDE_WORD, 'sub');
const profaneSpaced = compile(PROFANE_SPACED_OUT, 'sub');
const profaneTok = compile(PROFANE_TOKEN, 'token');

export function checkContent(text: string, context: ContentContext): ContentVerdict {
  if (!text) return { ok: true };
  const { tokens, squashed } = fold(text);
  if (severeSub.test(squashed) || tokens.some((t) => severeTok.test(t))) {
    return { ok: false, severity: 'severe' };
  }
  if (
    context === 'name' &&
    (profaneSpaced.test(squashed) ||
      tokens.some((t) => profaneInside.test(t) || profaneTok.test(t)))
  ) {
    return { ok: false, severity: 'profane' };
  }
  return { ok: true };
}

export const isContentAllowed = (text: string, context: ContentContext): boolean =>
  checkContent(text, context).ok;
