import { AuthService } from '../../src/auth/auth.service.ts';
import { parseReviewLogins } from '../../src/auth/review-logins.ts';
import { TokenService } from '../../src/auth/tokens.ts';
import { MemoryEmailProvider } from '../../src/email/email-provider.ts';
import { MemorySmsProvider } from '../../src/sms/sms-provider.ts';
import { createTestDb, type TestDb } from '../testing/testDb.ts';

const SECRET = 'k'.repeat(40);
const REVIEW_PHONE = '+2348031112233';
const REVIEW_EMAIL = 'review@mail.dyce.games';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

let tick = 0;
function build() {
  const sms = new MemorySmsProvider();
  const mail = new MemoryEmailProvider();
  // each test starts two hours after the last, so one test's codes never count against the next one's limits
  const clock = { now: new Date(Date.UTC(2026, 10, 24, 0, 0, 0) + ++tick * 2 * 3600_000) };
  const auth = new AuthService(
    db.app,
    sms,
    new TokenService(SECRET, { accessTtlSeconds: 900 }, () => clock.now),
    {
      phoneSecret: SECRET,
      otpTtlSeconds: 300,
      refreshTtlDays: 30,
      reviewCodes: parseReviewLogins(`${REVIEW_PHONE}=482913;${REVIEW_EMAIL}=739104`).codes,
    },
    () => clock.now,
    { warn: () => undefined },
    mail,
  );
  return { auth, sms, mail, clock };
}

describe('App Review demo logins (guideline 2.1(a))', () => {
  it('a listed phone signs in with its fixed code, and nothing is texted', async () => {
    const { auth, sms } = build();
    await auth.requestOtp({ phone: REVIEW_PHONE });
    expect(sms.sent).toHaveLength(0);
    const session = await auth.verifyOtp({ phone: REVIEW_PHONE, code: '482913' });
    expect(session.accessToken).toBeTruthy();
  });

  it('a listed email signs in with its fixed code, and nothing is emailed', async () => {
    const { auth, mail } = build();
    await auth.requestEmailOtp({ email: 'Review@Mail.Dyce.Games' });
    expect(mail.sent).toHaveLength(0);
    const session = await auth.verifyEmailOtp({ email: REVIEW_EMAIL, code: '739104' });
    expect(session.accessToken).toBeTruthy();
  });

  it('is the same account every time', async () => {
    const { auth, clock } = build();
    await auth.requestOtp({ phone: REVIEW_PHONE });
    const first = await auth.verifyOtp({ phone: REVIEW_PHONE, code: '482913' });
    clock.now = new Date(clock.now.getTime() + 31_000); // past the 30 s cooldown
    await auth.requestOtp({ phone: REVIEW_PHONE });
    const second = await auth.verifyOtp({ phone: REVIEW_PHONE, code: '482913' });
    expect(second.userId).toBe(first.userId);
    expect(second.isNewUser).toBe(false);
  });

  it('does not touch any other number or address: they still get a random code by text and email', async () => {
    const { auth, sms, mail } = build();
    await auth.requestOtp({ phone: '+2348039998877' });
    expect(sms.sent).toHaveLength(1);
    await expect(auth.verifyOtp({ phone: '+2348039998877', code: '482913' })).rejects.toMatchObject(
      { code: 'otp_invalid' },
    );
    await auth.requestEmailOtp({ email: 'someone.else@example.com' });
    expect(mail.sent).toHaveLength(1);
  });

  it('a wrong code for the demo account is refused like any other, and locks after five tries', async () => {
    const { auth } = build();
    await auth.requestOtp({ phone: REVIEW_PHONE });
    for (let i = 0; i < 4; i++) {
      await expect(auth.verifyOtp({ phone: REVIEW_PHONE, code: '000001' })).rejects.toMatchObject({
        code: 'otp_invalid',
      });
    }
    await expect(auth.verifyOtp({ phone: REVIEW_PHONE, code: '000001' })).rejects.toMatchObject({
      code: 'otp_locked',
    });
  });
});
