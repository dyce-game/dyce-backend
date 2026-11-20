import { Module } from '@nestjs/common';
import type pg from 'pg';
import { AuthModule } from '../auth/auth.module.ts';
import { PG_POOL } from '../db/db.module.ts';
import { DiscoveryController } from './discovery.controller.ts';
import { LeaderboardService } from './leaderboard.service.ts';
import { SearchService } from './search.service.ts';
import { UserProfileService } from './user-profile.service.ts';

/** Search, other people's profiles, badges and leaderboards (ADR-023). Read-only. */
@Module({
  imports: [AuthModule],
  controllers: [DiscoveryController],
  providers: [
    {
      provide: SearchService,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool) => new SearchService(pool),
    },
    {
      provide: UserProfileService,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool) => new UserProfileService(pool),
    },
    {
      provide: LeaderboardService,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool) => new LeaderboardService(pool),
    },
  ],
})
export class DiscoveryModule {}
