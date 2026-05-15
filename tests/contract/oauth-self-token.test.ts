// Cross-service contract test (T3-4): KC2's self-issued OAuth tokens.
//
// Validates the wire-shape and verification of tokens minted by KC2's
// OAuth-facade (`/oauth/token`) — the path Claude.ai uses to talk to KC2
// directly without approval2 in the middle.
//
// Specs:
//   - mcp-knowledge2/docs/plans/active/PLAN-as3-autonomous.md §1.1 (token shape)
//   - mcp-knowledge2/src/auth/oauth_facade/token.ts (canonical producer)
//   - mcp-knowledge2/src/auth/jwt.ts (canonical consumer / verifyServiceJwt)
//
// Token contract per PLAN-as3-autonomous.md §1.1:
//   {
//     iss: SELF_OAUTH_ISSUER,
//     aud: 'mcp-knowledge2',
//     sub: '<users.id>',
//     idp: 'google',
//     idp_sub: '<google-sub>',
//     scope: 'objects:read objects:write ...',
//     request_id: '<uuid>',
//     exp: now + 3600,
//   }
//
// This file does not boot a full DB-backed OAuth-flow; that's covered in
// tests/integration/oauth-flow.test.ts (gated on docker-compose). Here we
// verify the verifier accepts/rejects the canonical wire-shape using
// signing_keys-stub backed by an in-process JWKS.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

// Stub the signing_keys store so verifyServiceJwt() can find the test JWKS
// without DB. We do this before importing src/auth/jwt.ts so the module
// captures our mock.
type StubJwk = Record<string, unknown>;
const stubKeys: { keys: StubJwk[] } = { keys: [] };
vi.mock('../../src/auth/signing_keys.ts', () => ({
  listPublishedJwks: vi.fn(async () => stubKeys.keys.map((publicJwk) => ({
    kid: String(publicJwk['kid']),
    alg: String(publicJwk['alg']),
    publicJwk,
    active: true,
  }))),
  getActiveSigningKey: vi.fn(),
  SIGNING_ALG: 'EdDSA',
}));
// Stub users.resolveByGoogleSub so we don't need a DB for the Google-token path.
vi.mock('../../src/users/api.ts', () => ({
  resolveByEmail: vi.fn(async () => null),
  resolveByGoogleSub: vi.fn(async () => null),
}));

import { resetEnvCacheForTest } from '../../src/types/env.ts';
import { resetJwksCachesForTest, verifyServiceJwt } from '../../src/auth/jwt.ts';

// ─── Test fixtures ────────────────────────────────────────────────────────

const SELF_ISSUER = 'https://knowledge.test';
const KC2_AUDIENCE = 'mcp-knowledge2';

let signingKey: { privateKey: CryptoKey; publicJwk: Record<string, unknown>; kid: string };

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const jwk = (await exportJWK(publicKey)) as unknown as Record<string, unknown>;
  jwk['kid'] = 'kc2-test-key';
  jwk['alg'] = 'EdDSA';
  jwk['use'] = 'sig';
  signingKey = {
    privateKey: privateKey as unknown as CryptoKey,
    publicJwk: jwk,
    kid: 'kc2-test-key',
  };
  stubKeys.keys = [jwk];
});

const ORIGINAL_ENV: Record<string, string | undefined> = {};
function snapshotEnv(...keys: string[]) {
  for (const k of keys) ORIGINAL_ENV[k] = process.env[k];
}
function restoreEnv() {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  snapshotEnv(
    'SELF_OAUTH_ISSUER',
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'GOOGLE_OAUTH_REDIRECT_URI',
    'BACKUP_MASTER_KEY',
    'KMS_MASTER_KEY_B64',
    'KMS_PROVIDER',
    'DATABASE_URL',
    'DATABASE_ADMIN_URL',
    'BLOB_ENDPOINT',
    'BLOB_ACCESS_KEY',
    'BLOB_SECRET_KEY',
    'BLOB_BUCKET',
    'VERTEX_PROJECT',
    'SERVICE_TOKEN',
    'MCP_APPROVAL_JWKS_URL',
  );
  process.env.SELF_OAUTH_ISSUER = SELF_ISSUER;
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'gid';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'gsecret';
  process.env.GOOGLE_OAUTH_REDIRECT_URI = `${SELF_ISSUER}/auth/google/callback`;
  process.env.BACKUP_MASTER_KEY = 'a'.repeat(64);
  process.env.KMS_MASTER_KEY_B64 = Buffer.alloc(32, 7).toString('base64');
  process.env.KMS_PROVIDER = 'hkdf_local';
  process.env.DATABASE_URL = 'postgres://x:y@localhost:5432/test';
  process.env.DATABASE_ADMIN_URL = 'postgres://x:y@localhost:5432/test';
  process.env.BLOB_ENDPOINT = 'http://localhost:9000';
  process.env.BLOB_ACCESS_KEY = 'k';
  process.env.BLOB_SECRET_KEY = 's';
  process.env.BLOB_BUCKET = 'b';
  process.env.VERTEX_PROJECT = 'p';
  process.env.SERVICE_TOKEN = 'a'.repeat(40);
  delete process.env.MCP_APPROVAL_JWKS_URL;
  resetEnvCacheForTest();
  resetJwksCachesForTest();
});

afterEach(() => {
  restoreEnv();
  resetEnvCacheForTest();
  resetJwksCachesForTest();
});

afterAll(() => {
  vi.restoreAllMocks();
});

// Helper: mint a token exactly like src/auth/oauth_facade/token.ts ::
// signAccessToken would.
async function mintAccessToken(args: {
  userId?: string;
  scope?: string | undefined;
  googleSub?: string;
  clientId?: string;
  iss?: string;
  aud?: string;
  ttlSec?: number;
  request_id?: string;
}): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const requestId = args.request_id ?? '11111111-1111-1111-1111-111111111111';
  return new SignJWT({
    scope: args.scope ?? undefined,
    idp: 'google',
    idp_sub: args.googleSub ?? 'google-sub-abc',
    client_id: args.clientId ?? 'kc2_testclient',
    request_id: requestId,
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: signingKey.kid, typ: 'JWT' })
    .setIssuer(args.iss ?? SELF_ISSUER)
    .setAudience(args.aud ?? KC2_AUDIENCE)
    .setSubject(args.userId ?? '22222222-2222-2222-2222-222222222222')
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + (args.ttlSec ?? 3600))
    .setJti(requestId)
    .sign(signingKey.privateKey);
}

// ─── Happy path ───────────────────────────────────────────────────────────

describe('KC2 self-issued OAuth tokens — happy path', () => {
  it('verifies a fresh access token (typical Claude.ai-direct path)', async () => {
    const token = await mintAccessToken({
      userId: '22222222-2222-2222-2222-222222222222',
      scope: 'objects:read objects:write search shares',
      googleSub: 'google-sub-axel',
      request_id: '33333333-3333-3333-3333-333333333333',
    });
    const claims = await verifyServiceJwt(token);
    expect(claims.sub).toBe('22222222-2222-2222-2222-222222222222');
    expect(claims.iss).toBe(SELF_ISSUER);
    expect(claims.aud).toBe(KC2_AUDIENCE);
    expect(claims['scope']).toBe('objects:read objects:write search shares');
    expect(claims['idp']).toBe('google');
    expect(claims['idp_sub']).toBe('google-sub-axel');
    expect(claims['client_id']).toBe('kc2_testclient');
    expect(claims['request_id']).toBe('33333333-3333-3333-3333-333333333333');
  });

  it('issuer matches with and without trailing slash (jwt.ts robust-comparison)', async () => {
    process.env.SELF_OAUTH_ISSUER = `${SELF_ISSUER}/`;
    resetEnvCacheForTest();
    resetJwksCachesForTest();
    const token = await mintAccessToken({ iss: SELF_ISSUER }); // no trailing slash
    const claims = await verifyServiceJwt(token);
    expect(claims.sub).toBeDefined();
  });

  it('accepts a token even when scope is omitted (read-default path)', async () => {
    const token = await mintAccessToken({ scope: undefined });
    const claims = await verifyServiceJwt(token);
    expect(claims['scope']).toBeUndefined();
  });
});

// ─── Failure modes (security-relevant for the autonomous KC2-path) ────────

describe('KC2 self-issued OAuth tokens — failure modes', () => {
  it('rejects an expired token', async () => {
    const token = await mintAccessToken({ ttlSec: 1 });
    await new Promise((r) => setTimeout(r, 1500));
    await expect(verifyServiceJwt(token)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a token with wrong audience', async () => {
    const token = await mintAccessToken({ aud: 'some-other-service' });
    await expect(verifyServiceJwt(token)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a token from an unknown issuer', async () => {
    const token = await mintAccessToken({ iss: 'https://evil.example' });
    await expect(verifyServiceJwt(token)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a token signed by an unknown key', async () => {
    // Mint with a fresh keypair (not in stubKeys.keys), confirms JWKS-lookup
    // failure path.
    const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'EdDSA', kid: 'unknown-key', typ: 'JWT' })
      .setIssuer(SELF_ISSUER)
      .setAudience(KC2_AUDIENCE)
      .setSubject('user-x')
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 60)
      .sign(privateKey as unknown as CryptoKey);
    await expect(verifyServiceJwt(token)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a token using a forbidden algorithm', async () => {
    // HS256 is symmetric and disallowed by ALLOWED_JWT_ALGORITHMS. Compose
    // the JWT by hand (jose's SignJWT requires a matching key type for HS256).
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: SELF_ISSUER,
        aud: KC2_AUDIENCE,
        sub: 'u',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 60,
      }),
    ).toString('base64url');
    const token = `${header}.${payload}.bogus`;
    await expect(verifyServiceJwt(token)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a token with sub claim missing (verifier requires it)', async () => {
    // Sign without a subject claim.
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'EdDSA', kid: signingKey.kid, typ: 'JWT' })
      .setIssuer(SELF_ISSUER)
      .setAudience(KC2_AUDIENCE)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 60)
      .sign(signingKey.privateKey);
    await expect(verifyServiceJwt(token)).rejects.toMatchObject({ status: 401 });
  });
});

// ─── Token shape introspection (what an MCP-client would inspect) ─────────

describe('KC2 self-issued OAuth tokens — claim shape pinned per §1.1', () => {
  it('always includes idp + idp_sub for Google-rooted tokens', async () => {
    const token = await mintAccessToken({ googleSub: 'google-sub-x' });
    const claims = await verifyServiceJwt(token);
    expect(claims['idp']).toBe('google');
    expect(claims['idp_sub']).toBe('google-sub-x');
  });

  it('always includes client_id and request_id for audit correlation', async () => {
    const token = await mintAccessToken({ clientId: 'kc2_app123' });
    const claims = await verifyServiceJwt(token);
    expect(claims['client_id']).toBe('kc2_app123');
    expect(claims['request_id']).toMatch(/^[0-9a-fA-F-]{36}$/);
  });

  it('exp - iat default is 3600s (production ACCESS_TOKEN_TTL_SECONDS)', async () => {
    const token = await mintAccessToken({}); // default ttl
    const claims = await verifyServiceJwt(token);
    expect((claims['exp'] as number) - (claims['iat'] as number)).toBe(3600);
  });
});
