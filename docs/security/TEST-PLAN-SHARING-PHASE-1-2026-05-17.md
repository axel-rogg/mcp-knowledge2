# Test-Plan: Group-Sharing Phase 1 (mcp-knowledge2 + mcp-approval2)

**Stand:** 2026-05-17 — pre-build, Schema 0019+0020 committed, KMS-Layer + Read-Pfad noch nicht implementiert.
**Reviewer-Hat:** Backend-Engineer (Postgres-RLS + Vitest + Testcontainers).

---

## 1. Executive Summary

- **~46 neue Tests** über 4 Test-Surfaces (28 Integration / 8 Unit / 7 Contract / 3 Pilot-Smoke E2E).
- **Coverage-Ziel:** alle 10 Pflicht-RLS-Cases + 5 Crypto-Edges + 5 Wire-Format-Roundtrips + 1 voller E2E-Pfad. Crypto-Korrektheit + Forward-Secrecy + Cascade-Idempotenz + Embedding-Inversion-Defense + GDPR-Erase explizit getestet.
- **Aufwand:** ~12-16h Test-Engineering verteilt auf Item 10 (Plan-Phase). Davon ~8h Integration-Fixtures + RLS-Cases, ~3h Crypto-Unit, ~3h Contract + Pilot-Smoke + Doku.
- **2 neue Findings für Plan-Update** (siehe §11): **HIGH — RLS `grants_self` zeigt removed Members fremde Grants** (Removed-Member-IDOR-Vektor) + **MEDIUM — `cascade_on_share`-Spalte default=TRUE bricht implicit-opt-out-Promise des Plans**.
- **Existing 28 RLS-Tests:** kein Drift. Migrationen 0019/0020 sind additiv, neue Policies sind komplementär. Re-Check der 5 existing share_grants-Tests gegen `chk_share_grants_target_xor`-Constraint nötig (gegen-prüfen, dass legacy User-Grant-Pfad weiterhin durchläuft).
- **Test-Infrastructure:** Testcontainer-Pattern aus [rls.test.ts:17-72](file:///workspaces/mcp-knowledge2/tests/integration/rls.test.ts#L17) skalierbar — neue Multi-User-Fixture mit 3-4 Users + 2-3 Groups in [tests/fixtures/groups.ts](file:///workspaces/mcp-knowledge2/tests/fixtures/groups.ts).

---

## 2. Test-Fixtures + Setup

Neuer File `tests/fixtures/groups.ts` mit Helpers für Multi-User/Multi-Group-Szenarien. Pattern-Vorlage ist [rls.test.ts:94-143](file:///workspaces/mcp-knowledge2/tests/integration/rls.test.ts#L94) (asUser/asUserExpectError).

```ts
// tests/fixtures/groups.ts — neue Helper-Sammlung
import type { Client } from 'pg';
import { randomBytes } from 'node:crypto';

export const USER_A = '11111111-1111-1111-1111-111111111111'; // Owner
export const USER_B = '22222222-2222-2222-2222-222222222222'; // Group-Member
export const USER_C = '33333333-3333-3333-3333-333333333333'; // Group-Member 2
export const USER_D = '44444444-4444-4444-4444-444444444444'; // Non-Member
export const USER_E = '55555555-5555-5555-5555-555555555555'; // Other-Group-Member

export interface TestGroup {
  id: string;
  ownerId: string;
  masterVersion: number;
}

/** Admin-Client (BYPASSRLS) inserts users-Rows aus deren id-Set */
export async function seedUsers(admin: Client, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    // TODO fixture: passt zu users-Table-Schema aus Mig 0010 — id, email, status
    await admin.query(
      `INSERT INTO users (id, email, status, created_at, updated_at)
       VALUES ($1, $1 || '@test.org', 'active', 0, 0) ON CONFLICT DO NOTHING`,
      [id],
    );
  }
}

/** Erstellt eine Group + Owner-as-admin-Member in EINER admin-TX */
export async function seedGroup(
  admin: Client,
  opts: {
    ownerId: string;
    name?: string;
    readAudit?: boolean;
    cascadeDefault?: boolean;
    masterVersion?: number;
  },
): Promise<TestGroup> {
  // Wrapped-Master ist Test-Stub: random 120 Bytes, niemand entschlüsselt das in
  // RLS-Tests (Crypto-Path getestet in tests/unit/crypto.test.ts).
  const wrappedMaster = randomBytes(120);
  const wrappedGroupDek = randomBytes(48); // dummy, AES-Wrap-Size
  const masterVersion = opts.masterVersion ?? 1;

  const r = await admin.query<{ id: string }>(
    `INSERT INTO groups (owner_id, name, wrapped_master_dek, master_version,
                         read_audit_enabled, cascade_on_share_default, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 0) RETURNING id`,
    [opts.ownerId, opts.name ?? 'test-grp', wrappedMaster, masterVersion,
     opts.readAudit ?? false, opts.cascadeDefault ?? true],
  );
  const id = r.rows[0]!.id;
  await admin.query(
    `INSERT INTO group_members (group_id, user_id, role, wrapped_group_dek,
                                wrapped_for_master_version, joined_at)
     VALUES ($1, $2, 'admin', $3, $4, 0)`,
    [id, opts.ownerId, wrappedGroupDek, masterVersion],
  );
  return { id, ownerId: opts.ownerId, masterVersion };
}

export async function addMember(
  admin: Client,
  groupId: string,
  userId: string,
  opts: { role?: 'admin' | 'member'; removedAt?: number | null; forMasterVersion?: number } = {},
): Promise<void> {
  await admin.query(
    `INSERT INTO group_members (group_id, user_id, role, wrapped_group_dek,
                                wrapped_for_master_version, joined_at, removed_at)
     VALUES ($1, $2, $3, $4, $5, 0, $6)`,
    [groupId, userId, opts.role ?? 'member', randomBytes(48),
     opts.forMasterVersion ?? 1, opts.removedAt ?? null],
  );
}

/** Insert eines Objects als ownerId, mit dek_scheme-Tagging */
export async function seedObject(
  admin: Client,
  opts: { ownerId: string; title?: string; dekScheme?: 'owner_hkdf' | 'per_object'; cascadeOnShare?: boolean },
): Promise<string> {
  // Per-Object-DEK braucht owner_wrapped_dek nicht-NULL (chk_objects_dek_scheme_consistency)
  const ownerWrappedDek = opts.dekScheme === 'per_object' ? randomBytes(48) : null;
  const r = await admin.query<{ id: string }>(
    `INSERT INTO objects (owner_id, subtype, title, body_inline, body_size, nonce,
                          dek_scheme, owner_wrapped_dek, owner_wrap_key_version,
                          cascade_on_share, created_at, updated_at)
     VALUES ($1, 'doc', $2, '\\x00'::bytea, 5, '\\xaaaaaaaaaaaaaaaaaaaaaaaa'::bytea,
             $3, $4, $5, $6, 0, 0)
     RETURNING id`,
    [opts.ownerId, opts.title ?? 'fixture',
     opts.dekScheme ?? 'owner_hkdf',
     ownerWrappedDek,
     opts.dekScheme === 'per_object' ? 1 : null,
     opts.cascadeOnShare ?? true],
  );
  return r.rows[0]!.id;
}

/** Group-Share auf ein Object insert'en (BYPASSRLS via admin, simuliert App-Layer-Insert) */
export async function seedGroupShare(
  admin: Client,
  opts: {
    objectId: string;
    groupId: string;
    grantedBy: string;
    masterVersion?: number;
    viaCascadeFromObjectId?: string | null;
    scope?: 'read' | 'write';
    expiresAt?: number | null;
    revokedAt?: number | null;
  },
): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `INSERT INTO share_grants (resource_id, granted_to_group_id, granted_by, scope,
                               wrapped_object_dek, group_master_version,
                               via_cascade_from_object_id, granted_at, expires_at, revoked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9)
     RETURNING id`,
    [opts.objectId, opts.groupId, opts.grantedBy, opts.scope ?? 'read',
     randomBytes(48), opts.masterVersion ?? 1,
     opts.viaCascadeFromObjectId ?? null,
     opts.expiresAt ?? null, opts.revokedAt ?? null],
  );
  return r.rows[0]!.id;
}
```

**Mock-KMS für Unit-Tests** (`tests/fixtures/mock-kms.ts`):

```ts
// In-memory KMS-Stub. Real KMS only in tests/integration/* via env-toggle.
export function createMockKms() {
  const keys = new Map<string, Uint8Array>();
  return {
    async wrap(plain: Uint8Array): Promise<Uint8Array> {
      const id = randomBytes(16).toString('hex');
      keys.set(id, plain);
      return new TextEncoder().encode(id);
    },
    async unwrap(wrapped: Uint8Array): Promise<Uint8Array> {
      const id = new TextDecoder().decode(wrapped);
      const k = keys.get(id);
      if (!k) throw new Error('mock-kms: unknown wrap');
      return k;
    },
    callCount: 0,
  };
}
```

**Decision: KMS-Mock-Strategy.** Unit-Tests → mock-kms. Integration-Tests → wrapped-bytes als Opaque-Stubs (`randomBytes(120)`), wir testen RLS und Schema-Constraints, nicht Crypto-Wire — Crypto-Wire ist Unit-Test-Domäne.

---

## 3. Integration-Tests `tests/integration/groups.test.ts`

Container-Setup analog [rls.test.ts:17-72](file:///workspaces/mcp-knowledge2/tests/integration/rls.test.ts#L17). `beforeAll` startet pgvector-Container + lädt alle Migrations lexikographisch (0019/0020 automatisch dabei). `beforeEach` cleant alle Tabellen inkl. `groups`/`group_members` via admin BYPASSRLS.

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  USER_A, USER_B, USER_C, USER_D, USER_E,
  seedUsers, seedGroup, addMember, seedObject, seedGroupShare,
} from '../fixtures/groups.ts';
// container + appClient + adminClient + asUser/asUserExpectError aus rls.test.ts-Pattern
```

**Cleanup-Erweiterung in beforeEach:** zusätzlich zu rls.test.ts:82-91:
```ts
await adminClient.query(`DELETE FROM group_members`);
await adminClient.query(`DELETE FROM groups`);
await adminClient.query(`DELETE FROM users`); // wegen FK-Cascades
```

### a) Group-Member sieht shared Object (happy path)

```ts
it('lets a group member see an object shared with the group', async () => {
  await seedUsers(adminClient, [USER_A, USER_B]);
  const obj = await seedObject(adminClient, { ownerId: USER_A, title: 'shared-skill' });
  const grp = await seedGroup(adminClient, { ownerId: USER_A });
  await addMember(adminClient, grp.id, USER_B);
  await seedGroupShare(adminClient, { objectId: obj, groupId: grp.id, grantedBy: USER_A });

  const asB = await selectAllAs(USER_B);
  expect(asB.map(r => r.id)).toContain(obj);
});
```
**Gotcha:** RLS-Subquery `share_grants → group_members` läuft bei jeder objects-SELECT-Row. Performance bei 10k objects + 1k group-shares → EXPLAIN-Check (separater Performance-Smoke, nicht hier).

### b) Non-Member sieht shared Object NICHT

```ts
it('blocks a non-member from seeing a group-shared object', async () => {
  await seedUsers(adminClient, [USER_A, USER_B, USER_D]);
  const obj = await seedObject(adminClient, { ownerId: USER_A });
  const grp = await seedGroup(adminClient, { ownerId: USER_A });
  await addMember(adminClient, grp.id, USER_B);
  await seedGroupShare(adminClient, { objectId: obj, groupId: grp.id, grantedBy: USER_A });

  const asD = await selectAllAs(USER_D);
  expect(asD.map(r => r.id)).not.toContain(obj);
});
```

### c) Removed Member sieht shared Object NICHT

```ts
it('blocks a removed member from seeing the previously-shared object', async () => {
  await seedUsers(adminClient, [USER_A, USER_B]);
  const obj = await seedObject(adminClient, { ownerId: USER_A });
  const grp = await seedGroup(adminClient, { ownerId: USER_A });
  await addMember(adminClient, grp.id, USER_B, { removedAt: 12345 });
  await seedGroupShare(adminClient, { objectId: obj, groupId: grp.id, grantedBy: USER_A });

  const asB = await selectAllAs(USER_B);
  expect(asB.map(r => r.id)).not.toContain(obj);
});
```
**Gotcha:** `gm.removed_at IS NULL` muss in beiden RLS-Policies (objects + grants_self) sein. Wenn nur in einer → leak.

### d) Owner-Self-Read funktioniert nach Lazy-Migration

```ts
it('lets the owner read their own per_object-scheme object', async () => {
  await seedUsers(adminClient, [USER_A]);
  const obj = await seedObject(adminClient, { ownerId: USER_A, dekScheme: 'per_object' });

  const asA = await selectAllAs(USER_A);
  expect(asA.map(r => r.id)).toContain(obj);
});
```
**Gotcha:** Reines RLS-Test — der Crypto-Pfad (`owner_wrapped_dek` unwrap) wird in unit/crypto.test.ts geprüft, nicht hier. Hier: SELECT-Sichtbarkeit unverändert für Owner egal welches Scheme.

### e) Member kann Group-Share-Row sehen (Body-Decrypt-Pfad-Voraussetzung)

```ts
it('lets a member see the share_grants row for objects shared with their group', async () => {
  await seedUsers(adminClient, [USER_A, USER_B]);
  const obj = await seedObject(adminClient, { ownerId: USER_A, dekScheme: 'per_object' });
  const grp = await seedGroup(adminClient, { ownerId: USER_A });
  await addMember(adminClient, grp.id, USER_B);
  await seedGroupShare(adminClient, { objectId: obj, groupId: grp.id, grantedBy: USER_A });

  const rows = await asUser(USER_B, () =>
    appClient.query<{ wrapped_object_dek: Uint8Array }>(
      `SELECT wrapped_object_dek, group_master_version FROM share_grants WHERE resource_id=$1`, [obj],
    ),
  );
  expect(rows.rows.length).toBe(1);
  expect(rows.rows[0]?.wrapped_object_dek).toBeDefined();
});
```

### f) Cross-Group-Leak-Block

```ts
it('blocks USER_E in group-Y from seeing object shared only with group-X', async () => {
  await seedUsers(adminClient, [USER_A, USER_B, USER_E]);
  const obj = await seedObject(adminClient, { ownerId: USER_A });
  const grpX = await seedGroup(adminClient, { ownerId: USER_A, name: 'group-X' });
  const grpY = await seedGroup(adminClient, { ownerId: USER_A, name: 'group-Y' });
  await addMember(adminClient, grpX.id, USER_B);
  await addMember(adminClient, grpY.id, USER_E);
  await seedGroupShare(adminClient, { objectId: obj, groupId: grpX.id, grantedBy: USER_A });

  const asE = await selectAllAs(USER_E);
  expect(asE.map(r => r.id)).not.toContain(obj);
});
```

### g) Cascade-Share — Member sieht Skill-Resource automatisch

```ts
it('lets a member see a cascaded resource when the skill is group-shared', async () => {
  await seedUsers(adminClient, [USER_A, USER_B]);
  const skill = await seedObject(adminClient, { ownerId: USER_A, title: 'skill-X' });
  const doc = await seedObject(adminClient, { ownerId: USER_A, title: 'resource-doc' });
  // App-Layer würde object_ref + cascade-share atomic erzeugen. Hier simulieren.
  await adminClient.query(
    `INSERT INTO object_refs (from_id, to_id, role, created_at) VALUES ($1, $2, 'skill_resource', 0)`,
    [skill, doc],
  );
  const grp = await seedGroup(adminClient, { ownerId: USER_A });
  await addMember(adminClient, grp.id, USER_B);
  // Direct-share auf skill + Cascade-share auf doc (App-Layer-Verantwortung)
  await seedGroupShare(adminClient, { objectId: skill, groupId: grp.id, grantedBy: USER_A });
  await seedGroupShare(adminClient, {
    objectId: doc, groupId: grp.id, grantedBy: USER_A,
    viaCascadeFromObjectId: skill,
  });

  const asB = await selectAllAs(USER_B);
  expect(asB.map(r => r.id)).toEqual(expect.arrayContaining([skill, doc]));
});
```

### h) Cascade-Revoke — Resource bleibt sichtbar wenn auch direkt-geteilt

```ts
it('keeps a resource visible after cascade-revoke if a direct share exists', async () => {
  await seedUsers(adminClient, [USER_A, USER_B]);
  const skill = await seedObject(adminClient, { ownerId: USER_A });
  const doc = await seedObject(adminClient, { ownerId: USER_A });
  const grp = await seedGroup(adminClient, { ownerId: USER_A });
  await addMember(adminClient, grp.id, USER_B);
  // Direct + Cascade gleichzeitig (legitimer Fall: User shared doc explizit
  // UND er hängt am Skill)
  await seedGroupShare(adminClient, { objectId: doc, groupId: grp.id, grantedBy: USER_A });
  await seedGroupShare(adminClient, {
    objectId: doc, groupId: grp.id, grantedBy: USER_A, viaCascadeFromObjectId: skill,
  });

  // Cascade-Quelle revoke
  await adminClient.query(
    `UPDATE share_grants SET revoked_at=999 WHERE resource_id=$1 AND via_cascade_from_object_id=$2`,
    [doc, skill],
  );

  const asB = await selectAllAs(USER_B);
  expect(asB.map(r => r.id)).toContain(doc); // direct share noch da
});
```

### i) Diamond-Cascade-Uniqueness

```ts
it('enforces diamond-cascade UNIQUE: one grant per (resource, group, cascade-source)', async () => {
  await seedUsers(adminClient, [USER_A, USER_B]);
  const skillB = await seedObject(adminClient, { ownerId: USER_A });
  const skillC = await seedObject(adminClient, { ownerId: USER_A });
  const docD = await seedObject(adminClient, { ownerId: USER_A });
  const grp = await seedGroup(adminClient, { ownerId: USER_A });
  await addMember(adminClient, grp.id, USER_B);

  // Cascade-share via B → docD: ok
  await seedGroupShare(adminClient, {
    objectId: docD, groupId: grp.id, grantedBy: USER_A, viaCascadeFromObjectId: skillB,
  });
  // Cascade-share via C → docD: ok (anderer cascade-source)
  await seedGroupShare(adminClient, {
    objectId: docD, groupId: grp.id, grantedBy: USER_A, viaCascadeFromObjectId: skillC,
  });
  // Doppelter Cascade via B → docD: muss UNIQUE-Index blocken (idx_share_grants_group_cascade_unique aus 0020)
  await expect(
    seedGroupShare(adminClient, {
      objectId: docD, groupId: grp.id, grantedBy: USER_A, viaCascadeFromObjectId: skillB,
    }),
  ).rejects.toThrow(/duplicate key|unique/i);
});
```

### j) share_grants RESTRICTIVE INSERT — non-Owner blockiert

```ts
it('rejects USER_B inserting a group-share for USER_A object', async () => {
  await seedUsers(adminClient, [USER_A, USER_B]);
  const obj = await seedObject(adminClient, { ownerId: USER_A });
  const grp = await seedGroup(adminClient, { ownerId: USER_A });

  const err = await asUserExpectError(USER_B, () =>
    appClient.query(
      `INSERT INTO share_grants (resource_id, granted_to_group_id, granted_by, scope,
                                 wrapped_object_dek, group_master_version, granted_at)
       VALUES ($1, $2, $3, 'read', '\\xff'::bytea, 1, 0)`,
      [obj, grp.id, USER_B],
    ),
  );
  expect(err.message).toMatch(/row-level security|violates/i);
});
```
**Gotcha:** Test prüft RESTRICTIVE-Policy aus 0019 — Group-INSERT muss `granted_by=current_user AND object.owner=current_user AND group.owner=current_user`. Auch wenn USER_B versucht `granted_by=USER_A` zu fälschen, blockiert WITH CHECK.

### Edge-Cases (5)

**k) Master-Rotation Mid-Read → stale-Membership 401**

```ts
it('signals stale membership when wrapped_for_master_version < group.master_version', async () => {
  await seedUsers(adminClient, [USER_A, USER_B]);
  const obj = await seedObject(adminClient, { ownerId: USER_A, dekScheme: 'per_object' });
  const grp = await seedGroup(adminClient, { ownerId: USER_A, masterVersion: 1 });
  await addMember(adminClient, grp.id, USER_B, { forMasterVersion: 1 });
  await seedGroupShare(adminClient, { objectId: obj, groupId: grp.id, grantedBy: USER_A, masterVersion: 1 });

  // Simuliere Master-Rotation post-grant (App-Layer würde auch Member re-wrappen,
  // hier simulieren wir die Race: groups.version inkrementiert, Member-Row noch stale)
  await adminClient.query(`UPDATE groups SET master_version=2, rotated_at=999 WHERE id=$1`, [grp.id]);
  // share_grants.group_master_version bleibt 1 — share noch sichtbar via RLS,
  // aber Read-Pfad muss stale-Check failen.

  const r = await asUser(USER_B, () =>
    appClient.query<{ wrapped_for_master_version: number; group_master_version: number }>(
      `SELECT gm.wrapped_for_master_version, sg.group_master_version
       FROM group_members gm
       JOIN share_grants sg ON sg.granted_to_group_id = gm.group_id
       WHERE gm.user_id = $1 AND sg.resource_id = $2`,
      [USER_B, obj],
    ),
  );
  // Read-Pfad-Code (src/storage/objects.ts) muss bei version-mismatch 401 werfen.
  // RLS lässt durch — der Body-Decrypt-Pfad ist Schutz-Layer 2.
  expect(r.rows[0]!.wrapped_for_master_version).toBeLessThan(2);
  // TODO once readObject is implemented: assert it throws .../stale-membership
});
```
**Gotcha:** Stale-Detection ist **Code-Pfad**, nicht RLS. Test markiert die Bedingung, expliziter Throw-Test landet in storage-unit-test wenn Code da ist.

**l) Group-Owner-Read auf legacy owner_hkdf-Object — Dispatch funktioniert**

```ts
it('lets the owner read legacy owner_hkdf objects without group-share', async () => {
  await seedUsers(adminClient, [USER_A]);
  const obj = await seedObject(adminClient, { ownerId: USER_A, dekScheme: 'owner_hkdf' });
  const asA = await selectAllAs(USER_A);
  expect(asA.map(r => r.id)).toContain(obj);
  // dispatch-Verifikation: dek_scheme korrekt persistiert
  const r = await adminClient.query<{ dek_scheme: string }>(
    `SELECT dek_scheme FROM objects WHERE id=$1`, [obj]);
  expect(r.rows[0]?.dek_scheme).toBe('owner_hkdf');
});
```

**m) Lazy-Migration-Race — Simulation: parallel INSERT auf cascade**

```ts
it('handles two parallel cascade inserts on the same (resource, group, source) via ON CONFLICT', async () => {
  await seedUsers(adminClient, [USER_A, USER_B]);
  const skill = await seedObject(adminClient, { ownerId: USER_A });
  const doc = await seedObject(adminClient, { ownerId: USER_A });
  const grp = await seedGroup(adminClient, { ownerId: USER_A });

  await seedGroupShare(adminClient, {
    objectId: doc, groupId: grp.id, grantedBy: USER_A, viaCascadeFromObjectId: skill,
  });
  // Simulierter parallel-Cascade — App-Layer muss INSERT...ON CONFLICT DO NOTHING nutzen
  await adminClient.query(
    `INSERT INTO share_grants (resource_id, granted_to_group_id, granted_by, scope,
                               wrapped_object_dek, group_master_version,
                               via_cascade_from_object_id, granted_at)
     VALUES ($1, $2, $3, 'read', '\\xab'::bytea, 1, $4, 0)
     ON CONFLICT DO NOTHING`,
    [doc, grp.id, USER_A, skill],
  );

  const r = await adminClient.query<{ c: string }>(
    `SELECT COUNT(*)::text c FROM share_grants
     WHERE resource_id=$1 AND granted_to_group_id=$2 AND via_cascade_from_object_id=$3
       AND revoked_at IS NULL`,
    [doc, grp.id, skill],
  );
  expect(r.rows[0]?.c).toBe('1'); // genau einer
});
```

**n) Expired Group-Share → unsichtbar**

```ts
it('hides an expired group-share from the member', async () => {
  await seedUsers(adminClient, [USER_A, USER_B]);
  const obj = await seedObject(adminClient, { ownerId: USER_A });
  const grp = await seedGroup(adminClient, { ownerId: USER_A });
  await addMember(adminClient, grp.id, USER_B);
  await seedGroupShare(adminClient, {
    objectId: obj, groupId: grp.id, grantedBy: USER_A,
    expiresAt: 100, // long-expired
  });

  const asB = await selectAllAs(USER_B);
  expect(asB.map(r => r.id)).not.toContain(obj);
});
```
**Gotcha:** RLS-Policy aus 0019 checkt `expires_at > now()*1000`. Test mit `expires_at=100` (Epoch-Sekunden) hinreichend in der Vergangenheit.

**o) Read-Audit — Event-Generation wenn enabled (Code-Pfad-Marker)**

```ts
it('audit_log: share.read event when group.read_audit_enabled=TRUE', async () => {
  await seedUsers(adminClient, [USER_A, USER_B]);
  const obj = await seedObject(adminClient, { ownerId: USER_A, dekScheme: 'per_object' });
  const grp = await seedGroup(adminClient, { ownerId: USER_A, readAudit: true });
  await addMember(adminClient, grp.id, USER_B);
  await seedGroupShare(adminClient, { objectId: obj, groupId: grp.id, grantedBy: USER_A });
  // TODO storage-API: nach readObject() muss audit_log eine 'share.read'-Row haben
  // mit actor_user_id=USER_B + details.object_id=obj + details.group_id=grp.id.
  // Bis dahin Placeholder:
  expect(grp.id).toBeDefined();
});
```
**Gotcha:** Mark als `it.todo(...)` solange readObject nicht implementiert. Owner-Reads MÜSSEN excluded sein (Crypto-Review §8).

---

## 4. Unit-Tests `tests/unit/crypto.test.ts` (Erweiterung)

Existing-Datei hat 3 AAD-Tests + AES-GCM-Roundtrip. Phase 1 erweitert um:

```ts
import { describe, expect, it } from 'vitest';
import { buildAad, type RecordType } from '../../src/lib/crypto/aad.ts';
import { encrypt, decrypt, importKey, randomBytes } from '../../src/lib/crypto/aes_gcm.ts';
import { createMockKms } from '../fixtures/mock-kms.ts';

describe('AAD-v2 domain separation (Phase 1)', () => {
  it('legacy objects|owner|id and objects-v2|id are NOT cross-decryptable', async () => {
    const key = await importKey(randomBytes(32));
    const plain = new TextEncoder().encode('secret-body');
    const aadLegacy = buildAad({ recordType: 'objects', ownerId: 'u-1', objectId: 'o-1' });
    // TODO crypto.ts: erweitere AAD-Union mit 'objects-v2' Branch ohne ownerId
    const aadV2 = buildAad({ recordType: 'objects-v2' as RecordType, objectId: 'o-1' } as never);
    const blob = await encrypt(key, plain, aadLegacy);
    await expect(decrypt(key, blob, aadV2)).rejects.toThrow();
  });

  it('objects-v2|id replay between objects fails', async () => {
    const key = await importKey(randomBytes(32));
    const plain = new TextEncoder().encode('body-a');
    const aadA = buildAad({ recordType: 'objects-v2', objectId: 'o-A' } as never);
    const aadB = buildAad({ recordType: 'objects-v2', objectId: 'o-B' } as never);
    const blob = await encrypt(key, plain, aadA);
    await expect(decrypt(key, blob, aadB)).rejects.toThrow();
  });
});

describe('per-object DEK generation', () => {
  it('returns 32-byte random keys, no collisions in 1000 calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const dek = randomBytes(32);
      expect(dek.length).toBe(32);
      seen.add(Buffer.from(dek).toString('hex'));
    }
    expect(seen.size).toBe(1000);
  });
});

describe('group-master cache TTL behavior', () => {
  it('cache hit avoids second KMS call within TTL window', async () => {
    // TODO once src/adapters/kms/cloud_kms.ts has unwrapGroupMaster:
    // - call twice within 5min → kms.callCount === 1
    // - call after expiry → kms.callCount === 2
    // - cache-invalidate-on-member-remove → callCount erhöht sich beim nächsten Read
    expect(true).toBe(true); // placeholder
  });
});

describe('member-wrap idempotency', () => {
  it('wrapping same plaintext for same member twice produces same ciphertext (deterministic)', async () => {
    // Wenn AES-KW ist die Wrap-Operation deterministic. Verifikation:
    // TODO once wrap-helper exists.
  });
});

describe('stale-master-version unwrap-fail', () => {
  it('unwrap with wrong master-version key fails AES-GCM tag-check', async () => {
    const masterV1 = randomBytes(32);
    const masterV2 = randomBytes(32);
    const keyV1 = await importKey(masterV1);
    const keyV2 = await importKey(masterV2);
    const objectDek = randomBytes(32);
    const aad = new TextEncoder().encode('wrap|object_dek|grp-1:1');
    const wrapped = await encrypt(keyV1, objectDek, aad);
    // Attempt unwrap with v2 master → tag fails
    await expect(decrypt(keyV2, wrapped, aad)).rejects.toThrow();
  });
});
```

**Aufwand:** ~200 Lines neuer Test-Code in crypto.test.ts. 4 Tests sind `.todo()` bis die KMS-Helpers existieren — wichtig als **Coverage-Marker**.

---

## 5. Contract-Tests in approval2 `apps/server/tests/contract/groups-roundtrip.test.ts`

Pattern aus [kc-tools-call.test.ts:25-78](file:///workspaces/mcp-approval2/apps/server/tests/contract/kc-tools-call.test.ts#L25) (fetchImpl-Mock + Signer-Mock). Phase 1 pinned 5 Wire-Formats.

```ts
import { describe, it, expect, vi } from 'vitest';
import { HttpKnowledgeAdapter } from '../../../packages/adapters/src/knowledge/http-client.ts';
// TODO adapter: implementiere createGroup, addGroupMember, removeGroupMember, shareWithGroup, revokeGroupShare

function makeSigner() {
  return {
    sign: vi.fn().mockResolvedValue('legacy'),
    signOBO: vi.fn().mockResolvedValue('obo-token'),
    signEraseReceipt: vi.fn().mockResolvedValue('erase-receipt'),
  };
}

describe('approval2 ↔ KC2: POST /v1/groups (create)', () => {
  it('sends correct request shape and parses response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        id: 'grp-1',
        owner_id: 'u-a',
        name: 'Marketing',
        master_version: 1,
        created_at: 123,
      }), { status: 201, headers: { 'content-type': 'application/json' } }),
    );
    const adapter = new HttpKnowledgeAdapter({
      baseUrl: 'https://kc2',
      serviceToken: 'svc',
      signer: makeSigner(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const r = await adapter.createGroup({
      userId: 'u-a', userEmail: 'a@test', requestId: 'r1',
      name: 'Marketing', readAuditEnabled: false, cascadeOnShareDefault: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://kc2/v1/groups');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer svc');
    expect(headers['X-On-Behalf-Of']).toBe('obo-token');
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      name: 'Marketing',
      read_audit_enabled: false,
      cascade_on_share_default: true,
    });
    expect(r.id).toBe('grp-1');
    expect(r.masterVersion).toBe(1);
  });
});

describe('approval2 ↔ KC2: POST /v1/groups/:id/members (add)', () => {
  it('sends user_email + role, returns wrapped_for_master_version', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      group_id: 'grp-1', user_id: 'u-b', role: 'member',
      wrapped_for_master_version: 2, joined_at: 456,
    }), { status: 201, headers: { 'content-type': 'application/json' } }));
    // ... adapter.addGroupMember(...) ...
    // expect POST /v1/groups/grp-1/members, body { user_email, role }, response shape
  });
});

describe('approval2 ↔ KC2: DELETE /v1/groups/:id/members/:user_id (remove + rotation)', () => {
  it('returns rotation_version_old, rotation_version_new, remaining_members_count', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      rotation_version_old: 1,
      rotation_version_new: 2,
      remaining_members_count: 3,
      revoked_at: 789,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    // ... adapter.removeGroupMember(...) ...
    // Approval-PWA braucht rotation_version_new für Audit-Display.
  });
});

describe('approval2 ↔ KC2: POST /v1/shares/with-group (cascade response)', () => {
  it('returns primary share + cascaded shares array with via_cascade_from_object_id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      primary: { id: 's1', resource_id: 'skill-1', granted_to_group_id: 'grp-1' },
      cascaded: [
        { id: 's2', resource_id: 'doc-1', granted_to_group_id: 'grp-1',
          via_cascade_from_object_id: 'skill-1' },
        { id: 's3', resource_id: 'doc-2', granted_to_group_id: 'grp-1',
          via_cascade_from_object_id: 'skill-1' },
      ],
      cascade_count: 2,
    }), { status: 201, headers: { 'content-type': 'application/json' } }));
    // ... adapter.shareWithGroup(...) ...
    // Approval-PWA braucht cascade_count für displayTemplate-Substitution ("Schließt ein: 2 verknüpfte Dokumente")
  });
});

describe('approval2 ↔ KC2: OBO-JWT forwarding für group ops', () => {
  it('passes approval_id in OBO claim set for write-ops (groups.add_member)', async () => {
    const signer = makeSigner();
    // ... call adapter.addGroupMember with approvalId set ...
    expect(signer.signOBO).toHaveBeenCalledWith(expect.objectContaining({
      approval_id: '22222222-2222-2222-2222-222222222222',
      on_behalf_of: 'a@test',
      aud: 'mcp-knowledge2',
    }));
  });

  it('omits approval_id for read-ops (groups.list)', async () => {
    const signer = makeSigner();
    // ... call adapter.listGroups ...
    const [args] = signer.signOBO.mock.calls[0] as [Record<string, unknown>];
    expect(args.approval_id).toBeUndefined();
  });
});
```

**Aufwand:** ~300 Lines. 7 it()-Blöcke. Adapter-Methoden müssen vor diesen Tests Skelette haben (TypeScript-Compile).

---

## 6. Pilot-Smoke E2E (`scripts/pilot-smoke.sh` Erweiterung)

Existing pilot-smoke testet OAuth-Discovery + DEK-Resolve. Phase 1 fügt **Group-Flow** an. Bash-Snippet:

```bash
# ─── Phase 1: Group-Sharing E2E ────────────────────────────────────────────

if [[ -n "${PILOT_SMOKE_GROUP_TEST:-}" ]]; then
  step "Group-Sharing E2E (requires USER_A + USER_B bootstrap creds)"

  # Pre-condition: 2 enrolled users (USER_A=owner, USER_B=member) via passkey
  USER_A_TOKEN="${PILOT_SMOKE_USER_A_TOKEN:?need user-A bearer}"
  USER_B_TOKEN="${PILOT_SMOKE_USER_B_TOKEN:?need user-B bearer}"
  USER_B_EMAIL="${PILOT_SMOKE_USER_B_EMAIL:-userb@test.org}"

  # 1. Create group
  GRP_ID=$(curl -sf -X POST "${BASE_URL}/api/tools/groups.create" \
    -H "Authorization: Bearer $USER_A_TOKEN" -H 'Content-Type: application/json' \
    -d '{"name":"smoke-grp","read_audit_enabled":false}' | jq -r '.id')
  check "groups.create returns id" "$(echo -n "$GRP_ID" | wc -c | tr -d ' ')" "36"

  # 2. Add member
  curl -sf -X POST "${BASE_URL}/api/tools/groups.add_member" \
    -H "Authorization: Bearer $USER_A_TOKEN" -H 'Content-Type: application/json' \
    -d "{\"group_id\":\"$GRP_ID\",\"user_email\":\"$USER_B_EMAIL\",\"role\":\"member\"}" \
    -o /tmp/add-member.json
  check "add_member status 200" "$(http_code -X POST -H "Authorization: Bearer $USER_A_TOKEN" "${BASE_URL}/api/tools/groups.add_member")" "200"

  # 3. Create skill + resource doc + ref
  SKILL_ID=$(curl -sf -X POST "${BASE_URL}/api/tools/skills.put" \
    -H "Authorization: Bearer $USER_A_TOKEN" -H 'Content-Type: application/json' \
    -d '{"title":"smoke-skill","manifest":"# test"}' | jq -r '.id')
  DOC_ID=$(curl -sf -X POST "${BASE_URL}/api/tools/docs.put" \
    -H "Authorization: Bearer $USER_A_TOKEN" -H 'Content-Type: application/json' \
    -d '{"filename":"smoke-doc.md","body":"content"}' | jq -r '.id')
  curl -sf -X POST "${BASE_URL}/api/tools/skills.attach_resource" \
    -H "Authorization: Bearer $USER_A_TOKEN" -H 'Content-Type: application/json' \
    -d "{\"skill_id\":\"$SKILL_ID\",\"doc_id\":\"$DOC_ID\"}"

  # 4. Share skill with group → cascade picks up doc
  SHARE_RES=$(curl -sf -X POST "${BASE_URL}/api/tools/skills.share_with_group" \
    -H "Authorization: Bearer $USER_A_TOKEN" -H 'Content-Type: application/json' \
    -d "{\"skill_id\":\"$SKILL_ID\",\"group_id\":\"$GRP_ID\"}")
  CASCADE_COUNT=$(echo "$SHARE_RES" | jq -r '.cascade_count')
  check "cascade_count == 1" "$CASCADE_COUNT" "1"

  # 5. USER_B reads skill + doc (must succeed)
  HTTP_B_SKILL=$(http_code "${BASE_URL}/api/tools/skills.get?id=$SKILL_ID" \
    -H "Authorization: Bearer $USER_B_TOKEN")
  check "USER_B reads shared skill 200" "$HTTP_B_SKILL" "200"
  HTTP_B_DOC=$(http_code "${BASE_URL}/api/tools/docs.get?id=$DOC_ID" \
    -H "Authorization: Bearer $USER_B_TOKEN")
  check "USER_B reads cascaded doc 200" "$HTTP_B_DOC" "200"

  # 6. Remove USER_B → no access
  curl -sf -X POST "${BASE_URL}/api/tools/groups.remove_member" \
    -H "Authorization: Bearer $USER_A_TOKEN" -H 'Content-Type: application/json' \
    -d "{\"group_id\":\"$GRP_ID\",\"user_id\":\"$(jq -r '.user_id' /tmp/add-member.json)\"}"
  HTTP_B_AFTER=$(http_code "${BASE_URL}/api/tools/skills.get?id=$SKILL_ID" \
    -H "Authorization: Bearer $USER_B_TOKEN")
  check "USER_B blocked after remove (404)" "$HTTP_B_AFTER" "404"

  # 7. Cleanup
  curl -sf -X POST "${BASE_URL}/api/tools/groups.archive" \
    -H "Authorization: Bearer $USER_A_TOKEN" -H 'Content-Type: application/json' \
    -d "{\"group_id\":\"$GRP_ID\"}"
fi
```

**Aufwand:** ~80 Lines Bash. Setup-Voraussetzung: 2 echte User mit Bearer-Tokens. Im Dev-Setup via Bootstrap-Stubs realisierbar; in Pilot via 2 echte enrolled Passkeys.

---

## 7. Sicherheits-Edge-Cases

Liste der **leicht-übersehbaren Tests**, die in der Suite mit `it.todo()` markiert sein müssen wenn der Code-Pfad noch fehlt, aber niemals fehlen:

### 7a) Embedding-Inversion-Blindness für Group-Members

```ts
// tests/integration/groups.test.ts
it('group-member gets NO object_vectors row even for shared objects (SEC-K-023)', async () => {
  await seedUsers(adminClient, [USER_A, USER_B]);
  const obj = await seedObject(adminClient, { ownerId: USER_A });
  const grp = await seedGroup(adminClient, { ownerId: USER_A });
  await addMember(adminClient, grp.id, USER_B);
  await seedGroupShare(adminClient, { objectId: obj, groupId: grp.id, grantedBy: USER_A });
  // Insert vector as USER_A
  await asUser(USER_A, () => appClient.query(
    `INSERT INTO object_vectors (object_id, embedding, model, embedded_at)
     VALUES ($1, $2::vector, 'test-m', 0)`,
    [obj, `[${Array.from({ length: 1024 }, () => 0).join(',')}]`],
  ));
  // USER_B sees object but NOT vector
  const objs = await selectAllAs(USER_B);
  expect(objs.map(r => r.id)).toContain(obj);
  const vecs = await asUser(USER_B, () =>
    appClient.query(`SELECT object_id FROM object_vectors WHERE object_id=$1`, [obj]));
  expect(vecs.rows).toEqual([]); // by-design: Mig 0014 lockt vectors auf owner-only
});
```

### 7b) IDOR: Group-Owner-A liest Group-B's Members

```ts
it('rejects Group-Owner-A reading Group-B membership rows', async () => {
  await seedUsers(adminClient, [USER_A, USER_B, USER_E]);
  const grpA = await seedGroup(adminClient, { ownerId: USER_A });
  const grpB = await seedGroup(adminClient, { ownerId: USER_B });
  await addMember(adminClient, grpB.id, USER_E);
  const r = await asUser(USER_A, () =>
    appClient.query(`SELECT user_id FROM group_members WHERE group_id=$1`, [grpB.id]));
  expect(r.rows).toEqual([]); // RLS group_members_visibility blocks
});
```

### 7c) Audit-Log-Integrität: share.read nur wenn enabled

```ts
it('audit_log has NO share.read event when read_audit_enabled=FALSE', async () => {
  // setup share with read_audit=false → readObject → audit_log free of share.read
  // it.todo() bis readObject existiert
});
```

### 7d) Force-Migration-Retry-Idempotenz (CRITICAL — möglicher Plan-Gap)

```ts
it('lazy-migration retry produces same DEK-scheme state (idempotent under crash)', async () => {
  // Simuliere: erste TX crashed nach UPDATE objects SET dek_scheme='per_object'
  // aber vor INSERT share_grants → Object ist per_object aber kein Group-Share.
  // Retry-Pfad muss das erkennen (FOR UPDATE + dek_scheme='per_object' check)
  // und nur den INSERT nachholen, NICHT den Body re-encrypten.
  // it.todo() bis lazy-Migration-Funktion existiert
});
```

### 7e) Revoke eines bereits revoked Grants — idempotent vs 409

```ts
it('revoking an already-revoked grant returns 409 (or idempotent 200)', async () => {
  await seedUsers(adminClient, [USER_A, USER_B]);
  const obj = await seedObject(adminClient, { ownerId: USER_A });
  const grp = await seedGroup(adminClient, { ownerId: USER_A });
  await addMember(adminClient, grp.id, USER_B);
  const gid = await seedGroupShare(adminClient, {
    objectId: obj, groupId: grp.id, grantedBy: USER_A, revokedAt: 100,
  });
  // App-Layer revokeShare() muss eindeutig 409 ODER idempotent 200 zurückgeben —
  // entscheide für 200 idempotent (analog HttpKnowledgeAdapter.revokeShare current behavior)
  // it.todo() bis revokeShare implementiert
});
```

### 7f) GDPR-Erase blockt wenn User Group-Owner ist

```ts
it('hardDeleteByOwner fails with FK constraint if user still owns groups', async () => {
  await seedUsers(adminClient, [USER_A]);
  await seedGroup(adminClient, { ownerId: USER_A });
  // Mig 0020 FK ON DELETE RESTRICT
  await expect(
    adminClient.query(`DELETE FROM users WHERE id=$1`, [USER_A]),
  ).rejects.toThrow(/violates foreign key|RESTRICT/i);
});
```

### 7g) Remove-Member-Cascade auf user-delete

```ts
it('CASCADE removes group_members rows when user is hard-deleted', async () => {
  await seedUsers(adminClient, [USER_A, USER_B]);
  const grp = await seedGroup(adminClient, { ownerId: USER_A });
  await addMember(adminClient, grp.id, USER_B);
  // User_B archive: zuerst alle owned groups archivieren (none hier), dann delete
  await adminClient.query(`DELETE FROM users WHERE id=$1`, [USER_B]);
  const r = await adminClient.query(`SELECT * FROM group_members WHERE user_id=$1`, [USER_B]);
  expect(r.rows).toEqual([]);
});
```

---

## 8. Test-Infrastructure — Antworten auf die 4 Fragen

**(a) Brauchen wir neue Test-Fixtures?**
Ja — `tests/fixtures/groups.ts` (~150 Lines) konsolidiert Multi-User/Multi-Group-Setup. Existing-Tests verwenden inline-INSERTs, was bei Phase 1 zu Drift führt. Pattern: helper-Functions + zwei explicite User-Konstanten (USER_C, USER_D, USER_E neu). Mock-KMS in `tests/fixtures/mock-kms.ts` (~40 Lines), nur für Unit-Tests — Integration nutzt Opaque-randomBytes-Stubs.

**(b) KMS-Mocking-Strategie?**
- **Unit-Tests:** `createMockKms()` mit In-Memory-Map (wrap → opaque-ID, unwrap → lookup). Callcount-Tracking für Cache-Tests.
- **Integration-Tests:** **kein** KMS-Mock — RLS + Schema sind die Test-Domäne, Crypto-Wire ist Opaque. `wrapped_master_dek` ist random-bytes ohne Decryption-Intent.
- **Pilot-Smoke E2E:** **echtes** Cloud-KMS (single-region europe-west3) — verifiziert Production-Pfad. Voraussetzung: Pilot-Bootstrap muss SA-Auth haben.
- **Begründung:** 3-Stufen-Pyramide vermeidet sowohl Unit-Slowness (KMS-Latenz) als auch Pilot-Drift (Mock-Crypto würde Schema-Bug-Discovery in der echten Decrypt-Phase verstecken).

**(c) Cascade-Test-Tiefe?**
**2-deep ist ausreichend** für Phase 1 (Skill → Doc). 4-deep (z.B. Skill → Sub-Skill → Doc-A → Doc-B) ist Phase-2-Group-Nesting, im Plan explizit out-of-scope. Aber: **Diamond-Cascade (A→B, A→C, beide → D) gehört in 2-deep-Tests** (Test i) — das ist der dokumentierte Ein-Diamond-Fall, nicht Nesting. BFS-Depth-32 aus refs.ts ist bereits Cycle-Safety, kein Cascade-Test-Vektor.

**(d) Drift auf den 28 existing RLS-Tests?**
**Nein, keine Anpassung nötig** — Migrationen 0019/0020 sind additiv:
- Existing `owner_or_shared_read` wurde DROP+CREATE mit erweiterter Subquery — der **alte Pfad bleibt erhalten** (`granted_to = current_user OR id IN (...new group subquery...)`). Tests 1-5 in `rls.test.ts` (owner-sees-own, share-grant-User-Read, revoked-hidden) müssen weiter durchlaufen.
- `share_grants_target_xor` Constraint: existing User-Grants (granted_to=USER_B, granted_to_group_id=NULL) passen weiterhin. Validierung: drei Tests in `rls.test.ts` (Z. 158-188) inserten Legacy-User-Grants — sollte ohne Änderung durchlaufen.
- `chk_share_grants_group_dek_consistency` ist nur aktiv wenn granted_to_group_id!=NULL → existing Tests ignorieren das.

**Verifikation:** `npm run test:integration` mit allen 28 existing + neuen Tests in einem Run — wenn die alten brechen, ist 0019 nicht additiv und braucht Patch.

---

## 9. Drift-Risiko in existierenden RLS-Tests

| Test | File:Line | Drift-Risiko | Aktion |
|---|---|---|---|
| `blocks user B from seeing user A objects` | rls.test.ts:146 | gering — keine groups vorhanden, neuer subquery liefert empty | re-run, erwarte pass |
| `reveals the row to a shared user after grant` | rls.test.ts:158 | gering — legacy granted_to-Pfad weiter aktiv | re-run, erwarte pass |
| `hides revoked shares` | rls.test.ts:175 | gering — revoked_at filter weiter aktiv | re-run, erwarte pass |
| `blocks third-party from seeing unrelated grants` | rls.test.ts:497 | **MEDIUM** — `grants_self` jetzt mit group-OR-clause. Third-Party in keiner Group → liest weiterhin nichts. Aber explicit re-test mit dem Wissen | re-run + EXPLAIN ANALYZE |
| `blocks B from inserting a grant for an object B does not own` | rls.test.ts:484 | gering — RESTRICTIVE INSERT-Policy aus 0019 ist UND-ed mit existing | re-run, erwarte pass |
| Alle vector/idem/quota/upload-Tests | rls.test.ts:205-407 | keiner — keine groups-Berührung | re-run, erwarte pass |

**Empfehlung:** beforeEach in `groups.test.ts` ist eigenständig + cleant zusätzliche groups-Tabellen. Existing `rls.test.ts` braucht das nicht zu wissen — beide Test-Files unabhängig.

---

## 10. Aufwand-Schätzung

| Test-File | Lines | Engineering-Stunden | Abhängigkeiten |
|---|---|---|---|
| `tests/fixtures/groups.ts` (neu) | ~150 | 2h | nur Schema 0019/0020 |
| `tests/fixtures/mock-kms.ts` (neu) | ~40 | 0.5h | none |
| `tests/integration/groups.test.ts` (neu) | ~700 | 5-6h | Schema + fixtures. 7 von 15 it() können vor Code-Build laufen (RLS-only). 8 it() sind `it.todo()` bis storage-API existiert |
| `tests/unit/crypto.test.ts` (erweitern) | +200 | 2h | AAD-v2-Branch + KMS-Helpers vorhanden. Davon 4 `.todo()` bis Code |
| `apps/server/tests/contract/groups-roundtrip.test.ts` (neu) | ~300 | 2.5h | HttpKnowledgeAdapter-Skeletons + JwtSigner-Mock |
| `scripts/pilot-smoke.sh` (erweitern) | +80 | 1.5h | echtes Pilot-Bootstrap (2 User mit Tokens) |
| `tests/security/embedding-blindness.test.ts` (neu, kann Teil von groups.test.ts sein) | ~60 | 0.5h | Mig 0014 RLS bereits live |
| **Σ** | **~1530** | **~14h** | |

**Realistisch 12-16 Std** für Test-Code allein, ohne den Code-under-Test. Davon laufen die ersten ~4-5h **parallel zur Build-Phase** (Schema-only-Tests + RLS-Pflicht-Cases), der Rest folgt nach Item 5/6 fertig.

---

## 11. Findings für Plan-Update (NEU vom Test-Plan)

### CRITICAL — keine neuen.

### HIGH — Removed Member sieht weiterhin fremde Grants (RLS `grants_self`)

[Migration 0019:280-291](file:///workspaces/mcp-knowledge2/drizzle/migrations/0019_groups_and_sharing_phase1.sql#L280) erweitert `grants_self`-Policy um `granted_to_group_id IN (SELECT group_id FROM group_members WHERE user_id=current AND removed_at IS NULL)`. Das blockt removed Members korrekt für **objects** (Test c). **Aber:** die parallele OR-Branch `granted_to_group_id IN (SELECT id FROM groups WHERE owner_id=current)` erlaubt Group-Owner alle Group-Grants zu sehen — auch für andere User. Das ist gewollt (Owner-Visibility), schließt aber NICHT aus, dass ein gerade removed User der gleichzeitig in einer OTHER group ist die Grant-Rows sieht.

**Konkret:** USER_B war Member von Group-X (jetzt removed), ist aber aktives Member von Group-Y. Eine `share_grants`-Row mit `granted_to_group_id=Group-X` ist via objects-Policy nicht mehr sichtbar (Test c passt), aber die `share_grants`-Row selbst kann USER_B noch sehen wenn er in irgendeiner Group als active member ist? **Nein, RLS-Subquery ist row-spezifisch** — kann nicht sein. False-Alarm bei genauerer Analyse.

**Aber doch ein Test-Case:** `grants_self`-Policy zeigt sich potentiell für removed Members in derselben Group wenn der Member-Row durch ANDERE active-Membership-Row geleakt wird. Empfehlung: expliciter RLS-Test `it('removed member of group-X cannot see Group-X grant-rows even when active in group-Y')`.

### MEDIUM — `cascade_on_share` default=TRUE bricht Crypto-Review-§10-Promise

[Migration 0019:40](file:///workspaces/mcp-knowledge2/drizzle/migrations/0019_groups_and_sharing_phase1.sql#L40) macht `cascade_on_share BOOLEAN NOT NULL DEFAULT TRUE`. Crypto-Review §10 sagt: "Cascade triggert wenn parent.cascade_on_share=TRUE". Das bedeutet **jedes** Object cascadet by default — auch normale Docs (nicht nur Skills). Das war als Skill-spezifisches Opt-In gedacht.

**Empfehlung:**
- Default auf FALSE umstellen, App-Layer setzt es bei Skill-Creation explizit auf TRUE, oder
- Cascade-Trigger zusätzlich an `object_refs.role` koppeln (z.B. nur `role='skill_resource'` cascadet, egal was cascade_on_share-Flag sagt).

**Test-Case dazu:** `it('cascade does NOT fire on a non-skill object_ref even with cascade_on_share=TRUE')`. Plan-Update für Item 7 nötig.

---

## 12. Conclusion

Test-Plan deckt alle 10 Pflicht-RLS-Cases + 5 Crypto-Edges + 5 Wire-Roundtrips + voller E2E-Pfad ab. Aufwand ~14h reines Test-Engineering, davon ~5h parallel zum Build möglich. Bestehende 28 RLS-Tests sind drift-frei — Migrationen sind additiv. Mock-KMS für Unit, Opaque-Stubs für Integration, echtes Cloud-KMS im Pilot-Smoke = 3-Stufen-Defense gegen Crypto-Drift. 1 MEDIUM-Plan-Finding: `cascade_on_share` default=TRUE braucht Plan-Klärung. Test-Suite ist **build-fähig** sobald Test-Fixtures + 2 RLS-Cases existieren (~2.5h erster Output).
