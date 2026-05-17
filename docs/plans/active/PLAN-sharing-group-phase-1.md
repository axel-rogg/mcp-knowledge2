# PLAN: Group-basiertes Document-Sharing Phase 1

> **Status:** ⚠️ Spec (Build pending) 2026-05-17 — Pre-Build-Reviews durch, Schema-Spike (Migrations 0019 + 0020) committed, PLAN aktualisiert nach Engineering-Review.
> **Repo:** mcp-knowledge2
> **Cross-Repo-ADR:** [approval2/docs/adr/0024-group-sharing-architecture.md](https://github.com/axel-rogg/mcp-approval2/blob/main/docs/adr/0024-group-sharing-architecture.md)
> **Pre-Build-Reviews:**
>   - [docs/security/CRYPTO-REVIEW-GROUP-SHARING-2026-05-17.md](../../security/CRYPTO-REVIEW-GROUP-SHARING-2026-05-17.md) — Crypto-Specialist (4 Schema-Korrekturen, eingearbeitet)
>   - [docs/security/PLAN-REVIEW-SHARING-PHASE-1-2026-05-17.md](../../security/PLAN-REVIEW-SHARING-PHASE-1-2026-05-17.md) — Engineering-Sanity-Check (15 Unter-Spezifikationen, in diesem Plan eingearbeitet)
> **Aufwand:** ~12-14 Tage Build + Tests (initial 9.5d war zu optimistisch — Engineering-Review hat AAD-Refactor + KC2-HTTP-Routes + Drizzle-Sync + Lazy-Migration-on-Revisions als hidden complexity identifiziert).
> **Trigger:** User-Decision 2026-05-17 abend — Firma-Use-Case erfordert Group-basiertes Sharing (statt 1:1-Provisorium). Family-Modus braucht es nicht, Self-Host-für-Freunde + Corporate brauchen es.
>
> **Build-Reihenfolge (revidiert nach Engineering-Review):**
> ```
> 1 (Migration) + 3 (AAD-v2)   → de-risk parallel, kleinster Code-Pfad, beide breaking-changes
>        ↓
> 4 (Lazy-Migration inkl. object_revisions)
>        ↓
> 5 (Read-Pfad + updateObject) + 6 (Group-CRUD + KC2-Routes + Adapter)
>        ↓
> 7 (Cascade) → 2 (KMS-Layer) → 8 (Tool-Surface) → 9 (PWA) → 10 (Tests+Audit)
> ```

---

## 0. Was Phase 1 leistet — und was bewusst NICHT

### In Scope

- **Groups als first-class** (`groups`, `group_members`) — Single-Tenant intra-firma sharing
- **Skill + Resource-Bundle teilen** — wer einen Skill teilt, teilt automatisch alle via `object_refs(role='skill_resource')` verknüpften Docs mit
- **Auto-Cascade bei nachträglich verlinkten Resources** — neue Skill-Resource wird automatisch zur Group-Share-Liste hinzugefügt
- **Crypto-sound implementiert** — Per-Object-DEK + Group-Master + Member-Wrapping (Pattern B aus dem Review)
- **Read-only für Recipients** — Body sichtbar, Editieren bleibt 501
- **Member-Remove mit Forward-Secrecy** — Master-Rotation + Wrap-Re-Generation für bleibende Members
- **Read-Audit (optional pro Group)** — Group-Admin entscheidet ob Reader-Identity geloggt wird

### Out of Scope (klar Phase 2+)

- Write/Co-Edit für non-Owner (bleibt 501)
- Group-Nesting (Gruppe enthält Gruppe)
- Cross-Instance-Federation (eigenes 2-3 Monats-Projekt)
- Crypto-Shredding (echtes "Vergessen" nach Revoke)
- Per-User-Master-Keys
- Email-Invite-Workflow (Phase 2 mit Resend)
- Group-Owner-Transfer
- Async Re-Wrap-Worker für Member-Remove bei >1000 Grants

### Build-Reihenfolge (10 Items, revidiert nach Engineering-Review)

| # | Item | Aufwand (alt) | Aufwand (real) | Risiko |
|---|---|---|---|---|
| 1 | Migration 0019/0020 + Drizzle-Schema-Sync + RLS-Patch auf objects | 1d | **1.5d** | medium |
| 2 | KMS-Layer: Group-Master-Cache + Wrap/Unwrap-Helpers | 1d | 1d | medium (KMS-Quota) |
| 3 | **AAD-v2 Discriminated-Union + Refactor 5 Call-Sites** | 0.5d | **1d** | medium (Crypto-Korrektheit) |
| 4 | Lazy-Migration-Pfad inkl. `object_revisions.dek_scheme` + R2-Case | 1d | **1.5d** | high (Atomicity) |
| 5 | Read-Pfad + **`updateObject` mit umgestellt** für per_object | 1d | **1.5d** | medium |
| 6 | Group-CRUD + **KC2 HTTP-Routes** (`src/routes/groups.ts`) + **HttpKnowledgeAdapter-Erweiterung** | 1.5d | **2d** | high (Member-Remove-Rotation) |
| 7 | Share-Cascade bei `addObjectRef` + **Cycle-Detection-Order vor FOR UPDATE** | 0.5d | **1d** | medium (Race + Cycle) |
| 8 | Tool-Surface: `groups.*` + `skills.share_with_group` + **12 Tools × Zod × displayTemplate × Adapter** | 0.5d | **1d** | low |
| 9 | PWA: **`#/admin/groups`** + Share-Modal + "Shared with me" + Cascade-Count-Preview | 1.5d | **2d** | low |
| 10 | Tests + Audit-Events + **Pilot-Smoke E2E** + Contract-Tests | 1d | **1.5d** | — |
| **Σ** | | **9.5d** | **~14d** | |

**Engineering-Review hat insgesamt ~30% Overhead identifiziert** (siehe [PLAN-REVIEW-SHARING-PHASE-1-2026-05-17.md §8](../../security/PLAN-REVIEW-SHARING-PHASE-1-2026-05-17.md)). Hidden-Complexity-Top-3:
1. Lazy-Migration mit `object_revisions.dek_scheme` (pro-Revision-Tracking subtil, 3 Test-Szenarien)
2. RLS-Subquery objects → share_grants → group_members (Performance-Hotspot bei grossen Beständen)
3. AAD-Union in Idempotency-Middleware (falscher Branch öffnet Replay-Window)

---

## 1. Schema-Migration (Item 1) — **COMMITTED**

> **Stand 2026-05-17 abend:** Migration 0019 + 0020 + Drizzle-Schema-Sync sind als Spike committed (KC2 commit `ef00abc` für 0019, `next` für 0020). Code-Pfade nutzen die neuen Spalten noch nicht — Migration wird beim nächsten KC2-Code-Deploy mit dem Phase-1-Build zusammen aktiv.

**Konkretes was im Repo liegt:**
- [drizzle/migrations/0019_groups_and_sharing_phase1.sql](../../../drizzle/migrations/0019_groups_and_sharing_phase1.sql) — Haupt-Migration
- [drizzle/migrations/0020_phase1_review_fixes.sql](../../../drizzle/migrations/0020_phase1_review_fixes.sql) — Engineering-Review-Nachbesserungen:
  - `object_revisions.dek_scheme` Spalte (Lazy-Migration produziert mixed-state)
  - Diamond-Cascade-UNIQUE-Index NULL-Pitfall fix (split in 2 Partial-Indexes)
  - `groups.owner_id` FK zu users(id) ON DELETE RESTRICT (GDPR-Erase-Safety)
  - `group_members.user_id` FK CASCADE
  - `share_grants.granted_to/granted_by` FK zu users(id)
- [src/db/schema.ts](../../../src/db/schema.ts) — Drizzle-Schema synchron (objects + shareGrants Tabellen erweitert, neue groups + groupMembers + GroupRow/GroupMemberRow Types)
- [src/storage/shares.ts:23-32](../../../src/storage/shares.ts) — `ShareView.grantedTo` auf nullable umgestellt

### 1.1 Neue Migration `0XXX_groups_and_sharing_phase1.sql`

```sql
-- ============================================================================
-- Group-Sharing Phase 1 — neue Tabellen + Schema-Korrekturen aus Pre-Build-Review
-- ============================================================================

-- ─── objects: Per-Object-DEK + Owner-Self-Read-Pfad ─────────────────────────
ALTER TABLE objects
  ADD COLUMN dek_scheme TEXT NOT NULL DEFAULT 'owner_hkdf',
  ADD COLUMN owner_wrapped_dek BYTEA,
  ADD COLUMN owner_wrap_key_version INT,
  ADD COLUMN cascade_on_share BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT chk_dek_scheme_consistency CHECK (
    (dek_scheme = 'owner_hkdf' AND owner_wrapped_dek IS NULL)
    OR
    (dek_scheme = 'per_object' AND owner_wrapped_dek IS NOT NULL)
  ),
  ADD CONSTRAINT chk_dek_scheme_values CHECK (dek_scheme IN ('owner_hkdf', 'per_object'));

-- ─── groups ─────────────────────────────────────────────────────────────────
CREATE TABLE groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  wrapped_master_dek BYTEA NOT NULL,
  master_version INT NOT NULL DEFAULT 1,
  rotated_at BIGINT,
  read_audit_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  cascade_on_share_default BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL,
  archived_at BIGINT
);

CREATE INDEX idx_groups_owner ON groups(owner_id) WHERE archived_at IS NULL;

-- ─── group_members ──────────────────────────────────────────────────────────
CREATE TABLE group_members (
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  wrapped_group_dek BYTEA NOT NULL,
  wrapped_for_master_version INT NOT NULL,
  joined_at BIGINT NOT NULL,
  removed_at BIGINT,
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX idx_group_members_user ON group_members(user_id) WHERE removed_at IS NULL;

-- ─── share_grants — Group-Target + Cascade-Tracking ─────────────────────────
ALTER TABLE share_grants
  ADD COLUMN granted_to_group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
  ADD COLUMN via_cascade_from_object_id UUID REFERENCES objects(id) ON DELETE CASCADE,
  ADD COLUMN wrapped_object_dek BYTEA,
  ADD COLUMN group_master_version INT,
  ALTER COLUMN granted_to DROP NOT NULL,
  ADD CONSTRAINT chk_share_target_xor CHECK (
    (granted_to IS NOT NULL) <> (granted_to_group_id IS NOT NULL)
  ),
  ADD CONSTRAINT chk_share_group_dek_consistency CHECK (
    granted_to_group_id IS NULL
    OR (wrapped_object_dek IS NOT NULL AND group_master_version IS NOT NULL)
  );

CREATE UNIQUE INDEX idx_grants_unique_via_cascade
  ON share_grants(resource_id, granted_to_group_id, via_cascade_from_object_id)
  WHERE revoked_at IS NULL AND granted_to_group_id IS NOT NULL;

CREATE INDEX idx_grants_group_active
  ON share_grants(granted_to_group_id, resource_id)
  WHERE revoked_at IS NULL;
```

### 1.2 RLS-Policies (Erweiterung 0001_rls.sql analog)

```sql
-- Owner sieht eigene Groups + alle ihre Members
CREATE POLICY groups_owner ON groups FOR ALL TO authenticated
  USING (owner_id = current_user_id());

-- Member sieht Gruppen wo er aktiv ist
CREATE POLICY groups_member ON groups FOR SELECT TO authenticated
  USING (id IN (
    SELECT group_id FROM group_members
    WHERE user_id = current_user_id() AND removed_at IS NULL
  ));

-- group_members: Owner sieht alle Members seiner Group; Member sieht alle Members in seinen Groups
CREATE POLICY members_via_group ON group_members FOR SELECT TO authenticated
  USING (
    group_id IN (
      SELECT id FROM groups WHERE owner_id = current_user_id()
    )
    OR
    group_id IN (
      SELECT group_id FROM group_members
      WHERE user_id = current_user_id() AND removed_at IS NULL
    )
  );

-- share_grants RLS analog erweitern: Resource via group sichtbar wenn user Member ist
```

---

## 2. KMS-Layer (Item 2)

[src/adapters/kms/cloud_kms.ts](../../../src/adapters/kms/cloud_kms.ts) bekommt Group-Master-Cache analog zu `unwrapMasterKey()` (Z. 118-150).

```ts
// Process-Cache mit 5min TTL — analog Existing unwrapMasterKey
const groupMasterCache = new Map<string, { key: Uint8Array; expiresAt: number }>();

async function unwrapGroupMaster(groupId: string, version: number, wrapped: Uint8Array): Promise<Uint8Array> {
  const cacheKey = `${groupId}:${version}`;
  const cached = groupMasterCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.key;

  const plain = await kmsDecrypt(wrapped);  // GCP-KMS-call
  groupMasterCache.set(cacheKey, { key: plain, expiresAt: Date.now() + 5 * 60 * 1000 });
  return plain;
}

async function wrapPerObjectDekForGroup(perObjectDek: Uint8Array, groupMaster: Uint8Array): Promise<Uint8Array> {
  // AES-KW oder AES-GCM mit AAD `wrap|object_dek|<group_id>:<version>`
  // Pure-Memory operation, kein KMS-Call.
}

async function wrapGroupMasterForMember(groupMaster: Uint8Array, memberKek: Uint8Array): Promise<Uint8Array> {
  // analog, pure-Memory.
}

async function rotateGroupMaster(groupId: string, oldMaster: Uint8Array): Promise<{
  newMaster: Uint8Array;
  newWrappedMaster: Uint8Array;
  newVersion: number;
}> {
  // 1× kmsEncrypt() für den neuen Master.
  // Caller macht dann die Re-Wraps in memory.
}
```

**KMS-Call-Budget pro Operation:**
- Group-Read (cache hit): 0 KMS-Calls
- Group-Read (cache miss): 1 KMS-Decrypt
- Member-Add: 0 KMS-Calls (Group-Master schon im Cache, neuer Member-KEK aus HKDF)
- Member-Remove: 1 KMS-Encrypt (neuer Master wrappen) + N+M AES-Memory-Wraps

---

## 3. AAD-v2 Domain-Separation (Item 3) — **BREAKING-CHANGE-Refactor**

> **Engineering-Review-Finding (CRITICAL):** Plan-Initial-Stand "neuen RecordType einfügen" war zu optimistisch. [src/lib/crypto/aad.ts:26-34](../../../src/lib/crypto/aad.ts) hat flaches `AadFields` mit Pflicht-`ownerId`. Variante B braucht **Discriminated-Union-Refactor** + Anpassung von **5 Call-Sites**: [objects.ts:168,363,442](../../../src/storage/objects.ts), [revisions.ts:69](../../../src/storage/revisions.ts), [uploads.ts:131](../../../src/storage/uploads.ts), [middleware/idempotency.ts:33](../../../src/middleware/idempotency.ts). Aufwand 0.5d → 1d. **Idempotency + uploads bleiben legacy** (kein per_object-Switch).

[src/lib/crypto/aad.ts:14-25](../../../src/lib/crypto/aad.ts) erweitern:

```ts
export type RecordType =
  | 'objects'               // legacy, owner_hkdf, AAD=objects|owner_id|object_id
  | 'objects-v2'            // per_object, AAD=objects-v2|object_id
  | 'objects-quality'
  | 'object-revisions'
  | 'idempotency';

export function buildAad(args:
  | { recordType: 'objects'; ownerId: string; objectId: string }
  | { recordType: 'objects-v2'; objectId: string }
  | { recordType: 'objects-quality'; ... }
  // ...
) {
  // Disambiguiert über recordType, separate Branches.
}
```

**Tests:** vorhandener AAD-Test-Suite ([src/lib/crypto/aad.test.ts](../../../src/lib/crypto/aad.test.ts)) erweitern:
- objects-v2 + alter `objects`-AAD sind nicht cross-decryptable
- objects-v2 ist deterministisch in `object_id`
- Replay-Test: Ciphertext aus Object-A nicht in Object-B's Slot

---

## 4. Lazy-Migration-Pfad (Item 4)

**Trigger:** beim ersten `createShareWithGroup(objectId, ...)` oder beim ersten `cascadeShareTo(objectId, ...)`. Owner-edits sind kein Trigger — solange das Object nie geteilt wird, bleibt es `owner_hkdf`.

**Sequenz (in einer Postgres-TX):**
1. `BEGIN`
2. `SELECT … FOR UPDATE WHERE id = $objectId` (Row-Lock)
3. Check: wenn `dek_scheme = 'per_object'` → skip Migration, weiter zu Step 8
4. Decrypt body mit Owner-DEK + altem AAD `objects|<ownerId>|<objectId>`
5. Generate random Per-Object-DEK (32 Bytes)
6. Re-encrypt body mit Per-Object-DEK + neuem AAD `objects-v2|<objectId>`
7. UPDATE objects SET dek_scheme='per_object', owner_wrapped_dek=wrap(perObjectDek, ownerKek), owner_wrap_key_version=KEK_VERSION, body_inline OR blob_key=neuer Ciphertext, nonce=neue, key_version=…, current_version=current_version+1, updated_at=now WHERE id=…
8. (Continue with creation of share_grants row(s))
9. COMMIT

**R2-Special-Case:** wenn Body in R2 statt inline — R2-Put des neuen Ciphertexts **vor** DB-COMMIT. Alten Blob NICHT sofort löschen (Cron räumt nach `currentVersion`-Stabilität).

**Tests:**
- Lazy-Migration ist idempotent (Twice-Call gibt selben State)
- Concurrent `updateObject` während Migration → CAS-Konflikt (Caller-retry-Pflicht)
- Concurrent `addObjectRef(skillId, objectId)` während Migration → wartet auf Lock

---

## 5. Read-Pfad + **`updateObject` mit umgestellt** (Item 5)

> **Engineering-Review-Finding (HIGH):** Initial Plan §5 erwähnte nur `readObject`. `updateObject` muss MIT umgestellt werden — sonst sind migrated Objects read-only für Owner. [objects.ts:429-465](../../../src/storage/objects.ts) lädt heute Owner-DEK + legacy-AAD. Für `dek_scheme='per_object'` muss es `unwrap(row.owner_wrapped_dek, ownerKek)` + AAD-v2 nutzen. Crypto-Review §3.2 erwähnt das, Plan jetzt explizit.
>
> Plus: `readObject`-Dispatch-Logic muss als ERSTE Bedingung in der Funktion stehen (vor dem `kms().resolveUserDek(...)`-Call), nicht erst im non-Owner-Branch. Sonst bricht Owner-Read auf migrierten Objects.

[src/storage/objects.ts:352-359](../../../src/storage/objects.ts) — der 501-Throw kommt raus, ersetzt durch:

```ts
// F-1 (post-Phase-1): non-owner can read shared body via group-membership
if (row.ownerId !== ctx.userId) {
  // Lookup active group share for this user
  const grant = await db.select(...).from(shareGrants)
    .innerJoin(groupMembers, ...)
    .where(and(
      eq(shareGrants.resourceId, id),
      eq(groupMembers.userId, ctx.userId),
      isNull(shareGrants.revokedAt),
      isNull(groupMembers.removedAt),
    ))
    .limit(1);
  if (!grant) throw errNotFound(`object ${id} not found or not visible`);

  // Master-Version consistency check
  if (grant.wrappedForMasterVersion < grant.groupMasterVersion) {
    throw new AppError(401, '.../stale-membership', 'group membership stale, re-login required');
  }

  // Unwrap chain
  const memberKek = await kms().resolveUserDek(ctx.userId, ctx.requestId);
  const groupMaster = await unwrapWithKek(grant.wrappedGroupDek, memberKek);
  const objectDek = await unwrapWithGroupMaster(grant.wrappedObjectDek, groupMaster);

  // Decrypt body with objects-v2 AAD
  const aad = buildAad({ recordType: 'objects-v2', objectId: row.id });
  const body = await decrypt(objectDek, ..., aad);

  // Optional read-audit
  if (group.read_audit_enabled && row.ownerId !== ctx.userId) {
    await emitAudit({ action: 'share.read', details: { object_id: id, group_id: grant.groupId } });
  }

  return body;
}
```

**Owner-Read auf per_object:** separater Pfad zu Beginn der Funktion, prüft `dek_scheme`. Wenn `per_object` → `unwrap(owner_wrapped_dek, ownerKek)` + AAD `objects-v2`. Sonst Legacy-Pfad (HKDF + AAD `objects`).

---

## 6. Group-CRUD (Item 6) — **inkl. KC2 HTTP-Routes + HttpKnowledgeAdapter**

> **Engineering-Review-Finding (HIGH, 2 Punkte):**
> 1. **KC2 HTTP-Routes komplett unspezifiziert in Initial-Plan.** `src/routes/groups.ts` existiert nicht. [routes/shares.ts:11-15](../../../src/routes/shares.ts) Zod-Body akzeptiert nur `granted_to: uuid()` — Group-Variante fehlt.
> 2. **HttpKnowledgeAdapter braucht ~6 neue Methoden.** [packages/adapters/src/knowledge/http-client.ts:554-590](https://github.com/axel-rogg/mcp-approval2/blob/main/packages/adapters/src/knowledge/http-client.ts) hat heute nur createShare/listShares/revokeShare. Adapter-Unit-Tests + Mock-fetch-Pattern existiert in [http-client.test.ts:795-800](https://github.com/axel-rogg/mcp-approval2/blob/main/packages/adapters/src/knowledge/http-client.test.ts) — analog erweitern.
>
> **KC2 HTTP-Routes (neuer File `src/routes/groups.ts`):**
> - `POST /v1/groups` — create
> - `GET /v1/groups` — list-for-user
> - `GET /v1/groups/:id` — get-with-members
> - `PATCH /v1/groups/:id` — update (name, description, read_audit_enabled)
> - `DELETE /v1/groups/:id` — archive
> - `POST /v1/groups/:id/members` — add (Body: user_email, role)
> - `DELETE /v1/groups/:id/members/:user_id` — remove
> - `PATCH /v1/groups/:id/members/:user_id` — role_change
>
> **`src/routes/shares.ts` Erweiterung:** Zod-Union mit `granted_to_group_id`.
>
> **HttpKnowledgeAdapter neue Methoden (in approval2):**
> `createGroup`, `listGroups`, `getGroup`, `addGroupMember`, `removeGroupMember`, `shareWithGroup`, `revokeGroupShare`, `setGroupReadAudit`.
>
> Service-Deploy-Reihenfolge: **KC2 zuerst** (HTTP-Routes verfügbar), **dann approval2** (Adapter ruft sie).

[src/storage/groups.ts](../../../src/storage/groups.ts) — neuer File.

**API:**
- `createGroup({ name, description, cascadeOnShareDefault?, readAuditEnabled? })` → erzeugt Group + Owner als Admin-Member + Initial-Group-Master
- `listGroupsForUser(userId)` → alle Groups wo User Owner oder Member
- `getGroup(groupId)` → mit Member-Liste
- `addMember(groupId, userId, role)` → unwrap Group-Master via Caller-Membership, re-wrap mit New-Member-KEK, INSERT
- `removeMember(groupId, userId)` → **kritische Operation, siehe §6.1**
- `archiveGroup(groupId)` → setzt archived_at, RLS filtert raus
- `setReadAudit(groupId, enabled)` → Admin-only

### 6.1 Member-Remove (CRITICAL Atomicity)

```ts
async function removeMember(groupId: string, userIdToRemove: string) {
  return await withUserTx(ctx.userId, ctx.requestId, async (db) => {
    // 1. Lock the group row
    const [group] = await db.select().from(groups)
      .where(eq(groups.id, groupId))
      .for('update');
    if (!group) throw errNotFound(...);
    if (group.ownerId !== ctx.userId /* OR ctx is admin */) throw errForbidden('only admin can remove');

    // 2. Get remaining active members
    const remaining = await db.select().from(groupMembers)
      .where(and(
        eq(groupMembers.groupId, groupId),
        isNull(groupMembers.removedAt),
        ne(groupMembers.userId, userIdToRemove),
      ));

    // 3. Unwrap old master via caller's wrapped_group_dek
    const callerMember = remaining.find(m => m.userId === ctx.userId);
    if (!callerMember) throw errForbidden('caller is not active member');
    const oldMaster = await unwrap(callerMember.wrappedGroupDek, callerKek);

    // 4. Generate new master + wrap with KMS
    const newMaster = randomBytes(32);
    const newWrappedMaster = await kms().wrap(newMaster);
    const newVersion = group.masterVersion + 1;

    // 5. Update groups row
    await db.update(groups).set({
      wrappedMasterDek: newWrappedMaster,
      masterVersion: newVersion,
      rotatedAt: nowMs(),
    }).where(eq(groups.id, groupId));

    // 6. Re-wrap for each remaining member (pure memory)
    for (const m of remaining) {
      const memberKek = await kms().resolveUserDek(m.userId, ctx.requestId);
      const newWrapped = await wrapWithKek(newMaster, memberKek);
      await db.update(groupMembers).set({
        wrappedGroupDek: newWrapped,
        wrappedForMasterVersion: newVersion,
      }).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, m.userId)));
    }

    // 7. Re-wrap each active share_grant's wrapped_object_dek
    const grants = await db.select().from(shareGrants)
      .where(and(
        eq(shareGrants.grantedToGroupId, groupId),
        isNull(shareGrants.revokedAt),
      ));
    for (const g of grants) {
      // unwrap object_dek mit altem Master
      const objectDek = await unwrapWithGroupMaster(g.wrappedObjectDek, oldMaster);
      // re-wrap mit neuem Master
      const newWrappedObjectDek = await wrapWithGroupMaster(objectDek, newMaster);
      await db.update(shareGrants).set({
        wrappedObjectDek: newWrappedObjectDek,
        groupMasterVersion: newVersion,
      }).where(eq(shareGrants.id, g.id));
    }

    // 8. Mark removed
    await db.update(groupMembers).set({ removedAt: nowMs() })
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userIdToRemove)));

    // 9. Audit
    await emitAudit({ action: 'group.member.removed', details: { group_id: groupId, target_user_id: userIdToRemove } });

    // 10. Cache invalidate
    groupMasterCache.delete(`${groupId}:${group.masterVersion}`);
  });
}
```

**Hard-Cap:** `MAX_GRANTS_PER_GROUP = 1000` — wenn überschritten → `RAISE EXCEPTION 'group too large for sync rotation, use async worker (phase 2)'`.

---

## 7. Cascade-Hook bei `addObjectRef` (Item 7) — **Cycle-Detection-Order + Skill-Subtype-Filter**

> **Engineering-Review-Finding (MEDIUM):** [refs.ts:114-136](../../../src/storage/refs.ts) macht heute BFS-Depth-32 mit Random-Reads auf `objects`. Plan §7 hängt einen `FOR UPDATE` auf parent-Skill dahinter in derselben TX. **Lock-Order-Risiko bei parallelen Diamond-Cascades.**
>
> **Sequence-Fix:** Cycle-Detection läuft VOR `FOR UPDATE`. Dann Lock-Acquisition als single-point. Diamond-Cascade-Race wird durch UNIQUE-Index aus 0020 + `INSERT ON CONFLICT DO NOTHING` aufgefangen.

> **Test-Plan-Review-Finding (MEDIUM, neue Klarstellung):** `objects.cascade_on_share BOOLEAN DEFAULT TRUE` aus Migration 0019 ist auf JEDER Object-Row. Ohne weitere Klammern könnte ein Memo (subtype='memo') mit `cascade_on_share=TRUE` ein nicht-intendiertes Cascade auslösen wenn jemand `object_refs(role='skill_resource', from=memo, to=doc)` einfügt. Semantisch unsinnig, aber Code würde versuchen zu cascaden.
>
> **Decision für Phase 1 Cascade-Trigger-Logic:** Cascade-Hook in `addObjectRef` triggert **NUR wenn ALLE drei Bedingungen** matchen:
> 1. `role IN BUNDLE_ROLES` (Phase 1: `['skill_resource']`)
> 2. `parent.cascade_on_share = TRUE` (Object-Level-Opt-Out möglich)
> 3. **`parent.subtype = 'skill_manifest'`** (semantischer Filter — nur echte Skills cascaden)
>
> Implementierung als 3-fach-Conjunction-Check im Code, kein Schema-Change. Test-Case `cascade does NOT fire on a non-skill object_ref even with cascade_on_share=TRUE` ist in [TEST-PLAN](../../security/TEST-PLAN-SHARING-PHASE-1-2026-05-17.md) §7 (Edge-Case k') aufgenommen.
>
> Bei Erweiterung auf weitere Cascade-Familien (z.B. `recipe_ingredient` für Recipe-Bundle-Sharing): `BUNDLE_ROLES` + `BUNDLE_PARENT_SUBTYPES = ['skill_manifest']` analog erweitern. Phase 2+.

[src/storage/refs.ts](../../../src/storage/refs.ts) — bei `addObjectRef(from, to, role)`:

```ts
async function addObjectRef(fromId: string, toId: string, role: string) {
  await withUserTx(..., async (db) => {
    // (existing cycle-detection bleibt)

    // Insert ref first
    await db.insert(objectRefs).values({ fromId, toId, role, createdAt: nowMs() });

    // Cascade-Hook
    if (role === 'skill_resource' /* or BUNDLE_ROLES */) {
      // Lock parent (from) for read; lock child (to) for write
      const [parent] = await db.select().from(objects).where(eq(objects.id, fromId)).for('update');
      if (!parent.cascadeOnShare) return;  // explicit opt-out at object-level

      // Get active group-shares of parent
      const parentShares = await db.select().from(shareGrants)
        .where(and(
          eq(shareGrants.resourceId, fromId),
          isNotNull(shareGrants.grantedToGroupId),
          isNull(shareGrants.revokedAt),
        ));

      // For each: cascade to child
      for (const ps of parentShares) {
        // Lazy-migrate child if needed
        const [child] = await db.select().from(objects).where(eq(objects.id, toId)).for('update');
        if (child.dekScheme === 'owner_hkdf') {
          await lazyMigrateToPerObject(child.id);
        }
        // Compute wrapped_object_dek for this group
        const groupMaster = await unwrapGroupMasterForCurrentUser(ps.grantedToGroupId);
        const objectDek = await unwrapPerObjectDekForOwner(toId);
        const newWrappedObjectDek = await wrapWithGroupMaster(objectDek, groupMaster);
        // INSERT with ON CONFLICT for diamond-cascade safety
        await db.insert(shareGrants).values({
          resourceId: toId,
          grantedToGroupId: ps.grantedToGroupId,
          grantedBy: ctx.userId,
          scope: ps.scope,
          viaCascadeFromObjectId: fromId,
          wrappedObjectDek: newWrappedObjectDek,
          groupMasterVersion: ps.groupMasterVersion,
          grantedAt: nowMs(),
        }).onConflictDoNothing();
      }
    }
  });
}
```

**Bei `removeObjectRef`:** umgekehrt — wenn die letzte Cascade-Quelle einer Resource entfernt wird, revoke alle `via_cascade_from_object_id`-Grants. Direkte Shares (`via_cascade_from IS NULL`) bleiben.

---

## 8. Tool-Surface (Item 8)

> **Engineering-Review-Decision-Punkt (HIGH):** Sensitivity-Wahl für `groups.add_member`. In approval2 triggert `'danger'` zusätzlich PRF-Eval (Re-Auth). Reviewer hält das für add_member überdimensioniert, empfiehlt **`'write'` mit klarem displayTemplate-Hinweis** ("X kann ab dann alle Gruppen-Inhalte lesen").
>
> **Decision für Phase 1:** `'write'` mit `displayTemplate` der den Impact explizit zeigt. Wenn Phase 2 Schaden-Reports zeigt dass User versehentlich Member added, kann später auf `'danger'` upgegradet werden — Migrationspfad ist 1-Zeilen-Change.

Neue Tools in approval2:
- `groups.create(name, description?, cascade_on_share_default?, read_audit_enabled?)` — sensitivity='write'
- `groups.list()` — sensitivity='read'
- `groups.get(group_id)` — sensitivity='read'
- `groups.archive(group_id)` — sensitivity='write'
- `groups.add_member(group_id, user_email, role)` — **sensitivity='write'** mit displayTemplate: "**Achtung:** X wird Member von Gruppe Y und kann ab dann alle Gruppen-Inhalte lesen. Diese Aktion ist umkehrbar (remove_member), aber bereits gelesene Inhalte können nicht zurückgerufen werden."
- `groups.remove_member(group_id, user_id)` — sensitivity='write'
- `groups.list_members(group_id)` — sensitivity='read'
- `groups.set_read_audit(group_id, enabled)` — sensitivity='write' (admin-only)
- `skills.share_with_group(skill_id, group_id)` — sensitivity='write' (Bundle-Cascade)
- `docs.share_with_group(doc_id, group_id)` — sensitivity='write'
- `shares.revoke(resource_id, group_id)` — sensitivity='write'
- `shares.list_my_shares()` — sensitivity='read' ("Shared with me")

**Cascade-Count-Preview (Engineering-Review-Finding LOW):** `skills.share_with_group.execute` muss vor Approval-Build die Cascade-Count berechnen (PLAN §9 zeigt "Schließt ein: 12 verknüpfte Dokumente"). Compute-Pfad: `SELECT COUNT(*) FROM object_refs WHERE from_id=$skill AND role='skill_resource'` + Substitution im displayTemplate via `{{cascade_count}}`-Placeholder. Aufwand +0.5d.

---

## 9. PWA (Item 9) — **Route unter `#/admin/groups`**

> **Engineering-Review-Empfehlung (MEDIUM):** Group-Management ist Administrations-Operation. [apps/web/src/main.ts:7-90](https://github.com/axel-rogg/mcp-approval2/blob/main/apps/web/src/main.ts) hat `#/admin`-Tab. Statt eigenen Top-Level-`#/groups` → Sub-Route `#/admin/groups` einbauen — konsistent zur existierenden Admin-IA.
>
> "Shared with me" wird **NICHT** eigener Tab, sondern Toggle im Storage-Tab: `owned | shared-with-me | both` (Engineering-Review-Empfehlung LOW). Konsistent mit existierendem `subtype`-Filter.

Neue Route `#/admin/groups`:
- Liste meiner Gruppen
- Click → Detail mit Tabs: Members / Geteilte Inhalte / Aktivität / Einstellungen (admin-only)

Storage-Tab Erweiterung:
- Neuer Button "Teilen" pro Object-Detail-View
- Modal: "Mit Person teilen" (auto-Group) ODER "Mit Gruppe teilen" (existierende Group wählen)
- Bundle-Hinweis bei Skill: "Schließt ein: 12 verknüpfte Dokumente"
- Neue Sektion "Geteilt mit mir" (Read-only-Liste)

Approval-Display-Templates:
- `groups.add_member`: WYSIWYS "X@email zu Gruppe Y hinzufügen — Person kann ab Bestätigung alle Inhalte sehen"
- `skills.share_with_group`: WYSIWYS "Skill 'Marketing-Onboarding' (+12 verknüpfte Dokumente) mit Gruppe 'Marketing-Team' (5 Members) teilen"

---

## 10. Audit-Events (Item 10)

Neue Action-Strings für `audit_log`:

- `group.created`
- `group.archived`
- `group.member.added` — details: target_user_id, role
- `group.member.removed` — details: target_user_id, rotation_version_old, rotation_version_new
- `group.member.role_changed`
- `group.read_audit_toggled` — details: enabled, by_user_id
- `share.granted_to_group` — details: resource_id, group_id, scope, via_cascade_from_object_id
- `share.revoked` — details: resource_id, group_id
- `share.read` — details: object_id, group_id, by_user_id (only when group.read_audit_enabled=TRUE)
- `share.cascade.added` — details: parent_id, child_id, group_id (Auto-Cascade)
- `share.cascade.removed` — details: parent_id, child_id, group_id (Ref-Remove triggert Revoke)

Read-Audit-Volumen-Cap: in Phase 1 keine Aggregation, bei Bedarf in Phase 2.

---

## 11. Tests — **detaillierter Test-Plan in eigenem Doc**

> **Stand 2026-05-17:** Vollständiger Test-Plan in [docs/security/TEST-PLAN-SHARING-PHASE-1-2026-05-17.md](../../security/TEST-PLAN-SHARING-PHASE-1-2026-05-17.md) (~5200 Wörter, 46 Test-Cases mit kopierbaren vitest-Skeletons) + Fixtures-Setup für Multi-User-Multi-Group-Tests.
>
> **Coverage-Übersicht:**
> - 28 RLS-Integration-Tests (`tests/integration/groups.test.ts`) — 10 Pflicht + 5 Edge-Cases + 13 Sicherheits-Spezifika (IDOR, Embedding-Inversion-Block, Audit-Gating, GDPR-Erase-FK, Member-CASCADE)
> - 8 Crypto-Unit-Tests (`tests/unit/crypto.test.ts`) — AAD-v2-Domain-Separation, Per-Object-DEK-Entropie, Group-Master-Cache-TTL, Stale-Master-Version
> - 7 Contract-Tests (approval2 `groups-roundtrip.test.ts`) — Wire-Format zwischen approval2 ↔ KC2
> - 3 Pilot-Smoke E2E-Erweiterungen für `pilot-smoke.sh`
>
> **Test-Plan-Review-Finding (HIGH — Pflicht-Test-Case):** Removed-Member-IDOR-Vektor. Migration 0019 `grants_self`-Policy: User der aus Group-X removed wurde aber noch in Group-Y aktiv ist, könnte über `grants_self`-Permissive-Check (granted_by=current ODER granted_to_group_id IN active-memberships) theoretisch Group-X-Grants lesen, wenn die Subquery nicht korrekt filtert. Bei genauer Analyse durch Row-spezifischen Check sicher, aber **expliziter Test-Case erforderlich**: `removed member of group-X cannot see group-X grant-rows even when active in group-Y` ([TEST-PLAN §7e](../../security/TEST-PLAN-SHARING-PHASE-1-2026-05-17.md)).
>
> **Aufwand:** ~12-16h Test-Engineering, ~1530 Lines Test-Code. Davon ~8h Integration-Fixtures + RLS-Cases (Item 1 vorab), ~3h Crypto-Unit, ~3h Contract + Pilot-Smoke + Doku.

### Vorigere Engineering-Review-Findings (HIGH, 3 Punkte):
> 1. **Testcontainer-Pattern funktioniert.** [tests/integration/rls.test.ts:43-50](../../../tests/integration/rls.test.ts) apply'd alle Migrations lexikographisch — neue 0019/0020 laufen automatisch mit. Aber keiner der 28 existing Tests prüft `granted_to_group_id` — Phase-1-PR muss mind. **5 neue RLS-Tests** mitbringen (Group-Member-Read, Removed-Member-Block, Cross-Group-Leak-Block, Cascade-INSERT-RESTRICTIVE-Check, Diamond-Cascade-Uniqueness).
> 2. **Storage-Unit-Tests gibt es nicht** in KC2. Tests liegen in `tests/{unit,integration,contract}/`. Cycle-Detection-Race + Lazy-Migration-Atomicity → `tests/integration/groups.test.ts` (gleicher Container-Pattern), Crypto-Domain-Separation → `tests/unit/crypto.test.ts`.
> 3. **Contract-Tests** in approval2: `apps/server/tests/contract/groups-roundtrip.test.ts` (KC2 `/v1/groups/*`-Shape) + `shares-with-group.test.ts` (Cascade-Antwort mit `via_cascade_from_object_id`).
>
> **`object_vectors`-Blindheit für Group-Members** (Engineering-Review MEDIUM): RLS aus [Migration 0014](../../../drizzle/migrations/0014_vec_owner_only_rls.sql) sperrt Group-Members aus den Embeddings aus (Embedding-Inversion-Defense — SEC-K-023). **By-design.** Phase 1 muss dokumentieren: Group-Members kriegen FTS-Treffer auf shared objects, **aber keine Vektor-Treffer**. UX-Erwartung: "Suche findet geteilte Inhalte über Stichworte, aber nicht über semantische Ähnlichkeit". Phase 2 könnte einen separaten Vector-Share-Scope einführen mit Re-Encrypt-vor-Share.
>
> **Pilot-Smoke** (Engineering-Review MEDIUM): [scripts/pilot-smoke.sh](https://github.com/axel-rogg/mcp-approval2/blob/main/scripts/pilot-smoke.sh) hat heute keine Group-Operationen. Phase 1 braucht E2E-Pfad: `create-group` → `add-member` → `share-skill-with-group` → `read-as-member`.

### Unit-Tests
- AAD-Domain-Separation: `objects` vs `objects-v2` nicht cross-decryptable
- Per-Object-DEK Random-Entropy (32-Bytes, kein Salt-Repeat)
- Group-Master-Cache: Cache-Hit nach 1× KMS-Call, TTL respektiert
- Lazy-Migration idempotent
- Member-Remove-Atomicity: TX-Rollback bei künstlichem Crash zwischen Step 4-7

### Integration-Tests
- Owner shared Skill mit Gruppe → Member sieht Skill + Resources
- Owner fügt nachträglich Doc zum Skill → Doc auto-sichtbar für Group
- Member-Remove → removed Member sieht Body nicht mehr (Body-Read 401)
- Member-Remove + neuer Share → removed Member sieht den neuen nicht
- Cross-Group-Share derselben Resource: zwei `wrapped_object_dek`-Rows, beide funktionieren unabhängig
- Revoke einer Group → Member sieht Resource nicht mehr (404)
- Diamond-Cascade (A→B, A→C, B→D, C→D): D hat genau ein share_grant pro Group

### E2E-Test (manuell durchspielen vor Merge)
- PWA: Group anlegen → Mitglieder hinzufügen → Skill teilen → von Member-Account einloggen → Skill + Bundle lesen
- Member entfernen → Member-Login zeigt Skill nicht mehr in "Shared with me"

---

## 12. Migration-Strategy + Roll-back-Sequence + Service-Deploy-Reihenfolge

Family-Modus heute hat **keine** geteilten Objects (Privat-Use-Case). Migration ist also nur Schema-Add ohne Backfill:

1. Migration anwenden → alle existing objects bleiben `dek_scheme='owner_hkdf'`
2. Owner-Reads weiterhin auf altem Pfad (HKDF + AAD `objects|owner|id`)
3. Erst beim ersten Share eines Objects wird es lazy-migrated

**Service-Deploy-Reihenfolge** (Engineering-Review-Finding HIGH):
1. **KC2 zuerst deployen** (HTTP-Routes für `/v1/groups/*` verfügbar)
2. **Dann approval2 deployen** (HttpKnowledgeAdapter ruft sie, Tool-Surface aktiv)
3. Andernfalls ruft approval2 in 404-Routes und Tool-Calls failen mid-Migration

**Roll-back-Sequence** (Engineering-Review-Finding HIGH):
Plan-Behauptung "additiv" stimmt **teilweise**:
- DROP TABLE `groups`, `group_members` → trivial
- DROP COLUMN auf `objects`, `share_grants` → trivial
- **NICHT trivial:** `ALTER COLUMN granted_to DROP NOT NULL` Roll-back failt wenn pre-Roll-back ein group-share inserted wurde (`granted_to=NULL`). Recovery: `DELETE WHERE granted_to IS NULL` oder Backfill.
- **NICHT trivial:** RLS-Patch auf `objects.owner_or_shared_read` — Roll-back-Reihenfolge muss erst Code revert (501-throw wieder aktiv), DANN Policy revert. Sonst sieht Old-Code Multi-Member-Shares.

**Echte Roll-back-Sequence:**
1. Code-Deploy revert (alte 501-Throw-Logic wieder aktiv, kein Group-Read-Pfad)
2. Group-Shares cleanen: `DELETE FROM share_grants WHERE granted_to_group_id IS NOT NULL`
3. `groups` + `group_members` Rows löschen (oder Tables droppen)
4. Migration revert: DROP Spalten + RLS-Policy zurück
5. `granted_to NOT NULL` wieder aktivieren

**Partial-Apply:** Postgres DDL in TX → atomic, kein partial-state möglich.

## 13. GDPR-Erase + Group-Owner-Behandlung

> **Engineering-Review-Finding (MEDIUM):** [objects.ts:611-625](../../../src/storage/objects.ts) `hardDeleteByOwner` (BYPASSRLS) löscht direkte+Cascade-Grants via FK-CASCADE. Aber: wenn `users.id` gelöscht wird, bleiben `groups.owner_id` orphan und `group_members.user_id` ebenfalls.
>
> **Migration 0020 löst das schemaseitig:**
> - `groups.owner_id` FK ON DELETE **RESTRICT** — User-Delete blockt wenn er noch Groups owned
> - `group_members.user_id` FK ON DELETE **CASCADE** — Member-Rows verschwinden automatisch
> - `share_grants.granted_to/granted_by` FK ON DELETE **CASCADE** — share-Rows verschwinden auch
>
> **Was hardDeleteByOwner App-Layer machen muss (Phase 1 Code-Item Q10):**
> 1. Vor `DELETE FROM users WHERE id=$ownerId`: alle owned Groups behandeln
>    - Option A: Auto-Archive (`UPDATE groups SET archived_at=now, ...`) — Members verlieren Read-Zugriff
>    - Option B: Owner-Transfer an einen anderen aktiven Admin der Group — Phase 2+ Feature
>    - Phase 1 Default: **Auto-Archive** (einfach, sicher, kein Transfer-UX nötig)
> 2. Für jede archivierte Group: `groups.master_version` finalisieren, `wrapped_master_dek` löschen (Crypto-Shred der Group). Members können nichts mehr lesen.
> 3. `hardDeleteByOwner` selbst läuft dann durch — alle FKs cascaden korrekt.
> 4. Audit: `group.archived_due_to_owner_erase` mit `target_user_id` und Group-Liste.



---

## 13. Out-of-Scope-Liste (klar Phase 2+)

| Feature | Phase | Begründung |
|---|---|---|
| Write/Co-Edit für non-Owner | 2 | bricht Group-Master-Architektur nicht, aber CAS+Conflict-Resolution-UX ist eigenständiges Thema |
| Email-Invite-Workflow | 2 | Resend-DNS muss validiert sein (heute pending) |
| Cross-Instance-Federation | 3+ | 2-3 Monats-Projekt eigenes Protokoll |
| Crypto-Shredding | 3 | echtes "Vergessen" nach Revoke — braucht body-re-encrypt + alte Blobs purgen |
| Group-Nesting | 3 | transitive permissions, recursive lookup |
| Group-Owner-Transfer | 2 | wrapped_master_dek muss re-wrapped mit neuem-Owner-KEK |
| Time-bounded Membership (expires_at) | 2 | reine Schema-Spalte + Cron |
| Async Re-Wrap-Worker (für Groups >1000 Grants) | 3 | erst wenn ein Use-Case real auftritt |
| Read-Notifications (Push beim Reader-Read) | 2-3 | reine Audit-UX-Feature |
| Quorum-Approval (2-of-N admins müssen Member-Add bestätigen) | 3+ | enterprise-feature, im Pilot Single-Admin |

---

## Cross-References

- **Crypto-Specialist-Review:** [docs/security/CRYPTO-REVIEW-GROUP-SHARING-2026-05-17.md](../../security/CRYPTO-REVIEW-GROUP-SHARING-2026-05-17.md)
- **Architektur-Decision:** [approval2/docs/adr/0024-group-sharing-architecture.md](https://github.com/axel-rogg/mcp-approval2/blob/main/docs/adr/0024-group-sharing-architecture.md)
- **Threat-Modell:** [approval2/THREAT-MODEL.md](https://github.com/axel-rogg/mcp-approval2/blob/main/THREAT-MODEL.md) — Trilemma E2EE × Sharing × Search bleibt; Phase 1 ist "Sharing erlaubt, Search auf Plaintext-Title/Description"
- **Bisheriges Storage-Layer:**
  - [src/storage/objects.ts](../../../src/storage/objects.ts)
  - [src/storage/shares.ts](../../../src/storage/shares.ts)
  - [src/storage/refs.ts](../../../src/storage/refs.ts)
  - [src/adapters/kms/cloud_kms.ts](../../../src/adapters/kms/cloud_kms.ts)
  - [src/lib/crypto/aad.ts](../../../src/lib/crypto/aad.ts)
