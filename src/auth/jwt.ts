// AS-3 K5: Multi-Issuer JWT verifier for /v1/* endpoints.
//
// Spec: PLAN-as3-autonomous.md §1.1.
//
// Accepts tokens from two issuers:
//   1. Google OIDC  (iss=https://accounts.google.com, aud=GOOGLE_OAUTH_CLIENT_ID)
//      — typically not used for /v1/*; clients should go through our facade.
//      Kept for symmetry/testing.
//   2. Self facade  (iss=SELF_OAUTH_ISSUER,           aud='mcp-knowledge2')
//      — the normal MCP-client path. Verified against the in-process JWKS
//      published from `signing_keys` (K1).
//
// Algorithms are pinned asymmetric-only (F-14).

import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { MiddlewareHandler } from 'hono';
import { loadEnv } from '../types/env.ts';
import { errUnauthorized } from '../lib/errors.ts';
import { logger } from '../lib/logger.ts';
import type { AuthMode, RequestContext } from '../types/domain.ts';
import { uuidV4 } from '../lib/ids.ts';
import { listPublishedJwks } from './signing_keys.ts';
import { resolveByGoogleSub } from '../users/api.ts';

const ALLOWED_JWT_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'EdDSA'] as const;

interface DecodedJwtHeader {
  alg?: string;
  kid?: string;
  iss?: string;
}
function peekHeader(token: string): DecodedJwtHeader {
  const dot = token.indexOf('.');
  if (dot < 0) return {};
  try {
    const json = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
    return JSON.parse(json) as DecodedJwtHeader;
  } catch {
    return {};
  }
}
function peekPayload(token: string): JWTPayload | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payloadPart = parts[1];
    if (!payloadPart) return null;
    return JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as JWTPayload;
  } catch {
    return null;
  }
}

export interface JwtClaims extends JWTPayload {
  sub: string;
  scope?: string;
  request_id?: string;
  idp?: string;
  idp_sub?: string;
  client_id?: string;
}

// ─── JWKS resolvers ───────────────────────────────────────────────────────

let cachedGoogleJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function googleJwks() {
  if (cachedGoogleJwks) return cachedGoogleJwks;
  const env = loadEnv();
  cachedGoogleJwks = createRemoteJWKSet(new URL(env.GOOGLE_JWKS_URL), {
    cacheMaxAge: env.JWKS_CACHE_TTL_SECONDS * 1000,
    cooldownDuration: 30_000,
  });
  return cachedGoogleJwks;
}

interface SelfJwksCache {
  resolver: ReturnType<typeof createLocalJWKSet>;
  fetchedAt: number;
}
let cachedSelfJwks: SelfJwksCache | null = null;
const SELF_JWKS_CACHE_MS = 60_000;
async function selfJwks() {
  const now = Date.now();
  if (cachedSelfJwks && now - cachedSelfJwks.fetchedAt < SELF_JWKS_CACHE_MS) {
    return cachedSelfJwks.resolver;
  }
  const keys = await listPublishedJwks();
  // jose's createLocalJWKSet accepts a JWKS-set: { keys: [...] }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resolver = createLocalJWKSet({ keys: keys.map((k) => k.publicJwk) } as any);
  cachedSelfJwks = { resolver, fetchedAt: now };
  return resolver;
}

export function resetJwksCachesForTest(): void {
  cachedGoogleJwks = null;
  cachedSelfJwks = null;
}

// ─── Verifier dispatch ────────────────────────────────────────────────────

export async function verifyServiceJwt(token: string): Promise<JwtClaims> {
  const env = loadEnv();
  const payload = peekPayload(token);
  const issClaim = typeof payload?.iss === 'string' ? payload.iss : '';
  const header = peekHeader(token);
  if (header.alg && !ALLOWED_JWT_ALGORITHMS.includes(header.alg as never)) {
    throw errUnauthorized('jwt algorithm not allowed');
  }

  try {
    if (issClaim === env.SELF_OAUTH_ISSUER.replace(/\/$/, '') || issClaim === env.SELF_OAUTH_ISSUER) {
      const { payload: verified } = await jwtVerify(token, await selfJwks(), {
        issuer: [env.SELF_OAUTH_ISSUER, env.SELF_OAUTH_ISSUER.replace(/\/$/, '')],
        audience: 'mcp-knowledge2',
        algorithms: [...ALLOWED_JWT_ALGORITHMS],
      });
      if (typeof verified.sub !== 'string') throw errUnauthorized('jwt missing sub');
      return verified as JwtClaims;
    }
    if (issClaim === env.GOOGLE_ISSUER || issClaim === 'accounts.google.com') {
      const { payload: verified } = await jwtVerify(token, googleJwks(), {
        issuer: [env.GOOGLE_ISSUER, 'accounts.google.com'],
        audience: env.GOOGLE_OAUTH_CLIENT_ID,
        algorithms: [...ALLOWED_JWT_ALGORITHMS],
      });
      // For Google-issued tokens we need to map the `sub` (Google-sub) to
      // our internal users.id so RLS works. resolveByGoogleSub returns null
      // for un-provisioned users — reject.
      const googleSub = typeof verified.sub === 'string' ? verified.sub : '';
      const user = googleSub ? await resolveByGoogleSub(googleSub) : null;
      if (!user) throw errUnauthorized('google user not provisioned');
      return {
        ...verified,
        sub: user.id,
        idp: 'google',
        idp_sub: googleSub,
      } as JwtClaims;
    }
    throw errUnauthorized(`unsupported jwt issuer ${issClaim || '<none>'}`);
  } catch (e) {
    logger.warn({ err: { name: (e as Error).name, msg: (e as Error).message } }, 'jwt verify failed');
    throw errUnauthorized('jwt verification failed');
  }
}

export function contextFromJwt(claims: JwtClaims): RequestContext {
  return {
    userId: claims.sub,
    requestId: claims.request_id ?? uuidV4(),
    authMode: 'jwt' satisfies AuthMode,
    scopes: claims.scope ? claims.scope.split(/\s+/).filter(Boolean) : [],
  };
}

export const requireJwt: MiddlewareHandler = async (c, next) => {
  const auth = c.req.header('authorization') ?? '';
  if (!auth.toLowerCase().startsWith('bearer ')) {
    throw errUnauthorized('missing bearer token');
  }
  const token = auth.slice(7).trim();
  const claims = await verifyServiceJwt(token);
  const ctx = contextFromJwt(claims);
  c.set('ctx', ctx);
  await next();
};
