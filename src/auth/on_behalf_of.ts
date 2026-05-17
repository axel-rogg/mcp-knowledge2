// AS-3 K7: On-Behalf-Of verifier.
//
// Spec: PLAN-as3-autonomous.md §1.1 (on_behalf_of.ts) + §2.2.
//
// approval2 forwards Claude.ai calls to KC2 with two headers set:
//   * Authorization: Bearer <SERVICE_TOKEN>          (shared secret, two-factor)
//   * X-On-Behalf-Of:  <signed-JWT>                  (subject + approval_id)
//
// The OBO-JWT is signed by approval2's facade signing-key (MCP_APPROVAL_JWKS_URL).
// Required claims:
//   iss          = MCP_APPROVAL_ISSUER (env, default 'mcp-approval2')
//   aud          = 'mcp-knowledge2'
//   sub          = approval2-internal-users.id
//   on_behalf_of = email-or-google-sub of the human user (we use email)
//   exp          short — 120s window
//   approval_id  (optional for reads, required for writes per K-D4)
//   request_id   for correlation
//
// Verification flow:
//   1. constant-time-compare SERVICE_TOKEN
//   2. jose-verify OBO-JWT against MCP_APPROVAL_JWKS_URL with strict claims
//   3. Resolve `on_behalf_of` → users.id via resolveByEmail (K6)
//   4. Build a RequestContext with authMode='on_behalf_of', viaProxy=true,
//      approvalId set when present

import { timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { MiddlewareHandler } from 'hono';
import { loadEnv } from '../types/env.ts';
import { errBadRequest, errForbidden, errUnauthorized } from '../lib/errors.ts';
import { logger } from '../lib/logger.ts';
import { resolveByEmail, resolveByGoogleSub } from '../users/api.ts';
import type { AuthMode, RequestContext } from '../types/domain.ts';
import { isUuid, uuidV4 } from '../lib/ids.ts';
import { withAdminTx } from '../db/client.ts';
import { oboJtiSeen } from '../db/schema.ts';

const ALLOWED_JWT_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'EdDSA'] as const;

interface OboPayload extends JWTPayload {
  on_behalf_of?: string;
  approval_id?: string;
  request_id?: string;
}

let cachedApprovalJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedApprovalJwksUrl: string | null = null;
function approvalJwks() {
  const env = loadEnv();
  if (!env.MCP_APPROVAL_JWKS_URL) {
    throw errUnauthorized('OBO mode disabled (MCP_APPROVAL_JWKS_URL not set)');
  }
  if (!cachedApprovalJwks || cachedApprovalJwksUrl !== env.MCP_APPROVAL_JWKS_URL) {
    cachedApprovalJwks = createRemoteJWKSet(new URL(env.MCP_APPROVAL_JWKS_URL), {
      cacheMaxAge: env.JWKS_CACHE_TTL_SECONDS * 1000,
      cooldownDuration: 30_000,
    });
    cachedApprovalJwksUrl = env.MCP_APPROVAL_JWKS_URL;
  }
  return cachedApprovalJwks;
}
export function resetOboJwksCacheForTest(): void {
  cachedApprovalJwks = null;
  cachedApprovalJwksUrl = null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) {
    timingSafeEqual(A, Buffer.alloc(A.length, 0));
    return false;
  }
  return timingSafeEqual(A, B);
}

export interface OboContext extends RequestContext {
  authMode: 'on_behalf_of';
  viaProxy: true;
}

/**
 * Verify the two-factor OBO assertion and produce a RequestContext.
 *
 * Throws AppError on any failure (401/403). On success returns the context
 * with userId resolved to the internal users.id.
 */
export async function verifyOnBehalfOf(args: {
  authHeader: string | undefined;
  oboHeader: string | undefined;
  xRequestId: string | undefined;
}): Promise<OboContext> {
  const env = loadEnv();
  if (!env.MCP_APPROVAL_JWKS_URL) {
    throw errUnauthorized('OBO not configured');
  }

  // 1. SERVICE_TOKEN constant-time
  const presented = args.authHeader?.toLowerCase().startsWith('bearer ')
    ? args.authHeader.slice(7).trim()
    : '';
  if (!presented) throw errUnauthorized('OBO requires bearer service token');
  if (!constantTimeEqual(presented, env.SERVICE_TOKEN)) {
    throw errForbidden('invalid service token');
  }

  // 2. X-On-Behalf-Of JWT
  if (!args.oboHeader) throw errBadRequest('missing X-On-Behalf-Of header');
  let payload: OboPayload;
  try {
    const { payload: verified } = await jwtVerify(args.oboHeader, approvalJwks(), {
      issuer: env.MCP_APPROVAL_ISSUER,
      audience: 'mcp-knowledge2',
      algorithms: [...ALLOWED_JWT_ALGORITHMS],
      // Spec calls for short tokens (120s). jose enforces exp/nbf with a small clock skew default.
    });
    payload = verified as OboPayload;
  } catch (e) {
    logger.warn({ err: { name: (e as Error).name, msg: (e as Error).message } }, 'OBO jwt verify failed');
    throw errUnauthorized('OBO jwt verification failed');
  }

  const subject = typeof payload.on_behalf_of === 'string' ? payload.on_behalf_of : '';
  if (!subject) throw errUnauthorized('OBO jwt missing on_behalf_of');

  // Resolve subject. If it looks like an email, use resolveByEmail. Otherwise
  // assume google_sub.
  const user = subject.includes('@') ? await resolveByEmail(subject) : await resolveByGoogleSub(subject);
  if (!user) throw errForbidden('OBO subject not provisioned');
  if (user.status !== 'active') throw errForbidden(`OBO subject is ${user.status}`);

  // SEC-K-001: cross-check payload.sub (approval2-User-ID) gegen resolved-
  // user.externalId. Verhindert dass approval2 (oder ein Compromised
  // signing-key holder) beliebige User via on_behalf_of impersonisiert —
  // payload.sub MUSS zur resolved-user-row matchen.
  //
  // Migration-Phase: external_id ist optional. Wenn NULL (Bootstrap-Admin
  // pre-sync), skip-check + log warning. Sobald SEC-K-006-Backfill drueber
  // gelaufen ist, ist external_id populated und der Check greift hart.
  const payloadSub = typeof payload.sub === 'string' ? payload.sub : null;
  if (user.externalId !== null) {
    if (payloadSub === null || payloadSub !== user.externalId) {
      logger.warn(
        {
          kcUserId: user.id,
          userExternalId: user.externalId,
          oboSub: payloadSub,
          onBehalfOf: subject,
        },
        'OBO sub-externalId mismatch — refusing',
      );
      throw errForbidden('OBO sub does not match resolved user (SEC-K-001)');
    }
  } else {
    logger.warn(
      { kcUserId: user.id, email: user.email, oboSub: payloadSub },
      'OBO sub-check skipped — user.external_id NULL (Migration-Phase)',
    );
  }

  // approval_id is optional at this layer (K-D4). The write/read gate is
  // enforced in K8 by inspecting the resolved tool's annotations.
  let approvalId: string | undefined;
  if (typeof payload.approval_id === 'string') {
    if (!isUuid(payload.approval_id)) throw errBadRequest('approval_id must be a UUID');
    approvalId = payload.approval_id;
  }

  // SEC-K-010: jti-Replay-Protection. payload.jti wird von approval2's
  // signOBO mit randomUuid() gesetzt. Wir tracken pro JTI dass es schon
  // gesehen wurde via INSERT-ON-CONFLICT. PK-Conflict = Replay → 401.
  // exp_at = payload.exp (Token-Expiry) + 60s grace fuer Sweep-Cron.
  const jti = typeof payload.jti === 'string' ? payload.jti : null;
  const exp = typeof payload.exp === 'number' ? payload.exp : null;
  if (jti && exp) {
    const insertResult = await withAdminTx(async (db) => {
      return db
        .insert(oboJtiSeen)
        .values({
          jti,
          userId: user.id,
          seenAt: Math.floor(Date.now() / 1000),
          expAt: exp + 60,
        })
        .onConflictDoNothing({ target: oboJtiSeen.jti })
        .returning({ jti: oboJtiSeen.jti });
    });
    if (insertResult.length === 0) {
      logger.warn(
        { kcUserId: user.id, jti, oboSub: payloadSub },
        'OBO jti replay detected — refusing',
      );
      throw errUnauthorized('OBO jti replay detected (SEC-K-010)');
    }
  } else {
    // Tokens ohne jti/exp wären protokollfremd; approval2 setzt beide
    // verpflichtend. Log + accept fuer Backward-Compat.
    logger.warn(
      { hasJti: !!jti, hasExp: !!exp },
      'OBO missing jti or exp — replay-check skipped (legacy approval2?)',
    );
  }

  const requestId =
    typeof payload.request_id === 'string' && isUuid(payload.request_id)
      ? payload.request_id
      : args.xRequestId && isUuid(args.xRequestId)
      ? args.xRequestId
      : uuidV4();

  const ctx: OboContext = {
    userId: user.id,
    requestId,
    authMode: 'on_behalf_of' satisfies AuthMode,
    scopes: typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : [],
    viaProxy: true,
    ...(approvalId ? { approvalId } : {}),
  };
  return ctx;
}

/**
 * Middleware that ONLY accepts OBO; useful for kc-proxy routes that must
 * never accept user JWTs. /v1/* uses the combined middleware (K8) instead.
 */
export const requireOnBehalfOf: MiddlewareHandler = async (c, next) => {
  const ctx = await verifyOnBehalfOf({
    authHeader: c.req.header('authorization'),
    oboHeader: c.req.header('x-on-behalf-of'),
    xRequestId: c.req.header('x-request-id'),
  });
  c.set('ctx', ctx);
  await next();
};
