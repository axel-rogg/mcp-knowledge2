// Cross-Service contract roundtrip — exercises every endpoint the
// mcp-approval2 `KnowledgeAdapter` reaches against a real Postgres +
// pgvector (Testcontainers).
//
// We do NOT spin up the production `server.ts` boot path because that
// requires a live JWKS endpoint, KMS callback, blob endpoint, and
// Vertex SA. Instead we wire the same routers behind a thin test-only
// Hono app whose auth middleware injects a `ctx` directly. This keeps
// the test focused on the routes themselves while avoiding network
// dependencies.
//
// See docs/CROSS-SERVICE-CONTRACT.md and docs/runbooks/runbook-integration-tests.md.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';

// Environment must be configured BEFORE any module under test is imported,
// because `loadEnv` caches the parsed config.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.JWKS_URL = 'http://127.0.0.1:1/.well-known/jwks.json'; // unused
process.env.JWT_ISSUER = 'test-issuer';
process.env.JWT_AUDIENCE = 'mcp-knowledge2';
process.env.SERVICE_TOKEN = 'test-service-token-must-be-at-least-32-bytes-ok';
process.env.BLOB_ENDPOINT = 'http://127.0.0.1:1';
process.env.BLOB_REGION = 'eu-central';
process.env.BLOB_ACCESS_KEY = 'test';
process.env.BLOB_SECRET_KEY = 'test';
process.env.BLOB_BUCKET = 'test';
process.env.VERTEX_PROJECT = 'test-project';
process.env.MCP_APPROVAL_BASE_URL = 'http://127.0.0.1:1';
process.env.MCP_APPROVAL_INTERNAL_TOKEN = 'test-internal-token-must-be-32-bytes-or-more-x';
// AS-3-Schema in env.ts hat SELF_OAUTH_ISSUER + GOOGLE_OAUTH_* als Required
// (post-K3/K4 OAuth-Facade). Stubs reichen — kein OAuth-Flow im Integration-Test.
process.env.SELF_OAUTH_ISSUER = 'http://127.0.0.1:1';
process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-google-client-id';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-google-client-secret';
process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://127.0.0.1:1/auth/google/callback';
// 32 zero-bytes base64 — matches the F-21 validator which now requires
// BACKUP_MASTER_KEY to decode to exactly 32 raw bytes.
process.env.BACKUP_MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

// resetEnvCacheForTest is called once DATABASE_URL is known (after container starts).
import { resetEnvCacheForTest } from '../../src/types/env.ts';

let container: StartedPostgreSqlContainer;
let rootClient: pg.Client; // used for setup only

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

// Built once after env is final
let app: Hono;
let currentUserId: string = USER_A; // mutable so individual tests can flip subject

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
    .withDatabase('knowledge')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();

  rootClient = new pg.Client({ connectionString: container.getConnectionUri() });
  await rootClient.connect();
  await rootClient.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await rootClient.query(`CREATE EXTENSION IF NOT EXISTS vector`);
  await rootClient.query(`CREATE ROLE knowledge_app WITH LOGIN PASSWORD 'app'`);
  await rootClient.query(`CREATE ROLE knowledge_admin WITH LOGIN PASSWORD 'admin' BYPASSRLS`);
  await rootClient.query(`GRANT CONNECT ON DATABASE knowledge TO knowledge_app, knowledge_admin`);
  await rootClient.query(`GRANT USAGE ON SCHEMA public TO knowledge_app, knowledge_admin`);
  await rootClient.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO knowledge_app`,
  );
  await rootClient.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO knowledge_admin`,
  );

  // Apply ALL SQL migrations in lexical order, with a re-grant pass
  // after each file so new tables get the right GRANTs (default
  // privileges only apply to objects created *after* the ALTER).
  const { readdir } = await import('node:fs/promises');
  const migrationsDir = join(process.cwd(), 'drizzle', 'migrations');
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    await rootClient.query(sql);
    await rootClient.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO knowledge_app`,
    );
    await rootClient.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO knowledge_admin`,
    );
    // 0001 revokes UPDATE+DELETE on audit_log from knowledge_app —
    // re-apply that after every subsequent re-grant so the audit-log
    // append-only contract is honoured by 0002+ as well.
    await rootClient.query(`REVOKE UPDATE, DELETE ON audit_log FROM knowledge_app`).catch(() => {});
    // 0004 explicitly revokes from knowledge_app on blob_deletion_queue.
    await rootClient.query(`REVOKE ALL ON blob_deletion_queue FROM knowledge_app`).catch(() => {});
  }

  const host = container.getHost();
  const port = container.getPort();
  process.env.DATABASE_URL = `postgres://knowledge_app:app@${host}:${port}/knowledge`;
  process.env.DATABASE_ADMIN_URL = `postgres://knowledge_admin:admin@${host}:${port}/knowledge`;
  resetEnvCacheForTest();

  // ─── Adapters: inject in-memory stubs ────────────────────────────────────
  const { setBlobStoreForTest } = await import('../../src/adapters/blob/index.ts');
  setBlobStoreForTest(makeInMemoryBlobStore());

  const { setKmsForTest } = await import('../../src/adapters/kms/index.ts');
  setKmsForTest({
    resolveUserDek: async () => new Uint8Array(32), // all-zero key — fine for AES-GCM
    resolveEmbedSalt: async () => '00000000000000000000000000000000', // 16 bytes hex
  });

  const { setEmbeddingAdapterForTest } = await import('../../src/adapters/embed/index.ts');
  setEmbeddingAdapterForTest({
    model: 'test-stub',
    dimensions: 1024,
    embed: async (texts: string[]) => texts.map(() => Array.from({ length: 1024 }, () => 0.1)),
  });

  // ─── Build a test-only Hono app that mounts the production routers ──────
  const { objectsRouter } = await import('../../src/routes/objects.ts');
  const { sharesRouter } = await import('../../src/routes/shares.ts');
  const { searchRouter } = await import('../../src/routes/search.ts');
  const { internalRouter } = await import('../../src/routes/internal.ts');
  const { errorHandler } = await import('../../src/middleware/error.ts');
  const { installContext } = await import('../../src/middleware/context.ts');

  app = new Hono();
  app.onError(errorHandler);

  // Test-substitute for `requireJwt`: read the user from a header. No
  // signature checking — we're testing route shapes, not auth.
  const v1 = new Hono();
  v1.use('*', async (c, next) => {
    const u = c.req.header('x-test-user') ?? currentUserId;
    (c.set as (key: string, value: unknown) => void)('ctx', {
      userId: u,
      requestId: c.req.header('x-request-id') ?? crypto.randomUUID(),
      authMode: 'jwt',
      scopes: [],
    });
    await next();
  });
  v1.use('*', installContext);
  v1.route('/', objectsRouter);
  v1.route('/', sharesRouter);
  v1.route('/', searchRouter);
  app.route('/v1', v1);

  // Internal routes — same skip-auth pattern with service mode
  const internal = new Hono();
  internal.use('*', async (c, next) => {
    (c.set as (key: string, value: unknown) => void)('ctx', {
      userId: null,
      requestId: crypto.randomUUID(),
      authMode: 'service',
      scopes: [],
    });
    await next();
  });
  internal.use('*', installContext);
  internal.route('/', internalRouter);
  app.route('/v1', internal);
}, 120_000);

afterAll(async () => {
  const { closeDbPools } = await import('../../src/db/client.ts');
  await closeDbPools();
  await rootClient?.end();
  await container?.stop();
}, 60_000);

beforeEach(async () => {
  // Reset state between tests via admin connection (BYPASSRLS).
  const host = container.getHost();
  const port = container.getPort();
  const admin = new pg.Client({
    host,
    port,
    database: 'knowledge',
    user: 'knowledge_admin',
    password: 'admin',
  });
  await admin.connect();
  try {
    await admin.query(`DELETE FROM object_vectors`);
    await admin.query(`DELETE FROM share_grants`);
    await admin.query(`DELETE FROM object_tags`);
    await admin.query(`DELETE FROM object_refs`);
    await admin.query(`DELETE FROM object_revisions`);
    await admin.query(`DELETE FROM objects`);
    await admin.query(`DELETE FROM user_quotas`);
    await admin.query(`DELETE FROM idempotency_records`);
    await admin.query(`DELETE FROM uploads`);
    await admin.query(`DELETE FROM audit_log`);
  } finally {
    await admin.end();
  }
  currentUserId = USER_A;
});

// ─── Test helpers ─────────────────────────────────────────────────────────

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; user?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'x-test-user': opts.user ?? currentUserId };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  Object.assign(headers, opts.headers ?? {});
  return await app.request(`http://test${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

function makeInMemoryBlobStore() {
  const store = new Map<string, Uint8Array>();
  return {
    async put(key: string, body: Uint8Array): Promise<void> {
      store.set(key, body);
    },
    async get(key: string): Promise<Uint8Array | null> {
      return store.get(key) ?? null;
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async exists(key: string): Promise<boolean> {
      return store.has(key);
    },
    async presignPut(): Promise<string> {
      return 'http://localhost/upload';
    },
    async presignGet(): Promise<string> {
      return 'http://localhost/download';
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('objects roundtrip — Cross-Service Contract', () => {
  it('POST /v1/objects creates an object and returns the ObjectView shape', async () => {
    const r = await call('POST', '/v1/objects', {
      body: {
        subtype: 'doc',
        title: 'hello',
        description: 'first doc',
        keywords: ['a', 'b'],
        body_b64: b64('hello world'),
        mime_type: 'text/plain',
      },
    });
    expect(r.status).toBe(201);
    const view = (await r.json()) as Record<string, unknown>;
    expect(view).toMatchObject({
      subtype: 'doc',
      title: 'hello',
      description: 'first doc',
      visibility: 'private',
      pinned: false,
      archived: false,
      refcount: 0,
      currentVersion: 1,
    });
    expect(typeof view.id).toBe('string');
    expect(typeof view.ownerId).toBe('string');
    expect(typeof view.createdAt).toBe('number');
    expect(typeof view.updatedAt).toBe('number');
    expect(view.bodySize).toBe(11);
    expect(view.bodyHash).toBeTypeOf('string');
    // Contract D-12: `blob_key`/`r2_key` MUST NOT leak in the response.
    expect(view).not.toHaveProperty('blob_key');
    expect(view).not.toHaveProperty('r2_key');
    expect(view).not.toHaveProperty('blobKey');
  });

  it('GET /v1/objects/:id returns the same object; ?expand=body adds body_b64', async () => {
    const create = await call('POST', '/v1/objects', {
      body: { subtype: 'doc', title: 't', body_b64: b64('payload') },
    });
    const created = (await create.json()) as { id: string };
    const readNoBody = await call('GET', `/v1/objects/${created.id}`);
    expect(readNoBody.status).toBe(200);
    const view = (await readNoBody.json()) as Record<string, unknown>;
    expect(view.body_b64).toBeUndefined();

    const readWithBody = await call('GET', `/v1/objects/${created.id}?expand=body`);
    expect(readWithBody.status).toBe(200);
    const viewWithBody = (await readWithBody.json()) as { body_b64?: string };
    expect(viewWithBody.body_b64).toBeTypeOf('string');
    expect(Buffer.from(viewWithBody.body_b64 as string, 'base64').toString('utf8')).toBe('payload');
  });

  it('PATCH /v1/objects/:id updates fields and increments currentVersion when body changes', async () => {
    const created = (await (
      await call('POST', '/v1/objects', { body: { subtype: 'doc', title: 'old', body_b64: b64('v1') } })
    ).json()) as { id: string; currentVersion: number };

    const r = await call('PATCH', `/v1/objects/${created.id}`, {
      body: { title: 'new', body_b64: b64('v2-bigger') },
    });
    expect(r.status).toBe(200);
    const updated = (await r.json()) as { title: string; currentVersion: number; bodySize: number };
    expect(updated.title).toBe('new');
    expect(updated.currentVersion).toBe(created.currentVersion + 1);
    expect(updated.bodySize).toBe(9);
  });

  it('GET /v1/objects paginates and returns next_cursor (not "cursor")', async () => {
    for (let i = 0; i < 3; i++) {
      await call('POST', '/v1/objects', {
        body: { subtype: 'doc', title: `t${i}`, body_b64: b64(`p${i}`) },
      });
      // Different updatedAt timestamps so cursor ordering is unambiguous
      await new Promise((res) => setTimeout(res, 5));
    }
    const r = await call('GET', '/v1/objects?limit=2');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: unknown[]; next_cursor: number | null };
    expect(body.items.length).toBe(2);
    expect(body).toHaveProperty('next_cursor');
    // Contract D-4/D-5: the response shape is { items, next_cursor }, NOT { items, cursor, hasMore }.
    expect(body).not.toHaveProperty('cursor');
    expect(body).not.toHaveProperty('hasMore');
  });

  it('GET /v1/objects?subtype_prefix=app: returns only `app:*` subtypes (prefix-match)', async () => {
    // Seed: 2 app subtypes + 1 doc.
    await call('POST', '/v1/objects', {
      body: { subtype: 'app:composable', title: 'comp', body_b64: b64('c') },
    });
    await call('POST', '/v1/objects', {
      body: { subtype: 'app:shopping-list', title: 'shop', body_b64: b64('s') },
    });
    await call('POST', '/v1/objects', {
      body: { subtype: 'doc', title: 'd1', body_b64: b64('d') },
    });

    const r = await call('GET', '/v1/objects?subtype_prefix=app:');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: Array<{ subtype: string }> };
    expect(body.items.length).toBe(2);
    for (const item of body.items) {
      expect(item.subtype.startsWith('app:')).toBe(true);
    }
  });

  it('GET /v1/objects rejects subtype + subtype_prefix together (mutual-exclusive)', async () => {
    const r = await call('GET', '/v1/objects?subtype=doc&subtype_prefix=app:');
    expect(r.status).toBe(400);
  });

  it('DELETE /v1/objects/:id soft-deletes (204) and the object disappears from list', async () => {
    const created = (await (
      await call('POST', '/v1/objects', { body: { subtype: 'doc', title: 'del-me', body_b64: b64('x') } })
    ).json()) as { id: string };
    const del = await call('DELETE', `/v1/objects/${created.id}`);
    expect(del.status).toBe(204);
    const list = (await (await call('GET', '/v1/objects')).json()) as { items: unknown[] };
    expect(list.items).toEqual([]);
  });
});

// ─── PLAN-document-linking: refs in objects.get ────────────────────────────

describe('refs roundtrip — PLAN-document-linking P1', () => {
  async function create(subtype: string, title: string, description: string): Promise<string> {
    const r = await call('POST', '/v1/objects', {
      body: { subtype, title, description, body_b64: b64(`body of ${title}`) },
    });
    expect(r.status).toBe(201);
    const j = (await r.json()) as { id: string };
    return j.id;
  }

  async function addRef(fromId: string, toId: string, role: string): Promise<void> {
    const r = await call('POST', `/v1/objects/${fromId}/refs`, {
      body: { to_id: toId, role },
    });
    expect(r.status).toBe(204);
  }

  async function removeRef(fromId: string, toId: string, role: string): Promise<void> {
    const r = await call('DELETE', `/v1/objects/${fromId}/refs`, {
      body: { to_id: toId, role },
    });
    expect(r.status).toBe(204);
  }

  it('GET /objects/:id includes refs.outgoing[] with title+summary+uri by default', async () => {
    const skill = await create('skill_manifest', 'PDF-Handling', 'Skill for PDF ops');
    const doc1 = await create('doc', 'PDF-API-Reference', 'pdfplumber + PyPDF2 API');
    await addRef(skill, doc1, 'resource');

    const r = await call('GET', `/v1/objects/${skill}`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      id: string;
      refs: {
        outgoing: Array<{ role: string; id: string; title: string; summary: string; uri: string; subtype: string }>;
        incoming: Array<unknown>;
        truncated: { outgoing: boolean; incoming: boolean };
      };
    };
    expect(j.refs.outgoing).toHaveLength(1);
    expect(j.refs.outgoing[0]!.role).toBe('resource');
    expect(j.refs.outgoing[0]!.id).toBe(doc1);
    expect(j.refs.outgoing[0]!.title).toBe('PDF-API-Reference');
    expect(j.refs.outgoing[0]!.summary).toBe('pdfplumber + PyPDF2 API');
    expect(j.refs.outgoing[0]!.uri).toBe(`kc://object/${doc1}`);
    expect(j.refs.outgoing[0]!.subtype).toBe('doc');
    expect(j.refs.truncated.outgoing).toBe(false);
  });

  it('refs_limit=0 suppresses the refs block entirely', async () => {
    const a = await create('doc', 'A', 'sum a');
    const b = await create('doc', 'B', 'sum b');
    await addRef(a, b, 'references');

    const r = await call('GET', `/v1/objects/${a}?refs_limit=0`);
    const j = (await r.json()) as Record<string, unknown>;
    expect(j.refs).toBeUndefined();
  });

  it('truncates with boolean flag when more refs than limit', async () => {
    const parent = await create('skill_manifest', 'Parent', 'sum');
    const targets = await Promise.all(
      Array.from({ length: 6 }, (_, i) => create('doc', `T${i}`, `sum ${i}`)),
    );
    for (const t of targets) await addRef(parent, t, 'resource');

    const r = await call('GET', `/v1/objects/${parent}?refs_limit=3`);
    const j = (await r.json()) as {
      refs: { outgoing: unknown[]; truncated: { outgoing: boolean; incoming: boolean } };
    };
    expect(j.refs.outgoing).toHaveLength(3);
    expect(j.refs.truncated.outgoing).toBe(true);
  });

  it('M:N is_subdoc stays true while ≥1 resource ref remains, flips false on last', async () => {
    const sk1 = await create('skill_manifest', 'Skill-1', 'sum');
    const sk2 = await create('skill_manifest', 'Skill-2', 'sum');
    const doc = await create('doc', 'Shared-Doc', 'sum');

    // both skills point at doc as resource
    await addRef(sk1, doc, 'resource');
    await addRef(sk2, doc, 'resource');

    // remove sk1→doc — doc.is_subdoc should still be true (sk2 still points)
    await removeRef(sk1, doc, 'resource');
    let r = await call('GET', `/v1/objects/${doc}`);
    let j = (await r.json()) as { isSubdoc: boolean };
    expect(j.isSubdoc).toBe(true);

    // remove sk2→doc — now last resource ref gone, is_subdoc flips false
    await removeRef(sk2, doc, 'resource');
    r = await call('GET', `/v1/objects/${doc}`);
    j = (await r.json()) as { isSubdoc: boolean };
    expect(j.isSubdoc).toBe(false);
  });

  it('incoming refs show source (parent) info with denormalised title+summary', async () => {
    const skill = await create('skill_manifest', 'P', 'parent summary');
    const doc = await create('doc', 'D', 'doc summary');
    await addRef(skill, doc, 'resource');

    const r = await call('GET', `/v1/objects/${doc}`);
    const j = (await r.json()) as {
      refs: { incoming: Array<{ role: string; id: string; title: string; summary: string; uri: string }> };
    };
    expect(j.refs.incoming).toHaveLength(1);
    expect(j.refs.incoming[0]!.id).toBe(skill);
    expect(j.refs.incoming[0]!.title).toBe('P');
    expect(j.refs.incoming[0]!.summary).toBe('parent summary');
    expect(j.refs.incoming[0]!.uri).toBe(`kc://object/${skill}`);
  });

  it('refs_limit > 50 returns 400', async () => {
    const id = await create('doc', 'x', 'sum');
    const r = await call('GET', `/v1/objects/${id}?refs_limit=51`);
    expect(r.status).toBe(400);
  });
});

describe('shares roundtrip — Cross-Service Contract', () => {
  it('POST /v1/objects/:id/shares requires snake_case body { granted_to, scope }', async () => {
    const created = (await (
      await call('POST', '/v1/objects', { body: { subtype: 'doc', title: 's', body_b64: b64('shareable') } })
    ).json()) as { id: string };

    // Contract D-6 (post ADR-0004): the adapter sends `{ grantedTo, scope }` —
    // server expects snake_case. resourceKind is no longer part of the wire
    // format (the kind discriminator was removed).
    const wrongShape = await call('POST', `/v1/objects/${created.id}/shares`, {
      body: { grantedTo: USER_B, scope: 'read' },
    });
    expect(wrongShape.status).toBe(400);

    const r = await call('POST', `/v1/objects/${created.id}/shares`, {
      body: { granted_to: USER_B, scope: 'read' },
    });
    expect(r.status).toBe(201);
    const share = (await r.json()) as Record<string, unknown>;
    expect(share).toMatchObject({
      resourceId: created.id,
      grantedTo: USER_B,
      grantedBy: USER_A,
      scope: 'read',
    });
    // Contract D-7: the wire field is `grantedAt`, not `createdAt`.
    expect(share).toHaveProperty('grantedAt');
    expect(share).not.toHaveProperty('createdAt');
  });

  it('GET /v1/objects/:id/shares wraps in { items: [...] }', async () => {
    const created = (await (
      await call('POST', '/v1/objects', { body: { subtype: 'doc', title: 's', body_b64: b64('x') } })
    ).json()) as { id: string };
    await call('POST', `/v1/objects/${created.id}/shares`, {
      body: { granted_to: USER_B, scope: 'read' },
    });
    const r = await call('GET', `/v1/objects/${created.id}/shares`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: unknown[] };
    // Contract D-8: the response is wrapped, not a bare array.
    expect(Array.isArray(body)).toBe(false);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(1);
  });

  it('GET /v1/shared-with-me as the grantee surfaces the share', async () => {
    const created = (await (
      await call('POST', '/v1/objects', { body: { subtype: 'doc', title: 'cross', body_b64: b64('x') } })
    ).json()) as { id: string };
    await call('POST', `/v1/objects/${created.id}/shares`, {
      body: { granted_to: USER_B, scope: 'read' },
    });

    const r = await call('GET', '/v1/shared-with-me', { user: USER_B });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: Array<{ resourceId: string }> };
    expect(body.items.map((i) => i.resourceId)).toContain(created.id);
  });

  it('DELETE /v1/shares/:share_id revokes (204) and removes from shared-with-me', async () => {
    const created = (await (
      await call('POST', '/v1/objects', { body: { subtype: 'doc', title: 'r', body_b64: b64('x') } })
    ).json()) as { id: string };
    const share = (await (
      await call('POST', `/v1/objects/${created.id}/shares`, {
        body: { granted_to: USER_B, scope: 'read' },
      })
    ).json()) as { id: string };

    const revoke = await call('DELETE', `/v1/shares/${share.id}`);
    expect(revoke.status).toBe(204);

    const list = (await (await call('GET', '/v1/shared-with-me', { user: USER_B })).json()) as {
      items: unknown[];
    };
    expect(list.items).toEqual([]);
  });

  it('memo subtype is shareable (ADR-0004: uniform sharing across subtypes)', async () => {
    const memo = (await (
      await call('POST', '/v1/objects', { body: { subtype: 'memo', title: 'm', body_b64: b64('x') } })
    ).json()) as { id: string };
    const r = await call('POST', `/v1/objects/${memo.id}/shares`, {
      body: { granted_to: USER_B, scope: 'read' },
    });
    expect(r.status).toBe(201);
  });
});

describe('search roundtrip — Cross-Service Contract', () => {
  it('POST /v1/search accepts { query, subtypes, limit } and returns { items }', async () => {
    await call('POST', '/v1/objects', {
      body: { subtype: 'doc', title: 'about cats', description: 'feline lore', body_b64: b64('cat'), embed: true },
    });
    await call('POST', '/v1/objects', {
      body: { subtype: 'doc', title: 'about dogs', description: 'canine lore', body_b64: b64('dog'), embed: true },
    });

    const r = await call('POST', '/v1/search', { body: { query: 'cats', limit: 10 } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: Array<{ id: string; score: number }> };
    expect(Array.isArray(body.items)).toBe(true);
    // FTS should find at least the "about cats" doc
    expect(body.items.length).toBeGreaterThan(0);
  });

  it('accepts multi-subtype search via { subtypes: [...] } (D-9 resolved with kind-drop)', async () => {
    // Contract D-9 (post ADR-0004): the kind discriminator is gone. Multi-
    // category search is just `subtypes: [...]` and Postgres `ANY()` does
    // the filter.
    const r = await call('POST', '/v1/search', {
      body: { query: 'x', subtypes: ['doc', 'skill'] },
    });
    expect(r.status).toBe(200);
  });

  it('accepts subtype_prefixes search and combines with subtypes via OR', async () => {
    // Seed: a doc + an app:* subtype so the filter has something to match.
    await call('POST', '/v1/objects', {
      body: {
        subtype: 'doc',
        title: 'about hamsters',
        description: 'rodent lore',
        body_b64: b64('hamster'),
        embed: true,
      },
    });
    await call('POST', '/v1/objects', {
      body: {
        subtype: 'app:composable',
        title: 'hamster tracker',
        description: 'app for hamster facts',
        body_b64: b64('app'),
        embed: true,
      },
    });

    const r = await call('POST', '/v1/search', {
      body: { query: 'hamster', subtype_prefixes: ['app:'] },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: Array<{ subtype: string }> };
    // Prefix-only filter: every hit must be app:*.
    for (const hit of body.items) {
      expect(hit.subtype?.startsWith('app:')).toBe(true);
    }
  });

  // ─── PLAN-document-linking §10.5 D5: Group-by-Parent ──────────────────
  it('groups sub-doc hits under their parent skill when both match', async () => {
    // Create a skill + a resource doc, both should match query "alpha"
    const skill = (
      await (
        await call('POST', '/v1/objects', {
          body: {
            subtype: 'skill_manifest',
            title: 'alpha-skill',
            description: 'manifest for alpha',
            body_b64: b64('alpha skill body'),
          },
        })
      ).json()
    ).id as string;
    const doc = (
      await (
        await call('POST', '/v1/objects', {
          body: {
            subtype: 'doc',
            title: 'alpha-doc',
            description: 'alpha resource',
            body_b64: b64('alpha doc body'),
          },
        })
      ).json()
    ).id as string;
    // attach doc as resource of skill — makes doc is_subdoc=true
    await call('POST', `/v1/objects/${skill}/refs`, {
      body: { to_id: doc, role: 'resource' },
    });

    const r = await call('POST', '/v1/search', {
      body: { query: 'alpha', limit: 10 },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      items: Array<{
        id: string;
        title: string;
        childHits?: Array<{ id: string }>;
        linkedParent?: { id: string };
      }>;
    };
    // The skill should appear top-level; the doc should be its child (or
    // suppressed from top-level).
    const skillHit = body.items.find((h) => h.id === skill);
    const docTopLevel = body.items.find((h) => h.id === doc);
    expect(skillHit).toBeDefined();
    expect(skillHit?.childHits?.some((c) => c.id === doc)).toBe(true);
    expect(docTopLevel).toBeUndefined();
  });

  it('keeps orphan sub-doc top-level with linkedParent when parent did not match', async () => {
    // Create skill that does NOT match query, plus doc that DOES match
    const skill = (
      await (
        await call('POST', '/v1/objects', {
          body: {
            subtype: 'skill_manifest',
            title: 'zeta-skill',
            description: 'unrelated topic',
            body_b64: b64('zeta'),
          },
        })
      ).json()
    ).id as string;
    const doc = (
      await (
        await call('POST', '/v1/objects', {
          body: {
            subtype: 'doc',
            title: 'beta-doc',
            description: 'beta content',
            body_b64: b64('beta'),
          },
        })
      ).json()
    ).id as string;
    await call('POST', `/v1/objects/${skill}/refs`, {
      body: { to_id: doc, role: 'resource' },
    });

    const r = await call('POST', '/v1/search', {
      body: { query: 'beta', limit: 10 },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      items: Array<{
        id: string;
        title: string;
        linkedParent?: { id: string; title: string };
      }>;
    };
    const docHit = body.items.find((h) => h.id === doc);
    expect(docHit).toBeDefined();
    expect(docHit?.linkedParent?.id).toBe(skill);
    expect(docHit?.linkedParent?.title).toBe('zeta-skill');
  });
});

describe('error shape — Cross-Service Contract', () => {
  it('returns RFC 7807 Problem Details, not { error: { code, message } }', async () => {
    // Contract D-1 — fetch a missing object.
    const r = await call('GET', '/v1/objects/00000000-0000-0000-0000-000000000000');
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toContain('application/problem+json');
    const body = (await r.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('type');
    expect(body).toHaveProperty('title');
    expect(body).toHaveProperty('status');
    expect(body.status).toBe(404);
    // Adapter-expected shape would have `error.code` / `error.message`; verify
    // we do NOT emit that.
    expect(body).not.toHaveProperty('error');
  });

  it('soft-delete idempotency follows RFC 7807 on second attempt', async () => {
    const created = (await (
      await call('POST', '/v1/objects', { body: { subtype: 'doc', title: 'dx', body_b64: b64('x') } })
    ).json()) as { id: string };
    expect((await call('DELETE', `/v1/objects/${created.id}`)).status).toBe(204);
    // After soft-delete the object is not visible — second delete returns 404
    const r2 = await call('DELETE', `/v1/objects/${created.id}`);
    expect(r2.status).toBe(404);
    const body = (await r2.json()) as Record<string, unknown>;
    expect(body.status).toBe(404);
  });
});

describe('internal — erase-user', () => {
  it('POST /v1/internal/erase-user removes all owner data and returns the deletion summary', async () => {
    // Seed: USER_A has two docs
    currentUserId = USER_A;
    await call('POST', '/v1/objects', {
      body: { subtype: 'doc', title: 'A1', body_b64: b64('p1') },
    });
    await call('POST', '/v1/objects', {
      body: { subtype: 'doc', title: 'A2', body_b64: b64('p2') },
    });

    const r = await app.request('http://test/v1/internal/erase-user', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // SEC-K-009: scope-specific service-token middleware now lives on
        // the route. Test-env keeps only legacy SERVICE_TOKEN; the
        // middleware falls back to it when SERVICE_TOKEN_ERASE is unset.
        authorization: `Bearer ${process.env.SERVICE_TOKEN}`,
      },
      body: JSON.stringify({
        user_id: USER_A,
        confirmation_token: 'token-with-sufficient-length-1234567',
      }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { status: string; deleted: { objects: number } };
    // Contract D-10: adapter expects { deletedRows: number } — server returns
    // a richer summary. Document so the adapter team can adjust.
    expect(body.status).toBe('ok');
    expect(body.deleted.objects).toBe(2);
    expect(body).not.toHaveProperty('deletedRows');

    // Verify the data is actually gone
    const list = (await (await call('GET', '/v1/objects', { user: USER_A })).json()) as {
      items: unknown[];
    };
    expect(list.items).toEqual([]);
  });
});
