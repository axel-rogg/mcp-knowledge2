// RLS-Integration-Test: Uses Testcontainers Postgres + pgvector to verify
// that the row-level-security policies actually isolate users — even with
// a buggy application that forgets to filter by owner_id.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

let container: StartedPostgreSqlContainer;
let appClient: pg.Client;
let adminClient: pg.Client;
const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
    .withDatabase('knowledge')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();

  const rootClient = new pg.Client({ connectionString: container.getConnectionUri() });
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

  // Apply ALL migrations in lexikographischer Reihenfolge — sonst landet
  // Test gegen pre-ADR-0004-Schema (kind-Column NOT NULL aus 0000) waehrend
  // Production-Schema schon 0009_drop_kind hat. Pattern matched
  // `release_command = "npm run db:migrate"` in fly.toml.
  const migrationsDir = join(process.cwd(), 'drizzle', 'migrations');
  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    await rootClient.query(sql);
  }
  // Test-User in users-Tabelle inserten — Migration 0020 fuegt FK-Constraints
  // auf share_grants.granted_by/granted_to → users(id). Ohne diese Rows
  // fail't INSERT share_grants (granted_by, granted_to) mit FK-Violation.
  for (const id of [USER_A, USER_B, '33333333-3333-3333-3333-333333333333']) {
    await rootClient.query(
      `INSERT INTO users (id, email, status, created_at)
       VALUES ($1, $1 || '@test.org', 'active', 0) ON CONFLICT DO NOTHING`,
      [id],
    );
  }
  await rootClient.end();

  const host = container.getHost();
  const port = container.getPort();
  appClient = new pg.Client({
    host,
    port,
    database: 'knowledge',
    user: 'knowledge_app',
    password: 'app',
  });
  await appClient.connect();

  adminClient = new pg.Client({
    host,
    port,
    database: 'knowledge',
    user: 'knowledge_admin',
    password: 'admin',
  });
  await adminClient.connect();
}, 90_000);

afterAll(async () => {
  await appClient?.end();
  await adminClient?.end();
  await container?.stop();
});

beforeEach(async () => {
  // Reset state between tests (admin BYPASSRLS)
  await adminClient.query(`DELETE FROM object_vectors`);
  await adminClient.query(`DELETE FROM share_grants`);
  await adminClient.query(`DELETE FROM object_tags`);
  await adminClient.query(`DELETE FROM object_refs`);
  await adminClient.query(`DELETE FROM object_revisions`);
  await adminClient.query(`DELETE FROM objects`);
  await adminClient.query(`DELETE FROM user_quotas`);
  await adminClient.query(`DELETE FROM idempotency_records`);
  await adminClient.query(`DELETE FROM uploads`);
  await adminClient.query(`DELETE FROM audit_log`);
});

async function insertObject(asUser: string, opts: { title: string }) {
  await appClient.query('BEGIN');
  await appClient.query(`SELECT set_config('app.current_user', $1, true)`, [asUser]);
  const r = await appClient.query<{ id: string }>(
    `INSERT INTO objects (owner_id, subtype, title, body_inline, body_size, nonce, created_at, updated_at)
     VALUES ($1, 'doc', $2, '\\x00'::bytea, 5, '\\xaaaaaaaaaaaaaaaaaaaaaaaa'::bytea, 0, 0)
     RETURNING id`,
    [asUser, opts.title],
  );
  await appClient.query('COMMIT');
  const id = r.rows[0]?.id;
  if (!id) throw new Error('insert returned no id');
  return id;
}

async function selectAllAs(userId: string) {
  await appClient.query('BEGIN');
  await appClient.query(`SELECT set_config('app.current_user', $1, true)`, [userId]);
  const r = await appClient.query<{ id: string; owner_id: string; title: string }>(
    `SELECT id, owner_id, title FROM objects`,
  );
  await appClient.query('COMMIT');
  return r.rows;
}

// Helper: run a query block as a given user (sets app.current_user inside tx).
async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  await appClient.query('BEGIN');
  await appClient.query(`SELECT set_config('app.current_user', $1, true)`, [userId]);
  try {
    return await fn();
  } finally {
    await appClient.query('COMMIT').catch(() => appClient.query('ROLLBACK'));
  }
}

// Helper: same, but expect the inner fn to throw (RLS WITH CHECK violation
// rolls the transaction back). Returns the captured error.
async function asUserExpectError(userId: string, fn: () => Promise<unknown>): Promise<Error> {
  await appClient.query('BEGIN');
  await appClient.query(`SELECT set_config('app.current_user', $1, true)`, [userId]);
  try {
    await fn();
    await appClient.query('ROLLBACK');
    throw new Error('expected error but operation succeeded');
  } catch (e) {
    await appClient.query('ROLLBACK').catch(() => undefined);
    return e as Error;
  }
}

describe('RLS: objects visibility', () => {
  it('blocks user B from seeing user A objects', async () => {
    await insertObject(USER_A, { title: 'secret-A' });
    const asB = await selectAllAs(USER_B);
    expect(asB).toEqual([]);
  });

  it('lets the owner see their own objects', async () => {
    const id = await insertObject(USER_A, { title: 'mine' });
    const asA = await selectAllAs(USER_A);
    expect(asA.map((r) => r.id)).toContain(id);
  });

  it('reveals the row to a shared user after grant', async () => {
    const id = await insertObject(USER_A, { title: 'shareable' });

    // user A grants to user B
    await appClient.query('BEGIN');
    await appClient.query(`SELECT set_config('app.current_user', $1, true)`, [USER_A]);
    await appClient.query(
      `INSERT INTO share_grants (resource_id, granted_to, granted_by, scope, granted_at)
       VALUES ($1, $2, $3, 'read', 0)`,
      [id, USER_B, USER_A],
    );
    await appClient.query('COMMIT');

    const asB = await selectAllAs(USER_B);
    expect(asB.map((r) => r.id)).toContain(id);
  });

  it('hides revoked shares', async () => {
    const id = await insertObject(USER_A, { title: 'temporal' });
    await appClient.query('BEGIN');
    await appClient.query(`SELECT set_config('app.current_user', $1, true)`, [USER_A]);
    await appClient.query(
      `INSERT INTO share_grants (resource_id, granted_to, granted_by, scope, granted_at, revoked_at)
       VALUES ($1, $2, $3, 'read', 0, 1)`,
      [id, USER_B, USER_A],
    );
    await appClient.query('COMMIT');

    const asB = await selectAllAs(USER_B);
    expect(asB.map((r) => r.id)).not.toContain(id);
  });

  it('admin BYPASSRLS sees everything', async () => {
    await insertObject(USER_A, { title: 'a' });
    await insertObject(USER_B, { title: 'b' });
    const r = await adminClient.query<{ id: string }>(`SELECT id FROM objects`);
    expect(r.rowCount).toBe(2);
  });
});

// ─── object_vectors (SEC-K-023 / Migration 0014: owner-only) ──────────────
//
// Pre-0014 hatte vec_via_object dieselbe Sichtbarkeit wie objects (owner +
// shared-read). Damit konnte ein read-only-Grantee den Embedding-Vektor
// lesen und via Morris-2023 Inversion partial den Body rekonstruieren — auch
// wenn sie nur Title/Description sehen sollten. Post-0014 ist die Policy
// auf vec_owner_only umbenannt + WHERE owner_id check.
describe('RLS: object_vectors owner-only', () => {
  it('blocks shared-read grantee from reading owner vectors', async () => {
    const id = await insertObject(USER_A, { title: 'with-vec' });

    // Insert a vector for A's object as A.
    await asUser(USER_A, async () => {
      await appClient.query(
        `INSERT INTO object_vectors (object_id, embedding, model, embedded_at)
         VALUES ($1, $2::vector, 'test-model', 0)`,
        [id, `[${Array.from({ length: 1024 }, () => 0).join(',')}]`],
      );
      // Grant read to B
      await appClient.query(
        `INSERT INTO share_grants (resource_id, granted_to, granted_by, scope, granted_at)
         VALUES ($1, $2, $3, 'read', 0)`,
        [id, USER_B, USER_A],
      );
    });

    // B can see the object (share_grant) but NOT its vector.
    const objsAsB = await selectAllAs(USER_B);
    expect(objsAsB.map((r) => r.id)).toContain(id);

    const vecsAsB = await asUser(USER_B, () =>
      appClient.query(`SELECT object_id FROM object_vectors`),
    );
    expect(vecsAsB.rows).toEqual([]);
  });

  it('lets owner read their own vectors', async () => {
    const id = await insertObject(USER_A, { title: 'mine-vec' });
    await asUser(USER_A, () =>
      appClient.query(
        `INSERT INTO object_vectors (object_id, embedding, model, embedded_at)
         VALUES ($1, $2::vector, 'test-model', 0)`,
        [id, `[${Array.from({ length: 1024 }, () => 0).join(',')}]`],
      ),
    );

    const vecsAsA = await asUser(USER_A, () =>
      appClient.query<{ object_id: string }>(`SELECT object_id FROM object_vectors`),
    );
    expect(vecsAsA.rows.map((r) => r.object_id)).toContain(id);
  });

  it('blocks INSERT of vector for foreign object', async () => {
    const id = await insertObject(USER_A, { title: 'a-doc' });
    // B tries to attach a vector to A's object → WITH CHECK fails.
    const err = await asUserExpectError(USER_B, () =>
      appClient.query(
        `INSERT INTO object_vectors (object_id, embedding, model, embedded_at)
         VALUES ($1, $2::vector, 'test-model', 0)`,
        [id, `[${Array.from({ length: 1024 }, () => 0).join(',')}]`],
      ),
    );
    expect(err.message).toMatch(/row-level security|violates/i);
  });
});

// ─── audit_log: actor-own SELECT, INSERT app-emitted ──────────────────────
describe('RLS: audit_log isolation', () => {
  it('blocks user B from reading user A audit rows', async () => {
    await asUser(USER_A, () =>
      appClient.query(
        `INSERT INTO audit_log (ts, actor_user_id, action, result)
         VALUES (0, $1, 'test.event', 'success')`,
        [USER_A],
      ),
    );

    const rowsAsB = await asUser(USER_B, () =>
      appClient.query(`SELECT id FROM audit_log`),
    );
    expect(rowsAsB.rows).toEqual([]);
  });

  it('lets owner read their own audit rows', async () => {
    await asUser(USER_A, () =>
      appClient.query(
        `INSERT INTO audit_log (ts, actor_user_id, action, result)
         VALUES (0, $1, 'test.event', 'success')`,
        [USER_A],
      ),
    );

    const rowsAsA = await asUser(USER_A, () =>
      appClient.query<{ action: string }>(`SELECT action FROM audit_log`),
    );
    expect(rowsAsA.rows.map((r) => r.action)).toContain('test.event');
  });

  it('rejects UPDATE/DELETE on audit_log (append-only via REVOKE)', async () => {
    await asUser(USER_A, () =>
      appClient.query(
        `INSERT INTO audit_log (ts, actor_user_id, action, result)
         VALUES (0, $1, 'mutable?', 'success')`,
        [USER_A],
      ),
    );

    const updateErr = await asUserExpectError(USER_A, () =>
      appClient.query(`UPDATE audit_log SET action = 'rewrite'`),
    );
    expect(updateErr.message).toMatch(/permission denied|denied for|insufficient/i);

    const deleteErr = await asUserExpectError(USER_A, () =>
      appClient.query(`DELETE FROM audit_log`),
    );
    expect(deleteErr.message).toMatch(/permission denied|denied for|insufficient/i);
  });
});

// ─── idempotency_records: user-isolated replay store ─────────────────────
//
// SEC: if B could read A's idem-records, B could observe A's request
// patterns + responses (response_body is the raw plaintext API response).
// If B could write/overwrite A's idem-key, B could prime cache entries to
// replay-forge A's future responses.
describe('RLS: idempotency_records isolation', () => {
  it('blocks cross-user read', async () => {
    await asUser(USER_A, () =>
      appClient.query(
        `INSERT INTO idempotency_records (user_id, idem_key, response_status, created_at, expires_at)
         VALUES ($1, 'k1', 200, 0, 9999999999999)`,
        [USER_A],
      ),
    );

    const rowsAsB = await asUser(USER_B, () =>
      appClient.query(`SELECT idem_key FROM idempotency_records`),
    );
    expect(rowsAsB.rows).toEqual([]);
  });

  it('blocks B from inserting a record claiming to be A', async () => {
    const err = await asUserExpectError(USER_B, () =>
      appClient.query(
        `INSERT INTO idempotency_records (user_id, idem_key, response_status, created_at, expires_at)
         VALUES ($1, 'forged', 200, 0, 9999999999999)`,
        [USER_A],
      ),
    );
    expect(err.message).toMatch(/row-level security|violates/i);
  });
});

// ─── user_quotas: per-user isolation ─────────────────────────────────────
describe('RLS: user_quotas isolation', () => {
  it('blocks cross-user read of quota state', async () => {
    await asUser(USER_A, () =>
      appClient.query(
        `INSERT INTO user_quotas (user_id, embed_calls_resetat, created_at, updated_at)
         VALUES ($1, 0, 0, 0)`,
        [USER_A],
      ),
    );

    const rowsAsB = await asUser(USER_B, () =>
      appClient.query(`SELECT user_id FROM user_quotas`),
    );
    expect(rowsAsB.rows).toEqual([]);
  });

  it('blocks B from manipulating A quota (WITH CHECK)', async () => {
    const err = await asUserExpectError(USER_B, () =>
      appClient.query(
        `INSERT INTO user_quotas (user_id, embed_calls_resetat, created_at, updated_at)
         VALUES ($1, 0, 0, 0)`,
        [USER_A],
      ),
    );
    expect(err.message).toMatch(/row-level security|violates/i);
  });
});

// ─── uploads: owner-only ─────────────────────────────────────────────────
describe('RLS: uploads isolation', () => {
  it('blocks cross-user read', async () => {
    await asUser(USER_A, () =>
      appClient.query(
        `INSERT INTO uploads (owner_id, status, blob_key, created_at, expires_at)
         VALUES ($1, 'pending', 'k', 0, 9999999999999)`,
        [USER_A],
      ),
    );

    const rowsAsB = await asUser(USER_B, () =>
      appClient.query(`SELECT id FROM uploads`),
    );
    expect(rowsAsB.rows).toEqual([]);
  });

  it('blocks B from inserting an upload claiming A as owner', async () => {
    const err = await asUserExpectError(USER_B, () =>
      appClient.query(
        `INSERT INTO uploads (owner_id, status, blob_key, created_at, expires_at)
         VALUES ($1, 'pending', 'forged', 0, 9999999999999)`,
        [USER_A],
      ),
    );
    expect(err.message).toMatch(/row-level security|violates/i);
  });
});

// ─── object_refs / object_tags / object_revisions ────────────────────────
//
// Visibility delegates to the parent objects-row via EXISTS-subquery. So
// for a non-shared object, B can't see refs/tags/revs either. For a
// share_grant=read object, B *can* still see refs/tags/revs (the delegated
// policy is owner-or-shared). Note: vectors got tightened to owner-only in
// 0014; refs/tags/revs deliberately stay broader because the metadata is
// what a read-grantee needs to render a doc.
describe('RLS: object_refs/tags/revisions delegate to parent', () => {
  it('blocks non-shared user from reading refs', async () => {
    const fromId = await insertObject(USER_A, { title: 'from' });
    const toId = await insertObject(USER_A, { title: 'to' });
    await asUser(USER_A, () =>
      appClient.query(
        `INSERT INTO object_refs (from_id, to_id, role, created_at)
         VALUES ($1, $2, 'related', 0)`,
        [fromId, toId],
      ),
    );

    const rowsAsB = await asUser(USER_B, () =>
      appClient.query(`SELECT from_id FROM object_refs`),
    );
    expect(rowsAsB.rows).toEqual([]);
  });

  it('blocks non-shared user from reading tags', async () => {
    const id = await insertObject(USER_A, { title: 'tagged' });
    await asUser(USER_A, () =>
      appClient.query(
        `INSERT INTO object_tags (object_id, tag, created_at)
         VALUES ($1, 'private', 0)`,
        [id],
      ),
    );

    const rowsAsB = await asUser(USER_B, () =>
      appClient.query(`SELECT tag FROM object_tags`),
    );
    expect(rowsAsB.rows).toEqual([]);
  });

  it('blocks non-shared user from reading revisions', async () => {
    const id = await insertObject(USER_A, { title: 'versioned' });
    await asUser(USER_A, () =>
      appClient.query(
        `INSERT INTO object_revisions (object_id, version, created_at)
         VALUES ($1, 1, 0)`,
        [id],
      ),
    );

    const rowsAsB = await asUser(USER_B, () =>
      appClient.query(`SELECT version FROM object_revisions`),
    );
    expect(rowsAsB.rows).toEqual([]);
  });

  it('blocks B from inserting a ref pointing into A objects (WITH CHECK)', async () => {
    const fromId = await insertObject(USER_A, { title: 'from-a' });
    const ownB = await insertObject(USER_B, { title: 'own-b' });
    // B tries to forge a ref FROM A's object → fails because B can't see from_id.
    const err = await asUserExpectError(USER_B, () =>
      appClient.query(
        `INSERT INTO object_refs (from_id, to_id, role, created_at)
         VALUES ($1, $2, 'forged', 0)`,
        [fromId, ownB],
      ),
    );
    expect(err.message).toMatch(/row-level security|violates/i);
  });
});

// ─── share_grants: only INSERTable by the owner, only readable by parties
describe('RLS: share_grants self-or-owner', () => {
  it('blocks B from inserting a grant for an object B does not own', async () => {
    const id = await insertObject(USER_A, { title: 'a-doc' });
    // B tries to grant B-self read on A's doc → WITH CHECK fails (not owner).
    const err = await asUserExpectError(USER_B, () =>
      appClient.query(
        `INSERT INTO share_grants (resource_id, granted_to, granted_by, scope, granted_at)
         VALUES ($1, $2, $2, 'read', 0)`,
        [id, USER_B],
      ),
    );
    expect(err.message).toMatch(/row-level security|violates/i);
  });

  it('blocks third-party from seeing unrelated grants', async () => {
    const THIRD = '33333333-3333-3333-3333-333333333333';
    const id = await insertObject(USER_A, { title: 'shareable' });
    await asUser(USER_A, () =>
      appClient.query(
        `INSERT INTO share_grants (resource_id, granted_to, granted_by, scope, granted_at)
         VALUES ($1, $2, $3, 'read', 0)`,
        [id, USER_B, USER_A],
      ),
    );

    const asThird = await asUser(THIRD, () =>
      appClient.query(`SELECT resource_id FROM share_grants`),
    );
    expect(asThird.rows).toEqual([]);

    // Both A (granter) and B (grantee) DO see it.
    const asA = await asUser(USER_A, () =>
      appClient.query(`SELECT resource_id FROM share_grants`),
    );
    expect(asA.rows.length).toBe(1);

    const asB = await asUser(USER_B, () =>
      appClient.query(`SELECT resource_id FROM share_grants`),
    );
    expect(asB.rows.length).toBe(1);
  });

  // Grantee CAN revoke their own grant (grants_self USING/WITH CHECK passes
  // because granted_to=current_user). That's "decline a share" — a legitimate
  // UX. So we test the *third-party* case: someone neither granted-by nor
  // granted-to has no business touching the row.
  it('blocks third-party from revoking somebody else grants', async () => {
    const THIRD = '33333333-3333-3333-3333-333333333333';
    const id = await insertObject(USER_A, { title: 'shareable' });
    await asUser(USER_A, () =>
      appClient.query(
        `INSERT INTO share_grants (resource_id, granted_to, granted_by, scope, granted_at)
         VALUES ($1, $2, $3, 'read', 0)`,
        [id, USER_B, USER_A],
      ),
    );

    // THIRD party UPDATE: grants_self USING blocks it (granted_to!=THIRD AND
    // granted_by!=THIRD), and grants_update_by_owner USING blocks it. So the
    // UPDATE hits 0 rows — no error, just no effect.
    await asUser(THIRD, () =>
      appClient.query(
        `UPDATE share_grants SET revoked_at = 999 WHERE resource_id = $1`,
        [id],
      ),
    );

    const r = await adminClient.query<{ revoked_at: string | null }>(
      `SELECT revoked_at FROM share_grants WHERE resource_id = $1`,
      [id],
    );
    expect(r.rows[0]?.revoked_at).toBeNull();
  });
});
