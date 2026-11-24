import { Body, Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  emailOtpRequestSchema,
  emailOtpVerifySchema,
  otpRequestSchema,
  otpVerifySchema,
  refreshSchema,
  type EmailOtpRequest,
  type EmailOtpVerify,
  type OtpRequest,
  type OtpVerify,
  type SessionResponse,
  type SessionTokens,
} from '@dyce/shared';
import { ZodPipe } from '../common/zod.pipe.ts';
import { AuthGuard, CurrentUser, type AuthContext } from './auth.guard.ts';
import { AuthService, type SignInMethods } from './auth.service.ts';

// Per-IP limits on top of the per-phone limits inside AuthService.
const OTP_THROTTLE = { default: { limit: 10, ttl: 60_000 } };
// Email costs us a real send per request and can be pointed at anyone's inbox, so it is tighter per IP.
const EMAIL_REQUEST_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('otp/request')
  @HttpCode(202)
  @Throttle(OTP_THROTTLE)
  requestOtp(@Body(new ZodPipe(otpRequestSchema)) body: OtpRequest) {
    return this.auth.requestOtp(body);
  }

  @Post('otp/verify')
  @HttpCode(200)
  @Throttle(OTP_THROTTLE)
  verifyOtp(@Body(new ZodPipe(otpVerifySchema)) body: OtpVerify): Promise<SessionResponse> {
    return this.auth.verifyOtp(body);
  }

  /** Which ways in this server offers, so the app can hide what is switched off. Public. */
  @Get('methods')
  methods() {
    return this.auth.methods();
  }

  @Post('email/otp/request')
  @HttpCode(202)
  @Throttle(EMAIL_REQUEST_THROTTLE)
  requestEmailOtp(@Body(new ZodPipe(emailOtpRequestSchema)) body: EmailOtpRequest) {
    return this.auth.requestEmailOtp(body);
  }

  @Post('email/otp/verify')
  @HttpCode(200)
  @Throttle(OTP_THROTTLE)
  verifyEmailOtp(
    @Body(new ZodPipe(emailOtpVerifySchema)) body: EmailOtpVerify,
  ): Promise<SessionResponse> {
    return this.auth.verifyEmailOtp(body);
  }

  @Post('refresh')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  refresh(
    @Body(new ZodPipe(refreshSchema)) body: { refreshToken: string },
  ): Promise<SessionTokens> {
    return this.auth.refresh(body.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Body(new ZodPipe(refreshSchema)) body: { refreshToken: string }): Promise<void> {
    await this.auth.logout(body.refreshToken);
  }
}

/** Adding the other way in to an account that is signed in: an email for a phone account, a phone for an email one. */
@Controller('me')
@UseGuards(AuthGuard)
export class IdentityController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get('sign-in')
  methods(@CurrentUser() user: AuthContext): Promise<SignInMethods> {
    return this.auth.signInMethods(user.userId);
  }

  @Post('email/request')
  @HttpCode(202)
  @Throttle(EMAIL_REQUEST_THROTTLE)
  requestEmail(
    @CurrentUser() user: AuthContext,
    @Body(new ZodPipe(emailOtpRequestSchema)) body: EmailOtpRequest,
  ) {
    return this.auth.requestEmailLink(user.userId, body);
  }

  @Post('email/verify')
  @HttpCode(200)
  @Throttle(OTP_THROTTLE)
  verifyEmail(
    @CurrentUser() user: AuthContext,
    @Body(new ZodPipe(emailOtpVerifySchema)) body: EmailOtpVerify,
  ): Promise<SignInMethods> {
    return this.auth.verifyEmailLink(user.userId, body);
  }

  @Post('phone/request')
  @HttpCode(202)
  @Throttle(OTP_THROTTLE)
  requestPhone(
    @CurrentUser() user: AuthContext,
    @Body(new ZodPipe(otpRequestSchema)) body: OtpRequest,
  ) {
    return this.auth.requestPhoneLink(user.userId, body);
  }

  @Post('phone/verify')
  @HttpCode(200)
  @Throttle(OTP_THROTTLE)
  verifyPhone(
    @CurrentUser() user: AuthContext,
    @Body(new ZodPipe(otpVerifySchema)) body: OtpVerify,
  ): Promise<SignInMethods> {
    return this.auth.verifyPhoneLink(user.userId, body);
  }
}
