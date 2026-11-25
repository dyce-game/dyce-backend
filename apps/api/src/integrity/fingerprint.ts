import { createHmac } from 'node:crypto';

/**
 * Collusion checks need to know "is this the same phone or connection", not what the phone or address is. Both are
 * stored as keyed hashes (the server secret never leaves the API), kept 90 days, and deleted with the account
 * (ADR-039, NDPA data minimisation). Domain prefixes keep the two hashes, and the phone hash, apart.
 */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export function hashDevice(secret: string, deviceId: string): Buffer {
  return createHmac('sha256', secret).update(`device:${deviceId}`).digest();
}

/**
 * A home or mobile connection hands out a whole IPv6 /64, and IPv4 mapped into IPv6 is the same address as the IPv4:
 * so a person who moves inside one /64 still looks like one connection.
 */
export function normaliseIp(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (!ip.includes(':')) return ip;
  const halves = ip.toLowerCase().split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves[1] ? halves[1].split(':') : [];
  const full = [
    ...head,
    ...Array<string>(Math.max(0, 8 - head.length - tail.length)).fill('0'),
    ...tail,
  ];
  return `${full
    .slice(0, 4)
    .map((g) => g.padStart(4, '0'))
    .join(':')}::/64`;
}

export function hashIp(secret: string, ip: string): Buffer {
  return createHmac('sha256', secret)
    .update(`ip:${normaliseIp(ip)}`)
    .digest();
}
