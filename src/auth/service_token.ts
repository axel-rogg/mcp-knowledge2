// Service-Account-Bearer for /v1/internal/* routes.
// Caller is mcp-approval2 acting as a service. Token rotates per deploy.
//
// SEC-K-009 (2026-05-17): Service-Token-Split per Scope. Frueher war
// SERVICE_TOKEN admin-equivalent fuer alle /v1/internal/*-Routes — ein Leak
// gab vollen Zugriff inkl. erase-user. Jetzt prueft `requireServiceToken(scope)`
// erst gegen das scope-spezifische Secret (SERVICE_TOKEN_ERASE/SYNC/OPS) und
// faellt nur dann auf legacy SERVICE_TOKEN zurueck wenn das scope-Secret
// nicht gesetzt ist. Sobald approval2 die scope-Tokens nutzt + Operator das
// legacy SERVICE_TOKEN unsetzt, ist die admin-equivalence weg.

import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { loadEnv } from '../types/env.ts';
import { errBadRequest, errForbidden, errUnauthorized } from '../lib/errors.ts';
import { isUuid, uuidV4 } from '../lib/ids.ts';
import { logger } from '../lib/logger.ts';
import type { RequestContext } from '../types/domain.ts';

export type ServiceTokenScope = 'erase' | 'sync' | 'ops';

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

function resolveScopedSecret(scope: ServiceTokenScope): string | undefined {
  const env = loadEnv();
  switch (scope) {
    case 'erase':
      return env.SERVICE_TOKEN_ERASE;
    case 'sync':
      return env.SERVICE_TOKEN_SYNC;
    case 'ops':
      return env.SERVICE_TOKEN_OPS;
  }
}

export function requireServiceToken(scope: ServiceTokenScope): MiddlewareHandler {
  return async (c, next) => {
    const env = loadEnv();
    // Internal routes accept the service token as 'authorization: Bearer ...'
    const auth = c.req.header('authorization') ?? '';
    const presented = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    if (!presented) throw errUnauthorized('missing service token');

    // Try scope-specific secret first. If unset, fall back to legacy
    // SERVICE_TOKEN (kept for migration window; warn so operator notices).
    const scoped = resolveScopedSecret(scope);
    let ok = false;
    if (scoped && scoped.length > 0) {
      ok = constantTimeEqual(presented, scoped);
    } else {
      logger.warn(
        { scope },
        'service_token: scope-specific secret not set, falling back to legacy SERVICE_TOKEN — set SERVICE_TOKEN_<scope> to revoke admin-equivalence',
      );
      ok = constantTimeEqual(presented, env.SERVICE_TOKEN);
    }
    if (!ok) {
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
      scopes: [scope],
    };
    c.set('ctx', ctx);
    await next();
  };
}
