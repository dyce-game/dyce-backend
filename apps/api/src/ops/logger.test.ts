import { JsonLogger } from './logger.ts';
import { pickRequestId, requestContext, withRequestId } from './request-context.ts';

function capture(opts: ConstructorParameters<typeof JsonLogger>[0] = {}) {
  const lines: { line: string; level: string }[] = [];
  const logger = new JsonLogger({
    ...opts,
    write: (line, level) => lines.push({ line, level }),
    now: () => new Date('2026-11-23T10:00:00Z'),
  });
  return {
    logger,
    lines,
    parsed: () => lines.map((l) => JSON.parse(l.line) as Record<string, unknown>),
  };
}

describe('JsonLogger', () => {
  it('writes one redacted JSON object per line with service and release', () => {
    const { logger, parsed } = capture({ service: 'api', release: 'abc123' });
    logger.log('sms sent to +2348031234567', 'Auth');
    const [entry] = parsed();
    expect(entry).toMatchObject({
      ts: '2026-11-23T10:00:00.000Z',
      level: 'info',
      service: 'api',
      release: 'abc123',
      context: 'Auth',
    });
    expect(String(entry!.msg)).not.toContain('2348031234567');
  });

  it('puts the ambient request id on every line', () => {
    const { logger, parsed } = capture();
    withRequestId('req-12345678', () => logger.warn('slow'));
    expect(parsed()[0]!.requestId).toBe('req-12345678');
  });

  it('blanks sensitive fields in structured entries', () => {
    const { logger, parsed } = capture();
    logger.entry('info', {
      msg: 'login',
      refreshToken: 'abc',
      phone: '+2348031234567',
      status: 200,
    });
    expect(parsed()[0]).toMatchObject({
      refreshToken: '[redacted]',
      phone: '[redacted]',
      status: 200,
    });
  });

  it('honours the level and sends errors and warnings to the error stream', () => {
    const { logger, lines } = capture({ level: 'warn' });
    logger.log('info is dropped');
    logger.debug('debug is dropped');
    logger.warn('kept');
    logger.error('kept too', 'stack here', 'Ctx');
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error']);
    expect(JSON.parse(lines[1]!.line)).toMatchObject({ context: 'Ctx', stack: 'stack here' });
  });
});

describe('request ids', () => {
  it('accepts a sane incoming id and replaces a hostile one', () => {
    expect(pickRequestId('abc-12345678')).toBe('abc-12345678');
    expect(pickRequestId('x\nINJECTED {"level":"error"}')).toMatch(/^[0-9a-f-]{36}$/);
    expect(pickRequestId('short')).toMatch(/^[0-9a-f-]{36}$/);
    expect(pickRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes the id, and logs the route pattern, never the raw url', () => {
    const entries: Record<string, unknown>[] = [];
    const mw = requestContext({ entry: (_l, f) => entries.push(f) });
    const handlers: Record<string, () => void> = {};
    const headers: Record<string, string> = {};
    const req = {
      headers: { 'x-request-id': 'incoming-req-1' },
      method: 'GET',
      baseUrl: '',
      route: { path: '/invites/:token' },
      originalUrl: '/invites/SECRETTOKEN?phone=+2348031234567',
    };
    const res = {
      statusCode: 200,
      setHeader: (k: string, v: string) => (headers[k] = v),
      on: (ev: string, fn: () => void) => (handlers[ev] = fn),
    };
    mw(req as never, res as never, () => undefined);
    handlers.finish!();
    expect(headers['x-request-id']).toBe('incoming-req-1');
    expect(entries[0]).toMatchObject({ route: '/invites/:token', status: 200, method: 'GET' });
    expect(JSON.stringify(entries)).not.toContain('SECRETTOKEN');
    expect(JSON.stringify(entries)).not.toContain('2348031234567');
  });

  it('does not log healthy probes', () => {
    const entries: unknown[] = [];
    const mw = requestContext({ entry: (_l, f) => entries.push(f) });
    const handlers: Record<string, () => void> = {};
    mw(
      { headers: {}, method: 'GET', baseUrl: '', route: { path: '/health/ready' } } as never,
      {
        statusCode: 200,
        setHeader: () => undefined,
        on: (e: string, f: () => void) => (handlers[e] = f),
      } as never,
      () => undefined,
    );
    handlers.finish!();
    expect(entries).toEqual([]);
  });
});
