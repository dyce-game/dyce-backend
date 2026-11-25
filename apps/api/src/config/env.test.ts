import { validateEnv } from './env.ts';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost/db',
  JWT_SECRET: 'j'.repeat(40),
  PHONE_HASH_SALT: 's'.repeat(40),
};

describe('validateEnv', () => {
  it('applies safe defaults in development', () => {
    const env = validateEnv({ ...base });
    expect(env.PORT).toBe(3000);
    expect(env.JWT_ACCESS_TTL_SECONDS).toBe(900);
    expect(env.REFRESH_TTL_DAYS).toBe(30);
    expect(env.OTP_TTL_SECONDS).toBe(300);
    expect(env.SMS_DRIVER).toBe('console');
  });

  it('rejects weak or missing secrets', () => {
    expect(() => validateEnv({ ...base, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    expect(() => validateEnv({ ...base, PHONE_HASH_SALT: 'short' })).toThrow(/PHONE_HASH_SALT/);
    expect(() => validateEnv({ ...base, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });

  it('treats blank values from a .env file as unset', () => {
    const env = validateEnv({ ...base, OTP_TEST_CODE: '', TERMII_API_KEY: '' });
    expect(env.OTP_TEST_CODE).toBeUndefined();
  });

  it('only accepts a 6-digit test OTP', () => {
    expect(validateEnv({ ...base, OTP_TEST_CODE: '123456' }).OTP_TEST_CODE).toBe('123456');
    expect(() => validateEnv({ ...base, OTP_TEST_CODE: '12345' })).toThrow(/OTP_TEST_CODE/);
  });

  describe('production safety', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      SMS_DRIVER: 'real',
      PUSH_DRIVER: 'expo',
      INTEGRITY_DRIVER: 'store',
      TERMII_API_KEY: 'k',
      TERMII_SENDER_ID: 'Dyce',
      EMAIL_DRIVER: 'resend',
      RESEND_API_KEY: 're_key',
      EMAIL_FROM: 'Dyce <login@mail.dyce.games>',
    };

    it('accepts a properly configured production env', () => {
      expect(validateEnv(prod).NODE_ENV).toBe('production');
    });
    it('refuses the pass-everything device check in production', () => {
      expect(() => validateEnv({ ...prod, INTEGRITY_DRIVER: 'dev' })).toThrow(/INTEGRITY_DRIVER/);
    });
    it('needs an admin database for the moderation tokens', () => {
      expect(() => validateEnv({ ...prod, ADMIN_TOKENS: `amaka:${'a'.repeat(32)}` })).toThrow(
        /ADMIN_DATABASE_URL/,
      );
      expect(
        validateEnv({
          ...prod,
          ADMIN_TOKENS: `amaka:${'a'.repeat(32)}`,
          ADMIN_DATABASE_URL: 'postgres://m@localhost/dyce',
        }).ADMIN_TOKENS,
      ).toBeDefined();
    });
    it('refuses a test OTP code in production', () => {
      expect(() => validateEnv({ ...prod, OTP_TEST_CODE: '123456' })).toThrow(
        /OTP_TEST_CODE.*production/,
      );
    });
    it('refuses the console SMS driver in production', () => {
      expect(() => validateEnv({ ...prod, SMS_DRIVER: 'console' })).toThrow(/SMS_DRIVER/);
    });
    it('refuses the console email driver in production while email sign-in is on', () => {
      expect(() => validateEnv({ ...prod, EMAIL_DRIVER: 'console' })).toThrow(/EMAIL_DRIVER/);
    });
    it('lets production run without email sign-in at all', () => {
      const env = validateEnv({
        ...prod,
        EMAIL_AUTH_ENABLED: 'false',
        EMAIL_DRIVER: 'console',
        RESEND_API_KEY: undefined,
        EMAIL_FROM: undefined,
      });
      expect(env.EMAIL_AUTH_ENABLED).toBe(false);
    });
    it('refuses the console push driver in production', () => {
      expect(() => validateEnv({ ...prod, PUSH_DRIVER: 'console' })).toThrow(/PUSH_DRIVER/);
    });
  });

  describe('real SMS', () => {
    const real = { ...base, SMS_DRIVER: 'real' };
    it('needs at least one complete provider', () => {
      expect(() => validateEnv(real)).toThrow(/SMS_DRIVER/);
      expect(() => validateEnv({ ...real, TERMII_API_KEY: 'k' })).toThrow(/SMS_DRIVER/); // no sender id
      expect(() =>
        validateEnv({ ...real, TWILIO_ACCOUNT_SID: 'a', TWILIO_AUTH_TOKEN: 't' }),
      ).toThrow(/SMS_DRIVER/);
    });
    it('accepts Termii alone, Twilio alone, or both', () => {
      expect(validateEnv({ ...real, TERMII_API_KEY: 'k', TERMII_SENDER_ID: 'Dyce' })).toBeTruthy();
      expect(
        validateEnv({
          ...real,
          TWILIO_ACCOUNT_SID: 'a',
          TWILIO_AUTH_TOKEN: 't',
          TWILIO_MESSAGING_SERVICE_SID: 'm',
        }),
      ).toBeTruthy();
    });
  });

  describe('email sign-in (ADR-044)', () => {
    it('is on by default with the console driver in development', () => {
      const env = validateEnv(base);
      expect(env.EMAIL_AUTH_ENABLED).toBe(true);
      expect(env.EMAIL_DRIVER).toBe('console');
    });
    it('needs a key and a sender for Resend', () => {
      const resend = { ...base, EMAIL_DRIVER: 'resend' };
      expect(() => validateEnv(resend)).toThrow(/RESEND_API_KEY/);
      expect(() => validateEnv({ ...resend, RESEND_API_KEY: 're_key' })).toThrow(/EMAIL_FROM/);
      expect(() =>
        validateEnv({ ...resend, RESEND_API_KEY: 're_key', EMAIL_FROM: 'not an address' }),
      ).toThrow(/EMAIL_FROM/);
    });
    it('accepts a named or a bare sender address', () => {
      for (const from of ['Dyce <login@mail.dyce.games>', 'login@mail.dyce.games']) {
        const env = validateEnv({
          ...base,
          EMAIL_DRIVER: 'resend',
          RESEND_API_KEY: 're_key',
          EMAIL_FROM: from,
        });
        expect(env.EMAIL_FROM).toBe(from);
      }
    });
  });
});
