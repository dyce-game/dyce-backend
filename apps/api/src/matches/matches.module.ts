import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type pg from 'pg';
import { AuthModule } from '../auth/auth.module.ts';
import { ChatModule } from '../chat/chat.module.ts';
import { RealtimeHub } from '../chat/hub.ts';
import { MessagesService } from '../chat/messages.service.ts';
import { PG_POOL } from '../db/db.module.ts';
import { GamesController, MatchesController } from './matches.controller.ts';
import { MatchesService } from './matches.service.ts';

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
  ],
})
export class MatchesModule {}
