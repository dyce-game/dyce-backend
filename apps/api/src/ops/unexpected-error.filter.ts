import { Catch, HttpException, type ArgumentsHost } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { captureException } from './sentry.ts';
import type { JsonLogger } from './logger.ts';

/**
 * Catch-all. Expected failures (DyceError, AuthError, rate limits, 4xx HttpExceptions) are handled by their own
 * filters or are the caller's fault, so they are neither logged as errors nor reported. Anything that ends as a
 * 5xx is a bug: it is logged with the request id, reported to Sentry if configured, and then answered exactly as
 * Nest would. Register this FIRST in `useGlobalFilters` so the specific filters keep priority.
 */
@Catch()
export class UnexpectedErrorFilter extends BaseExceptionFilter {
  constructor(
    httpAdapter: ConstructorParameters<typeof BaseExceptionFilter>[0],
    private readonly logger: JsonLogger,
  ) {
    super(httpAdapter);
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    // 503 is how the probes say "not ready" (draining, database down) on purpose; the access line records it and the
    // uptime monitor alerts on it. It is not a bug, so it is neither logged as an error nor reported.
    const expectedUnavailable = exception instanceof HttpException && status === 503;
    if (status >= 500 && !expectedUnavailable) {
      this.logger.entry('error', {
        msg: 'unhandled error',
        status,
        error: exception instanceof Error ? exception : String(exception),
      });
      captureException(exception);
    }
    super.catch(exception, host);
  }
}
