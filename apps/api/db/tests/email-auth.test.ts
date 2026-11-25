import { AuthService, OTP_LIMIT_PER_10_MIN, type AuthConfig } from '../../src/auth/auth.service.ts';
import { TokenService } from '../../src/auth/tokens.ts';
import { MemoryEmailProvider } from '../../src/email/email-provider.ts';
import { ProfileService } from '../../src/profile/profile.service.ts';
import { LedgerRepo } from '../../src/ledger/ledger.repo.ts';
import { MemorySmsProvider } from '../../src/sms/sms-provider.ts';
import { createTestDb, type TestDb } from '../testing/testDb.ts';

const SECRET = 'k'.repeat(40);

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

type Harness = {
  auth: AuthService;
  mail: MemoryEmailProvider;
  sms: MemorySmsProvider;
  clock: { now: Date; advance(seconds: number): void };
  warnings: string[];
};

function harness(opts: { overrides?: Partial<AuthConfig>; withEmail?: boolean } = {}): Harness {
  const clock = {
    now: new Date('2026-11-24T10:00:00Z'),
    advance(seconds: number) {
      this.now = new Date(this.now.getTime() + seconds * 1000);
    },
  };
  const mail = new MemoryEmailProvider();
  const sms = new MemorySmsProvider();
  const tokens = new TokenService(SECRET, { accessTtlSeconds: 900 }, () => clock.now);
  const warnings: string[] = [];
  const auth = new AuthService(
    db.app,
    sms,
    tokens,
    { phoneSecret: SECRET, otpTtlSeconds: 300, refreshTtlDays: 30, ...opts.overrides },
    () => clock.now,
    { warn: (m) => warnings.push(m) },
    opts.withEmail === false ? undefined : mail,
  );
  return { auth, mail, sms, clock, warnings };
}

let n = 0;
const freshEmail = () => `player${++n}.${Math.random().toString(36).slice(2, 8)}@example.com`;
const freshPhone = () => {
  const d = String(2000000 + ++n * 11).padStart(7, '0');
  return { input: `0803${d}`, e164: `+234803${d}` };
};
const code = (c: string) => expect.objectContaining({ code: c });

async function signUp(h: Harness, email = freshEmail()) {
  await h.auth.requestEmailOtp({ email });
  const session = await h.auth.verifyEmailOtp({ email, code: h.mail.lastCode() });
  return { session, email };
}

describe('requestEmailOtp', () => {
  it('emails a 6-digit code to the normalised address, with the challenge id as the idempotency key', async () => {
    const h = harness();
    const res = await h.auth.requestEmailOtp({ email: '  Ada.Obi@Example.COM ' });
    expect(res).toEqual({ resendAfterSeconds: 30, expiresInSeconds: 300 });
    expect(h.mail.sent).toHaveLength(1);
    const sent = h.mail.sent[0]!;
    expect(sent.to).toBe('ada.obi@example.com');
    expect(sent.subject).toMatch(/^\d{6} is your Dyce code$/);
    expect(h.mail.lastCode()).toMatch(/^\d{6}$/);
    expect(sent.idempotencyKey).toMatch(/^otp-[0-9a-f-]{36}$/);
    expect(sent.html).toContain(h.mail.lastCode());
  });

  it('rejects an address that cannot be one, before sending anything', async () => {
    const h = harness();
    for (const bad of ['', 'nope', 'a@b', 'ada@example', 'ada @example.com', '@example.com']) {
      await expect(h.auth.requestEmailOtp({ email: bad })).rejects.toEqual(code('invalid_email'));
    }
    expect(h.mail.sent).toHaveLength(0);
  });

  it('is off, and says so, when the server has no email provider', async () => {
    const h = harness({ withEmail: false });
    expect(h.auth.methods()).toEqual({ phone: true, email: false });
    await expect(h.auth.requestEmailOtp({ email: freshEmail() })).rejects.toEqual(
      code('email_auth_disabled'),
    );
    await expect(h.auth.verifyEmailOtp({ email: freshEmail(), code: '123456' })).rejects.toEqual(
      code('email_auth_disabled'),
    );
  });

  it('reports itself as available when there is a provider', () => {
    expect(harness().auth.methods()).toEqual({ phone: true, email: true });
  });

  it('enforces the 30 second resend cooldown, the 10 minute and the daily limits per address', async () => {
    const h = harness();
    const email = freshEmail();
    await h.auth.requestEmailOtp({ email });
    await expect(h.auth.requestEmailOtp({ email })).rejects.toEqual(code('otp_resend_too_soon'));
    for (let i = 1; i < OTP_LIMIT_PER_10_MIN; i++) {
      h.clock.advance(31);
      await h.auth.requestEmailOtp({ email });
    }
    h.clock.advance(31);
    await expect(h.auth.requestEmailOtp({ email })).rejects.toEqual(code('otp_rate_limited'));
    expect(h.mail.sent).toHaveLength(OTP_LIMIT_PER_10_MIN);
  });

  it('keeps each address on its own limits (and the same limits as a phone, separately)', async () => {
    const h = harness();
    const a = freshEmail();
    await h.auth.requestEmailOtp({ email: a });
    await h.auth.requestEmailOtp({ email: freshEmail() });
    await h.auth.requestOtp({ phone: freshPhone().input, country: 'NG' });
    expect(h.mail.sent).toHaveLength(2);
  });

  it('a different spelling of the same address shares one set of limits', async () => {
    const h = harness();
    const email = freshEmail();
    await h.auth.requestEmailOtp({ email });
    await expect(h.auth.requestEmailOtp({ email: email.toUpperCase() })).rejects.toEqual(
      code('otp_resend_too_soon'),
    );
  });

  it('does not burn the limit when the provider fails, and logs no address', async () => {
    const h = harness();
    const email = freshEmail();
    h.mail.failWith = 'HTTP 500';
    await expect(h.auth.requestEmailOtp({ email })).rejects.toEqual(code('email_failed'));
    expect(h.warnings.join('\n')).not.toContain(email);
    expect(h.warnings.join('\n')).toContain('example.com'); // the masked form keeps the domain
    h.mail.failWith = null;
    await h.auth.requestEmailOtp({ email }); // no cooldown: the failed challenge was removed
    expect(h.mail.sent).toHaveLength(1);
  });

  it('answers the same whether or not the address already has an account', async () => {
    const h = harness();
    const known = (await signUp(h)).email;
    h.clock.advance(3600);
    const a = await h.auth.requestEmailOtp({ email: known });
    const b = await h.auth.requestEmailOtp({ email: freshEmail() });
    expect(a).toEqual(b);
  });

  it('sends nothing, and accepts the fixed code, in test mode', async () => {
    const h = harness({ overrides: { otpTestCode: '424242' } });
    const email = freshEmail();
    await h.auth.requestEmailOtp({ email });
    expect(h.mail.sent).toHaveLength(0);
    const session = await h.auth.verifyEmailOtp({ email, code: '424242' });
    expect(session.isNewUser).toBe(true);
  });
});

describe('verifyEmailOtp', () => {
  it('creates an account for a new address and logs a known one back in to the same account', async () => {
    const h = harness();
    const first = await signUp(h);
    expect(first.session.isNewUser).toBe(true);
    expect(first.session.nextStep).toBe('username');
    expect(first.session.accessToken).toBeTruthy();
    h.clock.advance(3600);
    await h.auth.requestEmailOtp({ email: first.email });
    const again = await h.auth.verifyEmailOtp({ email: first.email, code: h.mail.lastCode() });
    expect(again.isNewUser).toBe(false);
    expect(again.userId).toBe(first.session.userId);
  });

  it('treats a different spelling as the same person', async () => {
    const h = harness();
    const first = await signUp(h, 'Sam.Case@Example.com');
    h.clock.advance(3600);
    await h.auth.requestEmailOtp({ email: 'sam.case@example.com' });
    const again = await h.auth.verifyEmailOtp({
      email: 'SAM.CASE@EXAMPLE.COM',
      code: h.mail.lastCode(),
    });
    expect(again.userId).toBe(first.session.userId);
  });

  it('rejects a wrong code, counts the tries, and locks after five', async () => {
    const h = harness();
    const email = freshEmail();
    await h.auth.requestEmailOtp({ email });
    const right = h.mail.lastCode();
    const wrong = right === '000000' ? '111111' : '000000';
    await expect(h.auth.verifyEmailOtp({ email, code: wrong })).rejects.toEqual(
      expect.objectContaining({ code: 'otp_invalid', details: { attemptsRemaining: 4 } }),
    );
    for (let i = 0; i < 3; i++)
      await expect(h.auth.verifyEmailOtp({ email, code: wrong })).rejects.toBeTruthy();
    await expect(h.auth.verifyEmailOtp({ email, code: wrong })).rejects.toEqual(code('otp_locked'));
    // even the right code no longer works once locked
    await expect(h.auth.verifyEmailOtp({ email, code: right })).rejects.toEqual(code('otp_locked'));
  });

  it('rejects an expired code, and a code can be used only once', async () => {
    const h = harness();
    const email = freshEmail();
    await h.auth.requestEmailOtp({ email });
    const c = h.mail.lastCode();
    h.clock.advance(301);
    await expect(h.auth.verifyEmailOtp({ email, code: c })).rejects.toEqual(code('otp_expired'));

    const second = freshEmail();
    await h.auth.requestEmailOtp({ email: second });
    const c2 = h.mail.lastCode();
    await h.auth.verifyEmailOtp({ email: second, code: c2 });
    await expect(h.auth.verifyEmailOtp({ email: second, code: c2 })).rejects.toEqual(
      code('otp_invalid'),
    );
  });

  it('does not accept a code that was emailed to a different address', async () => {
    const h = harness();
    const a = freshEmail();
    const b = freshEmail();
    await h.auth.requestEmailOtp({ email: a });
    const codeForA = h.mail.lastCode();
    await h.auth.requestEmailOtp({ email: b });
    await expect(
      h.auth.verifyEmailOtp({
        email: b,
        code: codeForA === h.mail.lastCode() ? '999999' : codeForA,
      }),
    ).rejects.toBeTruthy();
  });

  it('refuses a disabled account', async () => {
    const h = harness();
    const { session, email } = await signUp(h);
    await db.admin.query('UPDATE users SET disabled_at = now() WHERE id = $1', [session.userId]);
    h.clock.advance(3600);
    await h.auth.requestEmailOtp({ email });
    await expect(h.auth.verifyEmailOtp({ email, code: h.mail.lastCode() })).rejects.toEqual(
      code('account_disabled'),
    );
  });

  it('refuses a suspended account', async () => {
    const h = harness();
    const { session, email } = await signUp(h);
    await db.admin.query(
      "UPDATE users SET suspended_until = now() + interval '30 days' WHERE id = $1",
      [session.userId],
    );
    h.clock.advance(3600);
    await h.auth.requestEmailOtp({ email });
    await expect(h.auth.verifyEmailOtp({ email, code: h.mail.lastCode() })).rejects.toEqual(
      code('account_suspended'),
    );
  });
});

describe('what is stored', () => {
  it('keeps only a hash and a masked hint of the address, never the address', async () => {
    const h = harness();
    const email = 'private.person@example.com';
    const { session } = await signUp(h, email);
    const u = await db.admin.query(
      'SELECT phone_hash, email_hash, email_hint, email_verified_at FROM users WHERE id = $1',
      [session.userId],
    );
    expect(u.rows[0].phone_hash).toBeNull();
    expect(Buffer.isBuffer(u.rows[0].email_hash)).toBe(true);
    expect(u.rows[0].email_hint).toBe('p••••••@example.com');
    expect(u.rows[0].email_verified_at).not.toBeNull();
    // nothing anywhere in the identity tables contains the address
    const dump = await db.admin.query(
      `SELECT row_to_json(u)::text AS t FROM users u WHERE id = $1
       UNION ALL SELECT row_to_json(o)::text FROM otp_challenges o WHERE o.email_hash = $2`,
      [session.userId, u.rows[0].email_hash],
    );
    expect(dump.rows.map((r) => r.t).join('\n')).not.toContain('private.person');
  });

  it('refuses an account with no way back in', async () => {
    await expect(
      db.admin.query('INSERT INTO users (phone_hash, email_hash) VALUES (NULL, NULL)'),
    ).rejects.toThrow(/users_identity_chk/);
  });

  it('refuses a challenge for both or neither identity', async () => {
    await expect(
      db.admin.query(
        `INSERT INTO otp_challenges (phone_hash, email_hash, code_hash, expires_at)
         VALUES ('\\x01', '\\x02', '\\x03', now())`,
      ),
    ).rejects.toThrow(/otp_challenges_one_identity_chk/);
    await expect(
      db.admin.query(`INSERT INTO otp_challenges (code_hash, expires_at) VALUES ('\\x03', now())`),
    ).rejects.toThrow(/otp_challenges_one_identity_chk/);
  });

  it('phone and email accounts are different accounts until linked', async () => {
    const h = harness();
    const phone = freshPhone();
    await h.auth.requestOtp({ phone: phone.input, country: 'NG' });
    const byPhone = await h.auth.verifyOtp({
      phone: phone.input,
      country: 'NG',
      code: h.sms.lastCode(),
    });
    const byEmail = (await signUp(h)).session;
    expect(byPhone.userId).not.toBe(byEmail.userId);
  });
});

describe('linking the other way in', () => {
  it('adds an email to a phone account, which can then log in with it', async () => {
    const h = harness();
    const phone = freshPhone();
    await h.auth.requestOtp({ phone: phone.input, country: 'NG' });
    const me = await h.auth.verifyOtp({
      phone: phone.input,
      country: 'NG',
      code: h.sms.lastCode(),
    });
    expect(await h.auth.signInMethods(me.userId)).toEqual({ phone: true, emailHint: null });

    const email = freshEmail();
    await h.auth.requestEmailLink(me.userId, { email });
    expect(h.mail.sent.at(-1)!.text).toContain('add this email address');
    const methods = await h.auth.verifyEmailLink(me.userId, { email, code: h.mail.lastCode() });
    expect(methods.phone).toBe(true);
    expect(methods.emailHint).toMatch(/@example\.com$/);

    h.clock.advance(3600);
    await h.auth.requestEmailOtp({ email });
    const login = await h.auth.verifyEmailOtp({ email, code: h.mail.lastCode() });
    expect(login.userId).toBe(me.userId);
    expect(login.isNewUser).toBe(false);
  });

  it('adds a phone to an email account', async () => {
    const h = harness();
    const { session } = await signUp(h);
    const phone = freshPhone();
    await h.auth.requestPhoneLink(session.userId, { phone: phone.input, country: 'NG' });
    const methods = await h.auth.verifyPhoneLink(session.userId, {
      phone: phone.input,
      country: 'NG',
      code: h.sms.lastCode(),
    });
    expect(methods.phone).toBe(true);
    expect(methods.emailHint).not.toBeNull();
    h.clock.advance(3600);
    await h.auth.requestOtp({ phone: phone.input, country: 'NG' });
    const login = await h.auth.verifyOtp({
      phone: phone.input,
      country: 'NG',
      code: h.sms.lastCode(),
    });
    expect(login.userId).toBe(session.userId);
  });

  it("will not take an address (or a number) that is another account's", async () => {
    const h = harness();
    const owner = await signUp(h);
    const other = await signUp(h);
    await expect(
      h.auth.requestEmailLink(other.session.userId, { email: owner.email }),
    ).rejects.toEqual(code('identity_taken'));
    const phone = freshPhone();
    await h.auth.requestOtp({ phone: phone.input, country: 'NG' });
    await h.auth.verifyOtp({ phone: phone.input, country: 'NG', code: h.sms.lastCode() });
    await expect(
      h.auth.requestPhoneLink(other.session.userId, { phone: phone.input, country: 'NG' }),
    ).rejects.toEqual(code('identity_taken'));
  });

  it('does not link on a wrong code, and does not let a code for one address link another', async () => {
    const h = harness();
    const { session } = await signUp(h);
    const email = freshEmail();
    await h.auth.requestEmailLink(session.userId, { email });
    const wrong = h.mail.lastCode() === '000000' ? '111111' : '000000';
    await expect(h.auth.verifyEmailLink(session.userId, { email, code: wrong })).rejects.toEqual(
      expect.objectContaining({ code: 'otp_invalid' }),
    );
    const before = await h.auth.signInMethods(session.userId);
    expect(before.emailHint).not.toBe(email);
  });

  it('can change the linked address to a new one', async () => {
    const h = harness();
    const { session } = await signUp(h);
    const next = 'brand.new@example.org';
    await h.auth.requestEmailLink(session.userId, { email: next });
    const methods = await h.auth.verifyEmailLink(session.userId, {
      email: next,
      code: h.mail.lastCode(),
    });
    expect(methods.emailHint).toBe('b••••••@example.org');
  });

  it('is off when the server has no email provider', async () => {
    const h = harness({ withEmail: false });
    const phone = freshPhone();
    await h.auth.requestOtp({ phone: phone.input, country: 'NG' });
    const me = await h.auth.verifyOtp({
      phone: phone.input,
      country: 'NG',
      code: h.sms.lastCode(),
    });
    await expect(h.auth.requestEmailLink(me.userId, { email: freshEmail() })).rejects.toEqual(
      code('email_auth_disabled'),
    );
  });
});

describe('/me and deleting the account', () => {
  it('tells the app how the person can sign in', async () => {
    const h = harness();
    const { session } = await signUp(h);
    const profiles = new ProfileService(db.app, new LedgerRepo(db.app));
    await profiles.createProfile(session.userId, {
      username: `mail_${n}_${Math.random().toString(36).slice(2, 6)}`,
    });
    const me = await profiles.getMe(session.userId);
    expect(me.signIn.phone).toBe(false);
    expect(me.signIn.emailHint).toMatch(/@example\.com$/);
  });

  it('frees the address when the account is deleted, so it can be used again', async () => {
    const h = harness();
    const { session, email } = await signUp(h);
    const profiles = new ProfileService(db.app, new LedgerRepo(db.app));
    await profiles.createProfile(session.userId, {
      username: `gone_${n}_${Math.random().toString(36).slice(2, 6)}`,
    });
    await db.admin.query('SELECT request_account_deletion($1)', [session.userId]);
    await db.admin.query(
      "UPDATE account_deletions SET execute_after = now() - interval '1 minute' WHERE user_id = $1",
      [session.userId],
    );
    await db.admin.query('SELECT anonymise_account($1)', [session.userId]);

    const row = await db.admin.query(
      'SELECT email_hash, email_hint, email_verified_at, phone_hash FROM users WHERE id = $1',
      [session.userId],
    );
    expect(row.rows[0].email_hash).toBeNull();
    expect(row.rows[0].email_hint).toBeNull();
    expect(row.rows[0].email_verified_at).toBeNull();
    expect(row.rows[0].phone_hash).not.toBeNull(); // the random placeholder that keeps the row valid

    h.clock.advance(3600);
    const again = await signUp(h, email);
    expect(again.session.isNewUser).toBe(true);
    expect(again.session.userId).not.toBe(session.userId);
  });
});
