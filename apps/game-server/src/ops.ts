import type * as Sentry from '@sentry/node';
import { redactString, redactValue } from './redact.ts';

/**
 * Logging and error reporting for the game server. The API has the full version (apps/api/src/ops); this is the
 * same behaviour in a smaller shape: one redacted JSON line per event, Sentry only when SENTRY_DSN is set.
 */
type Level = 'error' | 'warn' | 'info' | 'debug';
const ORDER: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export type OpsLogger = {
  entry(level: Level, fields: Record<string, unknown>): void;
  /** The `log(msg, extra)` shape the game server and its rooms already use (errors and notable events). */
  legacy(msg: string, extra?: unknown): void;
};

export function makeLogger(
  env: Record<string, string | undefined>,
  write: (line: string, level: Level) => void = (line, level) =>
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`),
  now: () => Date = () => new Date(),
): OpsLogger {
  const threshold =
    ORDER[(['error', 'warn', 'info', 'debug'] as const).find((l) => l === env.LOG_LEVEL) ?? 'info'];
  const pretty =
    env.LOG_FORMAT === 'pretty' || (env.LOG_FORMAT !== 'json' && env.NODE_ENV !== 'production');
  const base = { service: 'game-server', ...(env.RELEASE ? { release: env.RELEASE } : {}) };

  const entry = (level: Level, fields: Record<string, unknown>): void => {
    if (ORDER[level] > threshold) return;
    const record = { ts: now().toISOString(), level, ...base, ...(redactValue(fields) as object) };
    write(
      pretty
        ? `${record.ts.slice(11, 23)} ${level.toUpperCase().padEnd(5)} ${String((record as { msg?: unknown }).msg ?? '')}${extraOf(record)}`
        : JSON.stringify(record),
      level,
    );
  };
  return {
    entry,
    legacy(msg, extra) {
      // These are errors and notable events, never chatter: warn, or error when an Error came with it.
      entry(extra instanceof Error ? 'error' : 'warn', {
        msg,
        ...(extra === undefined ? {} : { extra }),
      });
    },
  };
}

function extraOf(record: Record<string, unknown>): string {
  const { ts: _ts, level: _level, service: _s, release: _r, msg: _m, ...rest } = record;
  return Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
}

/* eslint-disable no-console -- this function exists to wrap the console */
let patched = false;
export function redactConsole(): void {
  if (patched) return;
  patched = true;
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) =>
      original(...args.map((a) => (typeof a === 'string' ? redactString(a) : redactValue(a))));
  }
}
/* eslint-enable no-console */

// --- Sentry (flag: SENTRY_DSN) ----------------------------------------------------------------------------

let sentry: typeof Sentry | null = null;

export async function initSentry(env: Record<string, string | undefined>): Promise<boolean> {
  if (!env.SENTRY_DSN) return false;
  const mod = await import('@sentry/node');
  mod.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV ?? 'production',
    ...(env.RELEASE ? { release: env.RELEASE } : {}),
    tracesSampleRate: Number(env.SENTRY_TRACES_SAMPLE_RATE ?? 0) || 0,
    serverName: 'dyce-game-server',
    // Sentry SDK v11: collect no user info, cookies, headers, bodies or query strings.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    beforeSend: (event) => scrub(event as unknown as Record<string, unknown>) as never,
    beforeBreadcrumb: (crumb) => scrub(crumb as unknown as Record<string, unknown>) as never,
  });
  sentry = mod;
  return true;
}

export function sentryEnabled(): boolean {
  return sentry !== null;
}

export function captureException(err: unknown): void {
  sentry?.captureException(err);
}

export async function flushSentry(timeoutMs = 2000): Promise<void> {
  await sentry?.flush(timeoutMs).catch(() => undefined);
}

/** Exported for tests: no request data, no user data, redacted text, query strings cut from URLs. */
export function scrub<T extends Record<string, unknown>>(event: T): T {
  const out: Record<string, unknown> = redactValue(event) as Record<string, unknown>;
  delete out.user;
  if (out.request && typeof out.request === 'object') {
    const r = out.request as Record<string, unknown>;
    out.request = {
      ...(r.method ? { method: r.method } : {}),
      ...(typeof r.url === 'string' ? { url: r.url.split('?')[0] } : {}),
    };
  }
  return out as T;
}
