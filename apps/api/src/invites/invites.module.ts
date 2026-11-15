import { Module } from '@nestjs/common';
import type pg from 'pg';
import { AuthModule } from '../auth/auth.module.ts';
import { ChatModule } from '../chat/chat.module.ts';
import { MessagesService } from '../chat/messages.service.ts';
import { validateEnv } from '../config/env.ts';
import { PG_POOL } from '../db/db.module.ts';
import { MatchesModule } from '../matches/matches.module.ts';
import { MatchesService } from '../matches/matches.service.ts';
import { buildSmsProvider } from '../sms/sms.factory.ts';
import { InvitesController } from './invites.controller.ts';
import { InvitesService } from './invites.service.ts';

@Module({
  imports: [AuthModule, ChatModule, MatchesModule],
  controllers: [InvitesController],
  providers: [
    {
      provide: InvitesService,
      inject: [PG_POOL, MatchesService, MessagesService],
      useFactory: (pool: pg.Pool, matches: MatchesService, chat: MessagesService) => {
        const env = validateEnv(process.env);
        return new InvitesService(
          pool,
          buildSmsProvider(env),
          matches,
          chat,
          { phoneSecret: env.PHONE_HASH_SALT, linkBase: env.INVITE_BASE_URL },
          () => new Date(),
          { warn: (m) => console.warn(`[invites] ${m}`) },
        );
      },
    },
  ],
})
export class InvitesModule {}
