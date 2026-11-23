import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { readClientContext, type ClientContext } from './client-context.ts';

/** `route(@ClientCtx() ctx: ClientContext)`: the phone, connection and device token behind this request. */
export const ClientCtx = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ClientContext =>
    readClientContext(context.switchToHttp().getRequest<Request>()),
);
