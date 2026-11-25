import { Inject, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { TokenService } from '../auth/tokens.ts';
import { throttleTracker } from './throttle-tracker.ts';

/** The app-wide rate limiter, counting signed-in people by account and everyone else by address. */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  @Inject(TokenService) private readonly tokens!: TokenService;

  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    return throttleTracker(
      req as { headers: Record<string, string | undefined>; ip?: string },
      (token) => this.tokens.verifyAccess(token),
    );
  }
}
