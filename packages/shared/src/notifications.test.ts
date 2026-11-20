import {
  describeNotification,
  inQuietHours,
  NOTIFICATION_KINDS,
  notificationPrefsUpdateSchema,
  peopleSearchQuerySchema,
  leaderboardQuerySchema,
  PUSH_GROUP_OF,
  pushTokenSchema,
} from './index.ts';

describe('describeNotification', () => {
  it('gives every kind a title, a body and a route', () => {
    for (const kind of NOTIFICATION_KINDS) {
      const t = describeNotification(
        kind,
        { matchId: 'm1', gameName: 'Pig', code: 'ABC' },
        'Amaka',
      );
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.body.length).toBeGreaterThan(0);
      expect(t.route.startsWith('/')).toBe(true);
    }
  });

  it('never throws on a payload with missing facts', () => {
    for (const kind of NOTIFICATION_KINDS)
      expect(() => describeNotification(kind, {}, null)).not.toThrow();
  });

  it('words a Pool invite, a counter-offer, a win and a refund with naira', () => {
    expect(
      describeNotification(
        'game_invite',
        { mode: 'pool', stakeKobo: 100_000, gameName: 'Pig', matchId: 'm' },
        'Tunde',
      ).title,
    ).toBe('Tunde challenged you for ₦1,000');
    expect(
      describeNotification(
        'pool_countered',
        { stakeKobo: 100_000, counterStakeKobo: 50_000, gameName: 'Pig', matchId: 'm' },
        'Tunde',
      ).body,
    ).toBe('Tunde wants ₦500 each instead of ₦1,000.');
    expect(
      describeNotification(
        'pool_result',
        { result: 'win', payoutKobo: 200_000, gameName: 'Pig', matchId: 'm' },
        'Tunde',
      ).title,
    ).toBe('You won ₦2,000');
    expect(
      describeNotification('pool_refunded', { amountKobo: 50_000, reason: 'expired' }, 'Zainab')
        .body,
    ).toContain('Zainab did not answer in time');
  });

  it('sends a space result to the space and a money request to the pay screen', () => {
    expect(
      describeNotification(
        'game_result',
        { result: 'win', spaceId: 's1', matchId: 'm', gameName: 'Whot!' },
        null,
      ).route,
    ).toBe('/space/s1/result');
    expect(
      describeNotification('money_requested', { amountKobo: 500_000, code: 'ABCDEFGHIJ' }, 'Ada')
        .route,
    ).toBe('/wallet/pay/ABCDEFGHIJ');
  });

  it('pushes only what has a switch: results of Free games and levels stay in the list', () => {
    expect(PUSH_GROUP_OF.game_result).toBeNull();
    expect(PUSH_GROUP_OF.level_up).toBeNull();
    expect(PUSH_GROUP_OF.your_turn).toBe('turns');
    expect(PUSH_GROUP_OF.pool_refunded).toBe('pool');
  });
});

describe('inQuietHours', () => {
  const q = { enabled: true, startMinute: 22 * 60, endMinute: 7 * 60 };
  const at = (iso: string) => new Date(iso);

  it('wraps past midnight on the person’s own clock', () => {
    // Lagos = UTC+1: 21:30 UTC is 22:30 there (quiet), 05:30 UTC is 06:30 (quiet), 06:30 UTC is 07:30 (awake)
    expect(inQuietHours(at('2026-11-19T21:30:00Z'), q, 60)).toBe(true);
    expect(inQuietHours(at('2026-11-19T05:30:00Z'), q, 60)).toBe(true);
    expect(inQuietHours(at('2026-11-19T06:30:00Z'), q, 60)).toBe(false);
    expect(inQuietHours(at('2026-11-19T12:00:00Z'), q, 60)).toBe(false);
  });
  it('handles a window inside one day and negative offsets', () => {
    const lunch = { enabled: true, startMinute: 12 * 60, endMinute: 14 * 60 };
    expect(inQuietHours(at('2026-11-19T12:30:00Z'), lunch, 0)).toBe(true);
    expect(inQuietHours(at('2026-11-19T14:00:00Z'), lunch, 0)).toBe(false);
    // New York winter, UTC-5: 03:00 UTC is 22:00 the day before
    expect(inQuietHours(at('2026-11-19T03:00:00Z'), q, -300)).toBe(true);
  });
  it('is off when disabled or when start equals end', () => {
    expect(inQuietHours(at('2026-11-19T23:00:00Z'), { ...q, enabled: false }, 0)).toBe(false);
    expect(inQuietHours(at('2026-11-19T23:00:00Z'), { ...q, endMinute: q.startMinute }, 0)).toBe(
      false,
    );
  });
});

describe('request schemas', () => {
  it('normalises a people search and bounds its length', () => {
    expect(peopleSearchQuerySchema.parse({ q: '  @Zainab ' }).q).toBe('zainab');
    expect(peopleSearchQuerySchema.safeParse({ q: 'a' }).success).toBe(false);
    expect(peopleSearchQuerySchema.safeParse({ q: 'x'.repeat(31) }).success).toBe(false);
  });
  it('refuses a global Pool leaderboard (money is only ranked among friends)', () => {
    expect(leaderboardQuerySchema.safeParse({ scope: 'global', metric: 'pool' }).success).toBe(
      false,
    );
    expect(leaderboardQuerySchema.parse({}).scope).toBe('friends');
    expect(leaderboardQuerySchema.safeParse({ game: 'Not A Slug!' }).success).toBe(false);
  });
  it('accepts only Expo push tokens', () => {
    expect(
      pushTokenSchema.safeParse({ token: 'ExponentPushToken[abcdefgh1234]', platform: 'ios' })
        .success,
    ).toBe(true);
    expect(pushTokenSchema.safeParse({ token: 'fcm:abc', platform: 'android' }).success).toBe(
      false,
    );
  });
  it('rejects unknown preference fields', () => {
    expect(notificationPrefsUpdateSchema.safeParse({ groups: { turns: false } }).success).toBe(
      true,
    );
    expect(notificationPrefsUpdateSchema.safeParse({ groups: { promos: true } }).success).toBe(
      false,
    );
    expect(
      notificationPrefsUpdateSchema.safeParse({ quietHours: { startMinute: 2000 } }).success,
    ).toBe(false);
  });
});
