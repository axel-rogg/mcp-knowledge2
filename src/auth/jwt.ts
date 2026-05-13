// JWT-Validation middleware for /v1/* endpoints.
//
// Validates JWT signed by mcp-approval2 against its JWKS endpoint.
// Cached JWKS (24h) with refresh-on-miss via jose.

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { MiddlewareHandler } from 'hono';
import { loadEnv } from '../types/env.ts';
import { errUnauthorized } from '../lib/errors.ts';
import type { AuthMode, RequestContext } from '../types/domain.ts';
import { uuidV4 } from '../lib/ids.ts';

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedJwksUrl: string | null = null;

function jwks() {
  const env = loadEnv();
  if (!cachedJwks || cachedJwksUrl !== env.JWKS_URL) {
    cachedJwks = createRemoteJWKSet(new URL(env.JWKS_URL), {
      cacheMaxAge: env.JWKS_CACHE_TTL_SECONDS * 1000,
      cooldownDuration: 30_000,
    });
    cachedJwksUrl = env.JWKS_URL;
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
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });
    if (!payload.sub) {
      throw errUnauthorized('jwt missing sub claim');
    }
    return payload as JwtClaims;
  } catch (e) {
    throw errUnauthorized(`jwt verification failed: ${(e as Error).message}`);
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
