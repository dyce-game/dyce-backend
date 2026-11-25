import { initSentry, makeLogger, scrub, sentryEnabled } from './ops.ts';

describe('game server logger', () => {
  it('writes redacted JSON in production', () => {
    const lines: string[] = [];
    const log = makeLogger(
      { NODE_ENV: 'production', RELEASE: 'r1' },
      (l) => lines.push(l),
      () => new Date('2026-11-23T10:00:00Z'),
    );
    log.legacy(
      'match failed for +2348031234567',
      new Error('bad token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij'),
    );
    const rec = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(rec).toMatchObject({
      level: 'error',
      service: 'game-server',
      release: 'r1',
      ts: '2026-11-23T10:00:00.000Z',
    });
    expect(lines[0]).not.toContain('2348031234567');
    expect(lines[0]).not.toContain('eyJhbGci');
  });

  it('honours LOG_LEVEL', () => {
    const lines: string[] = [];
    const log = makeLogger({ NODE_ENV: 'production', LOG_LEVEL: 'error' }, (l) => lines.push(l));
    log.entry('info', { msg: 'quiet' });
    log.entry('error', { msg: 'loud' });
    expect(lines).toHaveLength(1);
  });
});

describe('game server sentry', () => {
  it('is off without a DSN', async () => {
    expect(await initSentry({})).toBe(false);
    expect(sentryEnabled()).toBe(false);
  });

  it('scrubs events', () => {
    const e = scrub({
      message: 'x +2348031234567',
      user: { id: 'u', ip_address: '1.1.1.1' },
      request: {
        method: 'POST',
        url: 'https://g.dyce.games/internal/rooms?sig=abc',
        headers: { authorization: 'Bearer abcdefghij' },
      },
    });
    expect(JSON.stringify(e)).not.toContain('2348031234567');
    expect(JSON.stringify(e)).not.toContain('abcdefghij');
    expect(JSON.stringify(e)).not.toContain('sig=abc');
    expect((e as Record<string, unknown>).user).toBeUndefined();
  });
});
