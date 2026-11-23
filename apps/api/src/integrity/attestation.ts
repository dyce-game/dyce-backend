import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Device integrity for Pool entry (ADR-039): "is this a genuine, unmodified app on a real phone". Google's Play
 * Integrity API (Android) and Apple's App Attest (iOS) answer that; both need a server-issued nonce (the
 * challenge below), a store account and a server-side verification step that a person has to set up.
 *
 * Until that is done the API runs with the `dev` driver, which always passes and is refused in production, and
 * `integrity_required` stays false. The `store` driver is where the real calls go; until they are written it
 * **fails closed**, so turning `integrity_required` on without finishing the integration blocks Pool instead of
 * silently letting everyone in.
 */
export type AttestationInput = {
  userId: string;
  platform: 'ios' | 'android' | 'web' | null;
  /** The Play Integrity token or App Attest assertion, exactly as the app sent it. */
  token: string;
  deviceId: string | null;
  /** The challenges the token may be bound to (this window's and the previous one's). */
  challenges: string[];
};

export type AttestationResult = { ok: true } | { ok: false; reason: string };

export interface AttestationVerifier {
  readonly name: 'dev' | 'store';
  verify(input: AttestationInput): Promise<AttestationResult>;
}

/** Development and tests only: every token passes. `INTEGRITY_DRIVER=dev` is refused when NODE_ENV=production. */
export class DevAttestationVerifier implements AttestationVerifier {
  readonly name = 'dev' as const;
  verify(): Promise<AttestationResult> {
    return Promise.resolve({ ok: true });
  }
}

/**
 * Production driver, not built yet (human-gated: it needs a Play Console app linked to a Google Cloud project
 * with the Play Integrity API, and an Apple developer account with App Attest; see ADR-039).
 * Android: decode the token with the Play Integrity API (`decodeIntegrityToken`), require
 * `appRecognitionVerdict = PLAY_RECOGNIZED`, a `deviceRecognitionVerdict` containing `MEETS_DEVICE_INTEGRITY` and a
 * `requestDetails.nonce` equal to one of `challenges`. iOS: verify the App Attest assertion against the stored
 * attested key and counter. Both are checked here and nowhere else.
 */
export class StoreAttestationVerifier implements AttestationVerifier {
  readonly name = 'store' as const;
  verify(): Promise<AttestationResult> {
    return Promise.resolve({ ok: false, reason: 'not_configured' });
  }
}

export function createAttestationVerifier(driver: 'dev' | 'store'): AttestationVerifier {
  return driver === 'store' ? new StoreAttestationVerifier() : new DevAttestationVerifier();
}

// ---- challenges: stateless, per user, valid for a few minutes ---------------------------------------

function windowOf(now: Date, minutes: number): number {
  return Math.floor(now.getTime() / (minutes * 60_000));
}

function challengeFor(secret: string, userId: string, win: number): string {
  return createHmac('sha256', secret).update(`attest:${userId}:${win}`).digest('base64url');
}

/** The nonce an app puts into its Play Integrity request or App Attest assertion. */
export function issueChallenge(
  secret: string,
  userId: string,
  now: Date,
  minutes: number,
): { challenge: string; expiresAt: Date } {
  const win = windowOf(now, minutes);
  return {
    challenge: challengeFor(secret, userId, win),
    expiresAt: new Date((win + 2) * minutes * 60_000),
  };
}

/** This window's and the previous one's challenge: a token made just before a window ended still counts. */
export function acceptableChallenges(
  secret: string,
  userId: string,
  now: Date,
  minutes: number,
): string[] {
  const win = windowOf(now, minutes);
  return [challengeFor(secret, userId, win), challengeFor(secret, userId, win - 1)];
}

export function challengeIsValid(candidate: string, acceptable: string[]): boolean {
  const c = Buffer.from(candidate);
  return acceptable.some((a) => {
    const b = Buffer.from(a);
    return b.length === c.length && timingSafeEqual(b, c);
  });
}
