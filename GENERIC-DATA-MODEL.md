# Implementation Brief — Generic Object Model (kein `kind` mehr)

> **✅ STATUS: IMPLEMENTED 2026-05-15** auf Branch `feat/as3-cutover`.
> Commit mcp-knowledge2 `ef8e2b9` (30 files, 1140+/245-) + mcp-approval2 `894d269` (32 files, 450+/347-).
> Verification: KC2 lint+build+unit+contract ✅, Approval2 lint+build+test 473/473 ✅.
> ADR-0004 accepted, Migration 0009_drop_kind.sql deployed-ready.
> Dieser Brief bleibt als **historische Spec** + **Onboarding-Referenz** für neue Entwickler die das Datenmodell verstehen wollen.
>
> **Adressat (historisch):** Subagent / Entwickler der die Umsetzung gemacht hat.
> **Repo:** `/workspaces/mcp-knowledge2` (Storage-Service, standalone) + Cross-Repo-Impact in `/workspaces/mcp-approval2` (Caller, siehe §11).
> **Revision:** v3 (2026-05-15) — Audit-driven Drift-Repair gegenüber v2. Konkrete Änderungen vs v2 siehe §0.7.
> **Out-of-scope (aus diesem Brief, Folge-Arbeit):** Standalone-Auth (ADR-0005), DEK-Resolution-Refactor, Body-Format-Specs pro Subtype, Property-Inkompatibilitäts-Validatoren, Mutation-Pattern-Enforcement, Decay-Score, Tool-Wrapper-Implementation. **Alles davon ist Wrapper-Konzern, nicht Storage** — siehe §2 + §10 + Wrapper-Conventions-Brief im mcp-approval2-Repo ([docs/plans/active/PLAN-wrapper-conventions.md](https://github.com/axel-rogg/mcp-approval2/blob/feat/as3-cutover/docs/plans/active/PLAN-wrapper-conventions.md)).

---

## 0. Begründung der Fassungen

### 0.1-0.6 v1 → v2 (entfernt §§8-11 Wrapper-creep)

Eine v1-Version dieses Briefs (~567 Zeilen) enthielt zusätzlich Subtype-Tabellen mit Per-Subtype-Defaults für `searchable_vector`/`decay_enabled`/`mutation_pattern`, Body-Format-Specs pro Subtype (Markdown-Checkbox-Regex etc.), 6-Achsen-Property-Tabelle und 8-zeilige Inkompatibilitäts-Matrix. v2 hat diese §§8-11 entfernt (Wrapper-Konzern, nicht Storage) und durch §2 "Was der Storage garantiert" ersetzt.

User-Direktive 2026-05-15: *"Es reicht ein Datentyp der alles kann. Die anderen sind nur Wrapper. Alle haben Title, Description und können embedded werden um über search mit Hybrid-Suche gefunden zu werden."*

### 0.7 v2 → v3 (2026-05-15 Audit-Drift)

Zwei parallele Audits (mcp-knowledge2 + mcp-approval2) haben gezeigt: v2 ist seit Schreibung von **AS-3** (Auth-Sprint 3, Cross-Service-Auth) überholt. Konkrete Drift-Punkte:

- **Migration-Slot 0005 belegt.** AS-3 hat 0005–0008 für signing_keys, users_and_invites, audit_proxy_columns, oauth_facade_state verbraucht. Korrekt: **`0009_drop_kind.sql`**.
- **11 kind-Stellen in `src/mcp/register_tools.ts`** — Datei existierte zur v2-Zeit nicht (AS-3 K10/K11, Commits 988d89b + b563cb7). Ist die nach aussen exponierte MCP-Tool-Surface.
- **2 kind-Stellen in `src/routes/internal.ts`** — AS-3 T3-pre (a9c9eb5), `/v1/internal/users/sync` neu.
- **1 kind-Stelle in `src/middleware/idempotency.ts`** — AS-3 K9 (ae27b92), `buildAad(...kind:'memo'...)`.
- **`audit_log.resource_kind` Column ist intakt** — 0007 hat sie nicht angefasst (nur via_proxy + approval_id ergänzt). Drop wird zusätzlicher Schritt in 0009.
- **mcp-approval2 hat 22 src-Files + 9 test-Files mit kind-Refs** (~125 Zeilen). Audit identifiziert kanonische Stelle, Zod-Schema-Duplikate (3×), Apps-Subsystem-Discriminator-Kollision.
- **AS-3 Cross-Service-Contract spricht heute live `kind`** — `kc_wrappers` und `manifest-roundtrip.test.ts` fixieren das Wire-Format. Synchroner Deploy.
- **`apps/api.ts` in mcp-approval2 nutzt zweistufige `kind='app' + subtype=appType`-Hierarchie**. Wenn `kind` wegfällt, kollidiert das mit free-form `subtype`. Strategy-Entscheid nötig (§6.1).
- **`buildAad`-Aufrufer sind 4 Stellen, nicht 1** — `storage/objects.ts`, `storage/revisions.ts`, `storage/uploads.ts:124`, `middleware/idempotency.ts:34`. Alle vier müssen synchron AAD-Shape ändern.
- **`shares.ts:49` blockt `obj.kind === 'memo'`** — Memo-Sharing-Restriction wird mit kind-Drop strukturell unmöglich; Policy-Frage (§6.3).

v3 inkorporiert die Audit-Daten exakt: korrigierte Migrations-Nummer, alle AS-3-Files, exakte Zeilen-Refs, Top-5-Risiken, Cross-Repo-Phasen (§11), 4 explizite Strategy-Entscheide (§7).

---

## 1. Ziel + Motivation

### 1.1 Ziel

`mcp-knowledge2` hat heute 4 hardcoded ObjectKinds (`doc | skill | app | memo`). Wir kollabieren das auf **einen einzigen generischen Object-Typ**. `kind` als Discriminator verschwindet komplett aus Schema, AAD, Routes und Types. `subtype` bleibt als **frei-erweiterbarer String** ohne Enum-Constraint, **ohne DB-Enforcement**, **ohne Storage-Semantik** — nur als Caller-Convention.

**Der Kern-Satz:**

> Storage kennt **ein** Object: `(id, owner_id, subtype?, title?, description?, body)`. `title` und `description` sind plaintext-Spalten (FTS-indexed). Body ist opaque ciphertext. Embedding läuft uniform: wenn `description` non-null und Request setzt `embed=true`, wird embedded. Tool-Wrapper im Caller-Repo (`lists.*`, `notes.*`, `memorize.*`, `apps.*`) implementieren Domain-Logik.

### 1.2-1.4 Motivation (Kurz, unverändert vs v2)

- **v1.2 History**: A2UI-LayoutDoc-System des Vorgängers war zu komplex (4 Race-Fix-Commits in 14 Tagen, "Tomaten auf Einkaufsliste" brauchte 3-5 Tool-Calls). Falsche Schicht-Trennung — Persistenz im UI-Layer.
- **v1.3 Trend-Recherche 2026**: "Tools = Hände, Skills = Hirn" (Anthropic), "narrow composable transparent tools" (Composio/MindStudio), OpenAI Apps SDK gegen UI-Layer-Persistenz.
- **v1.4 Migrations-Fenster**: pre-pilot ist Kosten ~1-2 Tage Code; post-pilot 2-4 Wochen Migration. 10-20× Multiplikator.

### 1.5 Warum **ein** Object reicht

Property-Orthogonalität: `body_format`, `mutation_pattern`, `searchable_vector`, `decay_enabled`, `versioning` sind orthogonal — die 4 Kinds sind nur etablierte Bundles. Title+Description sind universal. Embedding ist heute schon uniform (`composeEmbedSource()` ist kind-agnostisch in [src/storage/objects.ts](src/storage/objects.ts)). Sharing wird vollständig generisch.

### 1.6 Was das konkret löst

| Pain | Gelöst durch | Mechanismus |
|---|---|---|
| Memos sind nicht sharable | Generic Object Model | `share_grants.resource_kind` raus |
| Neuer Use-Case = neue Migration | Subtype free-form | Caller introduziert Convention ohne Repo-Change |
| Per-subtype searchable_vector defaults | Embed-Regel uniform | `description != null + embed=true` |
| Tool-Surfaces pro Use-Case (Anthropic 2026) | Wrapper im Caller-Repo | dünne Tools über generic objects |

### 1.7-1.8 Was wir bewusst NICHT machen + User-Direktive

Storage macht **keine** Body-Format-Validation, **keine** Property-Inkompatibilitäts-Matrix, **kein** Mutation-Pattern-Enforcement, **keinen** Decay-Score. Wrapper im Caller-Repo macht das.

User-Direktive 2026-05-15 (kanonisch): *"Es gibt nur einen generischen Dokumenttyp. Teilen soll generisch über alle Objekte gehen. Wir bauen es gleich multiuserfähig."* + *"Es reicht ein Datentyp der alles kann. Die anderen sind nur Wrapper. Alle haben Title, Description und können embedded werden um über search mit Hybrid-Suche gefunden zu werden."*

---

## 2. Was der Storage garantiert (und was nicht)

### 2.1 Storage-Surface (eindeutig)

| Spalte | Typ | Semantik |
|---|---|---|
| `id` | uuid PK | |
| `owner_id` | uuid | RLS-tenant |
| `subtype` | text, nullable | **Free-form Caller-Convention**, zod-Form-only (`^[a-z][a-z0-9_-]{0,31}$`). Storage interpretiert NICHTS. |
| `title` | text, nullable | Plaintext, FTS weight A |
| `description` | text, nullable | Plaintext, FTS weight B. **Embed-Source wenn non-null + embed=true.** |
| `keywords_json`, `trigger_hints` | text, nullable | Plaintext, FTS weight C/D |
| `meta_json` | jsonb, nullable | Caller-Convention |
| `body_inline`, `blob_key`, `body_size`, `body_hash`, `mime_type` | wie heute | mime_type ist Caller-Convention |
| `current_version` | int | CAS-Token, uniform |
| `deleted_at`, `created_at`, `updated_at` | timestamps | |
| `embedding` (via `object_vectors`) | vector(N) | NULL wenn nicht embedded |

`kind` und `share_grants.resource_kind` und `audit_log.resource_kind` werden in Migration 0009 entfernt.

### 2.2 Embedding-Regel (uniform)

**Bedingung:** `description != null` UND Request setzt `embed=true`. Dann `composeEmbedSource(title, description, triggerHints, keywords)` → upsert `object_vectors`. Sonst kein Vector. **Kein `searchable_vector`-Property im Schema.**

### 2.3 Hybrid-Search (kind-agnostisch)

`/search`: FTS + Vector + RRF über alle Objects. `subtypes?: string[]`-Filter optional.

### 2.4 Sharing (generisch)

`share_grants(resource_id, granted_to, granted_by, scope, ...)`. Alle Objects sharable. `obj.kind === 'memo'`-Block in `shares.ts:49` fällt weg (§6.3 dokumentiert die Policy-Entscheidung).

### 2.5 Was Storage NICHT macht

Keine Body-Format-Validation, keine Property-Inkompatibilitäten, keine Mutation-Pattern-Enforcement, kein Decay-Score, keine Subtype-Whitelist.

---

## 3. Akzeptanzkriterien

- `npm test` grün (alle vitest-Suites, besonders `tests/integration/rls.test.ts`)
- `npm run lint` grün
- `npm run build` grün
- `grep -rEn "ObjectKind|SharedResourceKind|z\.enum\(\['doc'" src/` liefert **0 Treffer** (ausser im Migrations-File `0009_drop_kind.sql` als historischer Audit)
- Migration `up` + Reset (`drizzle/migrate.ts` rerun) lauffähig gegen frische DB
- ADR-0004 geschrieben + Status `Accepted`
- [docs/plans/active/PLAN-architecture-v2.md](docs/plans/active/PLAN-architecture-v2.md) §§2.1 + 3.5 + 5.2 + 5.3 + 5.4 angepasst (13 kind-Refs raus, Zeilen 147/201/203/244/293/531/603/620/626/639/645/660)
- [docs/CROSS-SERVICE-CONTRACT.md](docs/CROSS-SERVICE-CONTRACT.md) angepasst (17 kind-Stellen raus)
- [docs/openapi.yaml](docs/openapi.yaml) angepasst (12 kind-Stellen raus, ObjectKind-Schema raus, subtype als free-form string)
- [docs/SECURITY.md](docs/SECURITY.md) AAD-Shape Z.40 aktualisiert
- [docs/MIGRATION-FROM-MCP-KNOWLEDGE.md](docs/MIGRATION-FROM-MCP-KNOWLEDGE.md) angepasst (5 Stellen)
- [docs/PILOT-READINESS.md](docs/PILOT-READINESS.md) curl-Beispiele + Sections angepasst (9 Stellen)
- AAD-Format-Change dokumentiert in [src/lib/crypto/aad.ts](src/lib/crypto/aad.ts) Header-Kommentar
- **Cross-Repo:** mcp-approval2 Contract-Tests (`apps/server/tests/contract/manifest-roundtrip.test.ts:47` + `kc-tools-call.test.ts`) angepasst und grün (§11 Cross-Repo)

---

## 4. Konkrete Änderungen pro File in mcp-knowledge2

**Audit-Total: 19 Code-Files / ~102 Code-Stellen + 7 Doc-Files / ~64 Doc-Stellen.** Pro File: exakte Zeilen + Action.

### 4.1 Migration `drizzle/migrations/0009_drop_kind.sql` (NEU — Slot 0005-0008 belegt durch AS-3)

```sql
-- 0009_drop_kind.sql — Remove kind discriminator, generic object model
-- See ADR-0004 + GENERIC-DATA-MODEL.md v3
-- Pre-pilot greenfield: no data to migrate.
-- Slot 0009 (not 0005) — AS-3 has consumed 0005-0008 for signing_keys, users_and_invites,
--   audit_proxy_columns, oauth_facade_state.

-- objects: drop kind column + dependent indexes + CHECK
ALTER TABLE objects DROP CONSTRAINT IF EXISTS objects_kind_check;
DROP INDEX IF EXISTS idx_objects_owner_kind;
DROP INDEX IF EXISTS idx_objects_owner_hash;
ALTER TABLE objects DROP COLUMN kind;

-- Recreate indexes without kind
CREATE INDEX idx_objects_owner_subtype ON objects (owner_id, subtype) WHERE deleted_at IS NULL;
CREATE INDEX idx_objects_owner_hash    ON objects (owner_id, body_hash) WHERE body_hash IS NOT NULL;

-- share_grants: drop resource_kind column + CHECK
ALTER TABLE share_grants DROP CONSTRAINT IF EXISTS share_grants_resource_kind_check;
ALTER TABLE share_grants DROP COLUMN resource_kind;

-- audit_log: drop resource_kind column (replaces v2-plan "keep as nullable TEXT" decision —
--   §6.4 strategy-entscheid favorisiert drop weil audit-info kann in details_json wandern).
-- Falls §6.4 anders entschieden wird (keep): diesen Block aus 0009 streichen.
ALTER TABLE audit_log DROP COLUMN IF EXISTS resource_kind;
```

**Pre-Migration-Verifikation (bash):**
```bash
grep -nE "kind|resource_kind" drizzle/migrations/0001_rls.sql drizzle/migrations/0002_security_hardening.sql drizzle/migrations/0004_erase_cascade.sql
```

Audit-Ergebnis: **0 Treffer** — RLS-Policies sind komplett kind-frei (alle auf `owner_id`/`granted_to`/`actor_user_id`/`auth.app_user_id()`). Kein POLICY-Rewrite nötig.

### 4.2 `src/db/schema.ts`

| Zeile | Was | Action |
|---|---|---|
| 42 | `kind: text('kind').notNull(), // 'doc' \| 'skill' \| 'app' \| 'memo'` | entfernen |
| 105 | `ownerKind: index('idx_objects_owner_kind').on(t.ownerId, t.kind, t.subtype)` | umbenennen auf `idx_objects_owner_subtype`, `t.kind` raus |
| 107 | `ownerHash: index('idx_objects_owner_hash').on(t.ownerId, t.kind, t.bodyHash)` | `t.kind` raus, Index-Name bleibt |
| 191 | `resourceKind: text('resource_kind').notNull()` (shareGrants) | entfernen |
| 227 | `resourceKind: text('resource_kind')` (auditLog) | entfernen (gemäss §6.4-Default) |

Nach Edit: `npm run db:types` (oder äquivalent) für Drizzle inferred Types.

### 4.3 `src/types/domain.ts`

| Zeile | Was | Action |
|---|---|---|
| 3 | `export type ObjectKind = 'doc' \| 'skill' \| 'app' \| 'memo'` | entfernen |
| 9 | `export type SharedResourceKind = 'doc' \| 'skill' \| 'app'` | entfernen |
| 29 | `resourceKind?: SharedResourceKind \| 'memo' \| 'upload' \| 'system'` in AuditEventInput | Type ändern auf `string \| undefined` (free-form) **oder** Feld ganz entfernen wenn §6.4 drop |

### 4.4 `src/lib/crypto/aad.ts` — **AAD-FORMAT-CHANGE**

**Vorher:** `<recordType>|<owner_id>|<object_id>|<kind>:<subtype>`
**Nachher:** `<recordType>|<owner_id>|<object_id>`

Begründung: subtype ist freeform Caller-Convention ohne Storage-Semantik. owner_id+object_id identifiziert den Ciphertext-Slot eindeutig.

| Zeile | Was | Action |
|---|---|---|
| 9 | `import type { ObjectKind } from '../../types/domain.ts'` | entfernen |
| 22 | `kind: ObjectKind` in `AadFields` | entfernen (subtype-Slot auch raus, siehe §6.2 Strategy) |
| 27 | ``${f.kind}:${f.subtype ?? ''}`` AAD-Komponente | weglassen |

```typescript
export interface AadFields {
  recordType: RecordType;
  ownerId: string;
  objectId: string;
}

export function buildAad(f: AadFields): Uint8Array {
  return new TextEncoder().encode([f.recordType, f.ownerId, f.objectId].join('|'));
}
```

Header-Kommentar updaten. **Vier `buildAad`-Aufrufer müssen sync angepasst werden** (4.5, 4.7, 4.8, 4.15). Pre-pilot, kein Re-Encrypt-Window — Hard-Cutover (siehe §6.2).

### 4.5 `src/storage/objects.ts` (10 Stellen)

| Zeile | Was | Action |
|---|---|---|
| 18 | `import type { ObjectKind, Visibility }` | `ObjectKind` raus |
| 41 | `kind: ObjectKind` in `CreateObjectInput` | entfernen |
| 72 | `kind: ObjectKind` in `ObjectView` | entfernen |
| 97 | `kind: r.kind as ObjectKind` in `rowToView` | entfernen |
| 158 | `kind: input.kind` (insert values) | entfernen |
| 193 | `kind: input.kind` (revision write) | entfernen |
| 241 | `getObjectByBodyHash(... kind: ObjectKind ...)` Param | durch `subtype?: string` ersetzen |
| 267 | `getObjectByMeta(... kind: ObjectKind ...)` Param | durch `subtype?: string` ersetzen |
| 336 | `kind: row.kind as ObjectKind` (readObject) | entfernen |
| 409 | `kind: row.kind as ObjectKind` (updateObject) | entfernen |
| 518 | `kind?: ObjectKind` in `ListOptions` | durch `subtype?: string` ersetzen |

`composeEmbedSource()` bleibt unverändert — ist heute schon kind-agnostisch.

### 4.6 `src/storage/shares.ts` (7 Stellen + Memo-Policy)

| Zeile | Was | Action |
|---|---|---|
| 5 | Kommentar zu memo-Sharing-Block | umformulieren (Memo ist jetzt shareable, §6.3) |
| 14 | `import { SharedResourceKind }` | entfernen |
| 25 | `resourceKind: SharedResourceKind` (CreateShareInput) | entfernen |
| 42 | `.select({ id, kind: objects.kind, ownerId })` | `kind` aus select raus |
| **49** | `if (obj.kind === 'memo') throw ...` **Memo-Block** | **entfernen** — Strategy-Entscheid §6.3 (Default: Memo wird shareable, alle Subtypes uniform) |
| 55 | `resourceKind: obj.kind as SharedResourceKind` (insert) | entfernen |
| 128 | `resourceKind: r.resourceKind as SharedResourceKind` (toView) | entfernen |

### 4.7 `src/storage/uploads.ts`

| Zeile | Was | Action |
|---|---|---|
| 124 | `kind: 'memo'` im `buildAad`-Aufruf (upload-finalize) | `kind` weglassen — AAD-Shape gemäss 4.4 |

### 4.8 `src/storage/revisions.ts`

| Zeile | Was | Action |
|---|---|---|
| 21 | `import type { ObjectKind }` | entfernen |
| 74 | `kind: parent.kind as ObjectKind` in `writeRevision` AAD | `kind` weglassen — AAD-Shape gemäss 4.4 |

### 4.9 `src/routes/objects.ts` (7 Stellen)

| Zeile | Was | Action |
|---|---|---|
| 21 | `const KIND = z.enum(['doc', 'skill', 'app', 'memo'])` | entfernen |
| 31 | `kind: KIND` in Create-Body-Schema | entfernen; `subtype: z.string().min(1).max(32).regex(/^[a-z][a-z0-9_-]*$/).optional()` als einziger Discriminator |
| 86 | `kind: body.kind` (an createObject) | entfernen |
| 99, 104, 126 | `emitAudit({... resourceKind: body.kind/r.view.kind ...})` | `resourceKind` raus (oder durch `subtype` falls §6.4 keep — Default: drop) |
| 109 | `const kind = c.req.query('kind') ...` | durch `const subtype = c.req.query('subtype')` ersetzen |
| 114 | `kind: ... ? kind : undefined` (an listObjects) | durch `subtype` ersetzen |

### 4.10 `src/routes/search.ts`

| Zeile | Was | Action |
|---|---|---|
| 11 | `kind: z.enum([...]).optional()` | durch `subtypes: z.array(z.string()).optional()` ersetzen |
| 24 | `...(b.kind !== undefined ? { kind: b.kind } : {})` | durch `subtypes` ersetzen |

### 4.11 `src/routes/shares.ts`

| Zeile | Was | Action |
|---|---|---|
| 29 | `resourceKind: share.resourceKind` (Response) | entfernen |

### 4.12 `src/routes/uploads.ts`

| Zeile | Was | Action |
|---|---|---|
| 18 | `emitAudit({... resourceKind: 'upload' ...})` | `resourceKind` raus (§6.4) |
| 28 | dito für upload.finalize | dito |

### 4.13 `src/routes/internal.ts` (AS-3 T3-pre, NEU vs v2)

| Zeile | Was | Action |
|---|---|---|
| 138 | `resourceKind: 'system'` (user.erased audit) | entfernen (§6.4) |
| 182 | `resourceKind: 'system'` (user.synced audit) | entfernen (§6.4) |

### 4.14 `src/mcp/register_tools.ts` (AS-3 K10/K11, NEU vs v2 — 11 Stellen)

**Kritisch**: ist die nach aussen exponierte MCP-Tool-Surface — Breaking-API für `mcp.objects.create`, `mcp.objects.list`, `mcp.search`, `mcp.shares.list`. Approval2-Adapter muss synchron mit (§11.2).

| Zeile | Was | Action |
|---|---|---|
| 43 | `const KIND = z.enum(['doc', 'skill', 'app', 'memo'])` | entfernen |
| 70 | `kind: KIND` in createObject tool-schema | entfernen, `subtype` rein |
| 106 | `kind: input.kind` (create) | entfernen |
| 121, 128 | `resourceKind: input.kind` in emitAudit | entfernen (§6.4) |
| 151 | `resourceKind: r.view.kind` (read audit) | entfernen |
| 160 | `kind: KIND.optional()` in listObjects tool-schema | durch `subtype: z.string().optional()` ersetzen |
| 178 | `...(input.kind ? { kind: input.kind as Kind } : {})` | durch `subtype` ersetzen |
| 384 | `resourceKind: share.resourceKind` (share output) | entfernen |
| 448 | `kind: KIND.optional()` (search tool-schema) | durch `subtypes: z.array(z.string()).optional()` ersetzen |
| 468 | `...(input.kind ? { kind: input.kind as Kind } : {})` | durch `subtypes` ersetzen |
| 500, 527 | `resourceKind: 'upload'` in emitAudit | entfernen |

### 4.15 `src/middleware/idempotency.ts` (AS-3 K9, NEU vs v2)

| Zeile | Was | Action |
|---|---|---|
| 28-29 | Kommentar `Reuse buildAad shape: recordType\|ownerId\|objectId\|kind:subtype` | aktualisieren auf `recordType\|ownerId\|objectId` |
| 34 | `kind: 'memo'` in `buildAad`-Aufruf | weglassen — AAD-Shape gemäss 4.4 |

### 4.16 `src/observability/audit.ts`

| Zeile | Was | Action |
|---|---|---|
| 22 | `resourceKind: event.resourceKind ?? null` in Insert-Branch 1 | entfernen (Column dropped in 0009) |
| 38 | dito Branch 2 | dito |

### 4.17 `src/search/hybrid.ts` (9 Stellen)

| Zeile | Was | Action |
|---|---|---|
| 10 | `import type { ObjectKind }` | entfernen |
| 14 | `kind?: ObjectKind` (Input) | durch `subtypes?: string[]` ersetzen |
| 22 | `kind: ObjectKind` (Output) | durch `subtype: string \| null` ersetzen |
| 55 | FTS-WHERE `${input.kind ? sql\`AND kind = ${input.kind}\` : sql\`\`}` | durch `${input.subtypes?.length ? sql\`AND subtype = ANY(${input.subtypes})\` : sql\`\`}` ersetzen |
| 60, 65 | Row-Types `kind: ObjectKind` (FtsRow/VecRow) | durch `subtype: string \| null` ersetzen, `kind` aus SELECT raus |
| 75 | Vector-WHERE | analog 55 |
| 87, 89, 93 | `metaById` Map mit `kind` als Feld | durch `subtype` ersetzen |
| 101, 104 | `kind: 'doc' as ObjectKind` Default-fallback | entfernen (kein Default mehr) |

### 4.18 Tests (3 Files, ~23 Stellen)

| File | Stellen | Action |
|---|---|---|
| `tests/integration/objects-roundtrip.test.ts` | 17 (Z. 254/265/288/305/321/338/350/379/395/409/428/440/443/487/503/506 `kind`, Z. 356/366 `resourceKind`, Z. 456 Kommentar) | `kind:` → `subtype:` oder weglassen; `resourceKind:` Stellen löschen |
| `tests/integration/rls.test.ts` | 2 raw-SQL `INSERT INTO share_grants (resource_kind, ...)` (Z. 132, 147) | Spalte aus INSERT raus |
| `tests/unit/crypto.test.ts` | 4 `buildAad(... kind: ...)` (Z. 25, 32, 50, 61) | `kind:` raus, AAD-Shape gemäss 4.4 |

Contract-Tests (`tests/contract/*.ts`, 4 Files, 1192 LOC) sind kind-frei — unverändert.

### 4.19 `docs/openapi.yaml` (12 Stellen)

ObjectKind-Schema (Z. 22), 5× `$ref ObjectKind` in ObjectView/CreateObjectBody/ListQuery/SearchHit (Z. 34/57/126/305/322), 2× resourceKind enum in ShareGrantView (Z. 71-74), Multi-kind D-9 (Z. 293-295), `required` (Z. 30/55/319). Alle raus; `subtype` als `type: string, pattern: '^[a-z][a-z0-9_-]{0,31}$'`.

### 4.20 `docs/CROSS-SERVICE-CONTRACT.md` (17 Stellen)

JWT-Scope-Beispiel `'docs:write skills:read'` → `objects:read`/`objects:write` als Phase-1-Default. Endpoint-URLs + Beispiel-Bodies + D-6 + D-9 (multi-kind search) anpassen. Beispiel-Mapping `alt: { kind: 'doc' }` → `neu: { subtype: 'file' }` dokumentieren. Cross-Repo-Coordination-Hinweis (§11 dieses Briefs) referenzieren.

### 4.21 `docs/plans/active/PLAN-architecture-v2.md` (13 Stellen)

§§ 2.1 Schema (Z. 147, 201, 203, 244, 293), §3.5 AAD (Z. 531), §5.2 FTS (Z. 603, 620, 626), §5.3 Vector (Z. 639, 645), §5.4 Privacy (Z. 660 `search_count{kind}`-Metric → durch `search_count{subtype}` oder generic ersetzen).

### 4.22 `docs/SECURITY.md`

Z. 40: AAD-Shape `objects|<owner_id>|<id>|<kind>:<subtype>` → `objects|<owner_id>|<id>`. Header-Section "AAD" aktualisieren.

### 4.23 `docs/MIGRATION-FROM-MCP-KNOWLEDGE.md` (5 Stellen)

Z. 22, 37, 132, 134, 137 — `kind='skill'` mapping + `getObjectByBodyHash(env, kind, hash)` signature. Anpassen auf neue Signaturen.

### 4.24 `docs/PILOT-READINESS.md` (9 Stellen)

Z. 16, 36, 44, 50, 97, 153, 159, 162, 205 — curl-Beispiele mit `?kind=doc` durch `?subtype=file` ersetzen; Crypto-Section AAD-Shape; Search-Section; D-9 row.

### 4.25 `docs/plans/active/PLAN-architecture-DRAFT-from-mcp-approval2-view.md`

Z. 85, 114 — old draft schema mit `kind` Column + Index. Hinweis "obsolet, siehe PLAN-architecture-v2 §2.1 v3-Revision" einfügen.

### 4.26 `docs/adr/0004-generic-object-model.md` (NEU)

```markdown
# ADR 0004 — Generic Object Model (no kind discriminator)

**Status:** Accepted, 2026-05-15
**Plan reference:** PLAN-architecture-v2 §§ 2.1 + 3.5 + 5.2-5.4 (revised v3)
**Implementation brief:** GENERIC-DATA-MODEL.md v3

## Context

mcp-knowledge2 had 4 hardcoded ObjectKinds (`doc | skill | app | memo`)
backed by CHECK constraints, Drizzle types, AAD format, and zod enums.
Sharing, RLS, encryption and search were already kind-agnostic in
behaviour — only the discriminator was hardcoded.

User-Direktive 2026-05-15:
- "Es gibt nur einen generischen Dokumenttyp."
- "Es reicht ein Datentyp der alles kann. Die anderen sind nur Wrapper."

## Decision

Remove `kind` column from `objects`, `share_grants.resource_kind`,
`audit_log.resource_kind`, `ObjectKind` + `SharedResourceKind` types,
`<kind>:<subtype>` from AAD format (AAD becomes
`<recordType>|<owner_id>|<object_id>`). `subtype` remains as free-form
optional string column without DB-enforcement.

Embedding rule is uniform: `description != null AND request.embed == true`
→ `composeEmbedSource(title, description, triggerHints, keywords)` →
upsert in `object_vectors`. No per-subtype defaults, no
`searchable_vector` property, no incompatibility matrix.

Memo-Sharing-Restriction (heute `if (obj.kind === 'memo') throw` in
`shares.ts:49`) entfällt — alle Subtypes uniform shareable.

Domain logic (body-format validation, mutation pattern, decay score,
property incompatibilities, "memo nicht shareable in App-X"-Policies)
lives in caller-side tool wrappers (`lists.*`, `notes.*`, `memorize.*`
in mcp-approval2), not in storage.

## Rationale

- Storage layer was always uniform; kind was conventional bundling
- Sharing-Generizität: memos are now shareable like everything else
- New subtypes (e.g., 'list', 'note') no longer require schema migrations
- AAD simpler, fewer migration surfaces for future format-changes
- Title + description columns already exist and are uniformly FTS-indexed
- composeEmbedSource is already kind-agnostic in code — brief codifies real behavior

## Consequences

- AAD format breaks all existing ciphertexts — pre-pilot, no data lost
- Cross-Service-Contract change: mcp-approval2 (22 src + 9 test files, ~125 lines)
  must drop kind-typed scopes + adapter + apps-subsystem discriminator-design
  (see §11 in GENERIC-DATA-MODEL.md v3)
- Apps-Subsystem in mcp-approval2 uses two-level `kind='app' + subtype=appType`
  hierarchy (apps/api.ts:230-353) — needs new discriminator design
- Memo-Sharing-Restriction lost — wrapper enforced if needed
- Type-safety on subtype is application-layer (zod string validation), not DB-enforced
- Storage gives zero body-format guarantees — wrappers own that

## Alternatives Considered

- Soften kind enum to free-form string: rejected as semantic noise
- Keep kind as bundle tag: rejected — code would have to handle "kind exists but is meaningless"
- Keep per-subtype Property-Defaults (`searchable_vector`, `decay_enabled`,
  `mutation_pattern`) in storage: rejected — these are wrapper concerns
- Keep `subtype` in AAD as `<recordType>|<owner>|<object>|<subtype>`:
  rejected — subtype is freeform caller-convention, owner_id+object_id
  sufficient for replay-protection
- Keep `audit_log.resource_kind` as nullable TEXT: rejected as default —
  audit_log details_json reicht; see §6.4 of brief for opt-in alternative
```

---

## 5. Vorgehen (Phasen, sync mit §11 Cross-Repo)

Phasen sind so geordnet, dass jede Phase **deploybar** ist ohne die anderen zu brechen. Phase 0 ist Vorab-Klärung, Phase 1-6 ist Code-Arbeit.

| Phase | Repo | Arbeit | Deploy-fähig? |
|---|---|---|---|
| **0** | (Doku/Meeting) | §6 Strategy-Entscheide abnicken (Apps-Discriminator, AAD-Strategy, Memo-Share-Policy, Audit-Log-Drop) | n/a |
| **1** | mcp-approval2 | PWA-Frontend (Bucket 8 im Approval2-Audit, 3 Files) auf `subtype`-tolerant — `api-storage.ts` ist bereits `\| string`, nur Filter-Pills + Edit-Pencil-Guard | ja, vorab |
| **2** | mcp-approval2 | Adapter-Package: `packages/adapters/src/knowledge/{types,interface,http-client}.ts` umbauen. **Lokal Tests grün halten** durch Mock-Update | nein (TypeScript-Errors in Service-Layer bis Phase 3) |
| **3** | mcp-approval2 | Service+Tool-Layer (15 Files), Zod-Schema-Duplikate (3 Stellen) synchron, Contract-Tests anpassen | ja — approval2 Build grün, Calls noch gegen heutige KC2 |
| **4** | mcp-knowledge2 | ADR-0004 schreiben + Migration 0009 schreiben + lokal gegen frische Test-DB ausführen | nein (interne Arbeit) |
| **5** | mcp-knowledge2 | Schema + Types + AAD + Routes + Storage + Search + MCP + Internal + Audit + Tests (alle §4-Files). `npm test` + `npm run lint` + `npm run build` grün. | ja — sobald Tests grün, deploybar |
| **6** | mcp-approval2 | Apps-Subsystem-Refactor (`apps/api.ts`, §6.1-Entscheid umsetzen) + Cleanup von Legacy-JWT-Scope-String | ja |
| **7** | beide | Smoke gegen Production + Cleanup von Dead-Code (alte ObjectKind-Aliase, kc_wrappers Tests) | ja |

**Kritischer Punkt:** Phase 5 (mcp-knowledge2 Deploy) MUSS nach Phase 3 (approval2 Adapter+Service) und vor Phase 6 (approval2 Apps-Subsystem). Apps-Subsystem braucht den `obj.subtype !== 'app'`-Check (oder neuen Discriminator) gegen die NEUE KC2-API.

---

## 6. Strategy-Entscheide (vor Phase 0 abnicken)

Vier Entscheidungen müssen vor Implementation getroffen werden. Default-Empfehlungen sind angegeben.

### 6.1 Apps-Subsystem-Discriminator-Pattern

**Heute:** `apps/api.ts:230-243` legt Apps mit `kind='app', subtype=args.appType` (z.B. `'composable'`) ab. Read-Guard `obj.kind !== 'app'` (Z. 259, 310) verhindert Cross-Kind-ID-Hits.

**Problem:** Wenn `kind` wegfällt und `subtype` zur einzigen Diskriminator-Ebene wird, kann ein App nicht mehr "App vom Typ X" sein — nur noch "Subtype X".

**Optionen:**

| Option | Beschreibung | Vor | Con |
|---|---|---|---|
| **A (empfohlen)** | Subtype-Namespacing: `subtype='app:composable'`, `subtype='app:shopping-list'` etc. Read-Guard wird `obj.subtype?.startsWith('app:')` | Bleibt in der zod-Regex (`a-z0-9_-`), klar, kein Schema-Change | Subtype-Strings werden länger, Caller müssen `'app:'`-Prefix konsequent setzen |
| B | Eigener Discriminator in `meta_json.entity_type='app'` + `meta_json.app_type='composable'` | Subtype bleibt kurz | Discovery via metadata-jsonb ist langsamer als per-Column; UI-Filter wird komplexer |
| C | Apps-Subsystem komplett auf `subtype` flach umstellen (`subtype='composable'` ohne `app:`) | Einfachste Konvention | Kollidiert mit anderen Subtypes — `subtype='composable'` ohne Namespace ist zu generisch |

**Default-Empfehlung: A** — Subtype-Namespacing mit `app:`-Prefix. Erlaubt Wrapper-Tools wie `apps.composable.create` ein klar abgegrenztes Subtype-Universum, ohne meta-jsonb-Komplexität. Zod-Regex bleibt erlaubend: `^[a-z][a-z0-9_:-]{0,31}$` (Doppelpunkt aufnehmen).

### 6.2 AAD-Format-Strategy

**Heute:** AAD ist `<recordType>|<owner>|<object>|<kind>:<subtype>`. Format-Change bricht alle existierenden Ciphertexts.

**Optionen:**

| Option | Beschreibung | Vor | Con |
|---|---|---|---|
| **A (empfohlen)** | **Hard-Cutover.** Pre-pilot, `SELECT COUNT(*) FROM objects` muss 0 sein. AAD-Format-Change Big-Bang. | Sauber, kein Dual-Code | Fail-closed-Verifikation pflicht — sonst Daten-Verlust |
| B | Dual-AAD-Decrypt-Window. Bei Decrypt-Fail mit neuem AAD: Retry mit altem AAD. Lazy-Re-Encrypt on Write. | Tolerant gegen vergessene Daten | 2-Pfad-Code-Komplexität, Re-Encrypt-Window unklar |
| C | AAD-Version-Byte vorne anstellen (`v1\|<recordType>\|...` vs `v2\|<recordType>\|...`) | Erweiterbar für zukünftige Changes | Investment für Pre-Pilot zu früh |

**Default-Empfehlung: A** — Hard-Cutover. Pre-Migration-Gate `SELECT COUNT(*) FROM objects` muss 0 sein. Audit-Log + idempotency_records ggf. truncaten. Verifikation explizit in Migration-Runbook.

### 6.3 Memo-Sharing-Policy

**Heute:** `src/storage/shares.ts:49` blockt `obj.kind === 'memo'` von Sharing. CHECK-Constraint `share_grants.resource_kind IN ('doc','skill','app')` enforced das auf DB-Ebene.

**Problem:** Ohne `kind` kann der Storage nicht mehr "memo unshareable" enforcen. User-Direktive sagt explizit "Teilen soll generisch über alle Objekte gehen".

**Optionen:**

| Option | Beschreibung | Vor | Con |
|---|---|---|---|
| **A (empfohlen)** | **Memos werden shareable** wie alles andere. Code-Block + DB-CHECK fallen weg. | Konsistent mit User-Direktive, keine Sonder-Logik | Default-Verhalten ändert sich für Memos |
| B | Wrapper-Reject im `memorize.*`-Tool im mcp-approval2-Repo. Storage erlaubt, `memorize.share` wirft 400. | Caller-Disziplin statt Storage-Enforcement | Wenn ein Caller direkt `POST /v1/shares` aufruft (nicht via Wrapper), geht's trotzdem |
| C | Storage behält Spalte `shareable BOOLEAN DEFAULT TRUE` auf objects, Wrapper setzt für memo `false`. CHECK-Constraint auf share_grants. | Daten-getrieben, opt-out per Object | Spalte für 1 Use-Case ist overkill |

**Default-Empfehlung: A** — Memos werden uniform shareable. Wenn ein Wrapper-Use-Case "Memos nicht teilbar" rechtfertigt: B nachrüsten.

### 6.4 audit_log.resource_kind: drop oder behalten?

**Heute:** `audit_log.resource_kind TEXT` (nullable), Werte heute `'doc'|'skill'|'app'|'memo'|'upload'|'system'`. 8 Schreib-Stellen im Code (`routes/*.ts`, `mcp/register_tools.ts`, `routes/internal.ts`).

**Optionen:**

| Option | Beschreibung | Vor | Con |
|---|---|---|---|
| **A (empfohlen)** | **Drop column.** Audit-Info wandert in `details_json` falls je gebraucht. | Konsistent mit "kind-Drop" Spirit | UI-Filter "alle list-Operationen" muss anders gebaut werden (details_json-Scan) |
| B | Umbenennen auf `resource_subtype`, free-form TEXT | Behält UI-Filter-Möglichkeit | Audit-Logs sind append-only und drift-anfällig |
| C | Behalten als TEXT, kein semantischer Constraint | Minimal-invasiv | Doku-Schuld (was bedeutet `resource_kind='upload'` vs `=null` post-cutover?) |

**Default-Empfehlung: A** — Drop. Audit-Filter über `details_json->>'subtype'` falls je gewünscht (Postgres jsonb-Index möglich).

---

## 7. Risiken (TOP 5, audit-belegt)

### Risiko 1 — Apps-Subsystem-Discriminator-Kollision

**Owner:** mcp-approval2 Apps-Wrapper.
**Pfad:** [packages/.../apps/api.ts:230-353, 259-311](file:///workspaces/mcp-approval2/apps/server/src/apps/api.ts).
**Bruchstelle:** `kind='app' + subtype=appType` ist heute zweistufig. `if (obj.kind !== 'app')` Read-Guard bricht beim ersten KC2-Read post-cutover.
**Mitigation:** §6.1 Strategy-Entscheid abnicken VOR Phase 6. Default A (Subtype-Namespacing `app:`).
**Likelihood:** sicher (jeder App-Read bricht).
**Impact:** kritisch (Apps-Feature steht).

### Risiko 2 — Cross-Service Wire-Format-Drift

**Owner:** mcp-approval2 Contract-Tests + KC2-Deploy-Sync.
**Pfad:** [tests/contract/manifest-roundtrip.test.ts:47](file:///workspaces/mcp-approval2/apps/server/tests/contract/manifest-roundtrip.test.ts), [kc-tools-call.test.ts:60-248](file:///workspaces/mcp-approval2/apps/server/tests/contract/kc-tools-call.test.ts).
**Bruchstelle:** Contract-Tests fixieren das Wire-Format zwischen approval2 ↔ KC2. Wenn KC2 deployed wird ohne approval2-Contract-Tests vorab anzupassen, fängt Smoke das nicht ab.
**Mitigation:** Phase 3 (approval2 Contract-Tests + Adapter) MUSS vor Phase 5 (KC2 Deploy) abgeschlossen sein. Pre-Deploy-Gate: Contract-Tests in beiden Repos lokal grün.
**Likelihood:** mittel (synchrones Phasing fängt das, asynchron bricht's).
**Impact:** hoch (Production-Ausfall bis Rollback).

### Risiko 3 — AAD-Shape-Breaking-Change

**Owner:** mcp-knowledge2 Crypto-Layer.
**Pfad:** [src/lib/crypto/aad.ts](src/lib/crypto/aad.ts) + 4 Aufrufer: [src/storage/objects.ts](src/storage/objects.ts), [src/storage/revisions.ts:74](src/storage/revisions.ts), [src/storage/uploads.ts:124](src/storage/uploads.ts), [src/middleware/idempotency.ts:34](src/middleware/idempotency.ts).
**Bruchstelle:** AAD-Format-Change macht alle existierenden Ciphertexts (objects + revisions + idempotency-records + finalized-uploads) nicht mehr decryptbar.
**Mitigation:** §6.2 Hard-Cutover. Pre-Migration-Gate `SELECT COUNT(*) FROM objects WHERE deleted_at IS NULL` MUSS 0 sein. Falls nicht: STOP + User fragen. Idempotency-Tabelle truncaten falls AAD-Bug existiert.
**Likelihood:** niedrig (pre-pilot, sollte 0 Rows haben).
**Impact:** kritisch (Daten-Verlust falls Rows existieren).

### Risiko 4 — Index-Selectivity-Regression

**Owner:** mcp-knowledge2 DB-Performance.
**Pfad:** [drizzle/migrations/0000_init.sql:55-57](drizzle/migrations/0000_init.sql), [src/db/schema.ts:105-107](src/db/schema.ts).
**Bruchstelle:** `idx_objects_owner_kind` und `idx_objects_owner_hash` haben `kind` als 2. B-Tree-Spalte. Nach Drop fallen 4 distinkte kind-Werte als Selektor weg. Bei wenigen distinkten Subtypes (post-cutover Verteilung unbekannt — Greenfield) kann das wie Full-Owner-Scan wirken.
**Mitigation:** Post-Migration `EXPLAIN ANALYZE` auf typische Queries (list-by-subtype, hash-lookup) gegen ein Mock-Dataset. Bei Regression: Composite-Index `(owner_id, subtype, body_hash)` testen.
**Likelihood:** mittel (Pre-Pilot kein realer Workload — frühestens nach Production-Daten bewertbar).
**Impact:** mittel (Performance, kein Korrektheits-Issue).

### Risiko 5 — Zod-Schema-Duplikate in mcp-approval2 (drift-prone)

**Owner:** mcp-approval2 Tool-Layer.
**Pfad:** drei unabhängige `KnowledgeKind`-Definitionen: [apps/server/src/tools/types.ts:40](file:///workspaces/mcp-approval2/apps/server/src/tools/types.ts), [apps/server/src/tools/federated-search-tool.ts:14](file:///workspaces/mcp-approval2/apps/server/src/tools/federated-search-tool.ts), [apps/server/src/routes/knowledge-proxy.ts:40](file:///workspaces/mcp-approval2/apps/server/src/routes/knowledge-proxy.ts).
**Bruchstelle:** Wenn nur eines der drei Zod-Schemas migriert wird, akzeptiert ein Layer `subtype`, der andere lehnt ab.
**Mitigation:** Phase 3 enforced alle drei synchron. Bonus-Cleanup: Konsolidieren auf einen einzigen Zod-Schema-Export aus dem Adapter-Package (separater Folge-PR).
**Likelihood:** hoch (drei Stellen sync zu halten ist anfällig).
**Impact:** mittel (Validation-Inkonsistenz, keine Daten-Verlust).

---

## 8. Definition of Done

Alle Akzeptanzkriterien aus §3 erfüllt. ADR-0004 ist accepted-status. PR-Body fasst die Änderung in 10-15 Zeilen zusammen und referenziert ADR-0004 + GENERIC-DATA-MODEL.md v3 + die vier §6-Entscheide.

**Zusätzliche Cross-Repo-Gates:**

- mcp-approval2 Contract-Tests grün (alle 4 Files unter `apps/server/tests/contract/`)
- mcp-approval2 Build (`npm run build` im monorepo) grün
- mcp-approval2 Apps-Subsystem-Refactor (Phase 6) abgeschlossen
- Smoke-Test gegen Production beide Repos: erfolgreiche objects.create/list/search/share über die MCP-Tool-Surface

---

## 9. Migration der existierenden 4 Kinds zu Subtypes

Greenfield in beiden Repos, keine Daten — Migration ist Caller-Konvention:

| Heute (kind) | Morgen (subtype, mcp-approval2-Konvention) | Anmerkung |
|---|---|---|
| `doc` | `file` | Standard. Wrapper-Conventions im approval2-Brief regeln genaueres |
| `skill` | `skill_manifest` | Manifest-Body unverändert |
| `app` | **`app:composable`, `app:shopping-list`, …** (§6.1 Option A) | Zweistufige Hierarchie aufgelöst durch Subtype-Namespacing |
| `memo` | `memo` | Subtype-Name identisch |

**Beispiel-Mapping in CROSS-SERVICE-CONTRACT.md (mcp-knowledge2):**
```
mcp-approval2 alt: { kind: 'doc' }
mcp-approval2 neu: { subtype: 'file' }

mcp-approval2 alt: { kind: 'app', subtype: 'composable' }
mcp-approval2 neu: { subtype: 'app:composable' }
```

Storage behandelt alle vier Konventionen gleich — kein Sonderfall im Code.

---

## 10. Wrapper-Konzept

§§0-9 spezifizieren Storage-Garantien. Diese Sektion erklärt **wer die nicht-Storage-Verantwortung trägt**.

### 10.1 Definition

Ein **Wrapper** ist eine Caller-side Tool-Family (heute im mcp-approval2-Repo) die die generische Storage-API von mcp-knowledge2 nutzt um einen **Domain-Use-Case** abzubilden. Beispiele: `lists.*`, `notes.*`, `memorize.*`, `apps.*`, `bookmarks.*`, `recipes.*` (letzte zwei hypothetisch).

Storage **sieht den Wrapper nicht** — der Wrapper ist HTTP-Client. Storage authentifiziert den User (per JWT), nicht den Wrapper.

### 10.2 Verantwortlichkeiten

| Aspekt | Wrapper (Caller-side) | Storage (mcp-knowledge2) |
|---|---|---|
| Body-Format-Validation | **Ja** — zod-Validator im Tool | Nein — opaque ciphertext |
| Subtype-String setzen (`'file'`, `'list'`, …) | **Ja** — Caller-Konvention | Nein — frei |
| `embed`-Flag setzen | **Ja** — Wrapper-Default | Nein — folgt Request |
| Mutation-Pattern (full_replace vs Patch) | **Ja** — Wrapper-Wahl | Liefert CAS-Token, keine Enforcement |
| Decay-Score | **Ja** — Wrapper-Layer post-Search | Nein |
| Property-Inkompatibilitäten | **Ja** — Wrapper-Reject | Nein |
| Tool-Description, Trigger-Hints | **Ja** — MCP-Tool-Schema | Nein |
| Approval-Sensitivity + Display-Templates | **Ja** — Tool-Standard | Nein |
| Encryption + AAD | Nein — Storage encrypted | **Ja** — DEK + AAD |
| RLS-Enforcement | Nein — vertraut Storage | **Ja** — Postgres-RLS |
| Share-Grants Persistenz | Nein — ruft `POST /v1/shares` | **Ja** |
| FTS5 + Vector-Embedding | Nein — serverseitig | **Ja** — Triggers + composeEmbedSource |
| Hybrid-Search (FTS + Vector + RRF) | Nein | **Ja** |
| Idempotency | Wrapper setzt Header | Storage persistiert |
| Audit-Log | Wrapper kann `details` liefern | Storage schreibt zentralen Log |
| WYSIWYS-Display für Approval-PWA | **Ja** | Nein |

**Faustregel:** Storage macht alles **kind-agnostisch** (Crypto, RLS, FTS, Sharing-Persistenz, Vector). Wrapper macht alles **subtype-spezifisch** (Body-Format, Defaults, Display, Tool-Schema).

### 10.3 Wrapper-Storage-Vertrag (HTTP-API)

Wrapper sprechen Storage via HTTP. **Keine Direct-Code-Imports** — nur HTTP. JWT mit `sub=user-uuid`, signed by Auth-Service. Internal-Endpoints nutzen `SERVICE_TOKEN`.

Kern-Endpoints (siehe [docs/openapi.yaml](docs/openapi.yaml) für autoritative Spec):

| Endpoint | Zweck |
|---|---|
| `POST /v1/objects` | Create Object |
| `GET /v1/objects/:id` | Read Object |
| `PATCH /v1/objects/:id` | Full-Replace Update (CAS via `current_version`) |
| `DELETE /v1/objects/:id` | Soft-Delete |
| `GET /v1/objects?subtype=X` | List by Subtype |
| `POST /v1/search` | Hybrid-Search |
| `POST /v1/shares` | Share-Grant erstellen |
| `DELETE /v1/shares/:id` | Share-Grant revoken |
| `GET /v1/shares?resource_id=X` | Share-Grants listen |
| `POST /v1/uploads/init` | Pre-signed Upload |

### 10.4 Subtype-Convention-Governance

`subtype` ist free-form String. Drei Governance-Themen:

**(a) Wer entscheidet Subtype-String-Semantik?** Der **Wrapper-Conventions-Brief** im mcp-approval2-Repo (siehe §11.6).

**(b) Drift-Prevention.** Wrapper exportieren Subtype-Konstanten (`SUBTYPE_LIST = 'list'`) statt String-Literals. Migration-Skript falls Drift: `UPDATE objects SET subtype='list' WHERE subtype IN ('lists', 'shopping_list')` — billig.

**(c) Konkurrierende Wrapper mit unterschiedlichen Body-Annahmen.** Wrapper-Bug, kein Storage-Problem.

### 10.5 Wrapper-Lebenszyklus

| Phase | Was passiert |
|---|---|
| Hinzufügen | Neue Tool-File im mcp-approval2-Repo, Wrapper-Conventions-Brief-Eintrag |
| Versionierung | Wrapper hat eigene Tool-Version, Storage hat eigene API-Version (`/v1/*`) |
| Migration | Wrapper-Body-Format-Change: One-shot-Script via Storage-API |
| Deprecation | Tool deprecated, Storage-Daten bleiben |
| Removal | Wrapper raus, Storage-Daten optional gewipet |

### 10.6 Discovery

MCP-Tool-Registry + Tool-Descriptions + Skills (`subtype='skill_manifest'`) + `capability_search` (RRF). Storage trägt direkt NICHTS bei.

### 10.7 Anti-Patterns

- Wrapper macht eigene Crypto — **NEIN** (Storage encrypted)
- Wrapper liest direkt aus Postgres — **NEIN** (HTTP only)
- Wrapper enforced Storage-Constraints — **NEIN** (Wrapper kann zusätzlich, nicht duplizieren)
- Wrapper baut eigenen FTS-Index — **NEIN**
- Wrapper hardcoded Subtype ohne Doku — **NEIN**
- Wrapper-Reject als Storage-Reject — **NEIN** (HTTP 400 im Wrapper, Storage erlaubt)
- Wrapper mutiert Storage-Schema — **NEIN**

### 10.8 Minimaler Wrapper (Beispiel)

```typescript
// mcp-approval2/apps/server/src/tools/lists/list_add.ts

const LIST_SUBTYPE = 'list';

const InputSchema = z.object({
  list_id: z.string().uuid().optional(),
  title: z.string().min(1).max(120).optional(),
  items: z.array(z.string().min(1).max(280)).min(1).max(50),
});

function validateMarkdownChecklist(body: string): void {
  // Wrapper-Validator — Storage sieht das nie
}

export async function listAdd(input: unknown, ctx: ToolContext) {
  const args = InputSchema.parse(input);
  // ...
  return await storageClient.createObject({
    subtype: LIST_SUBTYPE,
    title: args.title ?? 'Neue Liste',
    body,
    embed: false,
  });
}
```

### 10.9 Folge-Arbeit (separat zu ticketen, siehe §11.6)

---

## 11. Cross-Repo Impact — mcp-approval2

Audit (2026-05-15) hat **22 src-Files + 9 test-Files** mit kind-Refs in mcp-approval2 gefunden, ~125 Zeilen.

### 11.1 Buckets

| Bucket | Files | kind-Stellen |
|---|---:|---:|
| Adapter (`packages/adapters/src/knowledge/`) | 4 | ~22 |
| Apps-Subsystem (`apps/server/src/apps/`) | 1 | 5 |
| Service-Layer (`apps/server/src/services/`) | 3 | ~14 |
| Tool-Files (`apps/server/src/tools/`) | 7 | ~24 |
| Hub-PWA-Proxy-Route (`apps/server/src/routes/knowledge-proxy.ts`) | 1 | 6 |
| JWT-Scopes (Legacy, dead code unter AS-3) | 1 | 1 |
| Incoming-Response-Parser | 3 | 7 |
| PWA-Frontend (`apps/web/src/`) | 3 | ~16 |
| Tests | 9 | ~30 |
| **TOTAL** | **31** | **~125** |

### 11.2 Kanonische Stelle

[`packages/adapters/src/knowledge/types.ts:21`](file:///workspaces/mcp-approval2/packages/adapters/src/knowledge/types.ts) — `export type ObjectKind`. Alles andere zieht type-narrow hier rein. **Ändert sich diese Definition → TypeScript bricht an allen 22 src-Stellen kontrolliert.** Strategischer Vorteil.

### 11.3 Apps-Subsystem-Discriminator-Kollision (Risiko 1)

[`apps/server/src/apps/api.ts:230-353`](file:///workspaces/mcp-approval2/apps/server/src/apps/api.ts). Heute zweistufig `kind='app' + subtype=appType`. Auflösung: §6.1 Option A (Subtype-Namespacing `app:`). Read-Guards `obj.kind !== 'app'` → `obj.subtype?.startsWith('app:')`.

### 11.4 Zod-Schema-Duplikate (Risiko 5)

Drei unabhängige `KnowledgeKind`-Definitionen müssen sync migriert werden:
- [`apps/server/src/tools/types.ts:40`](file:///workspaces/mcp-approval2/apps/server/src/tools/types.ts)
- [`apps/server/src/tools/federated-search-tool.ts:14`](file:///workspaces/mcp-approval2/apps/server/src/tools/federated-search-tool.ts)
- [`apps/server/src/routes/knowledge-proxy.ts:40`](file:///workspaces/mcp-approval2/apps/server/src/routes/knowledge-proxy.ts)

Bonus-Cleanup als Folge-PR: Konsolidieren auf Adapter-Package-Export.

### 11.5 PWA-Frontend (`apps/web/src/`)

Spricht **nicht direkt mit KC2** — alle Storage-Calls via approval2-Proxy. PWA bricht nur, wenn approval2-Adapter-Layer inkonsistent. `api-storage.ts` ist bereits `\| string`-tolerant (Z. 17 `ObjectKind = ... \| string`) — Phase 1 ist nur Filter-Pills + Edit-Pencil-Guard.

### 11.6 Contract-Tests fixieren Wire-Format (Risiko 2)

[`apps/server/tests/contract/manifest-roundtrip.test.ts:47`](file:///workspaces/mcp-approval2/apps/server/tests/contract/manifest-roundtrip.test.ts) + [`kc-tools-call.test.ts:60-248`](file:///workspaces/mcp-approval2/apps/server/tests/contract/kc-tools-call.test.ts). Explizit als Cross-Service-Contract-Safeguard gegen Wire-Format-Drift gedacht. Wenn KC2 deployed wird ohne Contract-Tests in approval2 vorab anzupassen, fängt der Cutover-Smoke das nicht ab.

### 11.7 Cutover-Reihenfolge

| Phase | Repo | Datei-Buckets | Deploybar? |
|---|---|---|---|
| 1 | mcp-approval2 | PWA-Frontend (3 Files) | ja, unabhängig |
| 2 | mcp-approval2 | Adapter (4 Files, kanonische types.ts) | nein (TS-Errors überall bis Phase 3) |
| 3 | mcp-approval2 | Service+Tools+Routes+Tests (15 Files, 3× Zod-Duplikate sync) | ja, Build grün, Calls noch gegen heutige KC2 |
| 4 | mcp-knowledge2 | ADR-0004 + Migration 0009 schreiben | nein |
| 5 | mcp-knowledge2 | Alle §4-Files + Tests + Build grün | **ja — Pivot-Punkt** |
| 6 | mcp-approval2 | Apps-Subsystem-Refactor (§6.1 Option A) + Legacy-Cleanup | ja |
| 7 | beide | Smoke + Dead-Code-Cleanup | ja |

**Pivot-Punkt = Phase 5.** Vor Phase 5: approval2 spricht kind gegen heutige KC2 — geht. Nach Phase 5: approval2 muss sofort Apps-Subsystem (Phase 6) deployen, sonst brechen App-Reads.

### 11.8 Folge-Tickets (separater Brief im mcp-approval2-Repo)

- **Wrapper-Conventions-Brief** — kanonische Quelle für Subtype-Strings (`'file'`, `'skill_manifest'`, `'app:composable'`, `'memo'`, `'list'`, `'note'`, …), Body-Format-Specs, Defaults, Drift-Prevention.
- **Tool-Wrapper für `list`** (`lists.add`, `lists.tick`, `lists.ensure`)
- **Tool-Wrapper für `note`**
- **Tool-Wrapper für `memorize`** (setzt `embed=true` automatisch, optional Decay-Score Wrapper-side)
- **Tool-Wrapper für `app_state`** (enforced "nicht shareable in Phase 1" als Wrapper-Reject falls §6.3 Option B/C gewählt)
- **PWA-Renderer** für list-Checkbox-UI + note-Markdown-Render + memo-View-List + skill-Manifest-View
- **Konsolidieren der 3 Zod-Schema-Duplikate** auf Adapter-Package-Export

### 11.9 Folge-Tickets im mcp-knowledge2-Repo

- **ADR-0005:** Standalone-Auth (eigenes Email-Login statt JWKS-Pull)
- **ADR-0006 (falls relevant):** Time-Decay-Score im Search-Layer — Default bleibt Wrapper-side
- **ADR-0007 (falls relevant):** OT/CRDT für app_state-Sharing

---

## 12. Vor-Start-Checkliste

- [ ] §6.1 Apps-Discriminator-Entscheid (Default A: Subtype-Namespacing)
- [ ] §6.2 AAD-Strategy-Entscheid (Default A: Hard-Cutover)
- [ ] §6.3 Memo-Share-Policy (Default A: Memos werden shareable)
- [ ] §6.4 audit_log.resource_kind (Default A: Drop)
- [ ] Pre-Migration-Gate `SELECT COUNT(*) FROM objects WHERE deleted_at IS NULL` = 0 in mcp-knowledge2-Prod
- [ ] `npm test` heute grün in beiden Repos (Baseline)
- [ ] Phase-0..7 in §5 + §11.7 verstanden + bestätigt
- [ ] PR-Strategie: ein PR pro Repo, jeweils referenziert auf ADR-0004 + GENERIC-DATA-MODEL.md v3
