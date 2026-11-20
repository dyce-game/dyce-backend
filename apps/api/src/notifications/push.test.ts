import { ConsolePushDriver } from './console-push.driver.ts';
import { ExpoPushDriver } from './expo-push.driver.ts';
import { maskToken, type PushMessage } from './push-driver.ts';

const msg = (n: number): PushMessage => ({
  to: `ExponentPushToken[abcdefgh${String(n).padStart(4, '0')}]`,
  title: 'Your move',
  body: 'Amaka played in Pig. Free.',
  data: { route: '/g/1' },
  badge: 2,
});

type Call = { url: string; init: RequestInit };
function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    const call = { url, init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('maskToken', () => {
  it('keeps only a stub of the token', () => {
    expect(maskToken('ExponentPushToken[abcdefgh1234]')).toBe('ExponentPushToken[…1234]');
    expect(maskToken('weirdtoken')).toBe('…oken');
  });
});

describe('ConsolePushDriver', () => {
  it('logs a masked line, never the full token, and reports every message ok', async () => {
    const lines: string[] = [];
    const driver = new ConsolePushDriver((l) => lines.push(l));
    const res = await driver.send([msg(1), msg(2)]);
    expect(res).toEqual([{ ok: true }, { ok: true }]);
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).not.toContain('abcdefgh0001');
    expect(driver.sent).toHaveLength(2);
  });
});

describe('ExpoPushDriver', () => {
  it('posts the documented JSON array with the bearer token when there is one', async () => {
    const { fn, calls } = fakeFetch(() => json({ data: [{ status: 'ok', id: 't1' }] }));
    const res = await new ExpoPushDriver('secret', fn).send([msg(1)]);
    expect(res).toEqual([{ ok: true }]);
    expect(calls[0]!.url).toBe('https://exp.host/--/api/v2/push/send');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret');
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>[];
    expect(body[0]).toMatchObject({
      to: msg(1).to,
      title: 'Your move',
      sound: 'default',
      badge: 2,
      data: { route: '/g/1' },
    });
  });

  it('sends no Authorization header without an access token', async () => {
    const { fn, calls } = fakeFetch(() => json({ data: [{ status: 'ok' }] }));
    await new ExpoPushDriver(undefined, fn).send([msg(1)]);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('flags DeviceNotRegistered as a dead token and a per-message error otherwise', async () => {
    const { fn } = fakeFetch(() =>
      json({
        data: [
          { status: 'ok' },
          { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
          { status: 'error', message: 'slow down', details: { error: 'MessageRateExceeded' } },
        ],
      }),
    );
    const res = await new ExpoPushDriver(undefined, fn).send([msg(1), msg(2), msg(3)]);
    expect(res[0]).toEqual({ ok: true });
    expect(res[1]).toEqual({
      ok: false,
      error: 'DeviceNotRegistered',
      invalidToken: true,
      retry: false,
    });
    expect(res[2]).toMatchObject({ ok: false, invalidToken: false, retry: true });
  });

  it('splits more than 100 messages into several requests', async () => {
    const { fn, calls } = fakeFetch((c) => {
      const n = (JSON.parse(String(c.init.body)) as unknown[]).length;
      return json({ data: Array.from({ length: n }, () => ({ status: 'ok' })) });
    });
    const res = await new ExpoPushDriver(undefined, fn).send(
      Array.from({ length: 230 }, (_, i) => msg(i)),
    );
    expect(res).toHaveLength(230);
    expect(calls).toHaveLength(3);
  });

  it('treats a server error or a network failure as retryable and never throws', async () => {
    const down = fakeFetch(() => json({ errors: [] }, 503));
    expect(await new ExpoPushDriver(undefined, down.fn).send([msg(1)])).toEqual([
      { ok: false, error: 'http_503', invalidToken: false, retry: true },
    ]);
    const broken = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await new ExpoPushDriver(undefined, broken).send([msg(1)])).toEqual([
      { ok: false, error: 'network', invalidToken: false, retry: true },
    ]);
  });

  it('does not retry a rejected request (a 4xx is our bug, not a blip)', async () => {
    const bad = fakeFetch(() => json({ errors: [{ code: 'VALIDATION' }] }, 400));
    const [r] = await new ExpoPushDriver(undefined, bad.fn).send([msg(1)]);
    expect(r).toMatchObject({ ok: false, retry: false });
  });
});
