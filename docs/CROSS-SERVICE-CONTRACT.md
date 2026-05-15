# Cross-Service Contract: mcp-knowledge2 ⇄ mcp-approval2

> **Status:** DRAFT (2026-05-13) — owner: mcp-knowledge2.
> **Counterpart:** `mcp-approval2/packages/adapters/src/knowledge/{types,interface,http-client,errors}.ts`.
>
> ⚠️ **AS-3-Update (2026-05-15):** Die Auth-Sektion §3 ist durch AS-3 abgelöst.
> Authoritative Quelle für das aktuelle Auth-Pattern (OBO-JWT + `SERVICE_TOKEN`):
> [PLAN-as3-autonomous.md](./plans/active/PLAN-as3-autonomous.md) §2 sowie die
> ausführbaren Verträge in `tests/contract/obo-jwt.test.ts` + `user-sync.test.ts` +
> `mcp-tools-list.test.ts`. Die DTO-Catalogue (§4) bleibt gültig — wire-shape
> für Objects/Shares/Search ist unverändert.
>
> This document is the **storage-service-side view** of what the adapter
> caller expects vs. what this service currently delivers. Every drift is
> listed with a proposed resolution and a clear owner (which side fixes it).

---

## 1. Purpose

mcp-approval2 reaches mcp-knowledge2 exclusively through `KnowledgeAdapter`,
an HTTP client whose Wire-Shape was specified before this service had a
finalized router. The adapter is therefore the **early caller contract** —
authoritative until the two repos converge on a versioned OpenAPI spec.

This document closes the loop by enumerating:

1. The endpoints mcp-approval2 calls.
2. Each request/response shape **as expected** by the adapter vs. **as
   delivered** today.
3. Every known drift, with a recommended fix side (KS = knowledge-service,
   AP = approval-service, BOTH = needs joint change).
4. Outstanding follow-ups before Burst 5 (Live cutover).

---

## 2. Endpoint Map

| Adapter Method        | HTTP                                            | Auth   | Status |
|-----------------------|-------------------------------------------------|--------|--------|
| `createObject`        | `POST   /v1/objects`                            | JWT    | live   |
| `getObject`           | `GET    /v1/objects/{id}`                       | JWT    | live   |
| `listObjects`         | `GET    /v1/objects?subtype=&limit=&cursor=`    | JWT    | live   |
| `updateObject`        | `PATCH  /v1/objects/{id}`                       | JWT    | live   |
| `deleteObject`        | `DELETE /v1/objects/{id}` (soft)                | JWT    | live   |
| `createShare`         | `POST   /v1/objects/{id}/shares`                | JWT    | live   |
| `listShares`          | `GET    /v1/objects/{id}/shares`                | JWT    | live   |
| `revokeShare`         | `DELETE /v1/shares/{share_id}`                  | JWT    | live   |
| `search`              | `POST   /v1/search`                             | JWT    | live   |
| `eraseUser`           | `POST   /v1/internal/erase-user`                | Svc-T  | live   |

**Not exposed via adapter** (server-only): `POST /v1/objects/{id}/refs`,
`POST /v1/objects/{id}/tags`, `POST /v1/uploads/*`, `POST
/v1/internal/health-deep`. These are first-class server features that
mcp-approval2 will adopt incrementally — adapter-extension is tracked in
§7 below.

---

## 3. Auth

### 3.1 JWT (User-Auth, all `/v1/*` routes except `/v1/internal/*`)

- Adapter signs a 60s-TTL JWT per request via injected `JwtSigner`.
- Server validates against JWKS (`env.JWKS_URL`, 24h cache, refresh-on-miss).
- Required claim: `sub` = UUID-v4 of the user (NOT email).
- Optional claim: `scope` = space-separated string (e.g. `"objects:read objects:write"`).
- Header form: `Authorization: Bearer <jwt>`.
- Server propagates `X-Request-Id` (sets new one if absent); adapter sends
  one per call via `requestIdFactory` (default = `crypto.randomUUID`).

### 3.2 Service-Token (Internal-only, `/v1/internal/*`)

- Static bearer token, shared secret between mcp-approval2 and
  mcp-knowledge2. Configured via `env.SERVICE_TOKEN` (server) / out-of-band
  in approval2.
- **Adapter today reuses `JwtSigner`** for `eraseUser` and signs a JWT —
  this is wrong for the internal route (server expects a service token,
  not a JWT). See drift §5.10.

---

## 4. DTO Catalogue (current server reality)

### 4.1 `ObjectView` (returned by create/get/update)

```json
{
  "id": "uuid",
  "ownerId": "uuid",
  "subtype": "string|null",
  "title": "string|null",
  "description": "string|null",
  "keywords": ["string"]  // or null
  "triggerHints": "string|null",
  "meta": { "...": "..." } | null,
  "bodySize": 1234,
  "bodyHash": "hex|null",
  "mimeType": "string|null",
  "filename": "string|null",
  "visibility": "private|shared",
  "pinned": false,
  "archived": false,
  "refcount": 0,
  "currentVersion": 1,
  "createdAt": 1234567890000,
  "updatedAt": 1234567890000,
  "lastUsedAt": null
}
```

`GET /v1/objects/{id}?expand=body` adds `"body_b64": "<base64>"`.

**Note:** `blob_key` is an internal DB column — it is **never** included
in any HTTP response. The adapter `KnowledgeObject` type (which only has
`body: string | null`) is not in conflict with the schema, but the legacy
doc-comment in `types.ts` mentioning `r2_key` is stale.

### 4.2 `ObjectsList` (returned by GET /v1/objects)

```json
{
  "items": [ObjectView, ...],
  "next_cursor": 1234567890000 | null
}
```

Cursor is **integer** (= last item's `updatedAt`), not opaque string.

### 4.3 `ShareView`

```json
{
  "id": "uuid",
  "resourceId": "uuid",
  "grantedTo": "uuid",
  "grantedBy": "uuid",
  "scope": "read|write",
  "grantedAt": 1234567890000,
  "expiresAt": null,
  "revokedAt": null
}
```

### 4.4 `SearchHit`

```json
{
  "id": "uuid",
  "subtype": "string|null",
  "title": "string|null",
  "score": 0.42,
  "ftsRank": 0.85,
  "vectorScore": 0.81
}
```

Search response: `{ "items": [SearchHit, ...] }`.

### 4.5 Error body (RFC 7807 Problem Details)

```json
{
  "type":     "https://problems.knowledge2/quota-exceeded",
  "title":    "Daily embed quota exhausted",
  "status":   429,
  "instance": "<request-id>",
  "...":      "optional extra fields per-error-class"
}
```

`Content-Type: application/problem+json`.

---

## 5. Known Drift

Each drift is keyed `D-<n>` for follow-up tickets.

### D-1 — Error body shape (HIGH)

- **Adapter** (`errors.ts:errorFromResponse`) expects `{ error: { code, message, details } }`.
- **Server** returns RFC 7807 `{ type, title, status, detail, instance }`.
- **Effect:** Adapter `errorFromResponse` falls back to `bodyText.slice(0, 500)`
  as the error message — usable but loses structured fields.
- **Fix:** AP — adapter should also parse RFC 7807 shape:
  message ← `title`, code ← derive from `type` URI suffix.
- **Owner:** mcp-approval2.

### D-2 — `createObject` request body uses `body_b64`, not `body` (HIGH)

- **Adapter** sends `{ body: "plain string" }` (or omits — body is `string | undefined`).
- **Server** requires `body_b64` (base64-encoded `Uint8Array`) and
  enforces `min(1)` length.
- **Effect:** Adapter-issued `createObject` currently **fails with 400**
  every time — body field unrecognised, `body_b64` missing.
- **Fix:** AP — adapter must base64-encode the body and send `body_b64`.
- **Owner:** mcp-approval2 (Burst 5 blocker).

### D-3 — `createObject` extra fields (`mime_type`, `filename`, `embed`) missing in adapter (MED)

- **Server** accepts and stores `mime_type`, `filename`, `embed` (triggers
  vector-embedding). Adapter sends none of them.
- **Fix:** AP — extend `CreateObjectArgs` with `mimeType`, `filename`,
  `embed`. Server-side no change.

### D-4 — `listObjects` cursor type mismatch (MED)

- **Adapter** types `cursor: string` (opaque token) and `hasMore: boolean`.
- **Server** uses `cursor: number` (Unix-ms of `updated_at`) and reports
  `next_cursor: number | null` (no boolean).
- **Fix:** AP — change `ObjectsList.cursor` to `string | null` and
  parse server's `next_cursor` to string. Drop `hasMore`; derive as
  `cursor !== null`.

### D-5 — `listObjects` response key `next_cursor` vs `cursor` (MED)

- **Adapter** expects `{ items, cursor, hasMore }`.
- **Server** sends `{ items, next_cursor }`.
- **Fix:** AP — rename in `types.ts`. Server already emits camelCase
  for ObjectView fields but snake_case for envelope keys. Keep the
  server style; adapter conforms.

### D-6 — `createShare` request body field names (HIGH)

- **Adapter** sends `{ grantedTo, scope }`.
- **Server** accepts `{ granted_to, scope, expires_at? }`. With ADR-0004
  (generic object model) the legacy `resourceKind` field is gone from
  both wire and DB — the object's row is sufficient context for the
  server to authorise the share.
- **Effect:** zod parse fails: required key `granted_to` missing
  (pre-ADR-0004 also rejected the extra `resourceKind` field).
- **Fix:** AP — adapter should send `{ granted_to: args.grantedTo, scope:
  args.scope }`.

### D-7 — `Share` field `createdAt` vs `grantedAt` (LOW)

- **Adapter** types `Share.createdAt`.
- **Server** emits `grantedAt`.
- **Fix:** AP — rename in `types.ts`. Keep server name (matches DB).

### D-8 — `listShares` response wrapping (LOW)

- **Adapter** parses `ReadonlyArray<Share>`.
- **Server** wraps in `{ items: [...] }`.
- **Fix:** AP — change parsing to `(res as {items: Share[]}).items`.

### D-9 — `search` request: subtype filter shape (RESOLVED via ADR-0004)

- **Adapter** historically sent `{ kinds: ['doc', 'skill'], limit }`.
- **Server** today (post ADR-0004) accepts
  `{ subtypes?: string[], limit }` — free-form subtype array, no enum.
- **Effect (pre-ADR-0004):** zod-parse rejected multi-kind queries.
- **Fix:** AP — send `{ subtypes: ['file', 'skill_manifest'] }` (or omit
  entirely for unfiltered). Old `kind` / `kinds` keys are dropped.

### D-10 — `eraseUser` (HIGH)

Two drifts here:

- **Adapter** sends `{ confirmationToken }` and JWT-signs with the
  subject userId.
- **Server** requires `{ user_id, confirmation_token }` and authenticates
  with **Service-Token** (`requireServiceToken` middleware), not JWT.
- **Adapter response** parses `{ deletedRows: number }`.
- **Server response** is `{ status, deleted: { objects, shares, idempotency, uploads, blobs_deleted, blobs_pending } }`.

**Fix:** AP — adapter needs a distinct service-token path (separate
constructor option `serviceToken: string`); send the documented body
shape; parse the rich deletion summary.

### D-11 — `KnowledgeObject.body` shape (MED)

- **Adapter** types `body: string | null` (plain-text after server decryption).
- **Server** returns base64 (`body_b64`) — and only when explicitly
  requested via `?expand=body`.
- **Fix:** AP — call with `?expand=body` when body wanted; base64-decode
  on receipt.

### D-12 — Stale doc-comment in `types.ts` (LOW, cosmetic)

The header comment in `mcp-approval2/.../types.ts` refers to `r2_key` as
a wire field. It never was. The wire field is `blob_key` and only
appears in DB rows, never in HTTP responses. Recommend AP remove this
comment to avoid future-reader confusion. Schema-internal naming
(`blob_key` vs `r2_key`) is purely a DB-column choice — no wire impact.

---

## 6. Resolution Strategy

The default rule: **server (this repo) sets the wire format; adapter
conforms.** Server schema is already shipped and migrations are
non-trivial to rename. Wire-DTO renames in adapter `types.ts` are local
TS-only changes.

Exceptions: none — D-9 was resolved by ADR-0004 (the server now accepts
`subtypes: string[]`, see GENERIC-DATA-MODEL.md v3 §4.10).

Sequencing:
1. mcp-knowledge2 lands no functional changes from this contract; it
   only documents and ships the integration-test harness (this commit).
2. mcp-approval2 lands adapter fixes for D-1 .. D-8, D-10, D-11, D-12 in
   a follow-up burst (call it Burst 4b or 5a — owner-side decides).
3. D-9 is closed by ADR-0004: subtype-array filter is the canonical
   wire-format. Cross-repo migration tracked in
   GENERIC-DATA-MODEL.md v3 §11.

---

## 7. Adapter-Surface Gaps (for future bursts)

Server features without adapter coverage today. Not blocking Burst 5
cutover (mcp-approval2 doesn't use them yet), but tracked so the
contract stays honest:

| Gap                                                                | Server route                                | Adapter status |
|--------------------------------------------------------------------|---------------------------------------------|----------------|
| Object-refs (knowledge graph)                                      | `POST /v1/objects/:id/refs`, `DELETE`, `GET .../usages` | none           |
| Object-tags                                                        | `POST/GET/DELETE /v1/objects/:id/tags`      | none           |
| Restore from soft-delete                                           | `POST /v1/objects/:id/restore`              | none           |
| Presigned uploads                                                  | `POST /v1/uploads/init`, `/finalize`, `/status` | none       |
| Deep health for orchestrator                                       | `POST /v1/internal/health-deep`             | none           |
| Public `GET /health`, `GET /readyz`                                | `/health`, `/readyz`                        | none (probes only) |

Each is a future `AdapterExtensionN` ticket — keep the core contract
tight today.

---

## 8. Verification

This contract is exercised by:

- `tests/integration/objects-roundtrip.test.ts` (testcontainers-Postgres,
  full server boot, hit every adapter-shape endpoint).
- `tests/integration/rls.test.ts` (RLS isolation, pre-existing).

Run locally:

```bash
cd /workspaces/mcp-knowledge2
npm run test:unit         # unit (no Docker)
npm run test:integration  # spins up Postgres + pgvector via testcontainers
```

See [docs/runbooks/runbook-integration-tests.md](./runbooks/runbook-integration-tests.md)
for CI + smoke variants.

---

## 9. Change-Log

- 2026-05-13 — initial draft, drifts D-1..D-12 catalogued.
