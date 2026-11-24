import { maskEmail } from '@dyce/shared';

/**
 * Email delivery (ADR-044). Providers receive the plain address only for the instant of sending; they must
 * never log it (use maskEmail) or put it in an error message, and they never see anything but a one-time code.
 */
export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Stable per message (we use the challenge id): a retry after a timeout cannot send a second email. */
  idempotencyKey: string;
};

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

export class EmailDeliveryError extends Error {
  readonly provider: string;
  /** HTTP status from the provider, when there was one. */
  readonly status?: number;
  /** True when trying again later could work (network, 429, 5xx); false when the request itself is wrong. */
  readonly retryable: boolean;
  constructor(
    provider: string,
    detail: string,
    opts: { status?: number; retryable?: boolean } = {},
  ) {
    super(`${provider}: ${detail}`);
    this.name = 'EmailDeliveryError';
    this.provider = provider;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Sleep = (ms: number) => Promise<void>;

/** Development only: prints the (masked) destination and the message, including the code. */
export class ConsoleEmailProvider implements EmailProvider {
  async send(message: EmailMessage): Promise<void> {
    console.log(`[email:dev] to ${maskEmail(message.to)}: ${message.subject}\n${message.text}`);
  }
}

/** Tests: records what would have been sent. */
export class MemoryEmailProvider implements EmailProvider {
  readonly sent: EmailMessage[] = [];
  failWith: string | null = null;

  async send(message: EmailMessage): Promise<void> {
    if (this.failWith) throw new EmailDeliveryError('memory', this.failWith);
    this.sent.push(message);
  }

  /** The 6-digit code in the most recent message. */
  lastCode(): string {
    const last = this.sent.at(-1);
    const m = last && /\b(\d{6})\b/.exec(last.text);
    if (!m) throw new Error('No email sent');
    return m[1]!;
  }
}

export type ResendConfig = {
  apiKey: string;
  /** The verified sending address, `Dyce <login@mail.dyce.games>` or a bare address. */
  from: string;
  replyTo?: string;
  /** Overridable for tests; defaults to https://api.resend.com. */
  baseUrl?: string;
  /** Per attempt. */
  timeoutMs?: number;
  /** Extra attempts after the first for network errors, 429 and 5xx (safe: the idempotency key). */
  retries?: number;
};

const RETRY_DELAYS_MS = [300, 900];

/**
 * Resend (https://resend.com/docs/api-reference/emails/send-email). One POST per email with the API key as a
 * Bearer token and an Idempotency-Key, so a retry never double-sends. Failure messages carry the HTTP status
 * and Resend's error `name` only: never the address, the code or the key.
 */
export class ResendEmailProvider implements EmailProvider {
  constructor(
    private readonly config: ResendConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly sleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const attempts = 1 + (this.config.retries ?? 2);
    let last: EmailDeliveryError | null = null;
    for (let i = 0; i < attempts; i++) {
      try {
        await this.once(message);
        return;
      } catch (err) {
        if (!(err instanceof EmailDeliveryError)) throw err;
        last = err;
        if (!err.retryable || i === attempts - 1) break;
        await this.sleep(RETRY_DELAYS_MS[Math.min(i, RETRY_DELAYS_MS.length - 1)]!);
      }
    }
    throw last!;
  }

  private async once(message: EmailMessage): Promise<void> {
    const base = (this.config.baseUrl ?? 'https://api.resend.com').replace(/\/$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 8000);
    let res: Response;
    try {
      res = await this.fetchImpl(`${base}/emails`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': message.idempotencyKey,
          'user-agent': 'dyce-api/1',
        },
        body: JSON.stringify({
          from: this.config.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
          ...(this.config.replyTo ? { reply_to: this.config.replyTo } : {}),
          tags: [{ name: 'category', value: 'otp' }],
        }),
      });
    } catch {
      throw new EmailDeliveryError('resend', 'network error or timeout', { retryable: true });
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) return;
    // Resend's error body is { name, message, statusCode }; the message can echo the address, so keep `name` only.
    const body = (await res.json().catch(() => ({}))) as { name?: string };
    const name = typeof body.name === 'string' ? body.name.slice(0, 60) : 'error';
    throw new EmailDeliveryError('resend', `HTTP ${res.status} ${name}`, {
      status: res.status,
      retryable: res.status === 429 || res.status >= 500,
    });
  }
}
