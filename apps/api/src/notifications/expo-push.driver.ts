import type { PushDriver, PushMessage, PushResult } from './push-driver.ts';

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/** The Expo API accepts at most 100 messages per request. */
const CHUNK = 100;

type Fetch = typeof fetch;

type Ticket = { status: 'ok' | 'error'; message?: string; details?: { error?: string } };

/**
 * Expo Push API driver. NOT exercised against the live service in development (ADR-023): the request and response
 * shapes are unit-tested against recorded examples only.
 *
 * Tickets say whether Expo *accepted* a message. Delivery receipts (a second call, ~15 minutes later) are not read
 * yet (BACKLOG), so a token that Expo accepts but later reports as unregistered is removed the next time it is used
 * and the ticket comes back `DeviceNotRegistered`.
 */
export class ExpoPushDriver implements PushDriver {
  constructor(
    private readonly accessToken: string | undefined,
    private readonly fetchImpl: Fetch = fetch,
    private readonly url: string = EXPO_PUSH_URL,
  ) {}

  async send(messages: PushMessage[]): Promise<PushResult[]> {
    const results: PushResult[] = [];
    for (let i = 0; i < messages.length; i += CHUNK) {
      results.push(...(await this.sendChunk(messages.slice(i, i + CHUNK))));
    }
    return results;
  }

  private async sendChunk(chunk: PushMessage[]): Promise<PushResult[]> {
    const failAll = (error: string, retry: boolean): PushResult[] =>
      chunk.map(() => ({ ok: false, error, invalidToken: false, retry }));
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
        },
        body: JSON.stringify(
          chunk.map((m) => ({
            to: m.to,
            title: m.title,
            body: m.body,
            data: m.data,
            sound: 'default',
            channelId: 'default',
            priority: 'high',
            ...(m.badge !== undefined ? { badge: m.badge } : {}),
          })),
        ),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return failAll('network', true);
    }
    if (!res.ok) return failAll(`http_${res.status}`, res.status === 429 || res.status >= 500);

    let tickets: Ticket[];
    try {
      const json = (await res.json()) as { data?: Ticket[] };
      tickets = Array.isArray(json.data) ? json.data : [];
    } catch {
      return failAll('bad_response', true);
    }
    return chunk.map((_, i): PushResult => {
      const t = tickets[i];
      if (!t) return { ok: false, error: 'no_ticket', invalidToken: false, retry: true };
      if (t.status === 'ok') return { ok: true };
      const code = t.details?.error ?? 'error';
      return {
        ok: false,
        error: code,
        invalidToken: code === 'DeviceNotRegistered',
        retry: code === 'MessageRateExceeded',
      };
    });
  }
}
