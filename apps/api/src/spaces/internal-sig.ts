import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signs the server-to-server calls between the API and the game server (the game server has its own copy of
 * this file: the two apps share no code). `HMAC-SHA256(secret, "<timestamp>.<body>")`, valid for a minute.
 */
export const SIG_HEADER = 'x-dyce-signature';
export const TS_HEADER = 'x-dyce-timestamp';
export const SIG_MAX_AGE_MS = 60_000;

export function signInternal(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function verifyInternal(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  body: string,
  now: number = Date.now(),
): boolean {
  const ts = Number(timestamp);
  if (!signature || !Number.isFinite(ts) || Math.abs(now - ts) > SIG_MAX_AGE_MS) return false;
  const expected = Buffer.from(signInternal(secret, ts, body), 'hex');
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
