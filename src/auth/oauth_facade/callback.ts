// AS-3 K4: Google OAuth callback. Trades Google's code for an ID-token,
// auto-provisions the user, mints our own auth-code, and redirects the MCP
// client back to its registered redirect_uri.
//
// Spec: PLAN-as3-autonomous.md §1.1, §2.1.

import { Hono } from 'hono';
import { z } from 'zod';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { loadEnv } from '../../types/env.ts';
import { errBadRequest, errForbidden, errUnauthorized } from '../../lib/errors.ts';
import { logger } from '../../lib/logger.ts';
import { decodeAuthorizeState } from './authorize.ts';
import { mintAuthCode } from './storage.ts';
import { provisionFromGoogleLogin } from '../../users/api.ts';
import { resolveOrigin, buildRedirectUri } from '../../lib/origin.ts';

export const callbackRouter = new Hono();

const CallbackQuery = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

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

interface GoogleTokenResponse {
  access_token: string;
  id_token: string;
  expires_in: number;
  token_type: string;
  refresh_token?: string;
  scope?: string;
}

async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<GoogleTokenResponse> {
  const env = loadEnv();
  // CRITICAL: redirect_uri must EXACTLY match the value sent at /oauth/authorize.
  // Google rejects with `redirect_uri_mismatch` otherwise. The caller derives
  // it from the request-origin (= the URL Google actually called) via
  // resolveOrigin() — guarantees parity with authorize.ts.
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '<unreadable>');
    logger.warn({ status: r.status, body }, 'google token exchange failed');
    throw errUnauthorized('google token exchange failed');
  }
  return (await r.json()) as GoogleTokenResponse;
}

interface GoogleIdToken {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  hd?: string;
}

async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdToken> {
  const env = loadEnv();
  const { payload } = await jwtVerify(idToken, googleJwks(), {
    issuer: [env.GOOGLE_ISSUER, env.GOOGLE_ISSUER.replace('https://', '')],
    audience: env.GOOGLE_OAUTH_CLIENT_ID,
    algorithms: ['RS256', 'ES256'],
  });
  if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
    throw errUnauthorized('google id_token missing sub/email');
  }
  return payload as unknown as GoogleIdToken;
}

callbackRouter.get('/auth/google/callback', async (c) => {
  const env = loadEnv();
  const parsed = CallbackQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) throw errBadRequest('invalid callback request');
  const q = parsed.data;
  if (q.error) {
    throw errUnauthorized(`google callback error: ${q.error}${q.error_description ? `: ${q.error_description}` : ''}`);
  }
  if (!q.code || !q.state) throw errBadRequest('missing code or state');

  const state = decodeAuthorizeState(q.state);

  // Multi-Origin: redirect_uri muss EXAKT der gleiche sein wie in /authorize.
  // Da Google an genau diese URL hier callbackt, ist `request.origin` der
  // korrekte Wert. resolveOrigin validiert gegen ALLOWED_ORIGINS.
  const callbackRedirectUri = buildRedirectUri(resolveOrigin(c.req.raw, env));

  const tokens = await exchangeCodeForTokens(q.code, callbackRedirectUri);
  const id = await verifyGoogleIdToken(tokens.id_token);

  // K-D1: optional Workspace-domain allowlist.
  if (env.GOOGLE_HD_ALLOWLIST.length > 0 && (!id.hd || !env.GOOGLE_HD_ALLOWLIST.includes(id.hd))) {
    throw errForbidden('google account not in allowed Workspace domain');
  }

  // Email-allowlist enforcement. Empty list = open. Non-empty = strict whitelist:
  // only the listed emails may complete the OAuth callback. Defense-in-depth on
  // top of the OAuth-app's own Test-Users list in Google Cloud Console.
  if (env.ALLOWED_EMAILS.length > 0 && !env.ALLOWED_EMAILS.includes(id.email.toLowerCase())) {
    logger.warn({ email: id.email }, 'login denied: email not in ALLOWED_EMAILS');
    throw errForbidden('email not in allowed users list');
  }

  const user = await provisionFromGoogleLogin({
    sub: id.sub,
    email: id.email,
    emailVerified: id.email_verified ?? false,
    displayName: id.name ?? null,
  });

  // Mint our own auth-code bound to this user + the original PKCE-challenge.
  const code = await mintAuthCode({
    clientId: state.clientId,
    userId: user.id,
    redirectUri: state.redirectUri,
    scope: state.scope ?? undefined,
    codeChallenge: state.codeChallenge,
    codeChallengeMethod: state.codeChallengeMethod,
    googleIdTokenSub: id.sub,
  });

  // Redirect back to the MCP client.
  const out = new URL(state.redirectUri);
  out.searchParams.set('code', code);
  if (state.clientState) out.searchParams.set('state', state.clientState);
  return c.redirect(out.toString(), 302);
});
