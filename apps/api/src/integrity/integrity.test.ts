import { createHash } from 'node:crypto';
import {
  acceptableChallenges,
  challengeIsValid,
  createAttestationVerifier,
  DevAttestationVerifier,
  issueChallenge,
  StoreAttestationVerifier,
} from './attestation.ts';
import { matchAdminToken, parseAdminTokens } from './admin-tokens.ts';
import { readClientContext } from './client-context.ts';
import { hashDevice, hashIp, normaliseIp } from './fingerprint.ts';
import { scoreRequest, type SpamConfig, type SpamFacts } from './spam-filter.ts';

const SECRET = 's'.repeat(40);

describe('scoreRequest (the spam filter)', () => {
  const cfg: SpamConfig = {
    threshold: 50,
    newAccountHours: 24,
    massPerHour: 8,
    declines30d: 3,
    reports30d: 1,
  };
  const calm: SpamFacts = {
    known: false,
    accountAgeHours: 24 * 60,
    strangersLastHour: 1,
    declinedBy30d: 0,
    reporters30d: 0,
  };
  const score = (o: Partial<SpamFacts>) => scoreRequest({ ...calm, ...o }, cfg);

  it('leaves an ordinary request alone', () => {
    expect(score({})).toEqual({ score: 0, reasons: [], filtered: false });
  });

  it('a new account on its own is not enough', () => {
    expect(score({ accountAgeHours: 2 })).toEqual({
      score: 30,
      reasons: ['new_account'],
      filtered: false,
    });
  });

  it('a new account writing to many people is filtered', () => {
    expect(score({ accountAgeHours: 2, strangersLastHour: 8 })).toEqual({
      score: 70,
      reasons: ['new_account', 'mass_sending'],
      filtered: true,
    });
  });

  it('one report is a warning sign, three are enough alone', () => {
    expect(score({ reporters30d: 1 })).toMatchObject({ score: 30, filtered: false });
    expect(score({ reporters30d: 2 })).toMatchObject({ score: 30, filtered: false });
    expect(score({ reporters30d: 3 })).toMatchObject({
      score: 60,
      filtered: true,
      reasons: ['reported'],
    });
  });

  it('repeated declines count once the limit is reached', () => {
    expect(score({ declinedBy30d: 2 })).toMatchObject({ score: 0 });
    expect(score({ declinedBy30d: 3 })).toMatchObject({
      score: 40,
      reasons: ['repeated_declines'],
      filtered: false,
    });
    expect(score({ declinedBy30d: 3, reporters30d: 1 })).toMatchObject({
      score: 70,
      filtered: true,
    });
  });

  it('someone the recipient knows is never filtered, whatever else is true', () => {
    expect(
      score({
        known: true,
        accountAgeHours: 1,
        strangersLastHour: 99,
        declinedBy30d: 9,
        reporters30d: 9,
      }),
    ).toEqual({ score: 0, reasons: [], filtered: false });
  });

  it('caps at 100 and follows the configured limits', () => {
    expect(
      score({ accountAgeHours: 1, strangersLastHour: 50, declinedBy30d: 9, reporters30d: 9 }).score,
    ).toBe(100);
    expect(
      scoreRequest({ ...calm, strangersLastHour: 3 }, { ...cfg, massPerHour: 3 }).reasons,
    ).toEqual(['mass_sending']);
    expect(
      scoreRequest({ ...calm, accountAgeHours: 30 }, { ...cfg, newAccountHours: 48 }).reasons,
    ).toEqual(['new_account']);
  });
});

describe('fingerprints', () => {
  it('hashes the same install the same way and different ones differently, under a secret', () => {
    expect(hashDevice(SECRET, 'install-abcdefghijklmnop')).toEqual(
      hashDevice(SECRET, 'install-abcdefghijklmnop'),
    );
    expect(hashDevice(SECRET, 'install-abcdefghijklmnop')).not.toEqual(
      hashDevice(SECRET, 'install-abcdefghijklmnoq'),
    );
    expect(hashDevice(SECRET, 'install-abcdefghijklmnop')).not.toEqual(
      hashDevice('x'.repeat(40), 'install-abcdefghijklmnop'),
    );
    expect(hashDevice(SECRET, 'a').toString('hex')).toHaveLength(64);
  });

  it('keeps device, ip and the raw value apart', () => {
    expect(hashIp(SECRET, '10.1.2.3')).not.toEqual(hashDevice(SECRET, '10.1.2.3'));
    expect(hashIp(SECRET, '10.1.2.3').toString('hex')).not.toContain('10.1.2.3');
  });

  it('treats IPv4 mapped into IPv6 as the IPv4, and a whole IPv6 /64 as one connection', () => {
    expect(normaliseIp('::ffff:41.58.1.2')).toBe('41.58.1.2');
    expect(hashIp(SECRET, '::ffff:41.58.1.2')).toEqual(hashIp(SECRET, '41.58.1.2'));
    expect(normaliseIp('2a02:1234:abcd:1::1')).toBe(
      normaliseIp('2a02:1234:abcd:1:ffff:eeee:dddd:cccc'),
    );
    expect(normaliseIp('2a02:1234:abcd:1::1')).not.toBe(normaliseIp('2a02:1234:abcd:2::1'));
    expect(normaliseIp('2a02:1234:abcd:1::1')).toBe('2a02:1234:abcd:0001::/64');
  });
});

describe('client context headers', () => {
  const req = (headers: Record<string, string>, ip = '10.0.0.9') => ({ headers, ip });

  it('reads the install id, platform and token, and the proxy-trusted ip', () => {
    expect(
      readClientContext(
        req({
          'x-dyce-device': 'abcdefghijklmnop1234',
          'x-dyce-platform': 'ios',
          'x-dyce-attestation': 'tok',
        }),
      ),
    ).toEqual({
      ip: '10.0.0.9',
      deviceId: 'abcdefghijklmnop1234',
      platform: 'ios',
      attestation: 'tok',
    });
  });

  it('ignores a malformed install id, an unknown platform and an oversized token', () => {
    const ctx = readClientContext(
      req({
        'x-dyce-device': 'short',
        'x-dyce-platform': 'windows-phone',
        'x-dyce-attestation': 'x'.repeat(13_000),
      }),
    );
    expect(ctx).toEqual({ ip: '10.0.0.9', deviceId: null, platform: null, attestation: null });
    expect(readClientContext(req({}))).toMatchObject({ deviceId: null, attestation: null });
  });
});

describe('attestation', () => {
  const now = new Date('2026-11-14T10:03:00Z');

  it('the dev driver passes everything, the store stub passes nothing', async () => {
    const input = {
      userId: 'u',
      platform: 'android' as const,
      token: 't',
      deviceId: null,
      challenges: [],
    };
    await expect(new DevAttestationVerifier().verify()).resolves.toEqual({ ok: true });
    await expect(new StoreAttestationVerifier().verify()).resolves.toEqual({
      ok: false,
      reason: 'not_configured',
    });
    expect(createAttestationVerifier('dev').name).toBe('dev');
    expect(createAttestationVerifier('store').name).toBe('store');
    void input;
  });

  it('a challenge is stable inside a window, per person, and a token from the last window still counts', () => {
    const a = issueChallenge(SECRET, 'user-a', now, 5);
    expect(issueChallenge(SECRET, 'user-a', new Date(now.getTime() + 60_000), 5).challenge).toBe(
      a.challenge,
    );
    expect(issueChallenge(SECRET, 'user-b', now, 5).challenge).not.toBe(a.challenge);
    expect(issueChallenge('z'.repeat(40), 'user-a', now, 5).challenge).not.toBe(a.challenge);

    const later = new Date(now.getTime() + 5 * 60_000);
    expect(challengeIsValid(a.challenge, acceptableChallenges(SECRET, 'user-a', later, 5))).toBe(
      true,
    );
    const muchLater = new Date(now.getTime() + 15 * 60_000);
    expect(
      challengeIsValid(a.challenge, acceptableChallenges(SECRET, 'user-a', muchLater, 5)),
    ).toBe(false);
    expect(challengeIsValid('nonsense', acceptableChallenges(SECRET, 'user-a', now, 5))).toBe(
      false,
    );
    expect(a.expiresAt.getTime()).toBeGreaterThan(now.getTime());
  });
});

describe('admin tokens', () => {
  const good = 'a'.repeat(32);
  const other = 'b'.repeat(40);

  it('is off when nothing is configured', () => {
    expect(parseAdminTokens(undefined)).toBeNull();
    expect(parseAdminTokens('  ')).toBeNull();
  });

  it('maps tokens to moderator names and stores only digests', () => {
    const tokens = parseAdminTokens(`amaka:${good}, tunde:${other}`)!;
    expect([...tokens.keys()]).toEqual(['amaka', 'tunde']);
    expect(tokens.get('amaka')).toEqual(createHash('sha256').update(good).digest());
    expect(matchAdminToken(tokens, `Bearer ${good}`)).toBe('amaka');
    expect(matchAdminToken(tokens, `bearer ${other}`)).toBe('tunde');
  });

  it('rejects anything else', () => {
    const tokens = parseAdminTokens(`amaka:${good}`)!;
    expect(matchAdminToken(tokens, undefined)).toBeNull();
    expect(matchAdminToken(tokens, 'Bearer nope')).toBeNull();
    expect(matchAdminToken(tokens, good)).toBeNull();
    expect(matchAdminToken(tokens, `Basic ${good}`)).toBeNull();
  });

  it('refuses weak tokens and names that could pass for the system', () => {
    expect(() => parseAdminTokens('amaka:short')).toThrow(/ADMIN_TOKENS/);
    expect(() => parseAdminTokens(`:${good}`)).toThrow(/ADMIN_TOKENS/);
    expect(() => parseAdminTokens(`Amaka:${good}`)).toThrow(/ADMIN_TOKENS/);
    expect(() => parseAdminTokens(`system:${good}`)).toThrow(/ADMIN_TOKENS/);
  });
});
