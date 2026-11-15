import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  claimInviteSchema,
  createInviteSchema,
  guestMoveSchema,
  type ClaimInviteRequest,
  type CreateInviteRequest,
  type GuestMoveRequest,
} from '@dyce/shared';
import { AuthError } from '../auth/auth-error.ts';
import { AuthGuard, CurrentUser, type AuthContext } from '../auth/auth.guard.ts';
import { ZodPipe } from '../common/zod.pipe.ts';
import { InvitesService } from './invites.service.ts';

/** `Authorization: Bearer <guest token>` (not a user JWT: guests have no account). */
function bearer(header: string | undefined): string | undefined {
  return header ? /^Bearer (.+)$/i.exec(header)?.[1] : undefined;
}

function requiredBearer(header: string | undefined): string {
  const t = bearer(header);
  if (!t) throw new AuthError('guest_unauthorized');
  return t;
}

/** Tokens are 16 URL-safe characters; anything else cannot exist, so refuse it before the database. */
const TOKEN = /^[A-Za-z0-9_-]{8,64}$/;
function token(value: string): string {
  if (!TOKEN.test(value)) throw new AuthError('invite_not_found');
  return value;
}

@Controller('invites')
export class InvitesController {
  constructor(@Inject(InvitesService) private readonly invites: InvitesService) {}

  // ---- signed in: sending and joining ----------------------------------------------------------

  @Post()
  @HttpCode(201)
  @UseGuards(AuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  create(
    @CurrentUser() user: AuthContext,
    @Body(new ZodPipe(createInviteSchema)) body: CreateInviteRequest,
  ) {
    return this.invites.create(user.userId, body);
  }

  @Get()
  @UseGuards(AuthGuard)
  list(@CurrentUser() user: AuthContext) {
    return this.invites.list(user.userId);
  }

  /** After sign-up: join every invite that was sent to this account's number. Safe to call repeatedly. */
  @Post('claim')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  claim(
    @CurrentUser() user: AuthContext,
    @Body(new ZodPipe(claimInviteSchema)) body: ClaimInviteRequest,
  ) {
    return this.invites.claim(user.userId, body.token);
  }

  // ---- public: the landing page and the guest game ---------------------------------------------

  @Get(':token')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  get(@Param('token') t: string) {
    return this.invites.get(token(t));
  }

  /** Starts (or resumes) the guest's run. A resuming browser sends its guest token. */
  @Post(':token/guest')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  startGuest(@Param('token') t: string, @Headers('authorization') auth?: string) {
    return this.invites.startGuest(token(t), bearer(auth));
  }

  @Get(':token/guest')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  guestView(@Param('token') t: string, @Headers('authorization') auth?: string) {
    return this.invites.guestView(token(t), requiredBearer(auth));
  }

  @Post(':token/guest/move')
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  guestMove(
    @Param('token') t: string,
    @Headers('authorization') auth: string | undefined,
    @Body(new ZodPipe(guestMoveSchema)) body: GuestMoveRequest,
  ) {
    return this.invites.guestMove(token(t), requiredBearer(auth), body.action);
  }
}
