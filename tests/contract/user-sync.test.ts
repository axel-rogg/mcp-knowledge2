// Cross-service contract test (T3-2): User-Sync wire-format approval2 → KC2.
//
// This file documents and VALIDATES the /v1/internal/users/sync contract.
// approval2's `HttpKnowledgeAdapter.syncUser()` produces the request body;
// KC2's POST /v1/internal/users/sync route (routes/internal.ts) consumes it
// and dispatches to `syncFromApproval2()`.
//
// Specs:
//   - mcp-approval2/docs/plans/active/PLAN-as3-autonomous.md §2.2 + A11
//   - approval2 adapter shape: packages/adapters/src/knowledge/http-client.ts
//     :: syncUser  →  POST /v1/internal/users/sync with body:
//       {user_id, email, display_name, status, external_id?}
//
// Auth-Mode: Service-Token only (no OBO). KC2 routes mounted under
// /v1/internal/* use `requireServiceToken` middleware.
//
// This test stubs the DB-backed sync function so we focus on the
// wire-shape contract (route parsing + response shape). The end-to-end
// path with a real DB is covered in tests/integration/.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Set env BEFORE any module-under-test imports.
process.env.NODE_ENV ??= 'test';
process.env.LOG_LEVEL ??= 'error';
process.env.SERVICE_TOKEN = 'a'.repeat(40); // ≥32 bytes
process.env.SELF_OAUTH_ISSUER = 'https://knowledge.test';
process.env.GOOGLE_OAUTH_CLIENT_ID = 'gid';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'gsecret';
process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://knowledge.test/auth/google/callback';
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

// Mock syncFromApproval2 + the audit emitter (they would otherwise need a DB).
let lastSyncInput: unknown = null;
let syncReturn: { status: 'created' | 'updated' | 'unchanged'; kcUserId: string } = {
  status: 'created',
  kcUserId: 'kc-user-uuid-1',
};
let auditEvents: unknown[] = [];
vi.mock('../../src/users/api.ts', async () => {
  return {
    syncFromApproval2: vi.fn(async (input: unknown) => {
      lastSyncInput = input;
      return syncReturn;
    }),
  };
});
vi.mock('../../src/observability/audit.ts', async () => {
  return {
    emitAudit: vi.fn(async (e: unknown) => {
      auditEvents.push(e);
    }),
  };
});
// Mock storage + blob to avoid real DB / S3 — these are pulled in by the
// internal.ts module-level imports.
vi.mock('../../src/storage/objects.ts', async () => ({
  hardDeleteByOwner: vi.fn(async () => ({ rowsDeleted: 0, blobsToDelete: [] })),
}));
vi.mock('../../src/adapters/blob/index.ts', async () => ({
  blobStore: () => ({
    delete: vi.fn(async () => undefined),
    exists: vi.fn(async () => true),
  }),
}));
// withAdminTx is referenced by internal.ts directly — stub so any call no-ops.
vi.mock('../../src/db/client.ts', async () => {
  return {
    withAdminTx: vi.fn(async (cb: (db: unknown) => Promise<unknown>) => {
      // Provide a minimal stub for the delete-cascade path. The real path
      // is exercised by integration tests; here we just want sync route.
      const fakeDb = {
        delete: () => ({
          where: () => ({
            returning: () => [],
          }),
        }),
        insert: () => ({ values: () => undefined }),
        update: () => ({
          set: () => ({
            where: () => ({ returning: () => [] }),
          }),
        }),
        execute: async () => undefined,
      };
      return cb(fakeDb);
    }),
  };
});

import { Hono } from 'hono';
import { internalRouter } from '../../src/routes/internal.ts';
import { requireServiceToken } from '../../src/auth/service_token.ts';
import { errorHandler } from '../../src/middleware/error.ts';

let app: Hono;
const SERVICE_TOKEN = process.env.SERVICE_TOKEN as string;

beforeAll(() => {
  app = new Hono();
  app.use('/v1/*', requireServiceToken);
  app.route('/v1', internalRouter);
  app.onError(errorHandler);
});

beforeEach(() => {
  lastSyncInput = null;
  auditEvents = [];
  syncReturn = { status: 'created', kcUserId: 'kc-user-uuid-1' };
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${SERVICE_TOKEN}`,
      'x-request-id': '00000000-0000-0000-0000-000000000001',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

// ─── Happy path ───────────────────────────────────────────────────────────

describe('user-sync contract — happy path', () => {
  it('processes a new-user payload and returns status=created', async () => {
    syncReturn = { status: 'created', kcUserId: 'kc-user-uuid-1' };
    const res = await post('/v1/internal/users/sync', {
      user_id: '11111111-1111-1111-1111-111111111111',
      email: 'axel@example.org',
      display_name: 'Axel R.',
      status: 'active',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; kc_user_id: string };
    expect(body).toEqual({ status: 'created', kc_user_id: 'kc-user-uuid-1' });
    expect(lastSyncInput).toEqual({
      approval2UserId: '11111111-1111-1111-1111-111111111111',
      email: 'axel@example.org',
      displayName: 'Axel R.',
      status: 'active',
    });
    // Audit row emitted with upstream_status.
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      action: 'user.synced',
      result: 'success',
      details: { upstream_status: 'created', email: 'axel@example.org', status: 'active' },
    });
  });

  it('processes a suspend payload and returns status=updated', async () => {
    syncReturn = { status: 'updated', kcUserId: 'kc-user-uuid-1' };
    const res = await post('/v1/internal/users/sync', {
      user_id: '11111111-1111-1111-1111-111111111111',
      email: 'axel@example.org',
      display_name: 'Axel R.',
      status: 'suspended',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('updated');
    expect(lastSyncInput).toMatchObject({ status: 'suspended' });
  });

  it('processes an erase payload and returns status=updated', async () => {
    syncReturn = { status: 'updated', kcUserId: 'kc-user-uuid-1' };
    const res = await post('/v1/internal/users/sync', {
      user_id: '11111111-1111-1111-1111-111111111111',
      email: 'axel@example.org',
      display_name: 'Axel R.',
      status: 'erased',
    });
    expect(res.status).toBe(200);
    expect(lastSyncInput).toMatchObject({ status: 'erased' });
  });

  it('accepts external_id when present in the payload', async () => {
    syncReturn = { status: 'unchanged', kcUserId: 'kc-user-uuid-1' };
    const res = await post('/v1/internal/users/sync', {
      user_id: '11111111-1111-1111-1111-111111111111',
      email: 'axel@example.org',
      display_name: 'Axel R.',
      status: 'active',
      external_id: 'oidc:google:108x',
    });
    expect(res.status).toBe(200);
    expect(lastSyncInput).toMatchObject({ externalId: 'oidc:google:108x' });
  });

  it('accepts null display_name (deleted profile)', async () => {
    const res = await post('/v1/internal/users/sync', {
      user_id: '11111111-1111-1111-1111-111111111111',
      email: 'axel@example.org',
      display_name: null,
      status: 'active',
    });
    expect(res.status).toBe(200);
    expect(lastSyncInput).toMatchObject({ displayName: null });
  });

  it('returns status=unchanged for idempotent re-sync', async () => {
    syncReturn = { status: 'unchanged', kcUserId: 'kc-user-uuid-2' };
    const res = await post('/v1/internal/users/sync', {
      user_id: '11111111-1111-1111-1111-111111111111',
      email: 'axel@example.org',
      display_name: 'Axel R.',
      status: 'active',
    });
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('unchanged');
  });
});

// ─── Failure cases ────────────────────────────────────────────────────────

describe('user-sync contract — failure modes', () => {
  it('rejects without service token (401)', async () => {
    const res = await app.request('/v1/internal/users/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user_id: '11111111-1111-1111-1111-111111111111',
        email: 'axel@example.org',
        display_name: 'Axel R.',
        status: 'active',
      }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects with wrong service token (403)', async () => {
    const res = await app.request('/v1/internal/users/sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wrong-token-' + 'z'.repeat(20),
      },
      body: JSON.stringify({
        user_id: '11111111-1111-1111-1111-111111111111',
        email: 'axel@example.org',
        display_name: 'Axel R.',
        status: 'active',
      }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects when user_id is not a UUID', async () => {
    const res = await post('/v1/internal/users/sync', {
      user_id: 'not-a-uuid',
      email: 'axel@example.org',
      display_name: 'Axel R.',
      status: 'active',
    });
    expect(res.status).toBe(400);
  });

  it('rejects when email is not RFC-compliant', async () => {
    const res = await post('/v1/internal/users/sync', {
      user_id: '11111111-1111-1111-1111-111111111111',
      email: 'not-an-email',
      display_name: 'Axel R.',
      status: 'active',
    });
    expect(res.status).toBe(400);
  });

  it('rejects when status is an unknown enum value', async () => {
    const res = await post('/v1/internal/users/sync', {
      user_id: '11111111-1111-1111-1111-111111111111',
      email: 'axel@example.org',
      display_name: 'Axel R.',
      status: 'deleted', // not in active|suspended|erased
    });
    expect(res.status).toBe(400);
  });

  it('rejects when required field is missing', async () => {
    const res = await post('/v1/internal/users/sync', {
      // user_id missing
      email: 'axel@example.org',
      display_name: 'Axel R.',
      status: 'active',
    });
    expect(res.status).toBe(400);
  });
});
