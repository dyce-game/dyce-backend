import { jwtVerify } from 'jose';

/**
 * Verifies the access token the NestJS API issued (HS256, same secret, issuer and audience as its
 * TokenService). The room only needs to know who is connecting.
 */
export class TokenVerifier {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly issuer = 'dyce-api',
    private readonly audience = 'dyce',
  ) {
    if (secret.length < 32) throw new Error('JWT secret must be at least 32 characters');
    this.key = new TextEncoder().encode(secret);
  }

  /** The user id, or null when the token is missing, expired or not ours. */
  async userId(token: unknown): Promise<string | null> {
    if (typeof token !== 'string' || token.length < 10 || token.length > 4000) return null;
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'], // never "none", never an asymmetric alg
        issuer: this.issuer,
        audience: this.audience,
      });
      return typeof payload.sub === 'string' ? payload.sub : null;
    } catch {
      return null;
    }
  }
}
