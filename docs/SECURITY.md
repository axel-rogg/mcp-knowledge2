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
| Backups | AES-256-GCM | `BACKUP_MASTER_KEY` env (rotated per deploy) | `backup\|<timestamp>` |

The AAD bindings prevent ciphertext replay across users or across objects.
Owner transfer therefore requires explicit re-encryption (Phase 5+).

### Plaintext-by-design columns (F-22 from 2026-05-13 audit)

The columns **`title`**, **`description`**, **`keywords_json`**, and
**`trigger_hints`** are stored **plaintext**. They feed the FTS index
(`tsvector` on `objects.search_tsv`) and the embedding pipeline, both of
which require the underlying text. Encryption was previously also applied
to `description` (`description_enc` column), but the plaintext sat in the
same row — the encryption added no secrecy. Migration `0003` removed
those dead columns.

**Implication:** put sensitive content into `body`, which IS encrypted.
Metadata (titles, summaries, keywords) is queryable cold-storage from the
operator's perspective. This is the unavoidable cost of server-side
search. Clients should be told this.

### Sharing-aware body encryption (F-1 from the audit)

Body decryption uses the **caller's** per-user DEK. When a user shares an
object with another user, the recipient's DEK does not match — so a
recipient calling `GET /v1/objects/:id?expand=body` gets a deterministic
501 `shared-body-not-implemented`. The metadata row is still visible
(that's what sharing means today), and the body cipher stays at rest.

A per-object DEK with share-grant-side wrapping (Phase 5+) would lift this
limitation. Until then, only the owner reads or writes the body. This is
documented intent — not a regression to file as a bug.

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

## Audit findings explicitly accepted as documented (2026-05-13)

These items came up in the security review but are intentionally not
"fixes" — they are properties of the current architecture that we
choose to document instead of code around:

- **F-13 (CORS `origin: '*'`)** — the API is JWT-only, no browser
  client, `credentials: false`. The Cross-Origin headers do not allow
  cookie-bearing requests. `/health` and `/version` answer without
  auth and reveal only build info. We do not enforce a stricter
  Origin until/unless a browser client appears.
- **F-17 (presignGet content-disposition)** — `presignGet` is wired
  into the adapter but no route exposes it yet. If/when a public
  download path appears, the caller must set
  `ResponseContentDisposition: 'attachment; filename=<safe>'` and
  `ResponseContentType: 'application/octet-stream'` to prevent
  MIME-sniff XSS on the API domain. See the JSDoc on
  `BlobStore.presignGet`.
- **F-19 (pg-boss runs as `knowledge_admin` BYPASSRLS)** — necessary
  because cron jobs operate across users (sweep, GC, backup,
  erase-cascade-blob-queue). Mitigation: only the Postgres super-user
  can insert into the `pgboss.*` schema; an attacker would need
  Postgres write access to exploit. Hardening (signed job payloads)
  is Phase 5+.
- **F-27 (logger redact paths)** — pino's `paths` configuration uses
  property-name matching, and the `request_log` middleware only
  serialises path / method / status / duration / user_id /
  request_id — never request body or query string. Adding new fields
  to the request-log middleware requires reviewing pino-redact
  coverage at the same time.
- **F-29 (user-id in error log on KMS resolve failure)** — UUIDs are
  not directly PII; the operator already has full DB access. Logged.
- **F-30 (compromised mcp-approval2)** — assumed trusted-party per
  threat model. If mcp-approval2 is compromised, this service is too
  (KMS resolution is delegated). No service-side defense possible.
