# Migration Audit — mcp-knowledge → mcp-knowledge2

Audit-Datum: 2026-05-13.
Quelle: `github.com/axel-rogg/mcp-approval/knowledge-core` (the original
single-user Cloudflare Worker, archived in `/workspaces/mcp-knowledge` for
reference).

This document is the line-by-line accounting of what made it across, what
was deliberately left behind because it belongs in `mcp-approval2`, and
what was identified as a genuine gap and fixed in the same commit as
this report.

## TL;DR

| Bucket | Count | Status |
|---|---|---|
| Storage-layer ports (CRUD, refs, tags, search, uploads, audit, idempotency) | ~20 functions | ✅ Migrated, all with security-audit hardening |
| Cross-cutting concerns (crypto, PII, AAD, ULID/UUID, env, logger, errors) | ~10 modules | ✅ Migrated |
| MCP-Tool layer (`src/tools/**`, ~60 tools) | 60+ files | 🔄 **Deliberately not here** — lives in `mcp-approval2`. See §"Scope split". |
| Apps-Subsystem (`src/apps/**` — blocks, types, action-router) | ~30 files | 🔄 **Deliberately not here** — Tool/UI-Surface, in `mcp-approval2`. |
| MCP-Adapter (`src/routes/mcp.ts`, tool-registry, validate_schema) | ~5 files | 🔄 **Deliberately not here** — Protocol-Server in `mcp-approval2`. |
| Skill helpers (`src/skills/api.ts`) — slug/group/version helpers | ~25 functions | 🔄 Skill-row CRUD migrated as `subtype='skill_manifest'` on objects (ADR-0004 generic object model); skill-specific Tool-helpers belong in `mcp-approval2`. |
| Quality-Gate (`src/quality/`) | 2 files (~600 LOC) | ⚠️ Schema-ready (columns exist), code Phase 5+ |
| **Genuine gaps fixed in this commit** | 3 items | ✅ See §"Gaps fixed" |

## Scope split (PLAN-architecture-v2 §0)

`mcp-knowledge2` is **only** the storage + sharing + hybrid-search
service. Everything that lives "above the data" — MCP-protocol-handling,
tool-dispatch, approval-flow, the apps/blocks composable-UI system —
lives in `mcp-approval2`. The split is intentional and reflected
1:1 in the old repo's directory structure:

| Old path | New home |
|---|---|
| `mcp-knowledge/src/objects/api.ts` | `mcp-knowledge2/src/storage/objects.ts` + `refs.ts` + `tags.ts` + `shares.ts` |
| `mcp-knowledge/src/skills/api.ts` | Skill **storage** in `mcp-knowledge2` as `subtype='skill_manifest'` (ADR-0004 generic object model — no `kind` discriminator). Skill **bundle logic** (manifest parsing, slug-resolution, hash diffing, group membership, resource attachment workflows) → `mcp-approval2/.../tools/skills/*` |
| `mcp-knowledge/src/apps/**` (blocks + types + action-router + legacy-to-layout) | `mcp-approval2/apps/server/src/apps/**` (we see the file `mcp-approval2/apps/server/src/apps/blocks/action_button.ts` already exists there) |
| `mcp-knowledge/src/tools/**` (60+ tool implementations: docs.*, skills.*, memorize.*, apps.*, quality.*, objects.*) | `mcp-approval2/.../tools/**`. These wrap REST calls to the storage service. |
| `mcp-knowledge/src/routes/mcp.ts` (MCP JSON-RPC adapter) | `mcp-approval2/.../mcp/**` |
| `mcp-knowledge/src/util/validate_schema.ts` (JSON-Schema validator for tool inputs) | `mcp-approval2`. mcp-knowledge2 uses zod for REST-body validation; tool-arg validation is the tool-server's job. |
| `mcp-knowledge/src/util/safe_error.ts` | Replaced by RFC 7807 Problem Details in `mcp-knowledge2/src/lib/errors.ts` and `src/middleware/error.ts`. |
| `mcp-knowledge/src/util/retry.ts` (SQLITE_BUSY retries for D1) | Not needed — Postgres handles concurrency natively with MVCC. |
| `mcp-knowledge/src/embed/workers_ai.ts` (Cloudflare Workers AI) | Replaced by `src/adapters/embed/vertex.ts` (Vertex AI text-embedding-005). |
| Old D1 `skill_groups` table | Removed by design — skill-group-membership is now `object_tags` with `tag='group:<slug>'`, per PLAN-v2. |
| `vectorToBlob / blobToVector / cosineSimilarity` (D1-mirror for Vectorize eventual-consistency) | Not needed — pgvector is immediately-consistent; no mirror required. |

## Storage-layer functions — port matrix

Function-by-function check between `mcp-knowledge/src/objects/api.ts` and
the new `mcp-knowledge2/src/storage/*`:

| Old function | New location | Status |
|---|---|---|
| `insertObject` | `storage/objects.ts → createObject` | ✅ |
| `getObject` (by id) | `storage/objects.ts → readObject` | ✅ |
| `getObjectByBodyHash` (dedup) | `storage/objects.ts → getObjectByBodyHash` | ✅ **Migrated in this commit** (was a gap) |
| `getObjectByMeta` (json-path lookup) | `storage/objects.ts → getObjectByMeta` | ✅ **Migrated in this commit** (was a gap) |
| `listObjects` | `storage/objects.ts → listObjects` | ✅ |
| `updateObject` | `storage/objects.ts → updateObject` | ✅ — with CAS via `expectedVersion`; revision-write on body change (gap fixed in this commit) |
| `softDeleteObject` / `restoreObject` | `storage/objects.ts` | ✅ |
| `deleteObject` (hard) | `storage/objects.ts → hardDeleteByOwner` (admin-only via /v1/internal/erase-user) | ✅ |
| `addObjectTag` / `removeObjectTag` / `getObjectTags` | `storage/tags.ts → addTag/removeTag/listTags` | ✅ |
| `addObjectRef` / `removeObjectRef` / `listRefsBy` / `listRefsTo` | `storage/refs.ts` | ✅ |
| `syncRefcount` (recompute COUNT) | Inline `refcount + 1` / `GREATEST(refcount - 1, 0)` in addRef/removeRef | ✅ — no separate batch needed |
| `searchObjectsFts` / `searchObjectsByVector` | `search/hybrid.ts` (RRF-fused) | ✅ |
| `touchObjectLastUsed` | Inline in `readObject` | ✅ |
| `assertObjectR2Key` (path-traversal defense) | `storage/objects.ts → assertBlobKeyShape` + `storage/revisions.ts` inline check | ✅ **Migrated in this commit** (was a gap) |
| `listObjectRevisions` / `getObjectRevision` | `storage/revisions.ts → listRevisions / readRevision`, exposed at `GET /v1/objects/:id/revisions` and `GET /v1/objects/:id/revisions/:version` | ✅ **Migrated in this commit** (was a gap) |
| `decryptObjectSummary` (description_enc) | Removed — F-22 from the security audit, description is plaintext-only |
| `decryptObjectProducedFor` / `decryptObjectQualityReport` | Schema-ready in `objects`; code in `quality/judge.ts` not migrated (Phase 5+) |

## Upload-layer port matrix

| Old function | New location | Status |
|---|---|---|
| `signUpload` / `verifyUploadSig` | Hand-rolled HMAC replaced by S3-presigned-URL via `@aws-sdk/s3-request-presigner` | ✅ — S3 SDK handles signing |
| `initUpload` | `storage/uploads.ts → initUpload` | ✅ |
| `putUploadBody` (server-side PUT from client) | Replaced by presigned-PUT directly to S3 | ✅ |
| `finalizeUploadBody` | `storage/uploads.ts → finalizeUpload` | ✅ — with F-3 hardening: encrypt-in-place before marking finalized |
| `markUploadFinalized` | Absorbed into `finalizeUpload` | ✅ |
| `sweepExpired` / `purgeExpired` | `crons/sweep.ts → sweepExpiredUploads / purgeExpiredUploads` | ✅ |
| `getUpload` | `storage/uploads.ts → getUploadStatus` | ✅ |

## Cross-cutting concerns

| Old module | New location | Notes |
|---|---|---|
| `crypto/aesgcm.ts` (encrypt/decrypt + AAD) | `lib/crypto/aes_gcm.ts` | AAD now wrapped via `lib/crypto/aad.ts` builder; AAD includes owner_id for cross-user replay-protection |
| `crypto/hkdf.ts` | Not needed — DEK is resolved per-request via Internal API (Variant B), not derived |
| `crypto/serialize.ts` | `lib/crypto/serialize.ts` | 1:1 port |
| `pii/mask.ts` | `lib/pii/mask.ts` | 1:1 port + minor regex tightening |
| `ulid.ts` | `lib/ids.ts` | UUID v4 is the primary id; ULID retained via `ulidx` for non-persistent correlation if needed |
| `middleware/idempotency.ts` (KV-backed) | `middleware/idempotency.ts` (Postgres-backed, F-5: AES-GCM-encrypted body) | Same Pattern-D, different storage |
| `cron/backup.ts` | `crons/backup.ts` | pg_dump + BACKUP_MASTER_KEY (F-21 validator) |
| `auth/bearer.ts` (single static token) | `auth/jwt.ts` (JWKS) + `auth/service_token.ts` (single static token for /v1/internal/*) | Auth model upgraded — JWT signed by mcp-approval2 |
| `types.ts` (Env shape) | `types/env.ts` (zod-validated) + `types/domain.ts` (RequestContext, etc.) | Validated at boot, fails fast |

## Migrations — schema delta

| Old schema (D1) | New schema (Postgres) |
|---|---|
| `0001_objects.sql` — objects + refs + tags + revisions + vectors + audit | `0000_init.sql` — superset, with FTS as a `GENERATED` column instead of separate `objects_fts` table |
| `0002_uploads.sql` | Included in `0000_init.sql` |
| `0003_skill_groups.sql` | Removed — replaced by `object_tags` with `tag='group:<slug>'` |
| (no equivalent) | `0001_rls.sql` — Row-Level-Security policies (single-tenant via owner_id) |
| (no equivalent) | `0002_security_hardening.sql` — FORCE RLS + tightened refs/tags/revisions policies + audit_log actor-pin (F-6, F-10, F-11) |
| (no equivalent) | `0003_drop_description_enc.sql` — removed dead description_enc/_nonce/_key_version columns (F-22) |
| (no equivalent) | `0004_erase_cascade.sql` — blob_deletion_queue for retry-on-failure (F-8) |

## Test inventory — what got carried over

| Old test | New test | Notes |
|---|---|---|
| `tests/crypto.test.ts` | `tests/unit/crypto.test.ts` | Port + AAD-replay test |
| `tests/cas.test.ts` (CAS optimistic-locking) | Covered by `tests/integration/objects-roundtrip.test.ts → PATCH … expected_version` | |
| `tests/idempotency.test.ts` | Covered by middleware; explicit test file not migrated yet — TODO |
| `tests/retry.test.ts` | N/A — retry helper not needed (see above) |
| `tests/safe_error.test.ts` | N/A — RFC 7807 error system instead |
| `tests/security_hardening.test.ts` | Covered by `tests/integration/rls.test.ts` (cross-user isolation) and the security-audit fix commits |
| `tests/skills_tools_register.test.ts` | N/A — tool-registry is `mcp-approval2`'s problem |
| `tests/tool_annotations.test.ts` | N/A — same |
| `tests/uploads.test.ts` | Partial — upload-lifecycle exercised by integration tests, dedicated test file TODO |

## Genuine gaps identified by this audit — and fixed in this commit

These were the three places where `mcp-knowledge2` was strictly **less
capable** than `mcp-knowledge` for legitimate storage-service reasons.
All fixed in the same commit as this report:

### Gap 1 — Content-addressable deduplication
- **Old:** `getObjectByBodyHash(env, kind, hash)` powered `docs.put`'s
  "if you upload the same bytes twice we return the existing id" feature.
- **New (post ADR-0004):** Added
  `getObjectByBodyHash(bodyHash, subtype?): ObjectView | null` to
  `storage/objects.ts`. RLS-scoped to caller so it cannot leak the
  existence of another user's identical-hash row. The legacy `kind`
  argument is gone — callers pass an optional free-form `subtype`
  instead.
- **Plus:** `getObjectByMeta(metaKey, metaValue, subtype?)` for the
  `skills.attach_resource` style of "find by meta.slug" lookup. Key
  shape is regex-restricted to identifier-only to keep parametrisation
  safe.

### Gap 2 — Object-revision API
- **Old:** `listObjectRevisions(id)` + `getObjectRevision(id, version)`
  let callers walk the history of a body that was edited multiple times.
- **New:** `storage/revisions.ts` with the same two functions. Routes
  added: `GET /v1/objects/:id/revisions` and
  `GET /v1/objects/:id/revisions/:version`. Owner-only by RLS (F-6
  tightening from the security audit applies here — shared users cannot
  read pre-share revisions).
- **Plus a real fix:** `updateObject` was bumping `currentVersion` on
  body change but **not inserting the old row into `object_revisions`**,
  which made the column meaningless. The previous body is now persisted
  before the row is overwritten. The encryption envelope (nonce +
  key_version) carries over unchanged, so existing-row → revision-row
  decrypt works with the same DEK+AAD as the live row.

### Gap 3 — Path-traversal defense on blob_key
- **Old:** `assertObjectR2Key(r2Key, ctx)` validated that any value
  about to be passed to R2 looked like a key we minted (`objects/<id>`),
  not something like `../../../etc/passwd` or an attacker-crafted
  S3 key.
- **New:** `assertBlobKeyShape(blobKey, context)` in
  `storage/objects.ts` (regex-pinned to `objects/<uuid>(@v<n>)?`).
  Called before every blob-store dereference in `readObject` and
  `readRevision`. Defense-in-depth — a corrupted DB row can't make us
  fetch an arbitrary blob.

## Things still deliberately deferred

These are documented elsewhere as Phase-5+ or out-of-scope, not as
oversights:

- **Quality-Gate code** (`judge.ts`, `rubric.ts`) — Schema-ready
  (`quality_score`, `quality_checked_at`, `quality_rubric_version`,
  encrypted `quality_report` columns all in `objects`). Code lives in
  `mcp-knowledge` and is Phase 5+ for v2. PLAN-architecture-v2 §2.1
  documents this explicitly.
- **Per-object DEK + share-wrapped DEK** for shared-body decrypt (F-1
  Variant B from the audit). Today shared-body-read returns 501
  not-implemented; Phase 5+ task documented in SECURITY.md.
- **Object creation from finalized upload** — `finalizeUpload` produces
  an encrypted standalone blob, but no API path turns it into a fully
  attributed `objects`-row yet. TODO documented inline in
  `storage/uploads.ts`.

## Result

After this commit, `mcp-knowledge2` is at parity with the storage-only
subset of `mcp-knowledge` plus the security-audit hardening. The
remaining 60+ files in the old repo are tool/protocol/app layers that
belong in `mcp-approval2` by design.

If a future caller (the `mcp-approval2` `KnowledgeAdapter`) needs a
feature that lived only in the old `tools/` or `apps/` namespaces,
that's a `mcp-approval2` implementation task, not a `mcp-knowledge2`
gap.
