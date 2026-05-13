# Security Model — mcp-knowledge2

This document is the honest statement of what this service protects, what it
does not protect, and the residual risks the operator accepts.

## Trust boundaries

| Actor | Trust level | Access |
|---|---|---|
| Operator (engineer, DB admin) | **Full** | DB owner, backup master key, infra root |
| `mcp-approval2` (per signed JWT) | **Full** as a caller | every `/v1/*` endpoint via JWKS-verified token |
| End user (via mcp-approval2) | Full on **their own** data + objects shared **to them** | indirect, JWT-mediated |
| User A → User B (without share) | **None** | RLS-enforced isolation |
| Postgres super-user (DBA role) | **Full** | trusted platform |
| External attacker | None | JWKS verify + service-token + RLS hurdles |

## What at-rest encryption protects

✅ Cold-read scenarios:
- Stolen backup tape / disk
- Leaked DB dump (CSV, pastebin)
- S3 provider insider reading the bucket without going through the app
- Misconfigured public bucket read

❌ What it does **not** protect:
- **Operator bypass** — the operator has access to the KMS provider
- **RCE on the running app** — plaintext lives in RAM during request handling
- **Embedding-inversion attacks** — see below
- **Search-query logging** — the application enforces *no logging* of
  search queries; if that policy is violated, log readers see them

The word "encrypted" here means at-rest. It is **not** an operator-zero-knowledge
model. Anyone who builds on top of this service should explain this trade-off
to their end users.

## Encryption layers

| Layer | Algorithm | Key source | AAD |
|---|---|---|---|
| Object body | AES-256-GCM | Per-user DEK resolved per request from mcp-approval2 KMS (Variante B) | `objects\|<owner_id>\|<id>\|<kind>:<subtype>` |
| Description | AES-256-GCM | same DEK | `objects-desc\|<owner_id>\|<id>\|<kind>:<subtype>` |
| Backups | AES-256-GCM | `BACKUP_MASTER_KEY` env (rotated per deploy) | `backup\|<timestamp>` |

The AAD bindings prevent ciphertext replay across users or across objects.
Owner transfer therefore requires explicit re-encryption (Phase 5+).

## Embedding-inversion attack — residual risk

Research demonstrates that dense 768-dim+ embeddings can be partially
inverted back to original text fragments
(Morris et al. 2023 "Text Embeddings Reveal Almost As Much As Text";
Song & Raghunathan, IEEE S&P 2020).

In this service, vectors are stored in `object_vectors.embedding` in
plaintext (necessary for cosine search). Read access to that column is
therefore equivalent to a partial leak of the underlying object text.

Mitigations applied:
- **PII masking before generating embeddings** (`maskPII` in
  `src/lib/pii/mask.ts`) — emails, IBANs, IPs, UUIDs, phone numbers, URLs
  are deterministically replaced by sentinels.
- **RLS on `object_vectors`** — same visibility as parent `objects` row
- **Strict no-logging of search queries** — the application never logs
  user-typed queries, only counters

Mitigations **not** applied (out-of-scope):
- Encrypted vector search (research stage)
- Homomorphic similarity (research stage)

This residual risk is communicated to clients via the DPA template
maintained in mcp-approval2.

## Logging discipline

The application logger uses Pino with a redact rule set that scrubs:
- `req.headers.authorization`
- `req.headers["x-service-token"]`
- `req.headers.cookie`
- `*.password`, `*.token`, `*.secret`, `*.body`
- top-level `query` and `embedding` and `dek` keys

Audit logs in `audit_log` table record action + resource id, but
**never** request bodies or search queries.

## Threat model — what we explicitly do not protect against

- **Compromised operator** — the operator has DB-owner access, the
  backup master key, and infra root. There is no way for the service
  to defend against an insider with these privileges.
- **Platform compromise** — Hetzner hypervisor breakout, Cloud Run
  container escape, etc. Trusted platform assumption.
- **Side channels** — request-timing analysis, blob-storage volume
  analysis, search-pattern fingerprinting. Out-of-scope for v1.
- **Denial of service beyond per-user quota** — quota system limits one
  user; a flood from many JWT subjects requires reverse-proxy rate
  limiting (Caddy / Cloud Run throttling).

## Reporting issues

Internal — please contact the engineering owner directly.
