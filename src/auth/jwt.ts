// JWT-Validation middleware for /v1/* endpoints.
//
// (AS-3 K5 will rewrite this to a multi-issuer verifier — see the per-Repo
// spec §1.1. For K13's env switch we keep the API but point at the new env
// vars; K5 lands the real Google + self-facade logic.)

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { MiddlewareHandler } from 'hono';
import { loadEnv } from '../types/env.ts';
import { errUnauthorized } from '../lib/errors.ts';
import { logger } from '../lib/logger.ts';
import type { AuthMode, RequestContext } from '../types/domain.ts';
import { uuidV4 } from '../lib/ids.ts';

// F-14: explicit signature-algorithm whitelist. Without this, jose accepts
// whatever the JWKS-set advertises — including weaker algorithms like
// HS256 if a JWKS leak ever included a symmetric key entry by mistake.
const ALLOWED_JWT_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'EdDSA'] as const;

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedJwksUrl: string | null = null;

function jwks() {
  const env = loadEnv();
  // Placeholder: until K5 lands, point at Google's JWKS so the env loads.
  // The real multi-issuer logic comes in K5.
  if (!cachedJwks || cachedJwksUrl !== env.GOOGLE_JWKS_URL) {
    cachedJwks = createRemoteJWKSet(new URL(env.GOOGLE_JWKS_URL), {
      cacheMaxAge: env.JWKS_CACHE_TTL_SECONDS * 1000,
      cooldownDuration: 30_000,
    });
    cachedJwksUrl = env.GOOGLE_JWKS_URL;
  }
  return cachedJwks;
}

export interface JwtClaims extends JWTPayload {
  sub: string;
  scope?: string;
  request_id?: string;
}

export async function verifyServiceJwt(token: string): Promise<JwtClaims> {
  const env = loadEnv();
  try {
    const { payload } = await jwtVerify(token, jwks(), {
      issuer: env.SELF_OAUTH_ISSUER,
      audience: 'mcp-knowledge2',
      algorithms: [...ALLOWED_JWT_ALGORITHMS],
    });
    if (!payload.sub) {
      throw errUnauthorized('jwt missing sub claim');
    }
    return payload as JwtClaims;
  } catch (e) {
    logger.warn({ err: { name: (e as Error).name, msg: (e as Error).message } }, 'jwt verify failed');
    throw errUnauthorized('jwt verification failed');
  }
}

/**
 * Build the per-request RequestContext from a verified JWT.
 */
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
