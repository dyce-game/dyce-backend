import { EmailDeliveryError, ResendEmailProvider, type EmailMessage } from './email-provider.ts';
import { otpEmail } from './email-templates.ts';

const message: EmailMessage = {
  to: 'ada.obi@gmail.com',
  subject: '123456 is your Dyce code',
  text: 'Your Dyce code: 123456',
  html: '<p>123456</p>',
  idempotencyKey: 'otp-abc',
};
const config = { apiKey: 're_secret_key', from: 'Dyce <login@mail.dyce.games>' };

type Call = { url: string; init: RequestInit };

/** A fake fetch that replays the given responses in order and records every call. */
function fakeFetch(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init! });
    const next = responses.shift() ?? new Response('{}', { status: 200 });
    if (next instanceof Error) throw next;
    return next;
  };
  return { fn, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const noSleep = async () => undefined;

describe('ResendEmailProvider request', () => {
  it('posts one JSON email to /emails with a Bearer key and an idempotency key', async () => {
    const { fn, calls } = fakeFetch([json(200, { id: 'e1' })]);
    await new ResendEmailProvider(config, fn, noSleep).send(message);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer re_secret_key');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['idempotency-key']).toBe('otp-abc');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toMatchObject({
      from: 'Dyce <login@mail.dyce.games>',
      to: ['ada.obi@gmail.com'],
      subject: '123456 is your Dyce code',
      text: 'Your Dyce code: 123456',
      html: '<p>123456</p>',
    });
    expect(body.reply_to).toBeUndefined();
  });

  it('adds reply_to and honours a custom base URL', async () => {
    const { fn, calls } = fakeFetch([json(200, {})]);
    await new ResendEmailProvider(
      { ...config, replyTo: 'support@dyce.games', baseUrl: 'http://localhost:9999/' },
      fn,
      noSleep,
    ).send(message);
    expect(calls[0]!.url).toBe('http://localhost:9999/emails');
    expect(JSON.parse(calls[0]!.init.body as string).reply_to).toBe('support@dyce.games');
  });
});

describe('ResendEmailProvider failures', () => {
  it('does not retry a request the provider rejects (a bad address, a bad key, an unverified domain)', async () => {
    for (const status of [400, 401, 403, 422]) {
      const { fn, calls } = fakeFetch([
        json(status, {
          name: 'validation_error',
          message: 'The ada.obi@gmail.com address is invalid',
        }),
      ]);
      const err = await new ResendEmailProvider(config, fn, noSleep).send(message).catch((e) => e);
      expect(err).toBeInstanceOf(EmailDeliveryError);
      expect(err.status).toBe(status);
      expect(err.retryable).toBe(false);
      expect(calls).toHaveLength(1);
    }
  });

  it('retries a 429 and a 5xx, with the same idempotency key, then succeeds', async () => {
    const { fn, calls } = fakeFetch([
      json(429, { name: 'rate_limit_exceeded' }),
      json(503, {}),
      json(200, {}),
    ]);
    const slept: number[] = [];
    await new ResendEmailProvider(config, fn, async (ms) => void slept.push(ms)).send(message);
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect((c.init.headers as Record<string, string>)['idempotency-key']).toBe('otp-abc');
    }
    expect(slept).toEqual([300, 900]);
  });

  it('retries a network failure and gives up after the last attempt', async () => {
    const { fn, calls } = fakeFetch([
      new Error('ECONNRESET'),
      new Error('ECONNRESET'),
      new Error('ECONNRESET'),
    ]);
    const err = await new ResendEmailProvider(config, fn, noSleep).send(message).catch((e) => e);
    expect(err).toBeInstanceOf(EmailDeliveryError);
    expect(err.retryable).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('can be told not to retry', async () => {
    const { fn, calls } = fakeFetch([json(500, {})]);
    await expect(
      new ResendEmailProvider({ ...config, retries: 0 }, fn, noSleep).send(message),
    ).rejects.toBeInstanceOf(EmailDeliveryError);
    expect(calls).toHaveLength(1);
  });

  it('gives up on a hung request after the timeout instead of waiting for ever', async () => {
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const err = await new ResendEmailProvider(
      { ...config, timeoutMs: 20, retries: 0 },
      hang,
      noSleep,
    )
      .send(message)
      .catch((e) => e);
    expect(err).toBeInstanceOf(EmailDeliveryError);
    expect(err.retryable).toBe(true);
  });

  it('never puts the address, the code or the key in an error', async () => {
    const { fn } = fakeFetch([
      json(422, { name: 'validation_error', message: 'ada.obi@gmail.com 123456 re_secret_key' }),
    ]);
    const err = await new ResendEmailProvider(config, fn, noSleep).send(message).catch((e) => e);
    expect(String(err.message)).toBe('resend: HTTP 422 validation_error');
    expect(String(err.message)).not.toMatch(/ada|123456|re_secret/);
  });
});

describe('otpEmail', () => {
  it('puts the code in the subject, the text and the html, and says when it expires', () => {
    const m = otpEmail({ code: '482913', ttlMinutes: 5, purpose: 'signin' });
    expect(m.subject).toBe('482913 is your Dyce code');
    expect(m.text).toContain('482913');
    expect(m.text).toContain('expires in 5 minutes');
    expect(m.html).toContain('482913');
    expect(m.html).toContain('expires in 5 minutes');
  });

  it('has no links, so there is nothing to phish', () => {
    const m = otpEmail({ code: '482913', ttlMinutes: 5, purpose: 'signin' });
    expect(m.html).not.toMatch(/<a\s/i);
    expect(m.html).not.toMatch(/https?:\/\//i);
    expect(m.text).not.toMatch(/https?:\/\//i);
  });

  it('says what the code is for, and tells people never to share it', () => {
    expect(otpEmail({ code: '111111', ttlMinutes: 5, purpose: 'link' }).text).toContain(
      'add this email address',
    );
    expect(otpEmail({ code: '111111', ttlMinutes: 5, purpose: 'signin' }).text).toContain(
      'create your account',
    );
    expect(otpEmail({ code: '111111', ttlMinutes: 5, purpose: 'signin' }).text).toContain(
      'Never share',
    );
  });

  it('escapes what it prints and uses the singular for one minute', () => {
    const m = otpEmail({ code: '<b>1</b>', ttlMinutes: 1, purpose: 'signin' });
    expect(m.html).not.toContain('<b>1</b>');
    expect(m.html).toContain('&lt;b&gt;1&lt;/b&gt;');
    expect(m.text).toContain('expires in 1 minute.');
  });
});
