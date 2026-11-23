import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type pg from 'pg';
import { PG_POOL } from '../db/db.module.ts';
import { ShutdownState } from '../ops/shutdown.ts';

/**
 * Probes for the platform (docs/RUNBOOK.md):
 *  - `/health`        back-compat: database reachable.
 *  - `/health/live`   the process is up and the event loop answers. Never touches the database: restarting the
 *                     API cannot fix a database outage, so liveness must not depend on it.
 *  - `/health/ready`  safe to receive traffic: database reachable and not draining for shutdown. Reports the
 *                     release and the newest applied migration so a deploy (or rollback) can be confirmed.
 * Probes are exempt from the per-IP rate limit.
 */
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(ShutdownState) private readonly shutdown: ShutdownState,
  ) {}

  @Get()
  async check(): Promise<{ status: 'ok'; db: 'up' }> {
    try {
      await this.pool.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({ status: 'degraded', db: 'down' });
    }
    return { status: 'ok', db: 'up' };
  }

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{
    status: 'ok';
    db: 'up';
    release: string | null;
    schema: string | null;
  }> {
    if (this.shutdown.draining) {
      throw new ServiceUnavailableException({ status: 'draining' });
    }
    try {
      await this.pool.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({ status: 'degraded', db: 'down' });
    }
    let schema: string | null = null;
    try {
      const r = await this.pool.query<{ v: string | null }>(
        'SELECT max(version) AS v FROM schema_migrations',
      );
      schema = r.rows[0]?.v ?? null;
    } catch {
      // The table is readable by the API role in every real deployment; if not, readiness still holds.
    }
    return { status: 'ok', db: 'up', release: process.env.RELEASE ?? null, schema };
  }
}
