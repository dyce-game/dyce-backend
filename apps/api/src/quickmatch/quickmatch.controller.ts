import { Body, Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  quickMatchIdParamSchema,
  startQuickMatchSchema,
  type StartQuickMatchRequest,
} from '@dyce/shared';
import { AuthGuard, CurrentUser, type AuthContext } from '../auth/auth.guard.ts';
import { ZodPipe } from '../common/zod.pipe.ts';
import { PoolEntry, PoolEntryGuard } from '../integrity/pool-entry.guard.ts';
import { QuickMatchService } from './quickmatch.service.ts';

const idPipe = new ZodPipe(quickMatchIdParamSchema);

@Controller('quick-match')
@UseGuards(AuthGuard)
export class QuickMatchController {
  constructor(@Inject(QuickMatchService) private readonly quick: QuickMatchService) {}

  /** Your current search (or the one that just ended) and the games you can quick match. */
  @Get()
  state(@CurrentUser() user: AuthContext) {
    return this.quick.state(user.userId);
  }

  /** Joins the queue for a game and mode. Repeating it returns the same search. */
  @Post()
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @PoolEntry('body')
  @UseGuards(PoolEntryGuard)
  join(
    @CurrentUser() user: AuthContext,
    @Body(new ZodPipe(startQuickMatchSchema)) body: StartQuickMatchRequest,
  ) {
    return this.quick.join(user.userId, body);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthContext, @Param('id', idPipe) id: string) {
    return this.quick.cancel(user.userId, id);
  }

  @Post(':id/accept')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  accept(@CurrentUser() user: AuthContext, @Param('id', idPipe) id: string) {
    return this.quick.accept(user.userId, id);
  }

  @Post(':id/decline')
  @HttpCode(200)
  decline(@CurrentUser() user: AuthContext, @Param('id', idPipe) id: string) {
    return this.quick.decline(user.userId, id);
  }
}
