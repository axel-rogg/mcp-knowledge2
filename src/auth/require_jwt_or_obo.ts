// AS-3 K8: Combined JWT-or-OBO middleware for /v1/* routes.
//
// Spec: PLAN-as3-autonomous.md §1.5.
//
// Dispatch rule:
//   if X-On-Behalf-Of header is present → OBO path (K7 verifier)
//   else                                → user-JWT path (K5 verifier)
//
// The OBO path additionally enforces K-D4: for write operations the
// `approval_id` claim is REQUIRED. Reads may omit it.
//
// A write is detected by the HTTP method (anything that isn't GET/HEAD)
// — this is conservative; the K11 tool layer carries `annotations.write`
// on the MCP side, but the REST side has no such metadata so we treat
// non-safe methods as writes.

import type { MiddlewareHandler } from 'hono';
import { verifyServiceJwt, contextFromJwt } from './jwt.ts';
import { verifyOnBehalfOf } from './on_behalf_of.ts';
import { errBadRequest, errUnauthorized } from '../lib/errors.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const requireJwtOrOnBehalfOf: MiddlewareHandler = async (c, next) => {
  const oboHeader = c.req.header('x-on-behalf-of');
  if (oboHeader) {
    const ctx = await verifyOnBehalfOf({
      authHeader: c.req.header('authorization'),
      oboHeader,
      xRequestId: c.req.header('x-request-id'),
    });
    // K-D4: writes require approval_id.
    if (!SAFE_METHODS.has(c.req.method.toUpperCase()) && !ctx.approvalId) {
      throw errBadRequest('OBO writes require approval_id claim');
    }
    c.set('ctx', ctx);
    await next();
    return;
  }

  const auth = c.req.header('authorization') ?? '';
  if (!auth.toLowerCase().startsWith('bearer ')) {
    throw errUnauthorized('missing bearer token');
  }
  const token = auth.slice(7).trim();
  const claims = await verifyServiceJwt(token);
  c.set('ctx', contextFromJwt(claims));
  await next();
};
