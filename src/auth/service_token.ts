// Service-Account-Bearer for /v1/internal/* routes.
// Caller is mcp-approval2 acting as a service. Token rotates per deploy.

import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { loadEnv } from '../types/env.ts';
import { errBadRequest, errForbidden, errUnauthorized } from '../lib/errors.ts';
import { isUuid, uuidV4 } from '../lib/ids.ts';
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

  // F-9: validate headers that flow into Postgres `SET LOCAL app.current_user`
  // and into the audit_log.request_id (UUID column). Free-form input here
  // wouldn't be a SQL-injection (parametrised), but it would (a) trigger a
  // Postgres cast-error inside the request handler and (b) corrupt
  // audit-log correlation. Better to reject at the door.
  const rawRequestId = c.req.header('x-request-id');
  if (rawRequestId !== undefined && !isUuid(rawRequestId)) {
    throw errBadRequest('x-request-id must be a UUID');
  }
  const rawActing = c.req.header('x-acting-user-id');
  if (rawActing !== undefined && !isUuid(rawActing)) {
    throw errBadRequest('x-acting-user-id must be a UUID');
  }

  // Some internal endpoints also carry an x-acting-user-id acting on behalf
  // of a user. The handler decides whether to use it. We propagate the
  // request id, generating one if absent.
  const requestId = rawRequestId ?? uuidV4();
  const ctx: RequestContext = {
    userId: rawActing ?? null,
    requestId,
    authMode: 'service',
    scopes: [],
  };
  c.set('ctx', ctx);
  await next();
};
