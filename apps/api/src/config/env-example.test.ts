import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { envSchema, validateEnv } from './env.ts';

const file = readFileSync(join(__dirname, '../../../../deploy/production.env.example'), 'utf8');

/** Names that appear as `NAME=` (commented or not) at the start of a line. */
const documented = new Set([...file.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!));

describe('deploy/production.env.example', () => {
  it('documents every variable the API reads', () => {
    const missing = Object.keys(envSchema.shape).filter((k) => !documented.has(k));
    expect(missing).toEqual([]);
  });

  it('documents the game server variables and the migration URL', () => {
    for (const k of ['PORT', 'RECONNECT_SECONDS', 'JOIN_GRACE_SECONDS', 'MIGRATION_DATABASE_URL']) {
      expect(documented.has(k)).toBe(true);
    }
  });

  it('boots as-is once the placeholders are filled (the template is a valid production config)', () => {
    const raw: Record<string, string> = {};
    for (const m of file.matchAll(/^([A-Z][A-Z0-9_]+)=(.*)$/gm)) raw[m[1]!] = m[2]!;
    raw.JWT_SECRET = 'j'.repeat(48);
    raw.PHONE_HASH_SALT = 's'.repeat(48);
    raw.INTERNAL_SECRET = 'i'.repeat(48);
    raw.TERMII_API_KEY = 'k';
    raw.TERMII_SENDER_ID = 'Dyce';
    const env = validateEnv(raw);
    expect(env.NODE_ENV).toBe('production');
    expect(env.SMS_DRIVER).toBe('real');
    expect(env.PUSH_DRIVER).toBe('expo');
    expect(env.LEDGER_CHECK_ENABLED).toBe(true);
    expect(env.OTP_TEST_CODE).toBeUndefined();
  });

  it('contains no real-looking secrets', () => {
    expect(file).not.toMatch(/eyJ[\w-]{10,}\./);
    expect(file).not.toMatch(/supabase\.com/);
    expect(file).not.toMatch(/(?:sk|pk)_(?:live|test)_/);
  });
});
