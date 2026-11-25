import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { AccountModule } from './account/account.module.ts';
import { AuthModule } from './auth/auth.module.ts';
import { ChatModule } from './chat/chat.module.ts';
import { UserThrottlerGuard } from './common/user-throttler.guard.ts';
import { validateEnv } from './config/env.ts';
import { DbModule } from './db/db.module.ts';
import { DiscoveryModule } from './discovery/discovery.module.ts';
import { HealthController } from './health/health.controller.ts';
import { IntegrityModule } from './integrity/integrity.module.ts';
import { InvitesModule } from './invites/invites.module.ts';
import { LedgerModule } from './ledger/ledger.module.ts';
import { MatchesModule } from './matches/matches.module.ts';
import { OpsModule } from './ops/ops.module.ts';
import { NotificationsModule } from './notifications/notifications.module.ts';
import { ProgressModule } from './progress/progress.module.ts';
import { SafetyModule } from './safety/safety.module.ts';
import { SocialModule } from './social/social.module.ts';
import { QuickMatchModule } from './quickmatch/quickmatch.module.ts';
import { SpacesModule } from './spaces/spaces.module.ts';
import { WalletModule } from './wallet/wallet.module.ts';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    // Global ceiling per signed-in account (per address for everyone else); sensitive routes tighten it with
    // @Throttle. See docs/RATE_LIMITS.md.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
    ScheduleModule.forRoot(),
    DbModule,
    LedgerModule,
    OpsModule,
    AuthModule,
    SocialModule,
    ChatModule,
    WalletModule,
    MatchesModule,
    SafetyModule,
    IntegrityModule,
    InvitesModule,
    SpacesModule,
    QuickMatchModule,
    DiscoveryModule,
    ProgressModule,
    NotificationsModule,
    AccountModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: UserThrottlerGuard }],
})
export class AppModule {}
