import { redactString } from './redact.ts';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export type Alert = {
  severity: AlertSeverity;
  /** Short and stable: what fired (e.g. "ledger invariant failed"). */
  title: string;
  /** Detail for the human who gets paged. Redacted before it leaves the process. */
  body?: string;
};

export type AlertSink = { send(alert: Alert): Promise<void> };

export const noopAlerts: AlertSink = { send: () => Promise.resolve() };

/**
 * Posts alerts to a chat webhook (Slack incoming webhook format; `content` is the Discord equivalent).
 * Failing to alert must never break the job that raised it: errors are reported to `onError` and swallowed.
 */
export class WebhookAlerts implements AlertSink {
  constructor(
    private readonly url: string,
    private readonly opts: {
      service: string;
      environment: string;
      onError?: (err: unknown) => void;
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
    },
  ) {}

  async send(alert: Alert): Promise<void> {
    const tag = alert.severity.toUpperCase();
    const text = redactString(
      `[${tag}] ${this.opts.service}/${this.opts.environment}: ${alert.title}${alert.body ? `\n${alert.body}` : ''}`,
    ).slice(0, 3500);
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, content: text }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
      });
      if (!res.ok) this.opts.onError?.(new Error(`alert webhook answered ${res.status}`));
    } catch (err) {
      this.opts.onError?.(err);
    }
  }
}

/** Dead-man's switch: a monitor (healthchecks.io style) that alerts when the ping STOPS arriving. */
export async function pingHeartbeat(
  url: string | undefined,
  onError: (err: unknown) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!url) return;
  try {
    await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
  } catch (err) {
    onError(err);
  }
}
