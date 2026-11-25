import { createHash, timingSafeEqual } from 'node:crypto';

/** `ADMIN_TOKENS="alice:<token>,bob:<token>"` as name -> SHA-256 of the token. Names appear in the audit log. */
export type AdminTokens = ReadonlyMap<string, Buffer>;

const NAME = /^[a-z0-9_.-]{2,32}$/;

/** Parses the env value. Nobody can be named `system`, the name the automatic jobs (`system:lapse`) write to the audit log. */
export function parseAdminTokens(raw: string | undefined): AdminTokens | null {
  if (!raw || raw.trim() === '') return null;
  const out = new Map<string, Buffer>();
  for (const entry of raw.split(',')) {
    const at = entry.indexOf(':');
    const name = at > 0 ? entry.slice(0, at).trim() : '';
    const token = at > 0 ? entry.slice(at + 1).trim() : '';
    if (!NAME.test(name) || name === 'system' || token.length < 32) {
      throw new Error(
        'ADMIN_TOKENS: each entry must be "name:token" (name a-z0-9_.-, token 32+ characters)',
      );
    }
    out.set(name, createHash('sha256').update(token).digest());
  }
  return out;
}

/** Who an `Authorization` header belongs to, or null. Tokens are compared as digests in constant time. */
export function matchAdminToken(
  tokens: AdminTokens,
  authorization: string | undefined,
): string | null {
  const bearer = authorization ? /^Bearer (.+)$/i.exec(authorization) : null;
  if (!bearer) return null;
  const digest = createHash('sha256').update(bearer[1]!).digest();
  let found: string | null = null;
  for (const [name, want] of tokens) {
    if (timingSafeEqual(want, digest)) found = name;
  }
  return found;
}
