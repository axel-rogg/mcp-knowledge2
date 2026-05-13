// Service-Account-Bearer for /v1/internal/* routes.
// Caller is mcp-approval2 acting as a service. Token rotates per deploy.

import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { loadEnv } from '../types/env.ts';
import { errForbidden, errUnauthorized } from '../lib/errors.ts';
import { uuidV4 } from '../lib/ids.ts';
import type { RequestContext } from '../types/domain.ts';

function constantTimeEqual(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) {
    // Still consume time to avoid leaking length via timing
    timingSafeEqual(A, Buffer.alloc(A.length, 0));
    return false;
  }
  return timingSafeEqual(A, B);
}

export const requireServiceToken: MiddlewareHandler = async (c, next) => {
  const env = loadEnv();
  // Internal routes accept the service token as 'authorization: Bearer ...'
  const auth = c.req.header('authorization') ?? '';
  const presented = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!presented) throw errUnauthorized('missing service token');
  if (!constantTimeEqual(presented, env.SERVICE_TOKEN)) {
    throw errForbidden('invalid service token');
  }

  // Some internal endpoints also carry an x-user-jwt acting on behalf of a user.
  // The handler decides whether to use it. We propagate the request id.
  const requestId = c.req.header('x-request-id') ?? uuidV4();
  const ctx: RequestContext = {
    userId: c.req.header('x-acting-user-id') ?? null,
    requestId,
    authMode: 'service',
    scopes: [],
  };
  c.set('ctx', ctx);
  await next();
};
