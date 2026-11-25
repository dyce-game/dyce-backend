import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type pg from 'pg';
import { AuthError } from '../auth/auth-error.ts';
import type { AuthContext } from '../auth/auth.guard.ts';
import { PG_POOL } from '../db/db.module.ts';
import { readClientContext } from './client-context.ts';
import { IntegrityGate } from './integrity.gate.ts';
import { isPoolEntry, type PoolEntryKind } from './pool-entry.ts';

const KEY = 'dyce:pool-entry';
export const PoolEntry = (kind: PoolEntryKind) => SetMetadata(KEY, kind);

/**
 * Runs the integrity gate on routes that stake Pool cash, and only when the call really is a Pool one. It runs
 * after `AuthGuard` (which sets `req.auth`) and before the body is validated.
 */
@Injectable()
export class PoolEntryGuard implements CanActivate {
  constructor(
    @Inject(IntegrityGate) private readonly gate: IntegrityGate,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const kind = this.reflector.get<PoolEntryKind | undefined>(KEY, context.getHandler());
    if (!kind) return true;
    const req = context.switchToHttp().getRequest<Request & { auth?: AuthContext }>();
    if (!req.auth) throw new AuthError('unauthorized');
    if (await isPoolEntry(this.pool, kind, req)) {
      await this.gate.poolEntry(req.auth.userId, readClientContext(req));
    }
    return true;
  }
}
