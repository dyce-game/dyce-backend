import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  leaderboardQuerySchema,
  peopleSearchQuerySchema,
  usernameSchema,
  type LeaderboardQuery,
  type PeopleSearchQuery,
} from '@dyce/shared';
import type { z } from 'zod';
import { AuthGuard, CurrentUser, type AuthContext } from '../auth/auth.guard.ts';
import { ZodPipe } from '../common/zod.pipe.ts';
import { LeaderboardService } from './leaderboard.service.ts';
import { SearchService } from './search.service.ts';
import { UserProfileService } from './user-profile.service.ts';

@Controller()
@UseGuards(AuthGuard)
export class DiscoveryController {
  constructor(
    @Inject(SearchService) private readonly search: SearchService,
    @Inject(UserProfileService) private readonly profiles: UserProfileService,
    @Inject(LeaderboardService) private readonly boards: LeaderboardService,
  ) {}

  /** People by @username and name. Strangers only match the start of a @username (see SearchService). */
  @Get('search/people')
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  people(
    @CurrentUser() user: AuthContext,
    @Query(new ZodPipe(peopleSearchQuerySchema)) query: PeopleSearchQuery,
  ) {
    return this.search.people(user.userId, query.q);
  }

  /** Another person's profile (or your own): "Not in your contacts", mutual friends, head to head, recent games. */
  @Get('users/:username/profile')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  profile(
    @CurrentUser() user: AuthContext,
    @Param('username', new ZodPipe(usernameSchema)) username: z.output<typeof usernameSchema>,
  ) {
    return this.profiles.get(user.userId, username);
  }

  /** Every badge, with the date you earned it (null while locked). */
  @Get('me/badges')
  badges(@CurrentUser() user: AuthContext) {
    return this.profiles.myBadges(user.userId);
  }

  @Get('leaderboards')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  leaderboard(
    @CurrentUser() user: AuthContext,
    @Query(new ZodPipe(leaderboardQuerySchema)) query: LeaderboardQuery,
  ) {
    return this.boards.get(user.userId, query);
  }
}
