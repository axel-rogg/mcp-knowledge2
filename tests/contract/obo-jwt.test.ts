// Cross-service contract test (T3-1): OBO-JWT wire-format between approval2 and KC2.
//
// This file documents and VALIDATES the OBO-JWT contract by simulating
// approval2's signing pattern (`JwtSigner.signOBO()`) and verifying that KC2's
// `verifyOnBehalfOf()` accepts/rejects it exactly as the spec demands.
//
// Specs:
//   - mcp-approval2/docs/plans/active/PLAN-as3-autonomous.md §2.1 (OBO-JWT format)
//   - mcp-knowledge2/docs/plans/active/PLAN-as3-autonomous.md §1.1 (on_behalf_of)
//
// Wire-shape (signed by approval2, verified by KC2):
//   {
//     iss: 'mcp-approval2',          // MCP_APPROVAL_ISSUER (default)
//     aud: 'mcp-knowledge2',
//     sub: '<approval2 internal users.id>',
//     on_behalf_of: '<email or google-sub>',
//     approval_id?: '<uuid>',
//     request_id?: '<uuid>',
//     jti: '<uuid>',
//     iat, exp                       // 120s default
//   }
//
// Auth-Mode: Two-Factor — Bearer SERVICE_TOKEN + X-On-Behalf-Of (JWT).
//
// approval2's RS256-Signer (in apps/server/src/services/knowledge.ts ::
// makeRs256Signer) is the canonical producer for this token. KC2's verifier
// (src/auth/on_behalf_of.ts :: verifyOnBehalfOf) is the canonical consumer.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, importPKCS8, importSPKI, SignJWT } from 'jose';

// Mock the users-table lookup so verifyOnBehalfOf can resolve the OBO
// `on_behalf_of` subject without a real DB. Hoisted so the mock factory
// runs BEFORE `src/auth/on_behalf_of.ts` imports `users/api.ts`.
vi.mock('../../src/users/api.ts', () => {
  return {
    resolveByEmail: vi.fn(async (email: string) => {
      if (email === 'axel@example.org') {
        return {
          id: 'internal-user-uuid',
          email,
          googleSub: null,
          displayName: null,
          role: 'member',
          status: 'active',
          createdAt: 0,
          lastSeenAt: null,
          invitedBy: null,
          inviteToken: null,
        };
      }
      if (email === 'suspended@example.org') {
        return {
          id: 'internal-user-uuid',
          email,
          googleSub: null,
          displayName: null,
          role: 'member',
          status: 'suspended',
          createdAt: 0,
          lastSeenAt: null,
          invitedBy: null,
          inviteToken: null,
        };
      }
      return null;
    }),
    resolveByGoogleSub: vi.fn(async () => null),
  };
});

import { resetEnvCacheForTest } from '../../src/types/env.ts';
import { resetOboJwksCacheForTest, verifyOnBehalfOf } from '../../src/auth/on_behalf_of.ts';

// ─── Fixtures ─────────────────────────────────────────────────────────────

interface KeyPair {
  readonly privatePem: string;
  readonly publicPem: string;
  readonly kid: string;
}

function makeRsaKeyPair(kid = 'approval2-test-key'): KeyPair {
  const kp = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privatePem: kp.privateKey as string, publicPem: kp.publicKey as string, kid };
}

const APPROVAL2_ISSUER = 'mcp-approval2';
const KC2_AUDIENCE = 'mcp-knowledge2';
const TEST_SERVICE_TOKEN = 'x'.repeat(32);
const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';
const TEST_USER_EMAIL = 'axel@example.org';

let keyPair: KeyPair;
let importedPrivate: CryptoKey;
let jwksServer: Server;
let approvalJwksUrl: string;

beforeAll(async () => {
  keyPair = makeRsaKeyPair();
  importedPrivate = (await importPKCS8(keyPair.privatePem, 'RS256', {
    extractable: false,
  })) as unknown as CryptoKey;

  // Bring up a tiny localhost HTTP server that publishes the JWKS. This
  // emulates approval2's /.well-known/jwks.json. jose's `createRemoteJWKSet`
  // will hit this URL via real fetch, which we don't have to stub.
  const publicKey = (await importSPKI(keyPair.publicPem, 'RS256', {
    extractable: true,
  })) as unknown as CryptoKey;
  const jwk = (await exportJWK(publicKey)) as unknown as Record<string, unknown>;
  jwk['kid'] = keyPair.kid;
  jwk['alg'] = 'RS256';
  jwk['use'] = 'sig';
  const jwksBody = JSON.stringify({ keys: [jwk] });
  jwksServer = createServer((req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(jwksBody);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  const addr = jwksServer.address() as AddressInfo;
  approvalJwksUrl = `http://127.0.0.1:${addr.port}/.well-known/jwks.json`;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
});

// Save & restore env across tests.
const ORIGINAL_ENV: Record<string, string | undefined> = {};
function snapshotEnv(...keys: string[]): void {
  for (const k of keys) ORIGINAL_ENV[k] = process.env[k];
}
function restoreEnv(): void {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(async () => {
  snapshotEnv(
    'MCP_APPROVAL_JWKS_URL',
    'MCP_APPROVAL_ISSUER',
    'SERVICE_TOKEN',
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
  );
  process.env.MCP_APPROVAL_JWKS_URL = approvalJwksUrl;
  process.env.MCP_APPROVAL_ISSUER = APPROVAL2_ISSUER;
  process.env.SERVICE_TOKEN = TEST_SERVICE_TOKEN;
  process.env.SELF_OAUTH_ISSUER = 'https://knowledge.test';
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'gid';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'gsecret';
  process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://knowledge.test/auth/google/callback';
  process.env.BACKUP_MASTER_KEY = 'a'.repeat(64); // 32 byte hex
  process.env.KMS_MASTER_KEY_B64 = Buffer.alloc(32, 7).toString('base64');
  process.env.KMS_PROVIDER = 'hkdf_local';
  process.env.DATABASE_URL = 'postgres://x:y@localhost:5432/test';
  process.env.DATABASE_ADMIN_URL = 'postgres://x:y@localhost:5432/test';
  process.env.BLOB_ENDPOINT = 'http://localhost:9000';
  process.env.BLOB_ACCESS_KEY = 'k';
  process.env.BLOB_SECRET_KEY = 's';
  process.env.BLOB_BUCKET = 'b';
  process.env.VERTEX_PROJECT = 'p';
  resetEnvCacheForTest();
  resetOboJwksCacheForTest();
});

afterEach(() => {
  restoreEnv();
  resetEnvCacheForTest();
  resetOboJwksCacheForTest();
});

// Helper: sign an OBO-JWT exactly as approval2's `signOBO()` would. See
// apps/server/src/services/knowledge.ts :: makeRs256Signer
// for the production implementation.
async function signApproval2Obo(args: {
  sub?: string;
  aud?: string;
  on_behalf_of?: string;
  approval_id?: string;
  request_id?: string;
  ttlSec?: number;
  iss?: string;
  kid?: string | null;
  alg?: 'RS256';
}): Promise<string> {
  const ttl = args.ttlSec ?? 120;
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    on_behalf_of: args.on_behalf_of ?? TEST_USER_EMAIL,
  };
  if (args.approval_id !== undefined) payload['approval_id'] = args.approval_id;
  if (args.request_id !== undefined) payload['request_id'] = args.request_id;

  const header: { alg: 'RS256'; typ: 'JWT'; kid?: string } = {
    alg: args.alg ?? 'RS256',
    typ: 'JWT',
  };
  const kid = args.kid === null ? undefined : args.kid ?? keyPair.kid;
  if (kid) header.kid = kid;

  return new SignJWT(payload)
    .setProtectedHeader(header)
    .setIssuer(args.iss ?? APPROVAL2_ISSUER)
    .setAudience(args.aud ?? KC2_AUDIENCE)
    .setSubject(args.sub ?? TEST_USER_ID)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .setJti('jti-' + Math.random().toString(16).slice(2))
    .sign(importedPrivate);
}

// ─── Happy path ───────────────────────────────────────────────────────────

describe('OBO-JWT contract — happy path', () => {
  it('verifies a fully-populated OBO token (write-op shape: approval_id+request_id)', async () => {
    const obo = await signApproval2Obo({
      approval_id: '22222222-2222-2222-2222-222222222222',
      request_id: '33333333-3333-3333-3333-333333333333',
    });
    const ctx = await verifyOnBehalfOf({
      authHeader: `Bearer ${TEST_SERVICE_TOKEN}`,
      oboHeader: obo,
      xRequestId: undefined,
    });
    expect(ctx.authMode).toBe('on_behalf_of');
    expect(ctx.viaProxy).toBe(true);
    expect(ctx.userId).toBe('internal-user-uuid');
    expect(ctx.approvalId).toBe('22222222-2222-2222-2222-222222222222');
    expect(ctx.requestId).toBe('33333333-3333-3333-3333-333333333333');
  });

  it('accepts a read-op OBO token without approval_id', async () => {
    // Per K-D4: approval_id is optional for reads.
    const obo = await signApproval2Obo({
      request_id: '33333333-3333-3333-3333-333333333333',
    });
    const ctx = await verifyOnBehalfOf({
      authHeader: `Bearer ${TEST_SERVICE_TOKEN}`,
      oboHeader: obo,
      xRequestId: undefined,
    });
    expect(ctx.approvalId).toBeUndefined();
    expect(ctx.requestId).toBe('33333333-3333-3333-3333-333333333333');
  });

  it('falls back to X-Request-Id header when request_id claim is absent', async () => {
    const obo = await signApproval2Obo({});
    const headerReqId = '44444444-4444-4444-4444-444444444444';
    const ctx = await verifyOnBehalfOf({
      authHeader: `Bearer ${TEST_SERVICE_TOKEN}`,
      oboHeader: obo,
      xRequestId: headerReqId,
    });
    expect(ctx.requestId).toBe(headerReqId);
  });
});

// ─── Failure cases (each documents an attack surface) ─────────────────────

describe('OBO-JWT contract — failure modes', () => {
  it('rejects when SERVICE_TOKEN is missing', async () => {
    const obo = await signApproval2Obo({});
    await expect(
      verifyOnBehalfOf({ authHeader: undefined, oboHeader: obo, xRequestId: undefined }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rejects when SERVICE_TOKEN mismatches (two-factor enforcement)', async () => {
    const obo = await signApproval2Obo({});
    await expect(
      verifyOnBehalfOf({
        authHeader: 'Bearer wrong-service-token-' + 'y'.repeat(20),
        oboHeader: obo,
        xRequestId: undefined,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects when X-On-Behalf-Of header is absent', async () => {
    await expect(
      verifyOnBehalfOf({
        authHeader: `Bearer ${TEST_SERVICE_TOKEN}`,
        oboHeader: undefined,
        xRequestId: undefined,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects an expired OBO token', async () => {
    // exp ist (iat+ttl). Wir signen mit ttl=1s und warten 2s. Default-Toleranz
    // von jose ist sehr gering (kein clockTolerance => effektiv 0).
    const obo = await signApproval2Obo({ ttlSec: 1 });
    await new Promise((r) => setTimeout(r, 2100));
    await expect(
      verifyOnBehalfOf({
        authHeader: `Bearer ${TEST_SERVICE_TOKEN}`,
        oboHeader: obo,
        xRequestId: undefined,
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rejects wrong audience (token NOT intended for KC2)', async () => {
    const obo = await signApproval2Obo({ aud: 'some-other-service' });
    await expect(
      verifyOnBehalfOf({
        authHeader: `Bearer ${TEST_SERVICE_TOKEN}`,
        oboHeader: obo,
        xRequestId: undefined,
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rejects wrong issuer (token NOT signed by approval2)', async () => {
    const obo = await signApproval2Obo({ iss: 'mcp-evil' });
    await expect(
      verifyOnBehalfOf({
        authHeader: `Bearer ${TEST_SERVICE_TOKEN}`,
        oboHeader: obo,
        xRequestId: undefined,
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rejects when on_behalf_of subject is not provisioned', async () => {
    const obo = await signApproval2Obo({ on_behalf_of: 'unknown@example.org' });
    await expect(
      verifyOnBehalfOf({
        authHeader: `Bearer ${TEST_SERVICE_TOKEN}`,
        oboHeader: obo,
        xRequestId: undefined,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects when on_behalf_of user is suspended', async () => {
    const obo = await signApproval2Obo({ on_behalf_of: 'suspended@example.org' });
    await expect(
      verifyOnBehalfOf({
        authHeader: `Bearer ${TEST_SERVICE_TOKEN}`,
        oboHeader: obo,
        xRequestId: undefined,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects when on_behalf_of claim is missing', async () => {
    // Sign without on_behalf_of.
    const now = Math.floor(Date.now() / 1000);
    const obo = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: keyPair.kid })
      .setIssuer(APPROVAL2_ISSUER)
      .setAudience(KC2_AUDIENCE)
      .setSubject(TEST_USER_ID)
      .setIssuedAt(now)
      .setExpirationTime(now + 120)
      .sign(importedPrivate);
    await expect(
      verifyOnBehalfOf({
        authHeader: `Bearer ${TEST_SERVICE_TOKEN}`,
        oboHeader: obo,
        xRequestId: undefined,
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rejects an approval_id that is not a UUID', async () => {
    const obo = await signApproval2Obo({ approval_id: 'not-a-uuid' });
    await expect(
      verifyOnBehalfOf({
        authHeader: `Bearer ${TEST_SERVICE_TOKEN}`,
        oboHeader: obo,
        xRequestId: undefined,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
