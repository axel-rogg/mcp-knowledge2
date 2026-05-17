// RLS-Integration-Test: Uses Testcontainers Postgres + pgvector to verify
// that the row-level-security policies actually isolate users — even with
// a buggy application that forgets to filter by owner_id.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
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

  const migrationsDir = join(process.cwd(), 'drizzle', 'migrations');
  const init = await readFile(join(migrationsDir, '0000_init.sql'), 'utf8');
  const rls = await readFile(join(migrationsDir, '0001_rls.sql'), 'utf8');
  await rootClient.query(init);
  await rootClient.query(rls);
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
