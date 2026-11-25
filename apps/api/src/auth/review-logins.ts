import { normalizeEmail, normalizePhone } from '@dyce/shared';

/**
 * Demo accounts for App Review (Apple guideline 2.1(a): "include demo account info"). Apple's reviewers cannot
 * receive an SMS or an email, so a few named identities accept a fixed six-digit code that nobody can guess from
 * outside. `REVIEW_LOGINS=+2348012345678=482913;review@mail.dyce.games=739104`.
 *
 * What this does and does not do:
 *  - Only the listed identities, only with their own code. No other number or address is affected.
 *  - Nothing is sent to the listed identity (there is nobody to send to).
 *  - The usual limits still apply (cooldown, 3 in 10 minutes, 10 a day, 5 wrong tries, 5 minute expiry).
 *  - The account is an ordinary account: it is not an admin and has no extra money or powers.
 *  - Remove or rotate the variable after the review (docs/APP_REVIEW_NOTES.md). A leaked entry opens one demo
 *    account, nothing else.
 */
export const MAX_REVIEW_LOGINS = 4;

export type ReviewLogins = {
  /** `phone:<e164>` or `email:<address>` to the fixed code. */
  codes: Map<string, string>;
  /** Plain-language problems; empty when the value is fine. */
  errors: string[];
};

export const reviewKey = (kind: 'phone' | 'email', normalised: string): string =>
  `${kind}:${normalised}`;

export function parseReviewLogins(raw: string | undefined): ReviewLogins {
  const codes = new Map<string, string>();
  const errors: string[] = [];
  const text = raw?.trim();
  if (!text) return { codes, errors };

  const parts = text
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length > MAX_REVIEW_LOGINS) {
    errors.push(`at most ${MAX_REVIEW_LOGINS} entries`);
  }
  for (const [i, part] of parts.entries()) {
    const at = part.lastIndexOf('=');
    const who = part.slice(0, at).trim();
    const code = part.slice(at + 1).trim();
    const n = i + 1;
    if (at <= 0 || !who) {
      errors.push(`entry ${n} must look like identity=123456`);
      continue;
    }
    if (!/^\d{6}$/.test(code)) {
      errors.push(`entry ${n}: the code must be 6 digits`);
      continue;
    }
    if (/^(\d)\1{5}$/.test(code) || code === '123456' || code === '654321') {
      errors.push(`entry ${n}: pick a code that is not guessable`);
      continue;
    }
    if (who.includes('@')) {
      const address = normalizeEmail(who);
      if (!address) errors.push(`entry ${n}: not a valid email address`);
      else codes.set(reviewKey('email', address), code);
    } else {
      const e164 = normalizePhone(who);
      if (!e164) errors.push(`entry ${n}: use a full international number such as +2348012345678`);
      else codes.set(reviewKey('phone', e164), code);
    }
  }
  return { codes, errors };
}
