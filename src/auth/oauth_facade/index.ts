// AS-3 K3/K4: OAuth-facade root router.
//
// Composes the per-endpoint routers (discovery, DCR, authorize, callback, token).
//
// Rate-limits are applied per public auth-route as defense-in-depth on top
// of the CF-managed WAF rules (terraform-side). Each limiter is a fresh
// closure → routes don't share counters.

import { Hono } from 'hono';
import { discoveryRouter } from './discovery.ts';
import { dcrRouter } from './dcr.ts';
import { authorizeRouter } from './authorize.ts';
import { callbackRouter } from './callback.ts';
import { tokenRouter } from './token.ts';
import { rateLimit } from '../../middleware/rate_limit.ts';

export const oauthFacadeRouter = new Hono();
oauthFacadeRouter.route('/', discoveryRouter);

// DCR (RFC 7591) is intentionally open per spec — anyone can register an
// MCP client. Rate-limit at 10 reg/min per IP to prevent DB-bloat from
// spam-bots; legit MCP clients register once and reuse the client_id.
oauthFacadeRouter.use(
  '/oauth/register',
  rateLimit({ windowMs: 60_000, max: 10, name: 'oauth.register' }),
);
oauthFacadeRouter.route('/', dcrRouter);

// /oauth/authorize kicks off the Google-redirect. No auth gate (by design).
// Rate-limit at 30/min per IP — legit users authorize a few times per
// session, spam-bots get blocked.
oauthFacadeRouter.use(
  '/oauth/authorize',
  rateLimit({ windowMs: 60_000, max: 30, name: 'oauth.authorize' }),
);
oauthFacadeRouter.route('/', authorizeRouter);

// /auth/google/callback: state-cookie tied, but still public. Same throttle
// as authorize because callbacks 1:1 with authorize-starts.
oauthFacadeRouter.use(
  '/auth/google/callback',
  rateLimit({ windowMs: 60_000, max: 30, name: 'oauth.callback' }),
);
oauthFacadeRouter.route('/', callbackRouter);

// /oauth/token: PKCE-verified, but expensive (DB-lookup + JWT-sign). Limit
// to 60/min — refresh-rotation in a normal session is ~1/hour, this leaves
// plenty of headroom.
oauthFacadeRouter.use(
  '/oauth/token',
  rateLimit({ windowMs: 60_000, max: 60, name: 'oauth.token' }),
);
oauthFacadeRouter.route('/', tokenRouter);
