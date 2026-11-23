import { Body, Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  counterMatchSchema,
  createMatchSchema,
  matchIdParamSchema,
  submitMoveSchema,
  type CounterMatchRequest,
  type CreateMatchRequest,
  type SubmitMoveRequest,
} from '@dyce/shared';
import { AuthGuard, CurrentUser, type AuthContext } from '../auth/auth.guard.ts';
import { ZodPipe } from '../common/zod.pipe.ts';
import { PoolEntry, PoolEntryGuard } from '../integrity/pool-entry.guard.ts';
import { MatchesService } from './matches.service.ts';

const idPipe = new ZodPipe(matchIdParamSchema);

/** The Games drawer's catalogue. */
@Controller('games')
@UseGuards(AuthGuard)
export class GamesController {
  constructor(@Inject(MatchesService) private readonly matches: MatchesService) {}

  @Get()
  list() {
    return this.matches.listGames();
  }

  /** Stake limits, today's Pool usage and whether the age gate was answered (the stake picker). */
  @Get('pool')
  pool(@CurrentUser() user: AuthContext) {
    return this.matches.poolInfo(user.userId);
  }
}

@Controller('matches')
@UseGuards(AuthGuard)
export class MatchesController {
  constructor(@Inject(MatchesService) private readonly matches: MatchesService) {}

  /** Sends a game to the other person in a chat. The app picks the id, so retrying is safe. */
  @Post()
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @PoolEntry('body')
  @UseGuards(PoolEntryGuard)
  create(
    @CurrentUser() user: AuthContext,
    @Body(new ZodPipe(createMatchSchema)) body: CreateMatchRequest,
  ) {
    return this.matches.create(user.userId, body);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthContext, @Param('id', idPipe) id: string) {
    return this.matches.get(user.userId, id);
  }

  @Post(':id/accept')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @PoolEntry('match')
  @UseGuards(PoolEntryGuard)
  accept(@CurrentUser() user: AuthContext, @Param('id', idPipe) id: string) {
    return this.matches.accept(user.userId, id);
  }

  @Post(':id/decline')
  @HttpCode(200)
  decline(@CurrentUser() user: AuthContext, @Param('id', idPipe) id: string) {
    return this.matches.decline(user.userId, id);
  }

  /** The invitee suggests a smaller stake (0 = play free), once: `{ stakeKobo }`. */
  @Post(':id/counter')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @PoolEntry('match')
  @UseGuards(PoolEntryGuard)
  counter(
    @CurrentUser() user: AuthContext,
    @Param('id', idPipe) id: string,
    @Body(new ZodPipe(counterMatchSchema)) body: CounterMatchRequest,
  ) {
    return this.matches.counter(user.userId, id, body);
  }

  /** The sender takes an unanswered invite back. */
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthContext, @Param('id', idPipe) id: string) {
    return this.matches.cancel(user.userId, id);
  }

  /** Give up a running 1v1 match (the game menu's "Resign"): the other player wins. */
  @Post(':id/resign')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  resign(@CurrentUser() user: AuthContext, @Param('id', idPipe) id: string) {
    return this.matches.resign(user.userId, id);
  }

  /** One move: `{ expectedVersion, action }`. Returns your view of the match after it. */
  @Post(':id/moves')
  @HttpCode(200)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  move(
    @CurrentUser() user: AuthContext,
    @Param('id', idPipe) id: string,
    @Body(new ZodPipe(submitMoveSchema)) body: SubmitMoveRequest,
  ) {
    return this.matches.submitMove(user.userId, id, body);
  }
}
