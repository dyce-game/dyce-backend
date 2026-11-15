import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  ageGateSchema,
  clientStepSchema,
  profileCreateSchema,
  profileUpdateSchema,
  setAvatarSchema,
  usernameSchema,
  type ClientStep,
  type ProfileCreate,
  type ProfileUpdate,
  type SetAvatarRequest,
} from '@dyce/shared';
import { AuthGuard, CurrentUser, type AuthContext } from '../auth/auth.guard.ts';
import { ZodPipe } from '../common/zod.pipe.ts';
import { ProfileService } from './profile.service.ts';

const usernameQuery = z.object({ username: usernameSchema });

@Controller()
@UseGuards(AuthGuard)
export class ProfileController {
  constructor(@Inject(ProfileService) private readonly profiles: ProfileService) {}

  @Get('me')
  me(@CurrentUser() user: AuthContext) {
    return this.profiles.getMe(user.userId);
  }

  /** Live availability for the username screen (the app debounces). */
  @Get('profile/username/check')
  checkUsername(@Query(new ZodPipe(usernameQuery)) query: { username: string }) {
    return this.profiles.checkUsername(query.username);
  }

  @Post('profile')
  @HttpCode(201)
  createProfile(
    @CurrentUser() user: AuthContext,
    @Body(new ZodPipe(profileCreateSchema)) body: ProfileCreate,
  ) {
    return this.profiles.createProfile(user.userId, body);
  }

  /** Change your display name and/or who may send you requests. */
  @Patch('profile')
  updateProfile(
    @CurrentUser() user: AuthContext,
    @Body(new ZodPipe(profileUpdateSchema)) body: ProfileUpdate,
  ) {
    return this.profiles.updateProfile(user.userId, body);
  }

  @Post('profile/age-gate')
  @HttpCode(200)
  ageGate(
    @CurrentUser() user: AuthContext,
    @Body(new ZodPipe(ageGateSchema)) body: { birthYear: number },
  ) {
    return this.profiles.setBirthYear(user.userId, body.birthYear);
  }

  /** Pick (or change) your look. Counts as the onboarding "avatar" step. */
  @Put('profile/avatar')
  setAvatar(
    @CurrentUser() user: AuthContext,
    @Body(new ZodPipe(setAvatarSchema)) body: SetAvatarRequest,
  ) {
    return this.profiles.setAvatar(user.userId, body.avatar);
  }

  /** The client reports a finished (or skipped) step: contacts, avatar or notifications. */
  @Post('onboarding/steps/:step')
  @HttpCode(200)
  completeStep(
    @CurrentUser() user: AuthContext,
    @Param('step', new ZodPipe(clientStepSchema)) step: ClientStep,
  ) {
    return this.profiles.completeStep(user.userId, step);
  }

  @Post('onboarding/welcome-bonus')
  @HttpCode(200)
  welcomeBonus(@CurrentUser() user: AuthContext) {
    return this.profiles.claimWelcomeBonus(user.userId);
  }
}
