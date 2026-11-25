import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type pg from 'pg';
import { AuthModule } from '../auth/auth.module.ts';
import { ChatModule } from '../chat/chat.module.ts';
import { RealtimeHub } from '../chat/hub.ts';
import { PG_POOL } from '../db/db.module.ts';
import { IntegrityModule } from '../integrity/integrity.module.ts';
import { HttpGameRooms, NoGameRooms } from './game-rooms.ts';
import { SpacesController } from './spaces.controller.ts';
import { SpacesService, type GameRooms } from './spaces.service.ts';

/** Closes waiting spaces nobody started, giving every seat fee back. */
export class SpaceMaintenance {
  constructor(private readonly spaces: SpacesService) {}

  @Cron('*/10 * * * *')
  async expireSpaces(): Promise<void> {
    const n = await this.spaces.expireStaleSpaces();
    if (n > 0) new Logger('Spaces').log(`closed ${n} stale spaces`);
  }
}

@Module({
  imports: [AuthModule, ChatModule, IntegrityModule],
  controllers: [SpacesController],
  exports: [SpacesService],
  providers: [
    {
      provide: SpacesService,
      inject: [PG_POOL, RealtimeHub, ConfigService],
      useFactory: (pool: pg.Pool, hub: RealtimeHub, config: ConfigService) => {
        const base = config.get<string>('GAME_SERVER_URL') ?? 'http://localhost:2567';
        const secret = config.get<string>('INTERNAL_SECRET');
        const rooms: GameRooms = secret
          ? new HttpGameRooms({
              baseUrl: base,
              publicUrl: config.get<string>('GAME_SERVER_PUBLIC_URL'),
              secret,
            })
          : new NoGameRooms();
        return new SpacesService(pool, hub, rooms);
      },
    },
    {
      provide: SpaceMaintenance,
      inject: [SpacesService],
      useFactory: (spaces: SpacesService) => new SpaceMaintenance(spaces),
    },
  ],
})
export class SpacesModule {}
