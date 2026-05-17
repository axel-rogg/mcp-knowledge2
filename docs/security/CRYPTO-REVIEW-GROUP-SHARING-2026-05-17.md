# Crypto-Review: Group-basiertes Document-Sharing (Phase 1)

**Repo:** `/workspaces/mcp-knowledge2/`
**Reviewer:** Cryptography/Multi-Tenant-Key-Management Specialist
**Status:** Pre-Build (kein Schema-Commit erfolgt)
**Datum:** 2026-05-17

---

## 1. Executive Summary

Der Phase-1-Entwurf ist **konzeptionell auf der richtigen Linie** (Envelope-Encryption mit Per-Object-DEK, group-master als Wrap-Key, lazy-Migration), hat aber **drei schema-kritische Lücken** die vor dem ersten `CREATE TABLE groups` gefixt werden müssen:

- **CRITICAL — AAD-Pattern.** Owner-ID im AAD belassen führt nach Owner-Transfer und bei Cross-Group-Shares zu Decrypt-Failures. Empfehlung: AAD auf `objects|<object_id>` reduzieren, kombiniert mit Per-Object-DEK (random, nicht owner-derived).
- **CRITICAL — Owner-Self-Read-Pfad fehlt.** Schema sieht für `dek_scheme='per_object'` keinen Storage-Slot für den owner-wrapped DEK vor. Owner kann nach Lazy-Migration sein eigenes Object nicht mehr lesen ohne einen Group-Membership-Roundtrip.
- **HIGH — Group-Master-DEK Wrapping-Strategie unscharf.** „KMS-wrapped" vs. „owner-KEK-wrapped" ist unentschieden. Empfehlung: GCP-KMS-wrapped mit Process-Memory-Cache (TTL 5min), nicht owner-KEK-wrapped.
- **HIGH — Member-Remove-Atomicity** ist eine Multi-Row-Re-Wrap-Schleife. Muss in einer TX laufen, sonst Recovery-Hell.
- **MEDIUM — Cascade-Race + Lazy-Migration-Race** brauchen explizite Lock-Hierarchy (Skill-Row als Coordinator).
- **MEDIUM — Forward-Secrecy** ist klar nicht garantiert — muss als User-Expectation dokumentiert werden, nicht als Bug.

**Was sound ist:** envelope-pattern mit object-DEK, KMS-Master-Boot-Unwrap, refcount-aware Soft-Delete, RLS-First. Die Datenstruktur (`groups`/`group_members`/erweitertes `share_grants`) trägt — Probleme liegen in **wie die Felder gefüllt werden**, nicht im Tabellen-Layout.

---

## 2. Schema-Korrekturen

### 2.1 `objects` — wrapped Owner-DEK persistieren (CRITICAL)

```sql
ALTER TABLE objects
  ADD COLUMN dek_scheme TEXT NOT NULL DEFAULT 'owner_hkdf',
  ADD COLUMN owner_wrapped_dek BYTEA,           -- NULL solange dek_scheme='owner_hkdf'
  ADD COLUMN owner_wrap_key_version INT;        -- KEK-Version zum Re-Wrap-Tracking
CHECK (
  (dek_scheme = 'owner_hkdf' AND owner_wrapped_dek IS NULL)
  OR
  (dek_scheme = 'per_object' AND owner_wrapped_dek IS NOT NULL)
);
```

Ohne `owner_wrapped_dek` ist nach Lazy-Migration der Owner-Read-Pfad gebrochen (siehe §3.1). Wrap-Schlüssel ist der per-User-KEK aus `kms().resolveUserDek()` (= heutige `dek-v2`-Derivation). Beim Master-Rotation muss `owner_wrap_key_version` mit-rotieren — daher als Spalte, nicht implizit.

### 2.2 `share_grants` — Audit-Spuren statt nur `revoked_at` (HIGH)

```sql
ALTER TABLE share_grants
  ADD COLUMN granted_to_group_id UUID,                       -- entweder dies ODER granted_to (existing)
  ADD COLUMN via_cascade_from_object_id UUID,
  ADD COLUMN wrapped_object_dek BYTEA,
  ADD COLUMN group_master_version INT,                       -- referenziert groups.master_version
  ADD CONSTRAINT chk_share_target_xor
    CHECK ((granted_to IS NOT NULL) <> (granted_to_group_id IS NOT NULL));
```

`group_master_version` ist Pflicht — ohne sie kann der Read-Pfad nach Member-Remove-Rotation nicht entscheiden welcher Group-Master das wrapped_object_dek aufschließt (siehe §3.3).

### 2.3 `groups` — Versionierung + Last-Rotation-Cursor (HIGH)

```sql
CREATE TABLE groups (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  wrapped_master_dek BYTEA NOT NULL,
  master_version INT NOT NULL DEFAULT 1,             -- monoton, ++ bei Rotation
  rotated_at BIGINT,                                 -- Tracking ohne Audit-Log-Roundtrip
  read_audit_enabled BOOL NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  archived_at BIGINT
);
```

### 2.4 `group_members` — Master-Version mit-tracken

```sql
CREATE TABLE group_members (
  group_id UUID NOT NULL,
  user_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','member')),
  wrapped_group_dek BYTEA NOT NULL,
  wrapped_for_master_version INT NOT NULL,           -- = groups.master_version zum Wrap-Zeitpunkt
  joined_at BIGINT NOT NULL,
  removed_at BIGINT,
  PRIMARY KEY (group_id, user_id)
);
```

Wenn `wrapped_for_master_version < groups.master_version`, weiß der Read-Pfad: Member-Eintrag ist stale, re-wrap fällig oder Member-Read-Fail mit klarem Error. Ohne diese Spalte gibt es nach Member-Remove silent-fail.

---

## 3. Crypto-Operations-Korrekturen

### 3.1 Read-Pfad (CRITICAL — Fix verpflichtend)

**Korrigierte Sequenz für non-Owner-Read:**
1. Lookup `group_members(user_id=current, group_id, removed_at IS NULL)` → `wrapped_group_dek`, `wrapped_for_master_version`.
2. KMS-Unwrap `wrapped_group_dek` mit Member-KEK → Group-Master-DEK.
3. Lookup `share_grants(resource_id, granted_to_group_id=G, revoked_at IS NULL)` → `wrapped_object_dek`, `group_master_version`.
4. **Konsistenz-Check:** `wrapped_for_master_version` muss `≥ group_master_version` sein. Sonst → 401 stale-membership.
5. Unwrap `wrapped_object_dek` mit Group-Master-DEK → Object-DEK.
6. AAD bauen: `objects|<object_id>` (siehe §5).
7. AES-GCM-decrypt body.

**Korrigierte Sequenz für Owner-Read auf `dek_scheme='per_object'`:**
1. Lookup `objects.owner_wrapped_dek` + `owner_wrap_key_version`.
2. Resolve Owner-KEK via `kms().resolveUserDek(ownerId, ...)` (= Owner-self-KEK, gleiche HKDF wie heute).
3. Unwrap → Object-DEK.
4. Decrypt body.

Der **„impliziter Owner-self-share-grant"** ist eine schlechte Idee (Bloat in `share_grants`, special-casing der RLS-Policies). Spalte in `objects` ist sauberer.

### 3.2 Lazy-Migration (HIGH)

**Korrigierte Sequenz:**
1. `BEGIN`.
2. `SELECT … FOR UPDATE` auf das Object-Row → Lock. Lock-Window klein halten (kein Blob-Fetch innerhalb).
3. Innerhalb der TX: aktuellen Body decrypten (alter DEK + altes AAD `objects|<ownerId>|<objectId>`).
4. Random 32-Byte Per-Object-DEK generieren.
5. Re-encrypt mit Per-Object-DEK + **neuem** AAD `objects|<objectId>`.
6. `wrapped_object_dek = wrap(perObjectDek, groupMasterDek)` (für die initiale Group).
7. `owner_wrapped_dek = wrap(perObjectDek, ownerKek)`.
8. UPDATE objects SET dek_scheme='per_object', owner_wrapped_dek=…, body_inline/blob_key=neuer Ciphertext, nonce=…, key_version=…, current_version=current_version+1 WHERE id=…
9. INSERT share_grants(…, wrapped_object_dek=…, group_master_version=groups.master_version).
10. COMMIT.

**CAS-Konflikt mit gleichzeitigem `updateObject`-Body-Replace:**
- Das ist kein Race wenn Schritt 2 `FOR UPDATE` läuft. Der konkurrierende Update wartet auf Row-Lock-Freigabe und sieht dann `dek_scheme='per_object'`.
- Aber: `updateObject` muss DANN ebenfalls den `per_object`-Pfad nutzen (Re-encrypt mit dem schon existierenden Per-Object-DEK, nicht mit Owner-DEK). Heute wirft es 501 — das muss in Phase 1 ergänzt werden, sonst ist `dek_scheme='per_object'`-Objects read-only für Owner. Code-Pfad: [src/storage/objects.ts:429-481](src/storage/objects.ts).

### 3.3 Member-Add (LOW)

So wie geplant korrekt:
1. Owner/Admin unwrapped Group-Master (via eigene Membership-Row).
2. Wrap mit Member-KEK (= `kms().resolveUserDek(newMemberId)`).
3. INSERT `group_members(wrapped_for_master_version=groups.master_version)`.

Eine Subtilität: das **Wrap mit Member-KEK** setzt voraus dass `kms()` den DEK eines **anderen** Users resolven kann. Heute via Master-HKDF kein Problem (Master ist process-global). Wenn später Per-User-Master-Keys kommen (Multi-Tenant-Hardening), bricht das. **In Phase 1 explizit dokumentieren** dass Group-Sharing single-master-Annahme hat.

### 3.4 Member-Remove (CRITICAL — Atomicity-Fix)

**Korrigierte Sequenz (eine TX, eine Lock-Reihenfolge):**

```
BEGIN;
SELECT groups.* FROM groups WHERE id=$G FOR UPDATE;  -- Coordinator-Lock

-- 1. Old-master einlesen (für Re-Wrap-Quelle)
oldMaster := unwrap(groups.wrapped_master_dek);

-- 2. Neuen master generieren
newMaster := randomBytes(32);
newWrappedMaster := kms.wrap(newMaster);

-- 3. UPDATE groups SET wrapped_master_dek=newWrappedMaster,
--       master_version=master_version+1, rotated_at=now;
--    → master_version inkrementiert ATOMIC mit der wrapped-master-Änderung.

-- 4. Für jeden bleibenden Member: re-wrap mit Member-KEK
--    UPDATE group_members SET wrapped_group_dek=..., wrapped_for_master_version=NEW_VERSION
--    WHERE group_id=$G AND user_id=...

-- 5. Mark removed: UPDATE group_members SET removed_at=now WHERE user_id=$X
--    (kein Re-Wrap, Eintrag bleibt audit-stehen)

-- 6. Für jeden aktiven share_grants: alten wrapped_object_dek dekapseln,
--    neu wrappen, group_master_version=NEW_VERSION setzen.
--    UPDATE share_grants SET wrapped_object_dek=..., group_master_version=NEW_VERSION
--    WHERE granted_to_group_id=$G AND revoked_at IS NULL;
COMMIT;
```

**Crash-Recovery-Argument:** alles unter einem `FOR UPDATE` auf `groups.id` = serialisiert. Wenn die TX crashed (Prozess-Kill, DB-Timeout), rollbacked Postgres ALLES — kein partial-state. Lock-Window ist O(M+N) Re-Wraps **in CPU**, kein I/O — typisch <100ms für M=50 members + N=200 grants. Lock-Hold-Zeit ist kein Problem für realistic group-sizes.

**Wenn die Group sehr groß wird** (>10 000 grants): in Batches arbeiten, aber **dann pro Batch eine eigene TX mit zwischenzeitlicher `master_version`-Stabilität** — das heißt Schritt 3 erst ganz am Ende. Phase 1: hardcoded `MAX_GRANTS_PER_GROUP = 1000`, RAISE wenn überschritten.

**KMS-Roundtrip-Optimierung:** Schritt 2 macht 1× `kms.wrap()`. Schritte 4 + 6 sind reine Memory-Ops (AES-Wrap mit oldMaster/newMaster, die schon plain im Process sind). Also kein KMS-Rate-Limit-Risiko.

### 3.5 Cascade (HIGH)

**Korrigierte Sequenz für `addObjectRef(skill, doc, role='resource')`:**
1. `SELECT FOR UPDATE` auf Skill-Row (objects.id=skillId) — Coordinator-Lock.
2. `SELECT share_grants WHERE resource_id=skillId AND revoked_at IS NULL FOR UPDATE` (snapshot der aktiven Skill-Grants).
3. Für `doc`: prüfen `dek_scheme`. Wenn `owner_hkdf` → Lazy-Migration (§3.2) inline jetzt.
4. Für jeden Skill-Grant: INSERT share_grants(resource_id=docId, granted_to_group_id=skillGrant.groupId, scope=skillGrant.scope, via_cascade_from_object_id=skillId, wrapped_object_dek=wrap(docDek, skillGroupMaster), group_master_version=group.master_version).
5. INSERT `object_refs(from=skill, to=doc, role='resource')`.
6. COMMIT.

**Race-Antwort:** `FOR UPDATE` auf Skill serialisiert addObjectRef gegen `createShareBundle(skillId, groupZ)` und gegen `revokeShare`. Reihenfolge: wer den Lock zuerst kriegt, schreibt zuerst. Der zweite sieht im Snapshot den State des ersten.

**Cycle-Detection:** [src/storage/refs.ts:114-136](src/storage/refs.ts) hat schon Cycle-Detection mit BFS-Depth-32 für `addRef`. Für Cascade gilt: wenn A→B→C einen Cycle nach A→C blocked, dann auch B→C→A. Die Cascade muss aber nicht den Cycle-Check selbst machen — sie läuft NACH `addRef`-Cycle-Check.

---

## 4. Race-Conditions + Atomicity

| Operation | Lock | TX-Scope | Begründung |
|---|---|---|---|
| createObject (heute) | none | nur für DB-Insert | Object-ID UUID = unique, keine Konflikte |
| updateObject (per_object) | `FOR UPDATE` auf object-row | DB-Insert + R2-Put | CAS auf currentVersion + DEK-Re-Encrypt müssen atomic sein |
| lazy-Migration | `FOR UPDATE` auf object-row | DB-Updates + R2-Put | siehe §3.2 |
| createShare (group) | `FOR UPDATE` auf object-row | DB-Updates | wrap-mit-group-master + INSERT atomic |
| addObjectRef (cascade) | `FOR UPDATE` auf skill (from-id) | gesamte cascade | siehe §3.5 |
| member-add | `FOR UPDATE` auf groups-row | DB-Updates | sequenziert gegen master-rotation |
| member-remove | `FOR UPDATE` auf groups-row | ALLE Re-Wraps + UPDATE | siehe §3.4 (kritisch) |
| revokeShare | `FOR UPDATE` auf share-row | ein UPDATE | trivial |

**Lock-Hierarchy zur Deadlock-Vermeidung:** **immer in Reihenfolge `groups.id < objects.id < share_grants.id` locken**, niemals umgekehrt. Cascade lockt Skill → Group → share_grants. Member-Remove lockt nur Groups (Group-master rotation), modifiziert share_grants ohne separate Locks (von der Group-Lock geschützt).

**R2-Operations sind nicht-transactional.** Bei `lazy-Migration` muss Body-R2-Put **vor** DB-Commit passieren, aber nach erfolgreichem DB-Commit darf nichts mehr R2-failen. Pattern: `R2.put(new_key, new_cipher)` → DB-COMMIT → später async cron `R2.delete(old_key)` wenn `current_version > N`. Old-key-Leak ist kein Daten-Leak (alter Ciphertext mit owner-only-DEK, niemand außer Owner kann decrypten — und Owner hat den neuen sowieso).

---

## 5. AAD-Pattern-Empfehlung

**Variante A (Status quo):** `objects|<owner_id>|<object_id>`
- bricht bei Owner-Transfer (ownerId ändert sich → AAD-Mismatch → decrypt-fail).
- bricht NICHT bei Cross-Group-Share (object_id bleibt stabil).
- bei `dek_scheme='per_object'` ist owner_id im AAD redundant (DEK ist objektspezifisch).

**Variante B (empfohlen):** `objects|<object_id>` — owner_id raus.
- **Replay-Schutz:** weiterhin durch object_id-Binding. Ein Ciphertext aus Object-A kann nicht in Object-B's Slot replayed werden.
- **Cross-User-Replay (heute via owner-id verhindert):** ersetzt durch DEK-Domain-Separation. Per-User-DEK + AAD-mit-owner war double-protection. Bei `per_object`-DEK ist der DEK schon nicht mehr cross-user-derivable (random + per-object-wrap), AAD braucht nur noch Object-Binding.
- **Owner-Transfer:** funktioniert ohne Re-Encrypt (DEK bleibt, AAD bleibt, nur `owner_wrapped_dek` muss neu-wrapped werden auf neuen Owner-KEK).
- **Cross-Group-Share:** funktioniert ohne Re-Encrypt (DEK bleibt, AAD bleibt, neue Group bekommt eigenen `wrapped_object_dek`).
- **Co-Existenz mit Legacy (`dek_scheme='owner_hkdf'`):** AAD bleibt für legacy `objects|<owner_id>|<object_id>` — entschieden über `dek_scheme`-Spalte. Code-Pfad muss dispatched: `dek_scheme === 'per_object' ? buildAad({type:'objects-v2', objectId}) : buildAad({...legacy})`.

**Variante C (verworfen):** `objects|<group_id>|<object_id>`
- bricht bei Cross-Group-Share (gleiches Object in 2 Groups = 2 verschiedene AADs nötig = Re-Encrypt pro Group). Sofort raus.

**Empfehlung:** Variante B mit neuem RecordType in [src/lib/crypto/aad.ts:14-25](src/lib/crypto/aad.ts):

```ts
export type RecordType =
  | 'objects'           // legacy, owner_hkdf, AAD=objects|owner|id
  | 'objects-v2'        // per_object, AAD=objects-v2|id
  | 'objects-quality'
  | 'object-revisions'
  | 'idempotency';
```

Domain-Separation via Prefix-Unterschied. Saubere Lazy-Migration weil legacy + neu unterscheidbar im AAD selbst.

---

## 6. Forward-Secrecy-Analyse

**Was garantiert ist (Phase 1):**
- Nach `member-remove + rotation` kann der removed Member **keine NEUEN share_grants** mehr lesen, die nach der Rotation hinzukommen.
- Nach `revoke + rotation` kann der removed Member **bestehende share_grants nicht mehr aufschließen**, weil sein `wrapped_group_dek` jetzt stale (`wrapped_for_master_version < groups.master_version`).

**Was nicht garantiert ist:**
- Der removed Member **kann Bodies die er vor dem Remove lokal gecached/exportiert hat** weiter lesen — kein crypto-shredding möglich (Plaintext war in seinem Process).
- Wenn der removed Member zum Zeitpunkt der Remove-Operation eine offene `wrapped_object_dek + Group-Master`-Kombination im Memory hat, kann er den Body danach noch decrypten **wenn er auch den Ciphertext gespeichert hat**. Das ist ein Memory-Capture-Angriff, kein Crypto-Bug.

**Sollte `wrapped_object_dek` nach Revoke gelöscht werden?**
- Pro: kleinere DB-Surface, definitive "this grant is gone".
- Contra: Audit-Trail kaputt (kein Restore-Pfad), Re-Grant müsste re-wrap statt Reuse.
- **Empfehlung:** `revoked_at IS NOT NULL`-Rows behalten WrappedDek, ABER Read-Pfad ignoriert sie (RLS-Filter). Bei Member-Remove-mit-Rotation: re-wrap nur die nicht-revoked Grants (Schritt 6 in §3.4 filtert auf `revoked_at IS NULL`). Revoked Grants bleiben mit altem wrapped_object_dek — der Group-Master unter dem sie gewrapped sind ist nach Rotation aber weg, also de-facto un-decryptable. Forward-Secrecy für revoked grants somit automatic.

**User-Expectation-Management:**
- Im PWA-UI bei Revoke/Remove Hinweis: "Mitglied verliert ab jetzt den Zugriff. Bereits heruntergeladene Inhalte kann das System nicht zurückrufen — wende dich an die Person."
- Skill-Bundles haben dasselbe Caveat, aber stärker: Cascade-Removes betreffen viele Docs auf einmal.

---

## 7. Group-Master-DEK Storage-Form

**Optionen für `groups.wrapped_master_dek`:**

| Variante | Wrap-Key | KMS-Calls / Read | Owner-Compromise-Impact |
|---|---|---|---|
| A | GCP-KMS-Master direkt | 1 pro Read (cold cache) | begrenzt — Owner alleine sieht nichts ohne KMS |
| B | Owner-KEK (HKDF aus master) | 0 (Owner-KEK ist process-resident nach 1× Boot-Unwrap) | TOTAL — Owner-KEK-Leak = alle Group-Bodies lesbar (selbst nach Owner-Remove from Group, wenn die alte KEK noch gilt) |
| C (empfohlen) | GCP-KMS, mit Process-Cache (TTL 5min) | 1 pro Read pro 5min | begrenzt — KMS-Audit zeigt alle Group-Unwraps |

**Empfehlung Variante C.** Implementierung analog `unwrapMasterKey()` in [src/adapters/kms/cloud_kms.ts:118-150](src/adapters/kms/cloud_kms.ts), aber per-group statt global:

```ts
const groupMasterCache = new Map<string, { key: Uint8Array; expiresAt: number }>();
```

Auf shared-cpu-1x-VMs (512 MB RAM) sind 100 group-master-Keys × 32 Bytes = 3.2 KB Cache, no problem.

**Audit-Implikation:** alle group-master-Unwraps gehen via Cloud-KMS-Decrypt = GCP-KMS-Audit-Logs zeigen "key XYZ decrypt request" pro Group. Compliance-positive.

---

## 8. Read-Audit-Pfad (`groups.read_audit_enabled`)

**Empfehlung Phase 1:**
- Spalte einbauen, default `FALSE`.
- Wenn `TRUE`: `audit_log`-Insert pro Body-Read mit `action='share.read'`, `details={group_id, object_id}`.
- Reader-Identity (= `ctx.userId`) ist sowieso schon in `audit_log.actor_user_id` — kein zusätzliches PII-Risiko über das was `audit_log` heute schon hat.
- Volumen-Risk: an einem aktiven Skill (100 Reads/Tag × 50 Groups) sind das 5000 audit-rows/Tag/Skill. Bei 1000 Skills = 5M rows/Tag = 1.5GB/Monat. Tolerable, aber bei `read_audit_enabled=TRUE` PER GROUP → User entscheidet.
- **Owner-Reads ausschließen.** Read-Pfad checkt `if (row.ownerId === ctx.userId) skip audit-log`. Owner-Reads sind nicht „shared-reads" und sollen den Log nicht fluten.

**Out-of-scope für Phase 1:** Reader-Notification ("der Eigentümer wurde benachrichtigt dass du das gelesen hast"). Nur Log, kein Push.

---

## 9. Cross-Group-Share Sicherheits-Argument

**Szenario:** Owner shared Doc-A mit Group-X und Group-Y. → 2 share_grants Rows, jeweils eigenes `wrapped_object_dek`. Object-DEK ist identisch (per_object, einmal random).

**Was wenn Group-X kompromittiert (Group-Master leakt)?**
- Angreifer kann `share_grants(granted_to_group_id=X).wrapped_object_dek` aufschließen → Object-DEK.
- Mit Object-DEK + AAD `objects-v2|<docA>` → Body-Decrypt erfolgreich.
- **Kann er auch Doc-B lesen, das nur in Group-Y geteilt ist?** Nein — Doc-B hat eigenen Per-Object-DEK, wrapped unter Group-Y-Master. Group-X-Master hilft nicht.

**Aber:** kann er Doc-A in Group-Y lesen wenn Doc-A in BEIDEN Groups ist? **JA**, weil Object-DEK identisch. Cross-Group-Compromise → wenn dasselbe Object in beiden Groups ist und EINE Group leakt, ist das Object verloren (egal in welcher Group).

**Mitigation:** das ist by-design und nicht durch AAD verhinderbar — verschiedene AADs würden verschiedene Object-DEKs erfordern → kein single-object-DEK mehr → Re-Encrypt pro Group → zerstört den Lazy-Migration-Workflow.

**User-Communication:** "Wenn du dasselbe Object mit mehreren Groups teilst, ist die Vertraulichkeit auf das schwächste Mitglied der schwächsten Group reduziert." Ist intrinsisch zum Sharing-Modell, nicht Bug.

---

## 10. Skill-Bundle-Cascade — Role-Agnostic?

Heute: `BUNDLE_ROLES = ['skill_resource']` — Code-Pfade habe ich in der Storage-Schicht nicht gesehen (nur `KNOWN_ROLES = ['resource', 'references', 'depends_on']` in [src/storage/refs.ts:17](src/storage/refs.ts)). Die Cascade-Logik existiert noch nicht physisch in mcp-knowledge2; sie kommt mit Phase 1.

**Generalisierung:** statt hard-coded role-list, **Spalte `objects.cascade_on_share BOOLEAN DEFAULT FALSE`** auf Skill-Type-Objects setzen. Cascade triggert wenn:
- `share_grants` auf parent existiert (skill)
- UND parent.cascade_on_share=TRUE
- UND `addRef.role IN ('resource')` (bzw. dem konfigurierten role).

**Cycle-Safety:** [src/storage/refs.ts:114-136](src/storage/refs.ts) blockt Cycles bereits über BFS-Depth-32. Cascade-Phase muss ZUSÄTZLICH eine **per-Cascade-Visited-Set** halten, damit eine Diamond-Cascade (A→B, A→C, B→D, C→D — D sollte nur einmal cascade-grant kriegen) nicht doppelte share_grants erzeugt. `INSERT … ON CONFLICT DO NOTHING` mit `UNIQUE(resource_id, granted_to_group_id, via_cascade_from_object_id)` löst es.

---

## 11. Out-of-Scope für Phase 1 (verworfen)

- **Group-Nesting** (Group-Z ist Member von Group-X). Cascade-Lookup wäre recursive, transitive permissions → Mehraufwand für seltenen Use-Case.
- **Crypto-Shredding für Forward-Secrecy.** Echtes Vergessen würde `revoke + re-encrypt all bodies + delete old ciphertext` brauchen. Phase-3+ Feature.
- **Per-User-Master-Keys** (vs. heutigem global-master). Group-Membership-DEKs sind dann nicht mehr trivial wrappable. Phase 4+.
- **Read-Notifications** (Owner gets pinged on Reader-Access). Reine Audit-Pflicht-Funktion.
- **Time-bounded Group-Membership** (`group_members.expires_at`). Bestehende `share_grants.expires_at` reicht für Phase 1.
- **Quorum-Approval für Member-Add/Remove.** Single-admin-pro-Group reicht.
- **Group-Owner-Transfer.** Phase 1 = create-time owner stays.
- **Re-Wrap-Worker für Master-Rotation.** Phase 1 = sync inline mit der TX (works für <1000 grants/group).

---

## 12. Conclusion

Der Plan ist **build-fähig nach 4 konkreten Schema-Korrekturen** und einer **AAD-Format-Entscheidung**:

1. `objects.owner_wrapped_dek` + `owner_wrap_key_version` Spalten (CRITICAL) — Owner-Self-Read auf `per_object` Objects.
2. `share_grants.group_master_version` + `group_members.wrapped_for_master_version` (HIGH) — Member-Remove-Rotation-Detection.
3. `groups.master_version` (HIGH) — monoton, Coordinator-Lock-Ziel.
4. AAD-Format-Switch auf `objects-v2|<object_id>` für `dek_scheme='per_object'` (CRITICAL) — Owner-Transfer + Cross-Group-Share funktionieren ohne Re-Encrypt.

Member-Remove-Atomicity ist **eine TX mit `FOR UPDATE` auf `groups.id`**, nicht mehrere kleine TX — Lock-Window ist tolerable (<100ms typisch). Cascade-Race löst sich mit `FOR UPDATE` auf parent-Skill-Row.

Forward-Secrecy ist **best-effort durch Master-Rotation**, nicht crypto-erzwingbar — muss als User-Caveat in der PWA stehen.

Mit diesen Korrekturen ist Phase 1 **production-grade für Single-Tenant intra-firma sharing**.
