import {
  Inject,
  Injectable,
  NotFoundException,
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthError } from '../auth/auth-error.ts';
import { matchAdminToken, type AdminTokens } from './admin-tokens.ts';

export const ADMIN_TOKENS = Symbol('ADMIN_TOKENS');

type AdminRequest = Request & { admin?: string };

/**
 * Admin routes need `Authorization: Bearer <token>` from `ADMIN_TOKENS`. With none configured (or no admin
 * database) the routes do not exist (404): moderation is off, not open. The matching name becomes `req.admin`
 * and is written to the audit log with every action.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(ADMIN_TOKENS) private readonly tokens: AdminTokens | null) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.tokens || this.tokens.size === 0) throw new NotFoundException();
    const req = context.switchToHttp().getRequest<AdminRequest>();
    const name = matchAdminToken(this.tokens, req.headers.authorization);
    if (!name) throw new AuthError('unauthorized');
    req.admin = name;
    return true;
  }
}

/** The moderator's name: `act(@Admin() admin: string)`. */
export const Admin = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const req = context.switchToHttp().getRequest<AdminRequest>();
  if (!req.admin) throw new AuthError('unauthorized');
  return req.admin;
});
