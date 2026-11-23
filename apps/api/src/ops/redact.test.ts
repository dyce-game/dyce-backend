import { REDACTED, redactString, redactValue } from './redact.ts';

describe('redactString', () => {
  it.each([
    ['otp sent to +2348031234567 ok', '+2348031234567'],
    ['call +234 803 123 4567 now', '+234 803 123 4567'],
    ['us number +1 (415) 555-0100 here', '+1 (415) 555-0100'],
    ['local format 08031234567 given', '08031234567'],
    ['no plus 2348031234567 given', '2348031234567'],
  ])('removes phone numbers: %s', (input, secret) => {
    const out = redactString(input);
    expect(out).not.toContain(secret.replace(/\s/g, ''));
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it('removes JWTs and bearer credentials', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(redactString(`token ${jwt} end`)).not.toContain('eyJhbGci');
    expect(redactString('Authorization: Bearer abcdef1234567890')).not.toContain(
      'abcdef1234567890',
    );
  });

  it('removes passwords in connection strings and key=value pairs', () => {
    expect(redactString('postgres://dyce_app:hunter2@db.internal:5432/dyce')).not.toContain(
      'hunter2',
    );
    expect(redactString('refresh_token=abc123def456')).not.toContain('abc123def456');
    expect(redactString('otp: 424242')).not.toContain('424242');
  });

  it('leaves ids, timestamps and amounts alone', () => {
    const s =
      'user 7b1f3c52-9d0e-4f7a-8a55-1d2c3e4f5a6b paid 20000000 kobo at 1700000000000 (match 12)';
    expect(redactString(s)).toBe(s);
  });
});

describe('redactValue', () => {
  it('blanks sensitive keys at any depth and scrubs strings', () => {
    const out = redactValue({
      userId: 'u1',
      phone: '+2348031234567',
      headers: { authorization: 'Bearer x', 'x-request-id': 'abc' },
      nested: [{ refreshToken: 'secret', note: 'call +2348031234567' }],
      code: 'insufficient_funds',
    }) as Record<string, unknown>;
    expect(out.phone).toBe(REDACTED);
    expect((out.headers as Record<string, unknown>).authorization).toBe(REDACTED);
    expect((out.headers as Record<string, unknown>)['x-request-id']).toBe('abc');
    const nested = (out.nested as Record<string, unknown>[])[0]!;
    expect(nested.refreshToken).toBe(REDACTED);
    expect(String(nested.note)).not.toContain('2348031234567');
    expect(out.code).toBe('insufficient_funds');
    expect(out.userId).toBe('u1');
  });

  it('handles errors, cycles and depth without throwing', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect((redactValue(a) as Record<string, unknown>).self).toBe('[circular]');
    const err = redactValue(new Error('failed for +2348031234567')) as { message: string };
    expect(err.message).not.toContain('2348031234567');
  });
});
