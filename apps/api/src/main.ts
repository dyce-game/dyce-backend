import 'reflect-metadata';
import { NestFactory, HttpAdapterHost } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.ts';
import { DyceErrorFilter } from './common/dyce-error.filter.ts';
import { loggerFromEnv, redactConsole } from './ops/logger.ts';
import { requestContext } from './ops/request-context.ts';
import { captureException, flushSentry, initSentry } from './ops/sentry.ts';
import { UnexpectedErrorFilter } from './ops/unexpected-error.filter.ts';

// Logging and error reporting come up BEFORE configuration is validated, so a bad config is itself logged
// (as structured, redacted JSON) and reported. They read the raw environment; the validated schema in
// config/env.ts is the contract for the rest.
const logger = loggerFromEnv(process.env, 'api');
redactConsole();

async function bootstrap(): Promise<void> {
  const sentryOn = await initSentry({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    release: process.env.RELEASE,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0) || 0,
  });
  logger.entry('info', { msg: 'starting', sentry: sentryOn ? 'on' : 'off' });

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger });
  const config = app.get(ConfigService);

  // Behind a load balancer the client IP comes from X-Forwarded-For; trust only the hops we run.
  const hops = config.getOrThrow<number>('TRUST_PROXY_HOPS');
  if (hops > 0) app.set('trust proxy', hops);

  // Native apps don't need CORS; browsers (web guest game, local web dev) only get the origins we list.
  const origins = (config.get<string>('CORS_ORIGINS') ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (origins.length > 0)
    app.enableCors({
      origin: origins,
      methods: ['GET', 'POST', 'DELETE', 'PATCH', 'PUT'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 600,
    });

  app.use(requestContext(logger));
  // The catch-all goes FIRST so the specific filter keeps priority for the errors it knows.
  const { httpAdapter } = app.get(HttpAdapterHost);
  app.useGlobalFilters(new UnexpectedErrorFilter(httpAdapter, logger), new DyceErrorFilter());

  // Graceful shutdown: SIGTERM -> drain (/health/ready says 503) -> close HTTP, WebSockets, pool -> exit 0.
  // Handled here, not with `enableShutdownHooks()`: Nest re-raises the signal after cleanup, which makes a clean
  // stop exit with code 143 and look like a crash to the platform. If it takes too long we exit 1 anyway,
  // so a deploy can never hang.
  const hardStopMs = config.getOrThrow<number>('SHUTDOWN_TIMEOUT_MS');
  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.entry('info', { msg: 'shutting down', signal });
    setTimeout(() => {
      logger.entry('error', { msg: 'graceful shutdown timed out; exiting' });
      process.exit(1);
    }, hardStopMs).unref();
    try {
      await app.close();
      await flushSentry();
      process.exit(0);
    } catch (err) {
      logger.entry('error', { msg: 'shutdown failed', error: err });
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));

  const port = config.getOrThrow<number>('PORT');
  await app.listen(port);
  logger.entry('info', { msg: `dyce-api listening on :${port}`, port });
}

process.on('unhandledRejection', (reason) => {
  logger.entry('error', { msg: 'unhandled rejection', error: reason });
  captureException(reason);
});
process.on('uncaughtException', (err) => {
  logger.entry('error', { msg: 'uncaught exception', error: err });
  captureException(err);
  void flushSentry().finally(() => process.exit(1));
});

bootstrap().catch(async (err: unknown) => {
  logger.entry('error', { msg: 'failed to start', error: err });
  captureException(err);
  await flushSentry();
  process.exit(1);
});
