import { Logger, Module } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type pg from 'pg';
import { AuthModule } from '../auth/auth.module.ts';
import { PG_POOL } from '../db/db.module.ts';
import { StreakController } from './streak.controller.ts';
import { StreakService } from './streak.service.ts';

/** Notices streaks that ended (and tells their owners) once an hour. Also done whenever someone opens their streak. */
export class StreakMaintenance {
  constructor(private readonly streaks: StreakService) {}

  @Cron('7 * * * *')
  async sweep(): Promise<void> {
    const n = await this.streaks.sweep();
    if (n > 0) new Logger('Streaks').log(`noticed ${n} ended streaks`);
  }
}

/** Streaks and the streak saver (ADR-042). */
@Module({
  imports: [AuthModule],
  controllers: [StreakController],
  providers: [
    {
      provide: StreakService,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool) => new StreakService(pool),
    },
    {
      provide: StreakMaintenance,
      inject: [StreakService],
      useFactory: (streaks: StreakService) => new StreakMaintenance(streaks),
    },
  ],
})
export class ProgressModule {}
