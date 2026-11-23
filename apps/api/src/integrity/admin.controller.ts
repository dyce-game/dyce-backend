import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.ts';
import { Admin, AdminGuard } from './admin.guard.ts';
import { ModerationService } from './moderation.service.ts';

const id = new ZodPipe(z.uuid());
const note = z.string().trim().max(1000).optional();
const hours = z
  .number()
  .int()
  .min(1)
  .max(24 * 365)
  .optional();

const listQuery = new ZodPipe(
  z.object({
    status: z.enum(['open', 'reviewing', 'actioned', 'dismissed', 'pending']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }),
);
const signalQuery = new ZodPipe(
  z.object({
    flagged: z.enum(['true', 'false']).optional(),
    status: z.enum(['open', 'reviewing', 'actioned', 'dismissed']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }),
);
const holdQuery = new ZodPipe(
  z.object({
    status: z.enum(['held', 'released', 'voided', 'disqualified']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }),
);
const limitQuery = new ZodPipe(
  z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    userId: z.uuid().optional(),
  }),
);

const reportAction = new ZodPipe(
  z.object({
    action: z.enum(['review', 'warn', 'mute', 'suspend', 'dismiss']),
    note,
    hours,
  }),
);
const signalReview = new ZodPipe(
  z.object({ status: z.enum(['reviewing', 'actioned', 'dismissed']), note }),
);
const holdResolve = new ZodPipe(
  z.object({
    decision: z.enum(['release', 'void', 'disqualify']),
    note,
    userId: z.uuid().optional(),
  }),
);
const disputeResolve = new ZodPipe(
  z.object({
    status: z.enum(['reviewing', 'upheld', 'reversed']),
    note,
    txnId: z.uuid().optional(),
  }),
);
const sanction = new ZodPipe(
  z.object({
    kind: z.enum(['warning', 'mute', 'suspension']),
    note,
    hours,
    reportId: z.uuid().optional(),
    signalId: z.uuid().optional(),
  }),
);
const lift = new ZodPipe(z.object({ note }));

/**
 * The moderation API (ADR-039): JSON only, admin tokens only, no UI. `apps/api/scripts/moderation.mjs` is the
 * command-line client. Every write is an audited SQL function; reading goes through views the public API's
 * database role cannot see.
 */
@Controller('admin/moderation')
@UseGuards(AdminGuard)
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class AdminController {
  constructor(@Inject(ModerationService) private readonly moderation: ModerationService) {}

  @Get('reports')
  reports(
    @Query(listQuery)
    q: {
      status?: 'open' | 'reviewing' | 'actioned' | 'dismissed' | 'pending';
      limit?: number;
    },
  ) {
    return this.moderation.reports({ status: q.status ?? 'pending', limit: q.limit });
  }

  @Get('reports/:id')
  report(@Param('id', id) reportId: string) {
    return this.moderation.report(reportId);
  }

  @Post('reports/:id/action')
  @HttpCode(200)
  async actOnReport(
    @Admin() admin: string,
    @Param('id', id) reportId: string,
    @Body(reportAction)
    body: {
      action: 'review' | 'warn' | 'mute' | 'suspend' | 'dismiss';
      note?: string;
      hours?: number;
    },
  ) {
    await this.moderation.actOnReport(reportId, body.action, admin, body.note ?? null, body.hours);
    return { ok: true };
  }

  @Get('signals')
  signals(
    @Query(signalQuery)
    q: {
      flagged?: 'true' | 'false';
      status?: 'open' | 'reviewing' | 'actioned' | 'dismissed';
      limit?: number;
    },
  ) {
    return this.moderation.signals({
      flagged: q.flagged === undefined ? true : q.flagged === 'true',
      status: q.status,
      limit: q.limit,
    });
  }

  @Post('signals/:id/review')
  @HttpCode(200)
  async reviewSignal(
    @Admin() admin: string,
    @Param('id', id) signalId: string,
    @Body(signalReview) body: { status: 'reviewing' | 'actioned' | 'dismissed'; note?: string },
  ) {
    await this.moderation.reviewSignal(signalId, body.status, admin, body.note ?? null);
    return { ok: true };
  }

  @Get('holds')
  holds(
    @Query(holdQuery)
    q: {
      status?: 'held' | 'released' | 'voided' | 'disqualified';
      limit?: number;
    },
  ) {
    return this.moderation.holds({ status: q.status ?? 'held', limit: q.limit });
  }

  @Post('holds/:id/resolve')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  resolveHold(
    @Admin() admin: string,
    @Param('id', id) holdId: string,
    @Body(holdResolve)
    body: { decision: 'release' | 'void' | 'disqualify'; note?: string; userId?: string },
  ) {
    return this.moderation.resolveHold(
      holdId,
      body.decision,
      admin,
      body.note ?? null,
      body.userId,
    );
  }

  @Get('disputes')
  disputes(@Query(limitQuery) q: { limit?: number }) {
    return this.moderation.disputes({ limit: q.limit });
  }

  @Post('disputes/:id/resolve')
  @HttpCode(200)
  async resolveDispute(
    @Admin() admin: string,
    @Param('id', id) disputeId: string,
    @Body(disputeResolve)
    body: { status: 'reviewing' | 'upheld' | 'reversed'; note?: string; txnId?: string },
  ) {
    await this.moderation.resolveDispute(
      disputeId,
      body.status,
      admin,
      body.note ?? null,
      body.txnId,
    );
    return { ok: true };
  }

  @Get('users/:id')
  user(@Param('id', id) userId: string) {
    return this.moderation.user(userId);
  }

  @Post('users/:id/sanction')
  @HttpCode(200)
  async sanction(
    @Admin() admin: string,
    @Param('id', id) userId: string,
    @Body(sanction)
    body: {
      kind: 'warning' | 'mute' | 'suspension';
      note?: string;
      hours?: number;
      reportId?: string;
      signalId?: string;
    },
  ) {
    const sanctionId = await this.moderation.sanction(userId, body.kind, admin, body.note ?? null, {
      hours: body.hours,
      reportId: body.reportId,
      signalId: body.signalId,
    });
    return { sanctionId };
  }

  @Post('sanctions/:id/lift')
  @HttpCode(200)
  async lift(
    @Admin() admin: string,
    @Param('id', id) sanctionId: string,
    @Body(lift) body: { note?: string },
  ) {
    await this.moderation.lift(sanctionId, admin, body.note ?? null);
    return { ok: true };
  }

  @Get('audit')
  audit(@Query(limitQuery) q: { limit?: number; userId?: string }) {
    return this.moderation.audit({ limit: q.limit, targetUserId: q.userId });
  }
}
