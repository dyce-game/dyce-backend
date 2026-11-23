import { Body, Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  createDisputeSchema,
  deleteAccountSchema,
  matchIdParamSchema,
  type CreateDisputeRequest,
  type DeleteAccountRequest,
} from '@dyce/shared';
import { AuthGuard, CurrentUser, type AuthContext } from '../auth/auth.guard.ts';
import { ZodPipe } from '../common/zod.pipe.ts';
import { AccountService } from './account.service.ts';
import { DisputesService } from './disputes.service.ts';

/** Delete account and Download my data (Settings). */
@Controller('me')
@UseGuards(AuthGuard)
export class AccountController {
  constructor(@Inject(AccountService) private readonly account: AccountService) {}

  /** The confirm screen: what deleting does to you, and whether a request is already waiting. */
  @Get('deletion')
  async deletion(@CurrentUser() user: AuthContext) {
    const [status, preview] = await Promise.all([
      this.account.deletionStatus(user.userId),
      this.account.deletionPreview(user.userId),
    ]);
    return { status, preview };
  }

  /** `{ username }` typed to confirm. Starts the grace period; every session ends. */
  @Post('delete')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  requestDeletion(
    @CurrentUser() user: AuthContext,
    @Body(new ZodPipe(deleteAccountSchema)) body: DeleteAccountRequest,
  ) {
    return this.account.requestDeletion(user.userId, body.username);
  }

  @Post('delete/cancel')
  @HttpCode(200)
  cancelDeletion(@CurrentUser() user: AuthContext) {
    return this.account.cancelDeletion(user.userId);
  }

  /** Your data as one JSON document. */
  @Get('export')
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  export(@CurrentUser() user: AuthContext) {
    return this.account.exportData(user.userId);
  }
}

/** Disputing a Pool result (design: Dispute, DisputeStatus). */
@Controller('matches')
@UseGuards(AuthGuard)
export class DisputesController {
  constructor(@Inject(DisputesService) private readonly disputes: DisputesService) {}

  @Get(':id/dispute')
  info(@CurrentUser() user: AuthContext, @Param('id', new ZodPipe(matchIdParamSchema)) id: string) {
    return this.disputes.info(user.userId, id);
  }

  @Post(':id/dispute')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  open(
    @CurrentUser() user: AuthContext,
    @Param('id', new ZodPipe(matchIdParamSchema)) id: string,
    @Body(new ZodPipe(createDisputeSchema)) body: CreateDisputeRequest,
  ) {
    return this.disputes.open(user.userId, id, body);
  }
}
