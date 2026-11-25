import {
  Controller,
  HttpCode,
  Inject,
  Logger,
  Module,
  Post,
  UseGuards,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Throttle } from '@nestjs/throttler';
import pg from 'pg';
import { AuthModule } from '../auth/auth.module.ts';
import { AuthGuard, CurrentUser, type AuthContext } from '../auth/auth.guard.ts';
import { PG_POOL } from '../db/db.module.ts';
import { AdminController } from './admin.controller.ts';
import { parseAdminTokens } from './admin-tokens.ts';
import { ADMIN_TOKENS, AdminGuard } from './admin.guard.ts';
import { createAttestationVerifier } from './attestation.ts';
import { IntegrityGate } from './integrity.gate.ts';
import { ModerationService } from './moderation.service.ts';
import { PoolEntryGuard } from './pool-entry.guard.ts';

const ADMIN_POOL = Symbol('ADMIN_POOL');

/** The nonce an app binds its Play Integrity / App Attest request to. Authenticated, and cheap to refuse in bulk. */
@Controller('integrity')
@UseGuards(AuthGuard)
export class IntegrityController {
  constructor(@Inject(IntegrityGate) private readonly gate: IntegrityGate) {}

  @Post('challenge')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  challenge(@CurrentUser() user: AuthContext) {
    return this.gate.challenge(user.userId);
  }
}

/** Jobs: payouts nobody decided are released when their hold lapses; old fingerprints are deleted. */
export class IntegrityMaintenance {
  private readonly log = new Logger('Integrity');
  constructor(private readonly pool: pg.Pool) {}

  @Cron('*/10 * * * *')
  async lapseHolds(): Promise<void> {
    try {
      const r = await this.pool.query<{ n: number }>('SELECT integrity_lapse_holds() AS n');
      if ((r.rows[0]?.n ?? 0) > 0)
        this.log.warn(`${r.rows[0]!.n} payout hold(s) lapsed and were released`);
    } catch (err) {
      this.log.error(`could not lapse holds: ${String(err)}`);
    }
  }

  @Cron('15 4 * * *')
  async pruneFingerprints(): Promise<void> {
    try {
      const r = await this.pool.query<{ n: number }>('SELECT integrity_prune_fingerprints() AS n');
      if ((r.rows[0]?.n ?? 0) > 0) this.log.log(`deleted ${r.rows[0]!.n} old fingerprints`);
    } catch (err) {
      this.log.error(`could not prune fingerprints: ${String(err)}`);
    }
  }
}

/**
 * Pool anti-cheat and the moderation tools (ADR-039). The admin API needs `ADMIN_DATABASE_URL` (a login role that
 * is a member of `dyce_admin`) and `ADMIN_TOKENS`; without both its routes answer 404.
 */
@Module({
  imports: [AuthModule],
  controllers: [IntegrityController, AdminController],
  providers: [
    {
      provide: IntegrityGate,
      inject: [PG_POOL, ConfigService],
      useFactory: (pool: pg.Pool, config: ConfigService) =>
        new IntegrityGate(
          pool,
          createAttestationVerifier(config.get<'dev' | 'store'>('INTEGRITY_DRIVER') ?? 'dev'),
          config.getOrThrow<string>('PHONE_HASH_SALT'),
          () => new Date(),
          new Logger('IntegrityGate'),
        ),
    },
    PoolEntryGuard,
    {
      provide: ADMIN_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService): pg.Pool | null => {
        const url = config.get<string>('ADMIN_DATABASE_URL');
        return url ? new pg.Pool({ connectionString: url, max: 3 }) : null;
      },
    },
    {
      provide: ADMIN_TOKENS,
      inject: [ConfigService, ADMIN_POOL],
      // No admin database, no admin API: tokens alone are not enough.
      useFactory: (config: ConfigService, adminPool: pg.Pool | null) =>
        adminPool ? parseAdminTokens(config.get<string>('ADMIN_TOKENS')) : null,
    },
    {
      provide: ModerationService,
      inject: [ADMIN_POOL, PG_POOL],
      // With no admin pool the service is never reached (the guard answers 404); the public pool stands in so
      // the provider resolves, and it cannot read the views anyway.
      useFactory: (adminPool: pg.Pool | null, pool: pg.Pool) =>
        new ModerationService(adminPool ?? pool),
    },
    AdminGuard,
    {
      provide: IntegrityMaintenance,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool) => new IntegrityMaintenance(pool),
    },
  ],
  exports: [IntegrityGate, PoolEntryGuard],
})
export class IntegrityModule implements OnApplicationShutdown {
  constructor(@Inject(ADMIN_POOL) private readonly adminPool: pg.Pool | null) {}

  async onApplicationShutdown(): Promise<void> {
    await this.adminPool?.end();
  }
}
