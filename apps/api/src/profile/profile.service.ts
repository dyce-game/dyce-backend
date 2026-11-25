import { randomInt } from 'node:crypto';
import type pg from 'pg';
import {
  isAdultByBirthYear,
  nextOnboardingStep,
  parseAvatar,
  type AvatarConfig,
  type ProfileUpdate,
  type RequestPolicy,
  type ClientStep,
  type NextStep,
  type OnboardingState,
} from '@dyce/shared';
import { AuthError } from '../auth/auth-error.ts';
import type { Clock } from '../auth/tokens.ts';
import type { LedgerRepo } from '../ledger/ledger.repo.ts';
import { loadOnboardingState } from './onboarding.ts';

export type Me = {
  userId: string;
  profile: {
    username: string;
    displayName: string;
    isAdult: boolean;
    level: number;
    xp: number;
    /** Their starter look, or null until they pick one. */
    avatar: AvatarConfig | null;
    /** Who may send you friend requests and first messages. */
    requestPolicy: RequestPolicy;
  } | null;
  onboarding: OnboardingState;
  /** How this person can sign back in: a phone, an email (masked), or both. */
  signIn: { phone: boolean; emailHint: string | null };
  nextStep: NextStep;
};

type PgError = Error & { code?: string; constraint?: string };

export class ProfileService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly ledger: Pick<LedgerRepo, 'grantWelcome'>,
    private readonly clock: Clock = () => new Date(),
  ) {}

  async getMe(userId: string): Promise<Me> {
    const u = await this.pool.query<{
      disabled_at: Date | null;
      has_phone: boolean;
      email_hint: string | null;
    }>(
      'SELECT disabled_at, phone_hash IS NOT NULL AS has_phone, email_hint FROM users WHERE id = $1',
      [userId],
    );
    if (!u.rows[0]) throw new AuthError('unauthorized');
    if (u.rows[0].disabled_at) throw new AuthError('account_disabled');

    const p = await this.pool.query<{
      username: string;
      display_name: string;
      is_adult: boolean;
      level: number;
      xp: number;
      avatar: unknown;
      request_policy: RequestPolicy;
    }>(
      'SELECT username, display_name, is_adult, level, xp, avatar, request_policy FROM profiles WHERE id = $1',
      [userId],
    );
    const row = p.rows[0];
    const onboarding = await loadOnboardingState(this.pool, userId);
    return {
      userId,
      profile: row
        ? {
            username: row.username,
            displayName: row.display_name,
            isAdult: row.is_adult,
            level: row.level,
            xp: row.xp,
            avatar: parseAvatar(row.avatar),
            requestPolicy: row.request_policy,
          }
        : null,
      onboarding,
      signIn: { phone: u.rows[0].has_phone, emailHint: u.rows[0].email_hint },
      nextStep: nextOnboardingStep(onboarding),
    };
  }

  /** Availability plus, when taken, a few free alternatives. Format/reserved checks happen in the schema. */
  async checkUsername(username: string): Promise<{ available: boolean; suggestions: string[] }> {
    const taken = await this.pool.query('SELECT 1 FROM profiles WHERE lower(username) = $1', [
      username,
    ]);
    if (taken.rowCount === 0) return { available: true, suggestions: [] };
    return { available: false, suggestions: await this.suggest(username) };
  }

  private async suggest(base: string): Promise<string[]> {
    const stem = base.slice(0, 16);
    const candidates = new Set<string>();
    while (candidates.size < 6) {
      candidates.add(`${stem}${randomInt(10, 100)}`);
      candidates.add(`${stem}_${randomInt(1, 10)}`);
    }
    const list = [...candidates].filter((c) => c.length <= 20);
    const used = await this.pool.query<{ username: string }>(
      'SELECT username FROM profiles WHERE username = ANY($1)',
      [list],
    );
    const usedSet = new Set(used.rows.map((r) => r.username));
    return list.filter((c) => !usedSet.has(c)).slice(0, 3);
  }

  async createProfile(
    userId: string,
    input: { username: string; displayName?: string },
  ): Promise<Me> {
    try {
      await this.pool.query(
        `INSERT INTO profiles (id, username, display_name, created_at) VALUES ($1, $2, $3, $4)`,
        [userId, input.username, input.displayName?.trim() || input.username, this.clock()],
      );
    } catch (err) {
      const e = err as PgError;
      if (e.message === 'dyce:username_reserved') throw new AuthError('username_reserved');
      if (e.code === '23505') {
        if (e.constraint === 'profiles_pkey') throw new AuthError('profile_exists');
        throw new AuthError('username_taken', { suggestions: await this.suggest(input.username) });
      }
      throw err;
    }
    return this.getMe(userId);
  }

  /**
   * Age gate, shown the first time someone picks Pool. The birth year is stored the first time and
   * can never change (the database enforces this too), so retrying years can't unlock Pool.
   */
  async setBirthYear(userId: string, birthYear: number): Promise<{ isAdult: boolean }> {
    const adult = isAdultByBirthYear(birthYear, this.clock().getUTCFullYear());
    const r = await this.pool.query<{ is_adult: boolean }>(
      `UPDATE profiles SET birth_year = $2, is_adult = $3
        WHERE id = $1 AND birth_year IS NULL RETURNING is_adult`,
      [userId, birthYear, adult],
    );
    if (r.rowCount === 0) {
      const exists = await this.pool.query('SELECT 1 FROM profiles WHERE id = $1', [userId]);
      throw new AuthError(exists.rowCount === 0 ? 'profile_required' : 'age_already_set');
    }
    return { isAdult: r.rows[0]!.is_adult };
  }

  /** Changes the display name and/or who may send you requests. Returns the updated account. */
  async updateProfile(userId: string, patch: ProfileUpdate): Promise<Me> {
    const r = await this.pool.query(
      `UPDATE profiles
          SET display_name = coalesce($2, display_name),
              request_policy = coalesce($3::request_policy, request_policy)
        WHERE id = $1`,
      [userId, patch.displayName ?? null, patch.requestPolicy ?? null],
    );
    if (r.rowCount === 0) throw new AuthError('profile_required');
    return this.getMe(userId);
  }

  /**
   * Saves the player's look (a starter look today) and counts the onboarding "avatar" step as done. Choosing
   * again later just replaces it.
   */
  async setAvatar(
    userId: string,
    avatar: AvatarConfig,
  ): Promise<{ avatar: AvatarConfig; nextStep: NextStep }> {
    const r = await this.pool.query(
      `UPDATE profiles
          SET avatar = $2::jsonb, onboarding = onboarding || jsonb_build_object('avatar', true)
        WHERE id = $1`,
      [userId, JSON.stringify(avatar)],
    );
    if (r.rowCount === 0) throw new AuthError('profile_required');
    return { avatar, nextStep: nextOnboardingStep(await loadOnboardingState(this.pool, userId)) };
  }

  /** Records a client-side step (contacts, avatar, notifications) as done or skipped. */
  async completeStep(userId: string, step: ClientStep): Promise<{ nextStep: NextStep }> {
    const r = await this.pool.query(
      `UPDATE profiles SET onboarding = onboarding || jsonb_build_object($2::text, true) WHERE id = $1`,
      [userId, step],
    );
    if (r.rowCount === 0) throw new AuthError('profile_required');
    return { nextStep: nextOnboardingStep(await loadOnboardingState(this.pool, userId)) };
  }

  /** The Ð200k welcome grant. Idempotent: calling it again returns granted=false and changes nothing. */
  async claimWelcomeBonus(
    userId: string,
  ): Promise<{ granted: boolean; balanceKobo: number; nextStep: NextStep }> {
    const exists = await this.pool.query('SELECT 1 FROM profiles WHERE id = $1', [userId]);
    if (exists.rowCount === 0) throw new AuthError('profile_required');
    const result = await this.ledger.grantWelcome(userId);
    const bal = await this.pool.query<{ balance_kobo: string }>(
      'SELECT balance_kobo FROM wallets WHERE user_id = $1',
      [userId],
    );
    return {
      granted: !result.replayed,
      balanceKobo: Number(bal.rows[0]?.balance_kobo ?? 0),
      nextStep: nextOnboardingStep(await loadOnboardingState(this.pool, userId)),
    };
  }
}
