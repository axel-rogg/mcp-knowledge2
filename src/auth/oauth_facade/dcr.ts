// AS-3 K3: Dynamic Client Registration (RFC 7591).
//
// Spec: PLAN-as3-autonomous.md §1.1 + RFC 7591.
//
// Single endpoint: POST /oauth/register. No pre-approval; pilot keeps it
// open and relies on `Authorization: Bearer <SERVICE_TOKEN>` upstream only
// if operators wish — RFC 7591 allows open registration. The client_id
// + secret returned here is what Claude.ai stores per server.

import { Hono } from 'hono';
import { z } from 'zod';
import { registerClient } from './storage.ts';
import { errBadRequest } from '../../lib/errors.ts';

export const dcrRouter = new Hono();

const RegisterReq = z.object({
  redirect_uris: z.array(z.string().url()).min(1).max(8),
  client_name: z.string().max(256).optional(),
  grant_types: z.array(z.string().max(64)).max(8).optional(),
  response_types: z.array(z.string().max(64)).max(8).optional(),
  token_endpoint_auth_method: z.enum(['none', 'client_secret_basic', 'client_secret_post']).optional(),
  scope: z.string().max(512).optional(),
});

dcrRouter.post('/oauth/register', async (c) => {
  const raw = await c.req.json().catch(() => null);
  if (!raw || typeof raw !== 'object') throw errBadRequest('expected JSON body');
  const parsed = RegisterReq.safeParse(raw);
  if (!parsed.success) {
    throw errBadRequest('invalid registration request', {
      errors: parsed.error.errors,
    });
  }
  const client = await registerClient({
    redirectUris: parsed.data.redirect_uris,
    clientName: parsed.data.client_name,
    grantTypes: parsed.data.grant_types,
    responseTypes: parsed.data.response_types,
    tokenEndpointAuthMethod: parsed.data.token_endpoint_auth_method,
    scope: parsed.data.scope,
  });
  return c.json(
    {
      client_id: client.clientId,
      client_secret: client.clientSecret ?? undefined,
      client_name: client.clientName ?? undefined,
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      response_types: client.responseTypes,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      scope: client.scope,
      client_id_issued_at: Math.floor(client.createdAt / 1000),
    },
    201,
  );
});
