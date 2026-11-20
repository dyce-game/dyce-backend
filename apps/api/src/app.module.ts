import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module.ts';
import { ChatModule } from './chat/chat.module.ts';
import { validateEnv } from './config/env.ts';
import { DbModule } from './db/db.module.ts';
import { DiscoveryModule } from './discovery/discovery.module.ts';
import { HealthController } from './health/health.controller.ts';
import { InvitesModule } from './invites/invites.module.ts';
import { LedgerModule } from './ledger/ledger.module.ts';
import { MatchesModule } from './matches/matches.module.ts';
import { NotificationsModule } from './notifications/notifications.module.ts';
import { SafetyModule } from './safety/safety.module.ts';
import { SocialModule } from './social/social.module.ts';
import { SpacesModule } from './spaces/spaces.module.ts';
import { WalletModule } from './wallet/wallet.module.ts';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    // Global per-IP ceiling; sensitive routes (OTP, refresh) tighten it with @Throttle.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
    ScheduleModule.forRoot(),
    DbModule,
    LedgerModule,
    AuthModule,
    SocialModule,
    ChatModule,
    WalletModule,
    MatchesModule,
    SafetyModule,
    InvitesModule,
    SpacesModule,
    DiscoveryModule,
    NotificationsModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
