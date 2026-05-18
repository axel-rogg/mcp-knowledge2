// Group-Sharing RLS-Integration-Tests (Phase 1, Item 6g).
//
// Plan-Ref: docs/security/TEST-PLAN-SHARING-PHASE-1-2026-05-17.md §3
// Crypto-Review: CRYPTO-REVIEW-GROUP-SHARING-2026-05-17.md
// Build-Refs: Migrationen 0019/0020, group-crypto.ts, groups.ts, shares.ts
//
// Pattern aus tests/integration/rls.test.ts: Testcontainers Postgres 16
// mit pgvector, alle Migrations lexikographisch applied, knowledge_app
// (NICHT BYPASSRLS) + knowledge_admin (BYPASSRLS).
//
// Scope: ECHTE RLS-Verifikation. Crypto-Wrap-Operationen sind in
// tests/unit/group-crypto.test.ts isoliert getestet. Hier nur DB-Sicht:
// werden RLS-Policies korrekt evaluiert, sind Cross-User-Reads geblockt,
// triggert die share_grants-XOR-Constraint, etc.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

let container: StartedPostgreSqlContainer;
let appClient: pg.Client;
let adminClient: pg.Client;

// 5 Test-User: 1 Owner, 2 Group-Members, 1 Cross-Group-Member, 1 Non-Member
const USER_OWNER = '11111111-1111-1111-1111-111111111111';
const USER_MEMBER_1 = '22222222-2222-2222-2222-222222222222';
const USER_MEMBER_2 = '33333333-3333-3333-3333-333333333333';
const USER_OTHER_GROUP = '44444444-4444-4444-4444-444444444444';
const USER_NON_MEMBER = '55555555-5555-5555-5555-555555555555';

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
  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    await rootClient.query(sql);
  }
  // Test-User in users-Tabelle inserten (für FK-Constraints aus Mig 0020)
  for (const id of [
    USER_OWNER,
    USER_MEMBER_1,
    USER_MEMBER_2,
    USER_OTHER_GROUP,
    USER_NON_MEMBER,
  ]) {
    await rootClient.query(
      `INSERT INTO users (id, email, status, created_at)
       VALUES ($1::uuid, $1::text || '@test.org', 'active', 0) ON CONFLICT DO NOTHING`,
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
  await adminClient.query(`DELETE FROM share_grants`);
  await adminClient.query(`DELETE FROM group_members`);
  await adminClient.query(`DELETE FROM groups`);
  await adminClient.query(`DELETE FROM object_refs`);
  await adminClient.query(`DELETE FROM object_revisions`);
  await adminClient.query(`DELETE FROM object_vectors`);
  await adminClient.query(`DELETE FROM objects`);
});

// ─── Fixtures ──────────────────────────────────────────────────────────────

async function seedObject(ownerId: string, opts: {
  title: string;
  dekScheme?: 'owner_hkdf' | 'per_object';
  subtype?: string;
}): Promise<string> {
  const r = await adminClient.query<{ id: string }>(
    `INSERT INTO objects (owner_id, subtype, title, body_inline, body_size, nonce,
                          dek_scheme, owner_wrapped_dek, created_at, updated_at)
     VALUES ($1, $2, $3, '\\x00'::bytea, 5, '\\xaaaaaaaaaaaaaaaaaaaaaaaa'::bytea,
             $4, $5, 0, 0)
     RETURNING id`,
    [
      ownerId,
      opts.subtype ?? 'doc',
      opts.title,
      opts.dekScheme ?? 'owner_hkdf',
      opts.dekScheme === 'per_object' ? randomBytes(60) : null,
    ],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('seedObject returned no id');
  return id;
}

async function seedGroup(ownerId: string, opts: { name?: string } = {}): Promise<string> {
  const wrappedMaster = randomBytes(120);
  const r = await adminClient.query<{ id: string }>(
    `INSERT INTO groups (owner_id, name, wrapped_master_dek, master_version, created_at)
     VALUES ($1, $2, $3, 1, 0)
     RETURNING id`,
    [ownerId, opts.name ?? 'test-group', wrappedMaster],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('seedGroup returned no id');
  // Owner als initialer admin-Member
  await adminClient.query(
    `INSERT INTO group_members (group_id, user_id, role, wrapped_group_dek,
                                wrapped_for_master_version, joined_at)
     VALUES ($1, $2, 'admin', $3, 1, 0)`,
    [id, ownerId, randomBytes(60)],
  );
  return id;
}

async function addGroupMember(
  groupId: string,
  userId: string,
  opts: { role?: 'admin' | 'member'; removedAt?: number | null; masterVersion?: number } = {},
): Promise<void> {
  await adminClient.query(
    `INSERT INTO group_members (group_id, user_id, role, wrapped_group_dek,
                                wrapped_for_master_version, joined_at, removed_at)
     VALUES ($1, $2, $3, $4, $5, 0, $6)`,
    [
      groupId,
      userId,
      opts.role ?? 'member',
      randomBytes(60),
      opts.masterVersion ?? 1,
      opts.removedAt ?? null,
    ],
  );
}

async function shareWithGroup(opts: {
  resourceId: string;
  groupId: string;
  grantedBy: string;
  viaCascadeFrom?: string | null;
  scope?: 'read' | 'write';
}): Promise<string> {
  const r = await adminClient.query<{ id: string }>(
    `INSERT INTO share_grants (resource_id, granted_to, granted_to_group_id, granted_by,
                                scope, granted_at, wrapped_object_dek, group_master_version,
                                via_cascade_from_object_id)
     VALUES ($1, NULL, $2, $3, $4, 0, $5, 1, $6)
     RETURNING id`,
    [
      opts.resourceId,
      opts.groupId,
      opts.grantedBy,
      opts.scope ?? 'read',
      randomBytes(60),
      opts.viaCascadeFrom ?? null,
    ],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('shareWithGroup returned no id');
  return id;
}

async function selectObjectsAs(userId: string): Promise<Array<{ id: string; title: string | null }>> {
  await appClient.query('BEGIN');
  await appClient.query(`SELECT set_config('app.current_user', $1, true)`, [userId]);
  const r = await appClient.query<{ id: string; title: string | null }>(
    `SELECT id, title FROM objects`,
  );
  await appClient.query('COMMIT');
  return r.rows;
}

async function selectGroupsAs(userId: string): Promise<Array<{ id: string; name: string }>> {
  await appClient.query('BEGIN');
  await appClient.query(`SELECT set_config('app.current_user', $1, true)`, [userId]);
  const r = await appClient.query<{ id: string; name: string }>(
    `SELECT id, name FROM groups`,
  );
  await appClient.query('COMMIT');
  return r.rows;
}

async function selectGroupMembersAs(
  userId: string,
  groupId: string,
): Promise<Array<{ user_id: string; role: string }>> {
  await appClient.query('BEGIN');
  await appClient.query(`SELECT set_config('app.current_user', $1, true)`, [userId]);
  const r = await appClient.query<{ user_id: string; role: string }>(
    `SELECT user_id, role FROM group_members WHERE group_id = $1`,
    [groupId],
  );
  await appClient.query('COMMIT');
  return r.rows;
}

async function selectShareGrantsAs(
  userId: string,
  resourceId: string,
): Promise<Array<{ id: string }>> {
  await appClient.query('BEGIN');
  await appClient.query(`SELECT set_config('app.current_user', $1, true)`, [userId]);
  const r = await appClient.query<{ id: string }>(
    `SELECT id FROM share_grants WHERE resource_id = $1`,
    [resourceId],
  );
  await appClient.query('COMMIT');
  return r.rows;
}

// ─── Pflicht-RLS-Tests (10 Cases aus Test-Plan) ────────────────────────────

describe('RLS: Group-Sharing Phase 1', () => {
  it('(a) Group-Member sieht shared Object via objects.owner_or_shared_read', async () => {
    const objectId = await seedObject(USER_OWNER, {
      title: 'shared-doc',
      dekScheme: 'per_object',
    });
    const groupId = await seedGroup(USER_OWNER);
    await addGroupMember(groupId, USER_MEMBER_1);
    await shareWithGroup({ resourceId: objectId, groupId, grantedBy: USER_OWNER });

    const asMember = await selectObjectsAs(USER_MEMBER_1);
    expect(asMember).toHaveLength(1);
    expect(asMember[0]!.id).toBe(objectId);
  });

  it('(b) Non-Member sieht shared Object NICHT (RLS-Block)', async () => {
    const objectId = await seedObject(USER_OWNER, {
      title: 'shared-doc',
      dekScheme: 'per_object',
    });
    const groupId = await seedGroup(USER_OWNER);
    await addGroupMember(groupId, USER_MEMBER_1);
    await shareWithGroup({ resourceId: objectId, groupId, grantedBy: USER_OWNER });

    const asNonMember = await selectObjectsAs(USER_NON_MEMBER);
    expect(asNonMember).toHaveLength(0);
  });

  it('(c) Removed Member sieht shared Object NICHT (removed_at filter)', async () => {
    const objectId = await seedObject(USER_OWNER, {
      title: 'shared-doc',
      dekScheme: 'per_object',
    });
    const groupId = await seedGroup(USER_OWNER);
    await addGroupMember(groupId, USER_MEMBER_1, { removedAt: 1000 });
    await shareWithGroup({ resourceId: objectId, groupId, grantedBy: USER_OWNER });

    const asRemoved = await selectObjectsAs(USER_MEMBER_1);
    expect(asRemoved).toHaveLength(0);
  });

  it('(d) Owner sieht eigene Objects unverändert (legacy + per_object)', async () => {
    const legacyId = await seedObject(USER_OWNER, { title: 'legacy' });
    const newId = await seedObject(USER_OWNER, {
      title: 'new',
      dekScheme: 'per_object',
    });

    const asOwner = await selectObjectsAs(USER_OWNER);
    expect(asOwner.map((o) => o.id).sort()).toEqual([legacyId, newId].sort());
  });

  it('(e) Cross-Group-Leak-Block: User in Group-X sieht Group-Y-Object NICHT', async () => {
    const objectId = await seedObject(USER_OWNER, {
      title: 'group-y-only',
      dekScheme: 'per_object',
    });
    const groupX = await seedGroup(USER_OWNER, { name: 'group-x' });
    const groupY = await seedGroup(USER_OWNER, { name: 'group-y' });
    await addGroupMember(groupX, USER_OTHER_GROUP);
    await addGroupMember(groupY, USER_MEMBER_1);
    // Object nur in Group-Y geshared
    await shareWithGroup({ resourceId: objectId, groupId: groupY, grantedBy: USER_OWNER });

    // Group-X-Member darf nicht sehen
    const asGroupXMember = await selectObjectsAs(USER_OTHER_GROUP);
    expect(asGroupXMember).toHaveLength(0);
    // Group-Y-Member darf sehen
    const asGroupYMember = await selectObjectsAs(USER_MEMBER_1);
    expect(asGroupYMember).toHaveLength(1);
  });

  it('(f) Cascade-Share macht Resource sichtbar für Members ohne direkten Grant', async () => {
    const skillId = await seedObject(USER_OWNER, {
      title: 'skill',
      subtype: 'skill_manifest',
      dekScheme: 'per_object',
    });
    const docId = await seedObject(USER_OWNER, {
      title: 'resource',
      dekScheme: 'per_object',
    });
    const groupId = await seedGroup(USER_OWNER);
    await addGroupMember(groupId, USER_MEMBER_1);

    // Direct share auf Skill, Cascade auf Resource
    await shareWithGroup({ resourceId: skillId, groupId, grantedBy: USER_OWNER });
    await shareWithGroup({
      resourceId: docId,
      groupId,
      grantedBy: USER_OWNER,
      viaCascadeFrom: skillId,
    });

    const asMember = await selectObjectsAs(USER_MEMBER_1);
    expect(asMember.map((o) => o.id).sort()).toEqual([skillId, docId].sort());
  });

  it('(g) Revoked Share macht Resource wieder unsichtbar', async () => {
    const objectId = await seedObject(USER_OWNER, {
      title: 'soon-revoked',
      dekScheme: 'per_object',
    });
    const groupId = await seedGroup(USER_OWNER);
    await addGroupMember(groupId, USER_MEMBER_1);
    const shareId = await shareWithGroup({
      resourceId: objectId,
      groupId,
      grantedBy: USER_OWNER,
    });

    // Vor Revoke: sichtbar
    expect(await selectObjectsAs(USER_MEMBER_1)).toHaveLength(1);

    // Revoke
    await adminClient.query(`UPDATE share_grants SET revoked_at = 1000 WHERE id = $1`, [shareId]);

    // Nach Revoke: unsichtbar
    expect(await selectObjectsAs(USER_MEMBER_1)).toHaveLength(0);
  });

  it('(h) groups-Tabelle: Member sieht eigene Groups, Owner sieht eigene Groups', async () => {
    const groupOwned = await seedGroup(USER_OWNER, { name: 'owner-group' });
    const groupMember = await seedGroup(USER_NON_MEMBER, { name: 'foreign-group' });
    await addGroupMember(groupMember, USER_MEMBER_1);

    // Owner sieht eigene
    const asOwner = await selectGroupsAs(USER_OWNER);
    expect(asOwner.map((g) => g.id)).toContain(groupOwned);
    expect(asOwner.map((g) => g.id)).not.toContain(groupMember);

    // Member sieht Member-of
    const asMember = await selectGroupsAs(USER_MEMBER_1);
    expect(asMember.map((g) => g.id)).toContain(groupMember);
    expect(asMember.map((g) => g.id)).not.toContain(groupOwned);

    // Non-Member sieht nichts
    const asStranger = await selectGroupsAs(USER_NON_MEMBER);
    expect(asStranger.map((g) => g.id)).toContain(groupMember); // owner
    expect(asStranger.map((g) => g.id)).not.toContain(groupOwned);
  });

  it('(i) group_members-Tabelle: Phase-2-2 — aktive Member sehen alle aktiven Member', async () => {
    // P2-2-Decision (Mig 0023): Cross-Member-Visibility via SECURITY DEFINER
    // helper `is_active_member_of` aus Mig 0022. Aktive Member sehen jetzt
    // alle anderen aktiven Member desselben Group. Owner sieht alle (auch
    // removed). Non-Member sieht nichts.
    const groupId = await seedGroup(USER_OWNER);
    await addGroupMember(groupId, USER_MEMBER_1);
    await addGroupMember(groupId, USER_MEMBER_2);

    // Member-1 sieht alle 3 aktiven Member (Owner + member-1 + member-2)
    const asMember1 = await selectGroupMembersAs(USER_MEMBER_1, groupId);
    expect(asMember1).toHaveLength(3);
    expect(asMember1.map((m) => m.user_id).sort()).toEqual(
      [USER_OWNER, USER_MEMBER_1, USER_MEMBER_2].sort(),
    );
    // Owner sieht alle 3
    const asOwner = await selectGroupMembersAs(USER_OWNER, groupId);
    expect(asOwner).toHaveLength(3);
    // Non-Member sieht nichts
    const asStranger = await selectGroupMembersAs(USER_NON_MEMBER, groupId);
    expect(asStranger).toHaveLength(0);
  });

  it('(j) share_grants RESTRICTIVE INSERT: non-Owner kann keinen Group-Grant inserten', async () => {
    const objectId = await seedObject(USER_OWNER, {
      title: 'owners-doc',
      dekScheme: 'per_object',
    });
    const groupId = await seedGroup(USER_OWNER);
    await addGroupMember(groupId, USER_MEMBER_1);

    // Member-1 versucht zu sharen (granted_by=USER_MEMBER_1) — RESTRICTIVE-
    // INSERT-Policy aus 0019 verlangt:
    //   granted_by = current_user AND objects.owner_id = current_user
    //   AND groups.owner_id = current_user
    // Member-1 ist weder Object-Owner noch Group-Owner → INSERT failt.
    await appClient.query('BEGIN');
    await appClient.query(`SELECT set_config('app.current_user', $1, true)`, [USER_MEMBER_1]);
    let rejected = false;
    try {
      await appClient.query(
        `INSERT INTO share_grants (resource_id, granted_to_group_id, granted_by, scope,
                                   granted_at, wrapped_object_dek, group_master_version)
         VALUES ($1, $2, $3, 'read', 0, $4, 1)`,
        [objectId, groupId, USER_MEMBER_1, randomBytes(60)],
      );
      await appClient.query('COMMIT');
    } catch {
      rejected = true;
      await appClient.query('ROLLBACK').catch(() => undefined);
    }
    expect(rejected).toBe(true);
  });
});

// ─── Edge-Cases (Test-Plan §3 k-o) ─────────────────────────────────────────

describe('RLS: Group-Sharing Edge-Cases', () => {
  it('(k) XOR-Constraint: weder granted_to noch granted_to_group_id → INSERT failt', async () => {
    const objectId = await seedObject(USER_OWNER, {
      title: 'doc',
      dekScheme: 'per_object',
    });

    let rejected = false;
    try {
      await adminClient.query(
        `INSERT INTO share_grants (resource_id, granted_to, granted_to_group_id,
                                   granted_by, scope, granted_at)
         VALUES ($1, NULL, NULL, $2, 'read', 0)`,
        [objectId, USER_OWNER],
      );
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  it('(l) XOR-Constraint: beide granted_to UND granted_to_group_id → INSERT failt', async () => {
    const objectId = await seedObject(USER_OWNER, {
      title: 'doc',
      dekScheme: 'per_object',
    });
    const groupId = await seedGroup(USER_OWNER);

    let rejected = false;
    try {
      await adminClient.query(
        `INSERT INTO share_grants (resource_id, granted_to, granted_to_group_id,
                                   granted_by, scope, granted_at)
         VALUES ($1, $2, $3, $4, 'read', 0)`,
        [objectId, USER_MEMBER_1, groupId, USER_OWNER],
      );
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  it('(m) Direct-Share-Uniqueness: zweiter direct-Share auf gleiche (resource, group) failt', async () => {
    const objectId = await seedObject(USER_OWNER, {
      title: 'doc',
      dekScheme: 'per_object',
    });
    const groupId = await seedGroup(USER_OWNER);

    await shareWithGroup({ resourceId: objectId, groupId, grantedBy: USER_OWNER });
    // Zweiter direct-Share auf gleiches Paar → UNIQUE-Index 0020 sollte blocken
    let rejected = false;
    try {
      await shareWithGroup({ resourceId: objectId, groupId, grantedBy: USER_OWNER });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  it('(n) Diamond-Cascade: Doc via Skill-A UND Skill-B in Group → 2 Cascade-Shares', async () => {
    const skillA = await seedObject(USER_OWNER, {
      title: 'skill-a',
      subtype: 'skill_manifest',
      dekScheme: 'per_object',
    });
    const skillB = await seedObject(USER_OWNER, {
      title: 'skill-b',
      subtype: 'skill_manifest',
      dekScheme: 'per_object',
    });
    const docId = await seedObject(USER_OWNER, {
      title: 'shared-doc',
      dekScheme: 'per_object',
    });
    const groupId = await seedGroup(USER_OWNER);

    await shareWithGroup({ resourceId: skillA, groupId, grantedBy: USER_OWNER });
    await shareWithGroup({ resourceId: skillB, groupId, grantedBy: USER_OWNER });
    // Cascade von skillA
    await shareWithGroup({
      resourceId: docId,
      groupId,
      grantedBy: USER_OWNER,
      viaCascadeFrom: skillA,
    });
    // Cascade von skillB — sollte funktionieren (anderer via_cascade_from_object_id)
    await shareWithGroup({
      resourceId: docId,
      groupId,
      grantedBy: USER_OWNER,
      viaCascadeFrom: skillB,
    });

    // Beide Cascade-Rows existieren
    const grants = await selectShareGrantsAs(USER_OWNER, docId);
    expect(grants).toHaveLength(2);
  });

  it('(o-p2) Removed-Member sieht andere Member NICHT mehr (P2-2)', async () => {
    // Mig 0023: is_active_member_of filtert removed_at IS NULL → wer raus
    // ist, sieht die anderen aktiven Member nicht mehr.
    const groupId = await seedGroup(USER_OWNER);
    await addGroupMember(groupId, USER_MEMBER_1);
    await addGroupMember(groupId, USER_MEMBER_2);

    // Member-1 ist drin → sieht alle 3
    const beforeRemove = await selectGroupMembersAs(USER_MEMBER_1, groupId);
    expect(beforeRemove).toHaveLength(3);

    // Member-1 wird removed
    await adminClient.query(
      `UPDATE group_members SET removed_at = $1 WHERE group_id = $2 AND user_id = $3`,
      [Date.now(), groupId, USER_MEMBER_1],
    );

    // Member-1 sieht jetzt nur noch seine eigene Row (über user_id=self-Klausel)
    const afterRemove = await selectGroupMembersAs(USER_MEMBER_1, groupId);
    expect(afterRemove).toHaveLength(1);
    expect(afterRemove[0]!.user_id).toBe(USER_MEMBER_1);

    // Aktive Member-2 sieht weiterhin alle 3 (Owner + member-1-removed + member-2)?
    // Nein — Member-2 sieht nur AKTIVE Member-1 ist removed, also (Owner + self).
    // Owner aber sieht alle inkl. removed (owns_group-Helper hat keinen
    // removed_at-Filter).
    const asOwner = await selectGroupMembersAs(USER_OWNER, groupId);
    expect(asOwner).toHaveLength(3); // inkl. removed-1
  });

  it('(o) Removed-Member-IDOR-Block: Member-of-X kann Group-Y-Grants NICHT sehen', async () => {
    // Test-Plan-Review §11 Pflicht-Test: cross-group-Membership-Leak
    const objectInY = await seedObject(USER_OWNER, {
      title: 'group-y-secret',
      dekScheme: 'per_object',
    });
    const groupX = await seedGroup(USER_OWNER, { name: 'group-x' });
    const groupY = await seedGroup(USER_OWNER, { name: 'group-y' });
    await addGroupMember(groupX, USER_MEMBER_1); // user-1 in group-X
    // user-1 NICHT in group-Y
    await shareWithGroup({ resourceId: objectInY, groupId: groupY, grantedBy: USER_OWNER });

    // user-1 darf den Grant nicht sehen (RLS-Filter via group_members JOIN
    // bei grants_self-Policy)
    const grantsVisible = await selectShareGrantsAs(USER_MEMBER_1, objectInY);
    expect(grantsVisible).toHaveLength(0);
    // Auch das Object selbst nicht
    const objectsVisible = await selectObjectsAs(USER_MEMBER_1);
    expect(objectsVisible.find((o) => o.id === objectInY)).toBeUndefined();
  });
});
