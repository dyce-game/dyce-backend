import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  maskEmail,
  maskPhone,
  normalizeEmail,
  normalizePhone,
  type SessionResponse,
  type SessionTokens,
} from '@dyce/shared';
import { withTx } from '../db/tx.ts';
import { otpEmail } from '../email/email-templates.ts';
import { EmailDeliveryError, type EmailProvider } from '../email/email-provider.ts';
import { loadNextStep } from '../profile/onboarding.ts';
import type { SmsProvider } from '../sms/sms-provider.ts';
import { SmsDeliveryError } from '../sms/sms-provider.ts';
import { AuthError } from './auth-error.ts';
import {
  generateOtp,
  hashEmail,
  hashOtp,
  hashPhone,
  lockKey,
  newRefreshToken,
  safeEqual,
  sha256,
} from './crypto.ts';
import type { Clock, TokenService } from './tokens.ts';

export type AuthConfig = {
  /** Secret for phone, email and OTP hashing (PHONE_HASH_SALT). */
  phoneSecret: string;
  otpTtlSeconds: number;
  refreshTtlDays: number;
  /** Non-production only: every challenge uses this code and nothing is sent (SMS or email). */
  otpTestCode?: string;
};

export const OTP_RESEND_COOLDOWN_SECONDS = 30;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_LIMIT_PER_10_MIN = 3;
export const OTP_LIMIT_PER_DAY = 10;

const TEN_MIN_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

type OtpRow = {
  id: string;
  code_hash: Buffer;
  attempts: number;
  expires_at: Date;
};

type Logger = { warn(message: string): void };

type UserRow = {
  id: string;
  inserted: boolean;
  disabled_at: Date | null;
  suspended: boolean;
};

/**
 * A way to prove who you are: a phone number or an email address. Only the keyed hash is ever stored. The column
 * names below are fixed strings chosen here, never user input, so they are safe to put in SQL.
 */
type Identity =
  | { kind: 'phone'; hash: Buffer; column: 'phone_hash' }
  | { kind: 'email'; hash: Buffer; column: 'email_hash'; hint: string };

/** Who is signed in and how they can sign back in (Settings shows this). */
export type SignInMethods = { phone: boolean; emailHint: string | null };

export class AuthService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly sms: SmsProvider,
    private readonly tokens: TokenService,
    private readonly config: AuthConfig,
    private readonly clock: Clock = () => new Date(),
    private readonly logger: Logger = { warn: () => undefined },
    /** Without a provider, email sign-in is off: every email route answers `email_auth_disabled`. */
    private readonly email?: EmailProvider,
  ) {}

  /** What this server offers, for the app to show or hide the email buttons. */
  methods(): { phone: true; email: boolean } {
    return { phone: true, email: this.email !== undefined };
  }

  private phoneIdentity(phone: string, country?: string): { e164: string; identity: Identity } {
    const e164 = normalizePhone(phone, country);
    if (!e164) throw new AuthError('invalid_phone');
    return {
      e164,
      identity: {
        kind: 'phone',
        hash: hashPhone(this.config.phoneSecret, e164),
        column: 'phone_hash',
      },
    };
  }

  private emailIdentity(raw: string): { address: string; identity: Identity } {
    if (!this.email) throw new AuthError('email_auth_disabled');
    const address = normalizeEmail(raw);
    if (!address) throw new AuthError('invalid_email');
    return {
      address,
      identity: {
        kind: 'email',
        hash: hashEmail(this.config.phoneSecret, address),
        column: 'email_hash',
        hint: maskEmail(address),
      },
    };
  }

  // ---- OTP ----------------------------------------------------------------------------------

  /**
   * Creates a challenge for an identity, enforcing the limits: a 30 s cooldown, 3 per 10 minutes and 10 per day,
   * per phone or per address. Serialised per identity so concurrent requests can't slip past them. Returns the
   * challenge id and the plain code (the caller delivers it).
   */
  private async issueChallenge(
    identity: Identity,
    now: Date,
  ): Promise<{ id: string; code: string; testMode: boolean }> {
    const testMode = this.config.otpTestCode !== undefined;
    const code = this.config.otpTestCode ?? generateOtp();
    const id = randomUUID();
    const col = identity.column;

    await withTx(this.pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey(identity.hash)]);

      const windowStart = new Date(now.getTime() - DAY_MS);
      const tenMinStart = new Date(now.getTime() - TEN_MIN_MS);
      const r = await c.query<{
        last: Date | null;
        ten_count: string;
        day_count: string;
        oldest_ten: Date | null;
        oldest_day: Date | null;
      }>(
        `SELECT max(created_at) AS last,
                count(*) FILTER (WHERE created_at > $3) AS ten_count,
                count(*) AS day_count,
                min(created_at) FILTER (WHERE created_at > $3) AS oldest_ten,
                min(created_at) AS oldest_day
           FROM otp_challenges WHERE ${col} = $1 AND created_at > $2`,
        [identity.hash, windowStart, tenMinStart],
      );
      const row = r.rows[0]!;
      const secondsUntil = (t: Date, windowMs: number) =>
        Math.max(1, Math.ceil((t.getTime() + windowMs - now.getTime()) / 1000));

      if (row.last) {
        const since = (now.getTime() - row.last.getTime()) / 1000;
        if (since < OTP_RESEND_COOLDOWN_SECONDS) {
          throw new AuthError('otp_resend_too_soon', {
            retryAfterSeconds: Math.ceil(OTP_RESEND_COOLDOWN_SECONDS - since),
          });
        }
      }
      if (Number(row.ten_count) >= OTP_LIMIT_PER_10_MIN && row.oldest_ten) {
        throw new AuthError('otp_rate_limited', {
          retryAfterSeconds: secondsUntil(row.oldest_ten, TEN_MIN_MS),
        });
      }
      if (Number(row.day_count) >= OTP_LIMIT_PER_DAY && row.oldest_day) {
        throw new AuthError('otp_rate_limited', {
          retryAfterSeconds: secondsUntil(row.oldest_day, DAY_MS),
        });
      }

      await c.query(
        `INSERT INTO otp_challenges (id, ${col}, code_hash, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          id,
          identity.hash,
          hashOtp(this.config.phoneSecret, id, code),
          new Date(now.getTime() + this.config.otpTtlSeconds * 1000),
          now,
        ],
      );
    });
    return { id, code, testMode };
  }

  /**
   * Checks a code against the newest open challenge for an identity, inside the caller's transaction. Returns null
   * when it is right (and marks it used) or the error to report. The caller RETURNS the error instead of throwing it,
   * so that a wrong-guess counter committed here is not rolled back.
   */
  private async consumeChallenge(
    c: pg.PoolClient,
    identity: Identity,
    code: string,
    now: Date,
  ): Promise<AuthError | null> {
    await c.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey(identity.hash)]);

    const r = await c.query<OtpRow>(
      `SELECT id, code_hash, attempts, expires_at FROM otp_challenges
        WHERE ${identity.column} = $1 AND consumed_at IS NULL
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [identity.hash],
    );
    const challenge = r.rows[0];
    if (!challenge) return new AuthError('otp_invalid');
    if (challenge.expires_at <= now) return new AuthError('otp_expired');
    if (challenge.attempts >= OTP_MAX_ATTEMPTS) return new AuthError('otp_locked');

    const expected = hashOtp(this.config.phoneSecret, challenge.id, code);
    if (!safeEqual(expected, challenge.code_hash)) {
      const u = await c.query<{ attempts: number }>(
        'UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts',
        [challenge.id],
      );
      const remaining = Math.max(0, OTP_MAX_ATTEMPTS - (u.rows[0]?.attempts ?? OTP_MAX_ATTEMPTS));
      return remaining === 0
        ? new AuthError('otp_locked')
        : new AuthError('otp_invalid', { attemptsRemaining: remaining });
    }

    await c.query('UPDATE otp_challenges SET consumed_at = $2 WHERE id = $1', [challenge.id, now]);
    return null;
  }

  private ttlMinutes(): number {
    return Math.max(1, Math.round(this.config.otpTtlSeconds / 60));
  }

  /**
   * Sends a one-time code by SMS. The response is identical whether or not the number already has an
   * account, so this endpoint can't be used to find out who is on Dyce.
   */
  async requestOtp(input: { phone: string; country?: string }): Promise<{
    resendAfterSeconds: number;
    expiresInSeconds: number;
  }> {
    const { e164, identity } = this.phoneIdentity(input.phone, input.country);
    const now = this.clock();
    const { id, code, testMode } = await this.issueChallenge(identity, now);

    if (!testMode) {
      try {
        await this.sms.send(
          e164,
          `Your Dyce code is ${code}. It expires in ${this.ttlMinutes()} minutes. Never share it.`,
        );
      } catch (err) {
        // Don't burn the user's rate limit on our provider's failure.
        await this.pool.query('DELETE FROM otp_challenges WHERE id = $1', [id]);
        const provider = err instanceof SmsDeliveryError ? err.provider : 'unknown';
        this.logger.warn(`otp send failed via ${provider} to ${maskPhone(e164)}`);
        throw new AuthError('sms_failed');
      }
    }

    return this.requested();
  }

  /**
   * Sends a one-time code by email (ADR-044). Same promises as the phone: an identical answer whether or not the
   * address has an account, the same limits, and nothing stored but hashes.
   */
  async requestEmailOtp(input: { email: string }): Promise<{
    resendAfterSeconds: number;
    expiresInSeconds: number;
  }> {
    const { address, identity } = this.emailIdentity(input.email);
    await this.sendEmailCode(address, identity, 'signin');
    return this.requested();
  }

  private requested() {
    return {
      resendAfterSeconds: OTP_RESEND_COOLDOWN_SECONDS,
      expiresInSeconds: this.config.otpTtlSeconds,
    };
  }

  private async sendEmailCode(
    address: string,
    identity: Identity,
    purpose: 'signin' | 'link',
  ): Promise<void> {
    const now = this.clock();
    const { id, code, testMode } = await this.issueChallenge(identity, now);
    if (testMode) return;
    try {
      const mail = otpEmail({ code, ttlMinutes: this.ttlMinutes(), purpose });
      await this.email!.send({ to: address, ...mail, idempotencyKey: `otp-${id}` });
    } catch (err) {
      // Don't burn the user's rate limit on our provider's failure.
      await this.pool.query('DELETE FROM otp_challenges WHERE id = $1', [id]);
      const provider = err instanceof EmailDeliveryError ? err.provider : 'unknown';
      const status = err instanceof EmailDeliveryError && err.status ? ` HTTP ${err.status}` : '';
      this.logger.warn(`email otp send failed via ${provider}${status} to ${maskEmail(address)}`);
      throw new AuthError('email_failed');
    }
  }

  /** Checks the code and, on success, finds or creates the account and starts a session. */
  async verifyOtp(input: {
    phone: string;
    country?: string;
    code: string;
  }): Promise<SessionResponse> {
    const { identity } = this.phoneIdentity(input.phone, input.country);
    return this.verifyIdentity(identity, input.code);
  }

  /** The same, for an email address. A new address creates an account; a known one logs in. */
  async verifyEmailOtp(input: { email: string; code: string }): Promise<SessionResponse> {
    const { identity } = this.emailIdentity(input.email);
    return this.verifyIdentity(identity, input.code);
  }

  private async verifyIdentity(identity: Identity, code: string): Promise<SessionResponse> {
    const now = this.clock();

    type Outcome = { ok: true; session: SessionResponse } | { ok: false; error: AuthError };

    const outcome = await withTx<Outcome>(this.pool, async (c) => {
      const failure = await this.consumeChallenge(c, identity, code, now);
      if (failure) return { ok: false, error: failure };

      const u =
        identity.kind === 'phone'
          ? await c.query<UserRow>(
              `INSERT INTO users (phone_hash, created_at) VALUES ($1, $2)
               ON CONFLICT (phone_hash) DO UPDATE SET phone_hash = users.phone_hash
               RETURNING id, (xmax = 0) AS inserted, disabled_at, coalesce(suspended_until > $2, false) AS suspended`,
              [identity.hash, now],
            )
          : await c.query<UserRow>(
              `INSERT INTO users (email_hash, email_hint, email_verified_at, created_at) VALUES ($1, $3, $2, $2)
               ON CONFLICT (email_hash) DO UPDATE SET email_hash = users.email_hash
               RETURNING id, (xmax = 0) AS inserted, disabled_at, coalesce(suspended_until > $2, false) AS suspended`,
              [identity.hash, now, identity.hint],
            );
      const user = u.rows[0]!;
      if (user.disabled_at) return { ok: false, error: new AuthError('account_disabled') };
      // A moderator suspended this account (ADR-039): no new session until the suspension ends or is lifted.
      if (user.suspended) return { ok: false, error: new AuthError('account_suspended') };
      // Signing back in during the grace period is the change of mind (ADR-037): the deletion is cancelled.
      await c.query('SELECT cancel_account_deletion($1)', [user.id]);

      const familyId = randomUUID();
      const tokens = await this.startSession(c, user.id, familyId, now);
      const nextStep = await loadNextStep(c, user.id);
      return {
        ok: true,
        session: { ...tokens, userId: user.id, isNewUser: user.inserted, nextStep },
      };
    });

    if (!outcome.ok) throw outcome.error;
    return outcome.session;
  }

  // ---- Adding the other way in to an account that is signed in ------------------------------

  /** Which ways in an account has. */
  async signInMethods(userId: string): Promise<SignInMethods> {
    const r = await this.pool.query<{ has_phone: boolean; email_hint: string | null }>(
      'SELECT phone_hash IS NOT NULL AS has_phone, email_hint FROM users WHERE id = $1',
      [userId],
    );
    const row = r.rows[0];
    if (!row) throw new AuthError('unauthorized');
    return { phone: row.has_phone, emailHint: row.email_hint };
  }

  /** Step 1 of linking an email to your account: refuse an address another account uses, then send a code. */
  async requestEmailLink(
    userId: string,
    input: { email: string },
  ): Promise<{ resendAfterSeconds: number; expiresInSeconds: number }> {
    const { address, identity } = this.emailIdentity(input.email);
    await this.assertFree(userId, identity);
    await this.sendEmailCode(address, identity, 'link');
    return this.requested();
  }

  /** Step 2: the code proves the address is theirs; it becomes a way to sign in to this account. */
  async verifyEmailLink(
    userId: string,
    input: { email: string; code: string },
  ): Promise<SignInMethods> {
    const { identity } = this.emailIdentity(input.email);
    return this.verifyLink(userId, identity, input.code);
  }

  /** Step 1 of adding a phone number to an account that signed up with email. */
  async requestPhoneLink(
    userId: string,
    input: { phone: string; country?: string },
  ): Promise<{ resendAfterSeconds: number; expiresInSeconds: number }> {
    const { e164, identity } = this.phoneIdentity(input.phone, input.country);
    await this.assertFree(userId, identity);
    const now = this.clock();
    const { id, code, testMode } = await this.issueChallenge(identity, now);
    if (!testMode) {
      try {
        await this.sms.send(
          e164,
          `Your Dyce code is ${code}. It expires in ${this.ttlMinutes()} minutes. Never share it.`,
        );
      } catch (err) {
        await this.pool.query('DELETE FROM otp_challenges WHERE id = $1', [id]);
        const provider = err instanceof SmsDeliveryError ? err.provider : 'unknown';
        this.logger.warn(`otp send failed via ${provider} to ${maskPhone(e164)}`);
        throw new AuthError('sms_failed');
      }
    }
    return this.requested();
  }

  async verifyPhoneLink(
    userId: string,
    input: { phone: string; country?: string; code: string },
  ): Promise<SignInMethods> {
    const { identity } = this.phoneIdentity(input.phone, input.country);
    return this.verifyLink(userId, identity, input.code);
  }

  /** A phone or address that already belongs to someone else (or to you) cannot be linked again. */
  private async assertFree(userId: string, identity: Identity): Promise<void> {
    const r = await this.pool.query<{ id: string }>(
      `SELECT id FROM users WHERE ${identity.column} = $1`,
      [identity.hash],
    );
    const owner = r.rows[0];
    if (owner && owner.id !== userId) throw new AuthError('identity_taken');
  }

  private async verifyLink(
    userId: string,
    identity: Identity,
    code: string,
  ): Promise<SignInMethods> {
    const now = this.clock();
    type Outcome = { ok: true } | { ok: false; error: AuthError };
    const outcome = await withTx<Outcome>(this.pool, async (c) => {
      const failure = await this.consumeChallenge(c, identity, code, now);
      if (failure) return { ok: false, error: failure };
      const taken = await c.query<{ id: string }>(
        `SELECT id FROM users WHERE ${identity.column} = $1 FOR UPDATE`,
        [identity.hash],
      );
      if (taken.rows[0] && taken.rows[0].id !== userId) {
        return { ok: false, error: new AuthError('identity_taken') };
      }
      if (identity.kind === 'email') {
        await c.query(
          'UPDATE users SET email_hash = $2, email_hint = $3, email_verified_at = $4 WHERE id = $1',
          [userId, identity.hash, identity.hint, now],
        );
      } else {
        await c.query('UPDATE users SET phone_hash = $2 WHERE id = $1', [userId, identity.hash]);
      }
      return { ok: true };
    });
    if (!outcome.ok) throw outcome.error;
    return this.signInMethods(userId);
  }

  // ---- Sessions -----------------------------------------------------------------------------

  private async startSession(
    c: pg.PoolClient,
    userId: string,
    familyId: string,
    now: Date,
  ): Promise<SessionTokens> {
    const refreshToken = newRefreshToken();
    await c.query(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, familyId, sha256(refreshToken), this.refreshExpiry(now), now],
    );
    return {
      accessToken: await this.tokens.signAccess({ userId, familyId }),
      refreshToken,
      expiresIn: this.tokens.expiresIn,
    };
  }

  private refreshExpiry(now: Date): Date {
    return new Date(now.getTime() + this.config.refreshTtlDays * DAY_MS);
  }

  /**
   * Rotates a refresh token. Presenting a token that was already rotated or revoked means it was
   * stolen or replayed, so the whole session family is revoked and the user signs in again.
   */
  async refresh(refreshToken: string): Promise<SessionTokens> {
    const now = this.clock();
    type Outcome = { ok: true; tokens: SessionTokens } | { ok: false; error: AuthError };

    const outcome = await withTx<Outcome>(this.pool, async (c) => {
      const r = await c.query<{
        id: string;
        user_id: string;
        family_id: string;
        expires_at: Date;
        revoked_at: Date | null;
        replaced_by: string | null;
      }>(
        `SELECT id, user_id, family_id, expires_at, revoked_at, replaced_by
           FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
        [sha256(refreshToken)],
      );
      const row = r.rows[0];
      if (!row) return { ok: false, error: new AuthError('invalid_refresh') };

      if (row.revoked_at || row.replaced_by) {
        await c.query(
          'UPDATE refresh_tokens SET revoked_at = $2 WHERE family_id = $1 AND revoked_at IS NULL',
          [row.family_id, now],
        );
        return { ok: false, error: new AuthError('refresh_reused') };
      }
      if (row.expires_at <= now) return { ok: false, error: new AuthError('invalid_refresh') };

      const u = await c.query<{ disabled_at: Date | null; suspended: boolean }>(
        'SELECT disabled_at, coalesce(suspended_until > $2, false) AS suspended FROM users WHERE id = $1',
        [row.user_id, now],
      );
      if (!u.rows[0] || u.rows[0].disabled_at || u.rows[0].suspended) {
        await c.query(
          'UPDATE refresh_tokens SET revoked_at = $2 WHERE family_id = $1 AND revoked_at IS NULL',
          [row.family_id, now],
        );
        return {
          ok: false,
          error: new AuthError(u.rows[0]?.suspended ? 'account_suspended' : 'account_disabled'),
        };
      }

      const next = newRefreshToken();
      const ins = await c.query<{ id: string }>(
        `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [row.user_id, row.family_id, sha256(next), this.refreshExpiry(now), now],
      );
      await c.query('UPDATE refresh_tokens SET revoked_at = $2, replaced_by = $3 WHERE id = $1', [
        row.id,
        now,
        ins.rows[0]!.id,
      ]);
      return {
        ok: true,
        tokens: {
          accessToken: await this.tokens.signAccess({
            userId: row.user_id,
            familyId: row.family_id,
          }),
          refreshToken: next,
          expiresIn: this.tokens.expiresIn,
        },
      };
    });

    if (!outcome.ok) throw outcome.error;
    return outcome.tokens;
  }

  /** Ends this device's session. Idempotent: an unknown token is not an error. */
  async logout(refreshToken: string): Promise<void> {
    const now = this.clock();
    await this.pool.query(
      `UPDATE refresh_tokens SET revoked_at = $2
        WHERE revoked_at IS NULL AND family_id IN (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)`,
      [sha256(refreshToken), now],
    );
  }

  /** Ends every session for a user (account deletion, "sign out everywhere"). */
  async revokeAllSessions(userId: string): Promise<void> {
    await this.pool.query(
      'UPDATE refresh_tokens SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL',
      [userId, this.clock()],
    );
  }

  /** Housekeeping for a scheduled job: drops spent OTP challenges and long-dead refresh tokens. */
  async purgeExpired(): Promise<{ otp: number; refresh: number }> {
    const now = this.clock();
    const otp = await this.pool.query('DELETE FROM otp_challenges WHERE created_at < $1', [
      new Date(now.getTime() - DAY_MS * 2),
    ]);
    const refresh = await this.pool.query('DELETE FROM refresh_tokens WHERE expires_at < $1', [
      new Date(now.getTime() - DAY_MS * 7),
    ]);
    return { otp: otp.rowCount ?? 0, refresh: refresh.rowCount ?? 0 };
  }
}
