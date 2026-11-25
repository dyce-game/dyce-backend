import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

type Store = { requestId: string };
const storage = new AsyncLocalStorage<Store>();

export const REQUEST_ID_HEADER = 'x-request-id';

/** The id of the request being handled, from anywhere below the middleware (logger, filters, services). */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** Runs `fn` as if inside a request with this id: for background jobs, so their logs are correlated too. */
export function withRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

/** Accept a caller's id only if it is short and boring; otherwise mint our own (log injection guard). */
export function pickRequestId(incoming: unknown): string {
  const v = Array.isArray(incoming) ? incoming[0] : incoming;
  return typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : randomUUID();
}

export type AccessLogger = { entry(level: 'info', fields: Record<string, unknown>): void };

/**
 * Gives every request an id (echoed in `X-Request-Id`), and writes one structured access line when it ends.
 * The line carries the ROUTE PATTERN (`/invites/:token`), never the raw URL or query string, so tokens,
 * codes and phone numbers in paths cannot reach the log.
 */
export function requestContext(logger: AccessLogger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = pickRequestId(req.headers[REQUEST_ID_HEADER]);
    res.setHeader(REQUEST_ID_HEADER, requestId);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
      const route = req.route?.path ? `${req.baseUrl ?? ''}${String(req.route.path)}` : 'unmatched';
      // Probes every few seconds would drown the log; only their failures are interesting.
      if (route.startsWith('/health') && res.statusCode < 400) return;
      const auth = (req as Request & { auth?: { userId?: string } }).auth;
      logger.entry('info', {
        msg: 'http',
        requestId,
        method: req.method,
        route,
        status: res.statusCode,
        ms,
        ...(auth?.userId ? { userId: auth.userId } : {}),
      });
    });
    storage.run({ requestId }, next);
  };
}
