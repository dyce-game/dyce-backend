import {
  captureException,
  flushSentry,
  initSentry,
  scrubBreadcrumb,
  scrubEvent,
  sentryEnabled,
} from './sentry.ts';

describe('sentry (flag off)', () => {
  it('is a complete no-op without a DSN', async () => {
    expect(await initSentry({})).toBe(false);
    expect(sentryEnabled()).toBe(false);
    expect(() => captureException(new Error('x'))).not.toThrow();
    await expect(flushSentry()).resolves.toBeUndefined();
  });
});

describe('scrubEvent', () => {
  it('drops headers, cookies, bodies and query strings, and scrubs text', () => {
    const event = scrubEvent({
      message: 'otp failed for +2348031234567',
      request: {
        method: 'POST',
        url: 'https://api.dyce.games/auth/verify?phone=%2B2348031234567',
        headers: { authorization: 'Bearer abcdef123456', cookie: 'x=1' },
        data: { phone: '+2348031234567', code: '424242' },
        query_string: 'phone=%2B2348031234567',
      },
      user: { id: 'u-1', ip_address: '1.2.3.4', email: 'a@b.c', username: 'ada' },
      exception: { values: [{ value: 'boom for +2348031234567' }] },
      breadcrumbs: [
        { message: 'GET /x?token=abc12345', data: { url: '/x?token=abc12345', token: 'abc' } },
      ],
    });
    expect(event.request).toEqual({ method: 'POST', url: 'https://api.dyce.games/auth/verify' });
    expect(event.user).toEqual({ id: 'u-1' });
    const text = JSON.stringify(event);
    expect(text).not.toContain('2348031234567');
    expect(text).not.toContain('abcdef123456');
    expect(text).not.toContain('424242');
    expect(text).not.toContain('token=abc12345');
  });

  it('scrubs breadcrumbs', () => {
    const crumb = scrubBreadcrumb({
      message: 'refresh_token=abcdef123456',
      data: { url: '/a?b=1', password: 'x' },
    });
    expect(JSON.stringify(crumb)).not.toContain('abcdef123456');
    expect((crumb.data as Record<string, unknown>).url).toBe('/a');
    expect((crumb.data as Record<string, unknown>).password).toBe('[redacted]');
  });
});
