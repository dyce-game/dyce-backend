import { Module } from '@nestjs/common';
import type pg from 'pg';
import { AuthModule } from '../auth/auth.module.ts';
import { PG_POOL } from '../db/db.module.ts';
import { BlocksController, ReportsController } from './safety.controller.ts';
import { SafetyService } from './safety.service.ts';

@Module({
  imports: [AuthModule],
  controllers: [BlocksController, ReportsController],
  providers: [
    {
      provide: SafetyService,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool) => new SafetyService(pool),
    },
  ],
})
export class SafetyModule {}
