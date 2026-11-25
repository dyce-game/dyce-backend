import type * as Sentry from '@sentry/node';
import { redactString, redactValue } from './redact.ts';
import { currentRequestId } from './request-context.ts';

/**
 * Error reporting behind an env flag: with no `SENTRY_DSN` nothing is loaded and every call here is a no-op.
 * With a DSN, events are scrubbed (see `scrubEvent`) before they leave the process. We never send default PII,
 * request bodies, headers, cookies or query strings.
 */
export type SentryConfig = {
  dsn?: string | undefined;
  environment?: string | undefined;
  release?: string | undefined;
  tracesSampleRate?: number | undefined;
  serverName?: string | undefined;
};

let sentry: typeof Sentry | null = null;

export function sentryEnabled(): boolean {
  return sentry !== null;
}

export async function initSentry(cfg: SentryConfig): Promise<boolean> {
  if (!cfg.dsn) return false;
  const mod = await import('@sentry/node');
  mod.init({
    dsn: cfg.dsn,
    environment: cfg.environment ?? 'production',
    ...(cfg.release ? { release: cfg.release } : {}),
    tracesSampleRate: cfg.tracesSampleRate ?? 0,
    // Sentry SDK v11: collect no user info, cookies, headers, bodies or query strings. Nothing is opted into.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    // Never attach the machine name: containers have random ids and it adds nothing.
    serverName: cfg.serverName ?? 'dyce',
    beforeSend: (event) => scrubEvent(event as unknown as LooseEvent) as never,
    beforeBreadcrumb: (crumb) =>
      scrubBreadcrumb(crumb as unknown as Record<string, unknown>) as never,
  });
  sentry = mod;
  return true;
}

export function captureException(err: unknown, extra?: Record<string, unknown>): void {
  if (!sentry) return;
  const requestId = currentRequestId();
  sentry.withScope((scope) => {
    if (requestId) scope.setTag('request_id', requestId);
    if (extra) scope.setContext('extra', redactValue(extra) as Record<string, unknown>);
    sentry!.captureException(err);
  });
}

/** An operational alert as a Sentry event (e.g. a ledger invariant failure). */
export function captureMessage(
  message: string,
  level: 'info' | 'warning' | 'error' | 'fatal',
  extra?: Record<string, unknown>,
): void {
  if (!sentry) return;
  sentry.withScope((scope) => {
    scope.setLevel(level);
    if (extra) scope.setContext('extra', redactValue(extra) as Record<string, unknown>);
    sentry!.captureMessage(redactString(message));
  });
}

/** Sends what is queued; call before the process exits. */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!sentry) return;
  await sentry.flush(timeoutMs).catch(() => undefined);
}

type LooseEvent = {
  message?: string;
  request?: Record<string, unknown>;
  user?: Record<string, unknown>;
  exception?: { values?: { value?: string }[] };
  breadcrumbs?: unknown[];
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  [k: string]: unknown;
};

/** Exported for tests. Drops request data, scrubs text, keeps the stack. */
export function scrubEvent<T extends LooseEvent>(event: T): T {
  if (event.request) {
    // Method and (query-less) URL are enough to find the route; headers, cookies and bodies are not sent.
    const url = typeof event.request.url === 'string' ? event.request.url.split('?')[0] : undefined;
    event.request = {
      ...(event.request.method ? { method: event.request.method } : {}),
      ...(url ? { url: redactString(url) } : {}),
    };
  }
  if (event.user) event.user = event.user.id ? { id: event.user.id } : {};
  if (typeof event.message === 'string') event.message = redactString(event.message);
  for (const v of event.exception?.values ?? []) {
    if (typeof v.value === 'string') v.value = redactString(v.value);
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((b) => scrubBreadcrumb(b as Record<string, unknown>));
  }
  if (event.extra) event.extra = redactValue(event.extra) as Record<string, unknown>;
  if (event.contexts) event.contexts = redactValue(event.contexts) as Record<string, unknown>;
  return event;
}

export function scrubBreadcrumb<T extends Record<string, unknown>>(crumb: T): T {
  const out: Record<string, unknown> = { ...crumb };
  if (typeof out.message === 'string') out.message = redactString(out.message);
  if (out.data) {
    const data = redactValue(out.data) as Record<string, unknown>;
    // HTTP breadcrumbs carry full URLs: keep the path only.
    if (typeof data.url === 'string') data.url = data.url.split('?')[0];
    delete data.query;
    out.data = data;
  }
  return out as T;
}
