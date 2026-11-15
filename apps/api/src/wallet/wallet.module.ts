import { Logger, Module } from '@nestjs/common';
import type pg from 'pg';
import { AuthModule } from '../auth/auth.module.ts';
import { ChatModule } from '../chat/chat.module.ts';
import { MessagesService } from '../chat/messages.service.ts';
import { PG_POOL } from '../db/db.module.ts';
import { LedgerModule } from '../ledger/ledger.module.ts';
import { LedgerRepo } from '../ledger/ledger.repo.ts';
import { WalletController } from './wallet.controller.ts';
import { WalletService } from './wallet.service.ts';

const log = new Logger('Wallet');

@Module({
  imports: [AuthModule, LedgerModule, ChatModule],
  controllers: [WalletController],
  providers: [
    {
      provide: WalletService,
      inject: [PG_POOL, LedgerRepo, MessagesService],
      useFactory: (pool: pg.Pool, ledger: LedgerRepo, chat: MessagesService) =>
        new WalletService(pool, ledger, chat, () => new Date(), { warn: (m) => log.warn(m) }),
    },
  ],
})
export class WalletModule {}
