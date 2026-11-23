import { Logger, Module } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type pg from 'pg';
import { AuthModule } from '../auth/auth.module.ts';
import { PG_POOL } from '../db/db.module.ts';
import { SpacesModule } from '../spaces/spaces.module.ts';
import { SpacesService } from '../spaces/spaces.service.ts';
import { AccountController, DisputesController } from './account.controller.ts';
import { AccountService } from './account.service.ts';
import { DisputesService } from './disputes.service.ts';

/** Erases the accounts whose grace period is over (SPEC section 12). Safe to run twice: each erase is idempotent. */
export class AccountMaintenance {
  constructor(private readonly account: AccountService) {}

  @Cron('30 3 * * *')
  async eraseDue(): Promise<void> {
    const r = await this.account.processDue();
    if (r.done + r.deferred > 0) {
      new Logger('Account').log(`erased ${r.done} accounts, ${r.deferred} deferred`);
    }
  }
}

@Module({
  imports: [AuthModule, SpacesModule],
  controllers: [AccountController, DisputesController],
  providers: [
    {
      provide: AccountService,
      inject: [PG_POOL, SpacesService],
      useFactory: (pool: pg.Pool, spaces: SpacesService) => new AccountService(pool, spaces),
    },
    {
      provide: DisputesService,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool) => new DisputesService(pool),
    },
    {
      provide: AccountMaintenance,
      inject: [AccountService],
      useFactory: (account: AccountService) => new AccountMaintenance(account),
    },
  ],
})
export class AccountModule {}
