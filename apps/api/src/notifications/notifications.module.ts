import { Inject, Injectable, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import type pg from 'pg';
import { AuthModule } from '../auth/auth.module.ts';
import { ChatModule } from '../chat/chat.module.ts';
import { RealtimeHub } from '../chat/hub.ts';
import { PG_POOL } from '../db/db.module.ts';
import { ConsolePushDriver } from './console-push.driver.ts';
import { ExpoPushDriver } from './expo-push.driver.ts';
import { NotificationsController } from './notifications.controller.ts';
import { NotificationsService } from './notifications.service.ts';
import { PushDispatcher } from './push-dispatcher.ts';
import type { PushDriver } from './push-driver.ts';

const PUSH_DRIVER = Symbol('PUSH_DRIVER');

/** Runs the push queue every few seconds. A failure is logged and the next tick tries again. */
@Injectable()
export class PushJob {
  private readonly log = new Logger('PushJob');
  private running = false;

  constructor(@Inject(PushDispatcher) private readonly dispatcher: PushDispatcher) {}

  @Interval(3000)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.dispatcher.dispatchPending();
    } catch (err) {
      this.log.warn(`push dispatch failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

/** The in-app Notifications list, preferences, device tokens and the push dispatcher (ADR-023). */
@Module({
  imports: [AuthModule, ChatModule], // AuthGuard; the realtime hub
  controllers: [NotificationsController],
  providers: [
    {
      provide: NotificationsService,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool) => new NotificationsService(pool),
    },
    {
      provide: PUSH_DRIVER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): PushDriver =>
        config.get('PUSH_DRIVER') === 'expo'
          ? new ExpoPushDriver(config.get<string>('EXPO_ACCESS_TOKEN'))
          : new ConsolePushDriver(),
    },
    {
      provide: PushDispatcher,
      inject: [PG_POOL, PUSH_DRIVER, RealtimeHub],
      useFactory: (pool: pg.Pool, driver: PushDriver, hub: RealtimeHub) =>
        new PushDispatcher(pool, driver, hub),
    },
    PushJob,
  ],
  exports: [NotificationsService, PushDispatcher],
})
export class NotificationsModule {}
