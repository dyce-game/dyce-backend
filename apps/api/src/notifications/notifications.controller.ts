import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  markReadSchema,
  notificationPrefsUpdateSchema,
  notificationsQuerySchema,
  pushTokenRemoveSchema,
  pushTokenSchema,
  type MarkReadRequest,
  type NotificationPrefsUpdate,
  type NotificationsQuery,
  type PushTokenRequest,
} from '@dyce/shared';
import type { z } from 'zod';
import { AuthGuard, CurrentUser, type AuthContext } from '../auth/auth.guard.ts';
import { ZodPipe } from '../common/zod.pipe.ts';
import { NotificationsService } from './notifications.service.ts';

@Controller()
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  /** Newest first. `filter` is all | turn | pool; page with `before` (the previous `nextCursor`). */
  @Get('notifications')
  list(
    @CurrentUser() user: AuthContext,
    @Query(new ZodPipe(notificationsQuerySchema)) q: NotificationsQuery,
  ) {
    return this.notifications.list(user.userId, q);
  }

  /** The number on the bell and on the header avatar. */
  @Get('notifications/unread-count')
  unread(@CurrentUser() user: AuthContext) {
    return this.notifications.unread(user.userId);
  }

  @Post('notifications/read')
  @HttpCode(200)
  markRead(
    @CurrentUser() user: AuthContext,
    @Body(new ZodPipe(markReadSchema)) body: MarkReadRequest,
  ) {
    return this.notifications.markRead(user.userId, body);
  }

  @Get('notifications/prefs')
  prefs(@CurrentUser() user: AuthContext) {
    return this.notifications.getPrefs(user.userId);
  }

  /** Switches per group, quiet hours and the phone's time zone offset. Send only what changed. */
  @Patch('notifications/prefs')
  updatePrefs(
    @CurrentUser() user: AuthContext,
    @Body(new ZodPipe(notificationPrefsUpdateSchema)) body: NotificationPrefsUpdate,
  ) {
    return this.notifications.updatePrefs(user.userId, body);
  }

  /** Register this device for push (called after the person allows notifications). */
  @Post('push/tokens')
  @HttpCode(204)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async register(
    @CurrentUser() user: AuthContext,
    @Body(new ZodPipe(pushTokenSchema)) body: PushTokenRequest,
  ): Promise<void> {
    await this.notifications.registerToken(user.userId, body);
  }

  /** Stop pushing to this device (signing out, or turning notifications off). */
  @Delete('push/tokens')
  @HttpCode(204)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async remove(
    @CurrentUser() user: AuthContext,
    @Body(new ZodPipe(pushTokenRemoveSchema)) body: z.output<typeof pushTokenRemoveSchema>,
  ): Promise<void> {
    await this.notifications.removeToken(user.userId, body.token);
  }
}
