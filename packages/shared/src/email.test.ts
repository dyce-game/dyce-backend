import { isValidEmail, maskEmail, normalizeEmail } from './email.ts';
import { redactString, redactValue } from './redact.ts';

describe('normalizeEmail', () => {
  it('trims and lower-cases, so two spellings of one address are the same address', () => {
    expect(normalizeEmail('  Ada.Obi@Gmail.COM ')).toBe('ada.obi@gmail.com');
    expect(normalizeEmail('ADA@EXAMPLE.CO.UK')).toBe('ada@example.co.uk');
  });

  it('keeps plus tags as written (a different address to Dyce)', () => {
    expect(normalizeEmail('ada+games@gmail.com')).toBe('ada+games@gmail.com');
  });

  it('accepts ordinary addresses and unusual but legal ones', () => {
    for (const ok of [
      'a@b.co',
      'first.last@sub.example.com',
      "o'brien@example.ie",
      'x_y-z@my-site.org',
    ]) {
      expect(isValidEmail(ok)).toBe(true);
    }
  });

  it.each([
    '',
    'plainaddress',
    '@example.com',
    'ada@',
    'ada@example',
    'ada@@example.com',
    'a b@example.com',
    'ada@exa mple.com',
    'ada@.example.com',
    'ada@example..com',
    'ada@example.com.',
    '.ada@example.com',
    'ada.@example.com',
    'ada..obi@example.com',
    'ada@-example.com',
    'ada@example-.com',
    'ada@example.c',
    'ada@example.123',
    'ada@[127.0.0.1]',
    '"ada obi"@example.com',
    `${'a'.repeat(65)}@example.com`,
    `ada@${'a'.repeat(64)}.com`,
    `${'a'.repeat(250)}@x.co`,
  ])('rejects %j', (bad) => {
    expect(normalizeEmail(bad)).toBeNull();
  });

  it('normalises full-width characters before checking', () => {
    expect(normalizeEmail('ａｄａ@ｅｘａｍｐｌｅ.com')).toBe('ada@example.com');
  });
});

describe('maskEmail', () => {
  it('shows the first letter and the domain only', () => {
    expect(maskEmail('tunde.okafor@gmail.com')).toBe('t••••••@gmail.com');
    expect(maskEmail('a@b.co')).toBe('a•••@b.co');
  });
  it('never returns the local part', () => {
    expect(maskEmail('secretname@example.com')).not.toContain('ecretname');
  });
});

describe('redaction', () => {
  it('scrubs email addresses from free text and from "email" keys', () => {
    expect(redactString('failed to send to ada.obi@gmail.com now')).not.toContain('ada.obi');
    const out = redactValue({ email: 'ada@example.com', note: 'cc bob@example.org' }) as Record<
      string,
      string
    >;
    expect(out.email).toBe('[redacted]');
    expect(out.note).not.toContain('bob@');
  });
});
