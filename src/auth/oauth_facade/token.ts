// AS-3 K4: /oauth/token — issues access + refresh tokens.
//
// Spec: PLAN-as3-autonomous.md §1.1 (token format) + §2.1.
//
// Two grant_types supported:
//   * authorization_code — exchanges code (with PKCE verifier) for tokens
//   * refresh_token       — single-use rotation (K-D2)

import { Hono } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { SignJWT } from 'jose';
import {
  consumeAuthCode,
  getClient,
  mintRefreshToken,
  rotateRefreshToken,
  touchClientLastUsed,
} from './storage.ts';
import { getActiveSigningKey } from '../signing_keys.ts';
import { loadEnv } from '../../types/env.ts';
import { errBadRequest, errUnauthorized } from '../../lib/errors.ts';
import { logger } from '../../lib/logger.ts';
import { uuidV4 } from '../../lib/ids.ts';

export const tokenRouter = new Hono();

const ACCESS_TOKEN_TTL_SECONDS = 3600; // 1h

const CodeGrant = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string().min(1),
  redirect_uri: z.string().url(),
  client_id: z.string().min(1),
  code_verifier: z.string().min(43).max(128),
  client_secret: z.string().optional(),
});

const RefreshGrant = z.object({
  grant_type: z.literal('refresh_token'),
  refresh_token: z.string().min(1),
  client_id: z.string().min(1),
  client_secret: z.string().optional(),
});

const TokenBody = z.discriminatedUnion('grant_type', [CodeGrant, RefreshGrant]);

function b64urlSha256(input: string): string {
  return createHash('sha256').update(input).digest().toString('base64url');
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

async function authenticateClient(clientId: string, clientSecret: string | undefined) {
  const client = await getClient(clientId);
  if (!client) throw errUnauthorized('unknown client_id');
  if (client.tokenEndpointAuthMethod === 'none') return client;
  if (!clientSecret) throw errUnauthorized('client_secret required');
  if (!client.clientSecret) throw errUnauthorized('client has no secret configured');
  if (!constantTimeEqual(clientSecret, client.clientSecret)) {
    throw errUnauthorized('invalid client_secret');
  }
  return client;
}

async function signAccessToken(args: {
  userId: string;
  clientId: string;
  scope: string | null;
  googleSub: string;
}) {
  const env = loadEnv();
  const key = await getActiveSigningKey();
  const iss = env.SELF_OAUTH_ISSUER.replace(/\/$/, '');
  const nowSec = Math.floor(Date.now() / 1000);
  const requestId = uuidV4();
  const token = await new SignJWT({
    scope: args.scope ?? undefined,
    idp: 'google',
    idp_sub: args.googleSub,
    client_id: args.clientId,
    request_id: requestId,
  })
    .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: 'JWT' })
    .setIssuer(iss)
    .setAudience('mcp-knowledge2')
    .setSubject(args.userId)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + ACCESS_TOKEN_TTL_SECONDS)
    .setJti(requestId)
    .sign(key.privateKey);
  return { token, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

tokenRouter.post('/oauth/token', async (c) => {
  let formRaw: Record<string, string>;
  const ct = c.req.header('content-type') ?? '';
  if (ct.includes('application/x-www-form-urlencoded')) {
    const body = await c.req.text();
    formRaw = Object.fromEntries(new URLSearchParams(body));
  } else if (ct.includes('application/json')) {
    formRaw = (await c.req.json()) as Record<string, string>;
  } else {
    throw errBadRequest('content-type must be application/x-www-form-urlencoded or application/json');
  }

  // basic-auth alternative
  const authHeader = c.req.header('authorization');
  if (authHeader?.toLowerCase().startsWith('basic ')) {
    const decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon > 0) {
      formRaw.client_id ??= decoded.slice(0, colon);
      formRaw.client_secret ??= decoded.slice(colon + 1);
    }
  }

  const parsed = TokenBody.safeParse(formRaw);
  if (!parsed.success) {
    logger.warn({ errors: parsed.error.errors }, 'invalid token request');
    throw errBadRequest('invalid token request', { errors: parsed.error.errors });
  }
  const body = parsed.data;

  if (body.grant_type === 'authorization_code') {
    const client = await authenticateClient(body.client_id, body.client_secret);
    const code = await consumeAuthCode(body.code);
    if (code.clientId !== client.clientId) throw errUnauthorized('code/client mismatch');
    if (code.redirectUri !== body.redirect_uri) throw errUnauthorized('redirect_uri mismatch');
    // PKCE: code_challenge must equal SHA-256(code_verifier) (S256)
    const challenge = b64urlSha256(body.code_verifier);
    if (!constantTimeEqual(challenge, code.codeChallenge)) {
      throw errUnauthorized('PKCE code_verifier mismatch');
    }
    await touchClientLastUsed(client.clientId);
    const { token, expiresIn } = await signAccessToken({
      userId: code.userId,
      clientId: client.clientId,
      scope: code.scope,
      googleSub: code.googleIdTokenSub,
    });
    const refresh = await mintRefreshToken({
      clientId: client.clientId,
      userId: code.userId,
      scope: code.scope,
      googleIdTokenSub: code.googleIdTokenSub,
    });
    return c.json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: refresh,
      scope: code.scope ?? undefined,
    });
  }

  // refresh_token grant
  const client = await authenticateClient(body.client_id, body.client_secret);
  const rotated = await rotateRefreshToken(body.refresh_token);
  if (rotated.context.clientId !== client.clientId) throw errUnauthorized('refresh/client mismatch');
  await touchClientLastUsed(client.clientId);
  const { token, expiresIn } = await signAccessToken({
    userId: rotated.context.userId,
    clientId: client.clientId,
    scope: rotated.context.scope,
    googleSub: rotated.context.googleIdTokenSub,
  });
  return c.json({
    access_token: token,
    token_type: 'Bearer',
    expires_in: expiresIn,
    refresh_token: rotated.newToken,
    scope: rotated.context.scope ?? undefined,
  });
});
