import type { LoggerService } from '@nestjs/common';
import { redactString, redactValue } from './redact.ts';
import { currentRequestId } from './request-context.ts';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export type LoggerOptions = {
  level?: LogLevel;
  /** "json" (one object per line, for log shipping) or "pretty" (local development). */
  format?: 'json' | 'pretty';
  service?: string;
  release?: string;
  write?: (line: string, level: LogLevel) => void;
  now?: () => Date;
};

/** Nest's own startup chatter: kept at debug level. */
const QUIET_CONTEXTS = new Set([
  'RoutesResolver',
  'RouterExplorer',
  'InstanceLoader',
  'NestFactory',
]);

const defaultWrite = (line: string, level: LogLevel): void => {
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
};

/**
 * Structured logger for NestJS (`app.useLogger`) and our own code. Every line is redacted (phone numbers,
 * tokens, secrets) and carries the current request id when there is one.
 */
export class JsonLogger implements LoggerService {
  private readonly level: LogLevel;
  private readonly format: 'json' | 'pretty';
  private readonly write: (line: string, level: LogLevel) => void;
  private readonly now: () => Date;

  constructor(private readonly opts: LoggerOptions = {}) {
    this.level = opts.level ?? 'info';
    this.format = opts.format ?? 'json';
    this.write = opts.write ?? defaultWrite;
    this.now = opts.now ?? (() => new Date());
  }

  /** Structured entry from our own code: `logger.entry('info', { msg: 'http', status: 200 })`. */
  entry(level: LogLevel, fields: Record<string, unknown>): void {
    if (ORDER[level] > ORDER[this.level]) return;
    const requestId = currentRequestId();
    const record: Record<string, unknown> = {
      ts: this.now().toISOString(),
      level,
      ...(this.opts.service ? { service: this.opts.service } : {}),
      ...(this.opts.release ? { release: this.opts.release } : {}),
      ...(requestId ? { requestId } : {}),
      ...(redactValue(fields) as Record<string, unknown>),
    };
    this.write(this.format === 'pretty' ? pretty(record) : JSON.stringify(record), level);
  }

  // --- Nest LoggerService -------------------------------------------------------------------------

  log(message: unknown, ...rest: unknown[]): void {
    this.fromNest('info', message, rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.fromNest('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.fromNest('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.fromNest('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    this.fromNest('debug', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]): void {
    this.fromNest('error', message, rest);
  }

  /** Nest passes (message, context) or, for errors, (message, stack, context). */
  private fromNest(level: LogLevel, message: unknown, rest: unknown[]): void {
    const strings = rest.filter((r): r is string => typeof r === 'string');
    const context = strings.length > 0 ? strings[strings.length - 1] : undefined;
    // Nest prints one line per route and per module at startup: hundreds of lines nobody reads in production.
    if (level === 'info' && context && QUIET_CONTEXTS.has(context)) level = 'debug';
    const stack = level === 'error' && strings.length > 1 ? strings[0] : undefined;
    const fields: Record<string, unknown> =
      message !== null && typeof message === 'object' && !(message instanceof Error)
        ? { ...(message as Record<string, unknown>) }
        : { msg: message instanceof Error ? message.message : String(message) };
    if (message instanceof Error && message.stack) fields.stack = message.stack;
    if (context) fields.context = context;
    if (stack) fields.stack = stack;
    this.entry(level, fields);
  }
}

function pretty(r: Record<string, unknown>): string {
  const { ts, level, msg, context, requestId, service: _service, release: _release, ...rest } = r;
  const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
  const ctx = context ? ` [${String(context)}]` : '';
  const rid = requestId ? ` (${String(requestId).slice(0, 8)})` : '';
  return `${String(ts).slice(11, 23)} ${String(level).toUpperCase().padEnd(5)}${ctx}${rid} ${String(msg ?? '')}${extra}`;
}

/**
 * Routes `console.log/warn/error` through the redactor, so the few stray console calls (and any library
 * that prints) cannot leak a number or token. Idempotent.
 */
let consolePatched = false;
/* eslint-disable no-console -- this function exists to wrap the console */
export function redactConsole(): void {
  if (consolePatched) return;
  consolePatched = true;
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) =>
      original(...args.map((a) => (typeof a === 'string' ? redactString(a) : redactValue(a))));
  }
}
/* eslint-enable no-console */

export function loggerFromEnv(
  env: Record<string, string | undefined>,
  service: string,
): JsonLogger {
  const level = (['error', 'warn', 'info', 'debug'] as const).find((l) => l === env.LOG_LEVEL);
  const format =
    env.LOG_FORMAT === 'pretty' || env.LOG_FORMAT === 'json'
      ? env.LOG_FORMAT
      : env.NODE_ENV === 'production'
        ? 'json'
        : 'pretty';
  return new JsonLogger({
    level: level ?? 'info',
    format,
    service,
    ...(env.RELEASE ? { release: env.RELEASE } : {}),
  });
}
