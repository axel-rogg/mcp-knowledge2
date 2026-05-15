// AS-3 K3: OAuth-2.0 metadata + JWKS endpoints.
//
// Spec: RFC 8414 (Authorization Server Metadata) + PLAN-as3-autonomous.md §1.1.
//
// Routes:
//   GET /.well-known/oauth-authorization-server
//   GET /.well-known/jwks.json

import { Hono } from 'hono';
import { listPublishedJwks } from '../signing_keys.ts';
import { loadEnv } from '../../types/env.ts';

export const discoveryRouter = new Hono();

discoveryRouter.get('/.well-known/oauth-authorization-server', (c) => {
  const env = loadEnv();
  const issuer = env.SELF_OAUTH_ISSUER.replace(/\/$/, '');
  return c.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['objects:read', 'objects:write', 'search', 'shares', 'uploads'],
    id_token_signing_alg_values_supported: ['EdDSA'],
    service_documentation: 'https://github.com/axel-rogg/mcp-knowledge2',
  });
});

discoveryRouter.get('/.well-known/jwks.json', async (c) => {
  const keys = await listPublishedJwks();
  return c.json({
    keys: keys.map((k) => k.publicJwk),
  });
});
