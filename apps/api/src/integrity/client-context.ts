import type { Request } from 'express';
import { DEVICE_ID_PATTERN } from './fingerprint.ts';

/**
 * What the app tells us about the phone it runs on, in headers (never the body, so no schema changes):
 * - `x-dyce-device`      a random install id the app makes once and keeps (not a hardware id)
 * - `x-dyce-platform`    `ios` | `android` | `web`
 * - `x-dyce-attestation` the Play Integrity token or App Attest assertion for the challenge from
 *                        `POST /integrity/challenge`
 * The IP is the one the proxy settings (`TRUST_PROXY_HOPS`) let Express trust.
 */
export type ClientContext = {
  ip: string | null;
  deviceId: string | null;
  platform: 'ios' | 'android' | 'web' | null;
  attestation: string | null;
};

const MAX_ATTESTATION = 12_000;

function header(req: Pick<Request, 'headers'>, name: string): string | null {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.length > 0 ? s : null;
}

export function readClientContext(req: Pick<Request, 'headers' | 'ip'>): ClientContext {
  const device = header(req, 'x-dyce-device');
  const platform = header(req, 'x-dyce-platform');
  const attestation = header(req, 'x-dyce-attestation');
  return {
    ip: req.ip ?? null,
    deviceId: device && DEVICE_ID_PATTERN.test(device) ? device : null,
    platform: platform === 'ios' || platform === 'android' || platform === 'web' ? platform : null,
    attestation: attestation && attestation.length <= MAX_ATTESTATION ? attestation : null,
  };
}
