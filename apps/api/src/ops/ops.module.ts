import { Global, Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type pg from 'pg';
import { PG_POOL } from '../db/db.module.ts';
import { LedgerModule } from '../ledger/ledger.module.ts';
import { LedgerRepo } from '../ledger/ledger.repo.ts';
import { WebhookAlerts, noopAlerts, type AlertSink } from './alerts.ts';
import { LedgerCheckRunner } from './ledger-check.ts';
import { loggerFromEnv, type JsonLogger } from './logger.ts';
import { withRequestId } from './request-context.ts';
import { captureMessage } from './sentry.ts';
import { ShutdownState } from './shutdown.ts';

export const ALERTS = Symbol('ALERTS');
export const OPS_LOGGER = Symbol('OPS_LOGGER');

/** A check older than this at boot means a night was missed (instance was down at 02:15): run it now. */
const CATCH_UP_AFTER_HOURS = 26;
const CATCH_UP_DELAY_MS = 60_000;

export class LedgerCheckJob implements OnApplicationBootstrap {
  constructor(
    private readonly runner: LedgerCheckRunner,
    private readonly pool: Pick<pg.Pool, 'query'>,
    private readonly enabled: boolean,
    private readonly catchUp: boolean,
  ) {}

  /** 02:15 Lagos time, when traffic is lowest. */
  @Cron('15 2 * * *', { name: 'ledger-check', timeZone: 'Africa/Lagos' })
  async nightly(): Promise<void> {
    if (!this.enabled) return;
    await withRequestId(`ledger-${Date.now()}`, () => this.runner.run());
  }

  onApplicationBootstrap(): void {
    if (!this.enabled || !this.catchUp) return;
    setTimeout(() => void this.catchUpIfStale(), CATCH_UP_DELAY_MS).unref();
  }

  async catchUpIfStale(): Promise<void> {
    try {
      const r = await this.pool.query<{ stale: boolean }>(
        `SELECT coalesce(max(ran_at) < now() - make_interval(hours => $1), true) AS stale FROM ledger_check_runs`,
        [CATCH_UP_AFTER_HOURS],
      );
      if (r.rows[0]?.stale) await this.nightly();
    } catch (err) {
      new Logger('LedgerCheck').warn(`catch-up skipped: ${String(err)}`);
    }
  }
}

/**
 * Operations: structured logging, alerts, the shutdown drain and the nightly ledger check. Global so the health
 * controller (in AppModule) can inject ShutdownState.
 */
@Global()
@Module({
  imports: [LedgerModule],
  providers: [
    {
      provide: OPS_LOGGER,
      useFactory: (): JsonLogger => loggerFromEnv(process.env, 'api'),
    },
    {
      provide: ALERTS,
      inject: [ConfigService, OPS_LOGGER],
      useFactory: (config: ConfigService, log: JsonLogger): AlertSink => {
        const url = config.get<string>('ALERT_WEBHOOK_URL');
        if (!url) return noopAlerts;
        return new WebhookAlerts(url, {
          service: 'dyce-api',
          environment:
            config.get<string>('SENTRY_ENVIRONMENT') ?? config.get<string>('NODE_ENV') ?? 'unknown',
          onError: (err) => log.entry('warn', { msg: 'alert webhook failed', error: String(err) }),
        });
      },
    },
    {
      provide: ShutdownState,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new ShutdownState(config.get<number>('SHUTDOWN_DRAIN_MS') ?? 0),
    },
    {
      provide: LedgerCheckJob,
      inject: [PG_POOL, LedgerRepo, ALERTS, OPS_LOGGER, ConfigService],
      useFactory: (
        pool: pg.Pool,
        ledger: LedgerRepo,
        alerts: AlertSink,
        log: JsonLogger,
        config: ConfigService,
      ) => {
        const runner = new LedgerCheckRunner({
          pool,
          ledger,
          alerts,
          log,
          freeze: config.get<boolean>('LEDGER_CHECK_FREEZE') ?? true,
          heartbeatUrl: config.get<string>('LEDGER_CHECK_HEARTBEAT_URL'),
          report: (message, extra) => captureMessage(message, 'fatal', extra),
        });
        return new LedgerCheckJob(
          runner,
          pool,
          config.get<boolean>('LEDGER_CHECK_ENABLED') ?? true,
          config.get<string>('NODE_ENV') !== 'test',
        );
      },
    },
  ],
  exports: [ShutdownState, ALERTS, OPS_LOGGER],
})
export class OpsModule {}
