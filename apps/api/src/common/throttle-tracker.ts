/**
 * Who a rate limit counts (ADR-039, docs/RATE_LIMITS.md). Mobile networks in Nigeria put thousands of phones behind
 * one shared address (carrier-grade NAT), so counting every route per IP lets a few busy neighbours lock a whole
 * network out, and lets nobody in particular be held to account. A request that carries a valid access token is
 * counted against that person; everything else (sign-in, OTP, the guest web game) still against the address.
 * A token that does not verify is not trusted for anything: it falls back to the address, so nobody can spend
 * another person's allowance by forging a token.
 */
export async function throttleTracker(
  req: { headers: Record<string, string | string[] | undefined>; ip?: string },
  verify: (token: string) => Promise<{ userId: string }>,
): Promise<string> {
  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  const bearer = value ? /^Bearer (.+)$/i.exec(value) : null;
  if (bearer) {
    try {
      const claims = await verify(bearer[1]!);
      return `user:${claims.userId}`;
    } catch {
      // fall through to the address
    }
  }
  return `ip:${req.ip ?? 'unknown'}`;
}
