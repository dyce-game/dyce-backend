import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  blockSchema,
  reportSchema,
  userIdParamSchema,
  type BlockRequest,
  type ReportRequest,
} from '@dyce/shared';
import { AuthGuard, CurrentUser, type AuthContext } from '../auth/auth.guard.ts';
import { ZodPipe } from '../common/zod.pipe.ts';
import { SafetyService } from './safety.service.ts';

@Controller('blocks')
@UseGuards(AuthGuard)
export class BlocksController {
  constructor(@Inject(SafetyService) private readonly safety: SafetyService) {}

  /** People you've blocked. */
  @Get()
  list(@CurrentUser() user: AuthContext) {
    return this.safety.list(user.userId);
  }

  @Post()
  @HttpCode(204)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async block(
    @CurrentUser() user: AuthContext,
    @Body(new ZodPipe(blockSchema)) body: BlockRequest,
  ): Promise<void> {
    await this.safety.block(user.userId, body.userId);
  }

  @Delete(':userId')
  @HttpCode(204)
  async unblock(
    @CurrentUser() user: AuthContext,
    @Param('userId', new ZodPipe(userIdParamSchema)) userId: string,
  ): Promise<void> {
    await this.safety.unblock(user.userId, userId);
  }
}

@Controller('reports')
@UseGuards(AuthGuard)
export class ReportsController {
  constructor(@Inject(SafetyService) private readonly safety: SafetyService) {}

  @Post()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  report(@CurrentUser() user: AuthContext, @Body(new ZodPipe(reportSchema)) body: ReportRequest) {
    return this.safety.report(user.userId, body);
  }
}
