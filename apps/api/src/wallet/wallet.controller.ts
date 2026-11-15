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
import {
  createPaymentRequestSchema,
  historyQuerySchema,
  payPaymentRequestSchema,
  requestCodeSchema,
  sendMoneySchema,
  type CreatePaymentRequestInput,
  type HistoryQuery,
  type PayPaymentRequestInput,
  type SendMoneyRequest,
} from '@dyce/shared';
import { z } from 'zod';
import { AuthGuard, CurrentUser, type AuthContext } from '../auth/auth.guard.ts';
import { ZodPipe } from '../common/zod.pipe.ts';
import { WalletService } from './wallet.service.ts';

const codePipe = new ZodPipe(requestCodeSchema);
const txnIdPipe = new ZodPipe(z.uuid());

@Controller('wallet')
@UseGuards(AuthGuard)
export class WalletController {
  constructor(@Inject(WalletService) private readonly wallet: WalletService) {}

  /** Balance, free top-up availability and your limits. */
  @Get()
  summary(@CurrentUser() user: AuthContext) {
    return this.wallet.summary(user.userId);
  }

  @Post('topup')
  @HttpCode(200)
  topup(@CurrentUser() user: AuthContext) {
    return this.wallet.claimTopup(user.userId);
  }

  @Post('send')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  send(
    @CurrentUser() user: AuthContext,
    @Body(new ZodPipe(sendMoneySchema)) body: SendMoneyRequest,
  ) {
    return this.wallet.send(user.userId, body);
  }

  @Get('history')
  history(
    @CurrentUser() user: AuthContext,
    @Query(new ZodPipe(historyQuerySchema)) query: HistoryQuery,
  ) {
    return this.wallet.history(user.userId, query);
  }

  /** The last 7 days of net movement (History bars, Top-up week grid). */
  @Get('weekly')
  weekly(@CurrentUser() user: AuthContext) {
    return this.wallet.weekly(user.userId);
  }

  @Get('transactions/:id')
  receipt(@CurrentUser() user: AuthContext, @Param('id', txnIdPipe) id: string) {
    return this.wallet.receipt(user.userId, id);
  }

  /** Requests you made. */
  @Get('requests')
  myRequests(@CurrentUser() user: AuthContext) {
    return this.wallet.myRequests(user.userId);
  }

  @Post('requests')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  createRequest(
    @CurrentUser() user: AuthContext,
    @Body(new ZodPipe(createPaymentRequestSchema)) body: CreatePaymentRequestInput,
  ) {
    return this.wallet.createRequest(user.userId, body);
  }

  /** What the Pay sheet shows for a scanned code. Throttled: this is also a way to probe codes. */
  @Get('requests/:code')
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  getRequest(@CurrentUser() user: AuthContext, @Param('code', codePipe) code: string) {
    return this.wallet.getRequest(user.userId, code);
  }

  @Post('requests/:code/pay')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  pay(
    @CurrentUser() user: AuthContext,
    @Param('code', codePipe) code: string,
    @Body(new ZodPipe(payPaymentRequestSchema)) body: PayPaymentRequestInput,
  ) {
    return this.wallet.payRequest(user.userId, code, body);
  }

  @Post('requests/:code/cancel')
  @HttpCode(204)
  async cancel(
    @CurrentUser() user: AuthContext,
    @Param('code', codePipe) code: string,
  ): Promise<void> {
    await this.wallet.cancelRequest(user.userId, code);
  }
}
