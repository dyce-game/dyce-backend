import { Logger, Module } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import type pg from 'pg';
import { AuthModule } from '../auth/auth.module.ts';
import { ChatModule } from '../chat/chat.module.ts';
import { RealtimeHub } from '../chat/hub.ts';
import { MessagesService } from '../chat/messages.service.ts';
import { PG_POOL } from '../db/db.module.ts';
import { GamesController, MatchesController } from './matches.controller.ts';
import { MatchesService } from './matches.service.ts';

/** Gives stakes back for invites nobody answered (also done lazily whenever a match is opened). */
export class MatchMaintenance {
  constructor(private readonly matches: MatchesService) {}

  @Cron('*/5 * * * *')
  async expireInvites(): Promise<void> {
    const n = await this.matches.expireStaleInvites();
    if (n > 0) new Logger('Matches').log(`expired ${n} stale invites`);
  }
}

@Module({
  imports: [AuthModule, ChatModule],
  controllers: [GamesController, MatchesController],
  providers: [
    {
      provide: MatchesService,
      inject: [PG_POOL, RealtimeHub, MessagesService, ConfigService],
      useFactory: (pool: pg.Pool, hub: RealtimeHub, chat: MessagesService, config: ConfigService) =>
        new MatchesService(pool, hub, chat, () => new Date(), {
          // The reference game (Pig) is for development and tests only.
          allowDevGames: config.get<string>('NODE_ENV') !== 'production',
        }),
    },
    {
      provide: MatchMaintenance,
      inject: [MatchesService],
      useFactory: (matches: MatchesService) => new MatchMaintenance(matches),
    },
  ],
})
export class MatchesModule {}
