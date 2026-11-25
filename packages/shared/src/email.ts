/**
 * Email addresses (ADR-044). Like phone numbers they are identifiers that must not leak: the server stores
 * only a keyed hash plus a masked hint, and logs only the masked form. This file is the one definition of what
 * counts as an address and how two spellings of the same address are made equal.
 */

export const EMAIL_MAX_LENGTH = 254; // RFC 5321 path limit
const LOCAL_MAX = 64;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// letters, digits and the punctuation real mailboxes use; quoted strings and comments are not accepted
const LOCAL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;

/**
 * Trims and lower-cases an address and checks its shape. Returns null when it is not a deliverable-looking
 * address. Deliberately conservative: it rejects what no mail server would accept (spaces, a missing dot in the
 * domain, an IP literal, a trailing dot, a one-letter top-level domain) and nothing fancier, because the only real
 * proof an address works is the code we send to it.
 *
 * `name+tag@gmail.com` is kept as written: it is a different address to Dyce (see ADR-044 for why).
 */
export function normalizeEmail(raw: string): string | null {
  const email = raw.normalize('NFKC').trim().toLowerCase();
  if (email.length < 6 || email.length > EMAIL_MAX_LENGTH) return null;
  const at = email.lastIndexOf('@');
  if (at < 1 || email.indexOf('@') !== at) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > LOCAL_MAX || !LOCAL.test(local)) return null;
  const labels = domain.split('.');
  if (labels.length < 2) return null;
  if (!labels.every((l) => LABEL.test(l))) return null;
  const tld = labels[labels.length - 1]!;
  if (tld.length < 2 || /^\d+$/.test(tld)) return null;
  return email;
}

export function isValidEmail(raw: string): boolean {
  return normalizeEmail(raw) !== null;
}

/** "tunde.okafor@gmail.com" -> "t•••••@gmail.com". For logs and UI only; never reversible. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '•'.repeat(Math.min(email.length, 6));
  const local = email.slice(0, at);
  return `${local[0]}${'•'.repeat(Math.max(3, Math.min(6, local.length - 1)))}${email.slice(at)}`;
}
