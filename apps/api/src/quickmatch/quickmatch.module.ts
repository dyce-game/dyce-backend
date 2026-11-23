import { Inject, Injectable, Logger, Module } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type pg from 'pg';
import { AuthModule } from '../auth/auth.module.ts';
import { ChatModule } from '../chat/chat.module.ts';
import { RealtimeHub } from '../chat/hub.ts';
import { PG_POOL } from '../db/db.module.ts';
import { IntegrityModule } from '../integrity/integrity.module.ts';
import { SpacesModule } from '../spaces/spaces.module.ts';
import { SpacesService } from '../spaces/spaces.service.ts';
import { QuickMatchController } from './quickmatch.controller.ts';
import { QuickMatchService } from './quickmatch.service.ts';

/** Pairs people who are waiting, gives up on old searches and settles matches nobody accepted. */
@Injectable()
export class QuickMatchJob {
  private readonly log = new Logger('QuickMatch');
  private running = false;

  constructor(@Inject(QuickMatchService) private readonly quick: QuickMatchService) {}

  @Interval(2000)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const r = await this.quick.sweep();
      if (r.paired + r.missed + r.expired + r.restarted > 0) this.log.debug(JSON.stringify(r));
    } catch (err) {
      this.log.warn(`sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

@Module({
  imports: [AuthModule, ChatModule, SpacesModule, IntegrityModule],
  controllers: [QuickMatchController],
  providers: [
    {
      provide: QuickMatchService,
      inject: [PG_POOL, RealtimeHub, SpacesService],
      useFactory: (pool: pg.Pool, hub: RealtimeHub, spaces: SpacesService) =>
        new QuickMatchService(pool, hub, spaces),
    },
    QuickMatchJob,
  ],
})
export class QuickMatchModule {}
