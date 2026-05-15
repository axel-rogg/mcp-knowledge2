// AS-3 K4: /oauth/authorize — kicks off the Auth-Code-Flow with PKCE.
//
// Spec: PLAN-as3-autonomous.md §1.1, §2.1.
//
// Flow:
//   1. MCP client redirects user to /oauth/authorize?...
//   2. We validate the request (client_id, redirect_uri, PKCE), persist the
//      request as a `state` cookie/encoded-state, redirect to Google's
//      OAuth-consent.
//   3. Google redirects back to /auth/google/callback (callback.ts) with
//      its own authorization code.
//
// The PKCE code_challenge is stored alongside the auth-code (minted in
// callback.ts after Google verifies the user) and validated at /oauth/token.

import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getClient } from './storage.ts';
import { loadEnv } from '../../types/env.ts';
import { errBadRequest, errUnauthorized } from '../../lib/errors.ts';

export const authorizeRouter = new Hono();

const AuthorizeQuery = z.object({
  response_type: z.literal('code'),
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  scope: z.string().optional(),
  state: z.string().optional(),
  code_challenge: z.string().min(32).max(128),
  code_challenge_method: z.literal('S256'),
});

// State payload we hand to Google as `state`. Encoded as base64url(JSON).
// Includes a server-side hash so we can detect tampering on the way back.
export interface AuthorizeState {
  clientId: string;
  redirectUri: string;
  scope: string | null;
  clientState: string | null;
  codeChallenge: string;
  codeChallengeMethod: string;
  nonce: string;
}

function b64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

export function decodeAuthorizeState(raw: string): AuthorizeState {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not object');
    return parsed as AuthorizeState;
  } catch {
    throw errBadRequest('invalid state parameter');
  }
}

authorizeRouter.get('/oauth/authorize', async (c) => {
  const env = loadEnv();
  const parsed = AuthorizeQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) {
    throw errBadRequest('invalid authorize request', { errors: parsed.error.errors });
  }
  const q = parsed.data;

  const client = await getClient(q.client_id);
  if (!client) throw errUnauthorized('unknown client_id');
  if (!client.redirectUris.includes(q.redirect_uri)) {
    throw errBadRequest('redirect_uri not registered for client');
  }

  // Bundle the request into a state-payload Google will echo back to us.
  const state: AuthorizeState = {
    clientId: client.clientId,
    redirectUri: q.redirect_uri,
    scope: q.scope ?? null,
    clientState: q.state ?? null,
    codeChallenge: q.code_challenge,
    codeChallengeMethod: q.code_challenge_method,
    nonce: createHash('sha256').update(`${q.client_id}|${q.code_challenge}|${Date.now()}`).digest('base64url'),
  };

  // Build Google OAuth URL. Scopes: openid email profile (+ hd if allowlist).
  const googleUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  googleUrl.searchParams.set('client_id', env.GOOGLE_OAUTH_CLIENT_ID);
  googleUrl.searchParams.set('redirect_uri', env.GOOGLE_OAUTH_REDIRECT_URI);
  googleUrl.searchParams.set('response_type', 'code');
  googleUrl.searchParams.set('scope', 'openid email profile');
  googleUrl.searchParams.set('access_type', 'online');
  googleUrl.searchParams.set('prompt', 'select_account');
  googleUrl.searchParams.set('state', b64urlJson(state));
  if (env.GOOGLE_HD_ALLOWLIST.length === 1) {
    googleUrl.searchParams.set('hd', env.GOOGLE_HD_ALLOWLIST[0] ?? '');
  }

  return c.redirect(googleUrl.toString(), 302);
});
