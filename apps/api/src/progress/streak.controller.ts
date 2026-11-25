import { Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard, CurrentUser, type AuthContext } from '../auth/auth.guard.ts';
import { StreakService } from './streak.service.ts';

@Controller('me/streak')
@UseGuards(AuthGuard)
export class StreakController {
  constructor(@Inject(StreakService) private readonly streak: StreakService) {}

  /** Your streak, and the one that just ended and can be saved (design: StreakLost). */
  @Get()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  get(@CurrentUser() user: AuthContext) {
    return this.streak.get(user.userId);
  }

  /** The loss screen was seen (or dismissed): do not show it again. */
  @Post('seen')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async seen(@CurrentUser() user: AuthContext): Promise<{ ok: true }> {
    await this.streak.markSeen(user.userId);
    return { ok: true };
  }
}
