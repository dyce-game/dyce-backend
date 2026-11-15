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
import {
  createSpaceSchema,
  joinSpaceSchema,
  removeSpaceMemberSchema,
  spaceCodeSchema,
  spaceIdParamSchema,
  type CreateSpaceRequest,
} from '@dyce/shared';
import { AuthGuard, CurrentUser, type AuthContext } from '../auth/auth.guard.ts';
import { ZodPipe } from '../common/zod.pipe.ts';
import { SpacesService } from './spaces.service.ts';

const idPipe = new ZodPipe(spaceIdParamSchema);
const codeQuery = new ZodPipe(z.object({ code: spaceCodeSchema }));

@Controller('spaces')
@UseGuards(AuthGuard)
export class SpacesController {
  constructor(@Inject(SpacesService) private readonly spaces: SpacesService) {}

  /** Your spaces: waiting, live and recently finished. */
  @Get()
  list(@CurrentUser() user: AuthContext) {
    return this.spaces.list(user.userId);
  }

  /** The app picks the id, so retrying is safe. */
  @Post()
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  create(
    @CurrentUser() user: AuthContext,
    @Body(new ZodPipe(createSpaceSchema)) body: CreateSpaceRequest,
  ) {
    return this.spaces.create(user.userId, body);
  }

  /** Preview a space by its code (`?code=DY-4K9P`) before sitting down. */
  @Get('lookup')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  lookup(@CurrentUser() user: AuthContext, @Query(codeQuery) q: { code: string }) {
    return this.spaces.lookup(user.userId, q.code);
  }

  @Post('join')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  join(
    @CurrentUser() user: AuthContext,
    @Body(new ZodPipe(joinSpaceSchema)) body: { code: string },
  ) {
    return this.spaces.join(user.userId, body.code);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthContext, @Param('id', idPipe) id: string) {
    return this.spaces.get(user.userId, id);
  }

  @Post(':id/leave')
  @HttpCode(200)
  leave(@CurrentUser() user: AuthContext, @Param('id', idPipe) id: string) {
    return this.spaces.leave(user.userId, id);
  }

  @Post(':id/remove')
  @HttpCode(200)
  remove(
    @CurrentUser() user: AuthContext,
    @Param('id', idPipe) id: string,
    @Body(new ZodPipe(removeSpaceMemberSchema)) body: { userId: string },
  ) {
    return this.spaces.remove(user.userId, id, body.userId);
  }

  @Post(':id/close')
  @HttpCode(200)
  close(@CurrentUser() user: AuthContext, @Param('id', idPipe) id: string) {
    return this.spaces.close(user.userId, id);
  }

  @Post(':id/start')
  @HttpCode(200)
  start(@CurrentUser() user: AuthContext, @Param('id', idPipe) id: string) {
    return this.spaces.start(user.userId, id);
  }

  /** Where to open the live connection (makes sure the room exists). */
  @Post(':id/connect')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  connect(@CurrentUser() user: AuthContext, @Param('id', idPipe) id: string) {
    return this.spaces.connect(user.userId, id);
  }
}
