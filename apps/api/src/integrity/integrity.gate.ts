import type pg from 'pg';
import { AuthError } from '../auth/auth-error.ts';
import type { Clock } from '../auth/tokens.ts';
import { readConfigInt } from '../db/config.ts';
import { acceptableChallenges, issueChallenge, type AttestationVerifier } from './attestation.ts';
import type { ClientContext } from './client-context.ts';
import { hashDevice, hashIp } from './fingerprint.ts';

/**
 * The checks every Pool entry goes through (ADR-039): who is playing from which phone and connection (kept as
 * keyed hashes for the collusion signals), and the device integrity check. With `integrity_required` off (the
 * default) a missing or failing attestation is only recorded as a signal; with it on, Pool is refused
 * (`integrity_check_failed`). Nothing here moves money or bans anyone.
 */
export class IntegrityGate {
  constructor(
    private readonly pool: pg.Pool,
    private readonly verifier: AttestationVerifier,
    /** Keys the fingerprint hashes and the challenges (the same server secret as phone hashing). */
    private readonly secret: string,
    private readonly clock: Clock = () => new Date(),
    private readonly log: { warn(message: string): void } = { warn: () => undefined },
  ) {}

  get driver(): AttestationVerifier['name'] {
    return this.verifier.name;
  }

  /** The nonce the app binds its Play Integrity request or App Attest assertion to. */
  async challenge(userId: string): Promise<{ challenge: string; expiresAt: string }> {
    const minutes = await readConfigInt(this.pool, 'attestation_challenge_minutes', 5);
    const c = issueChallenge(this.secret, userId, this.clock(), minutes);
    return { challenge: c.challenge, expiresAt: c.expiresAt.toISOString() };
  }

  /** Call before a stake is taken. Throws `integrity_check_failed` only when the check is required. */
  async poolEntry(userId: string, ctx: ClientContext): Promise<void> {
    await this.recordFingerprints(userId, ctx);
    const required = await this.isRequired();

    if (!ctx.attestation) {
      if (required) throw new AuthError('integrity_check_failed', { reason: 'missing' });
      return;
    }

    const minutes = await readConfigInt(this.pool, 'attestation_challenge_minutes', 5);
    let failure: string | null = null;
    try {
      const verdict = await this.verifier.verify({
        userId,
        platform: ctx.platform,
        token: ctx.attestation,
        deviceId: ctx.deviceId,
        challenges: acceptableChallenges(this.secret, userId, this.clock(), minutes),
      });
      if (!verdict.ok) failure = verdict.reason;
    } catch (err) {
      // A verifier that cannot answer is not a pass.
      this.log.warn(
        `attestation verifier failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
      failure = 'verifier_error';
    }
    if (failure === null) return;

    await this.pool
      .query('SELECT integrity_record_attestation_failure($1, $2, $3)', [
        userId,
        ctx.platform,
        failure,
      ])
      .catch((err: unknown) =>
        this.log.warn(`could not record attestation failure: ${String(err)}`),
      );
    if (required) throw new AuthError('integrity_check_failed', { reason: failure });
  }

  private async recordFingerprints(userId: string, ctx: ClientContext): Promise<void> {
    if (!ctx.deviceId && !ctx.ip) return;
    try {
      await this.pool.query('SELECT record_fingerprints($1, $2, $3)', [
        userId,
        ctx.deviceId ? hashDevice(this.secret, ctx.deviceId) : null,
        ctx.ip ? hashIp(this.secret, ctx.ip) : null,
      ]);
    } catch (err) {
      // Signals are best effort: never block a game because the bookkeeping failed.
      this.log.warn(`could not record fingerprints: ${String(err)}`);
    }
  }

  private async isRequired(): Promise<boolean> {
    const r = await this.pool.query<{ v: string | null }>(
      `SELECT value #>> '{}' AS v FROM app_config WHERE key = 'integrity_required'`,
    );
    return r.rows[0]?.v === 'true';
  }
}
