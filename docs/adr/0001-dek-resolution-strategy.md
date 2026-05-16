# ADR 0001 — DEK Resolution Strategy

**Status:** ⛔ **Superseded by AS-3 (2026-05-15)** — see [PLAN-as3-autonomous.md §1.3 (K9)](../plans/active/PLAN-as3-autonomous.md). The "Variant B / Internal-API DEK resolver" described below is no longer the implementation. Post AS-3 the service holds its own KMS provider (factory in [`src/adapters/kms/`](../../src/adapters/kms/)): `hkdf_local` (dev), `openbao` (Hetzner Transit), or `cloud_kms` (GCP wrapped-master + HKDF-derive). The `internal_api.ts` module mentioned under "Consequences" has been deleted.

**Original status:** Accepted, 2026-05-13
**Plan reference (original):** PLAN-architecture-v2 §3.3

## Context

mcp-knowledge2 must encrypt object bodies before storage. Per the parent
plan, OpenBao is the KEK provider, but it lives in mcp-approval2's
boundary, not ours. Three options for getting a per-user DEK into the
encrypt/decrypt path:

- **A — DEK in JWT:** mcp-approval2 unwraps the DEK from OpenBao and
  packs it (base64 encrypted) into a JWT claim. Knowledge2 reads it
  directly from the verified JWT.
- **B — DEK via Internal-API:** Knowledge2 calls
  `POST mcp-approval2/internal/v1/dek/resolve` per request to retrieve
  the DEK. Two round-trips, but the DEK is never serialised into the
  JWT.
- **C — Per-object DEK in OpenBao:** Knowledge2 holds its own OpenBao
  AppRole credentials and unwraps a `wrapped_dek` column directly.

## Decision

**Variant B** — Internal-API DEK resolver.

## Rationale

- **A** leaks the DEK into the JWT-audit log on knowledge2's side. Even
  if encrypted, the DEK material has measurable side effects in the
  audit trail.
- **C** distributes OpenBao credentials across two services, doubling
  the operator-bypass surface and complicating credential rotation.
- **B** concentrates KMS calls in one place (mcp-approval2) which is
  also where the OpenBao audit-trail lives, so we have a single source
  of truth for "who decrypted what when".

The DEK lives in mcp-knowledge2's memory only during request handling
and is never persisted. The cost is one extra HTTP round-trip per
encrypted operation, mitigated by HTTP/2 keep-alive and TCP reuse.

## Consequences

- mcp-knowledge2 implements `KmsProvider` with a single
  `InternalApiKms` implementation backed by
  `fetch(MCP_APPROVAL_BASE_URL/internal/v1/dek/resolve)`.
- A per-deploy `SERVICE_TOKEN` is required for mcp-approval2 to
  authenticate the caller.
- If mcp-approval2 is unreachable, all encrypt/decrypt paths return
  `503 Service Unavailable` — caller is expected to back off and retry.
