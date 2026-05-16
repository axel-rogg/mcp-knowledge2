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
| Object body | AES-256-GCM | Per-user DEK from `KmsProvider` (factory in `src/adapters/kms/`) | `objects\|<owner_id>\|<id>` (ADR-0004: kind/subtype slot removed) |
| Backups | AES-256-GCM | `BACKUP_MASTER_KEY` env (rotated per deploy) | `backup\|<timestamp>` |

The AAD bindings prevent ciphertext replay across users or across objects.
Owner transfer therefore requires explicit re-encryption (Phase 5+).

### KMS-Provider choice (`KMS_PROVIDER`)

Three implementations of the per-user-DEK resolution, selected via env:

| Provider | Where the master key lives | Crypto-strength | When to use |
|---|---|---|---|
| `openbao` | OpenBao Transit-Engine on the Hetzner VM | HSM-grade (software, key never leaves Transit) | Hetzner pilot — separate compose-service `openbao` |
| `cloud_kms` | GCP Cloud KMS (encrypted master in env, decrypted once at boot, then HKDF-derived per user) | Cloud-KMS HSM at unwrap-time; master in-process after boot | GCP business — Cloud Run with Workload Identity Federation, no SA-JSON file |
| `hkdf_local` | Env-var `KMS_MASTER_KEY_B64` | weakest — master is plaintext in Doppler | dev / solo with shared-master setups only |

Rotation paths:
- `openbao`: Transit-Engine key-versioning, multi-version reads supported
- `cloud_kms`: re-wrap the master (`gcloud kms encrypt`) → Doppler-update → restart. Cloud KMS key-rotation alone does NOT rotate the wrapped master.
- `hkdf_local`: new env-var → restart → all old DEKs become unreadable. Re-encrypt all object bodies offline first.

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

Research demonstrates that dense 1024-dim+ embeddings can be partially
inverted back to original text fragments
(Morris et al. 2023 "Text Embeddings Reveal Almost As Much As Text";
Song & Raghunathan, IEEE S&P 2020).

In this service, vectors are stored in `object_vectors.embedding` in
plaintext (necessary for cosine search). Read access to that column is
therefore equivalent to a partial leak of the underlying object text.

Mitigations applied:
- **PII masking before generating embeddings** (`maskPII` in
  `src/lib/pii/mask.ts`) — emails, IBANs, IPs, UUIDs, phone numbers, URLs
  are deterministically replaced by sentinels. **Applied uniformly across
  both embedding providers** (Cloudflare Workers AI bge-m3 default, Vertex
  AI text-multilingual-embedding-002 fallback).
- **RLS on `object_vectors`** — same visibility as parent `objects` row
- **Strict no-logging of search queries** — the application never logs
  user-typed queries, only counters

Mitigations **not** applied (out-of-scope):
- Encrypted vector search (research stage)
- Homomorphic similarity (research stage)

This residual risk is communicated to clients via the DPA template
maintained in mcp-approval2.

### Provider-Wahl (Embedding-Inversion-Risiko-Mitigation)

`EMBED_PROVIDER=cloudflare` (Default, 2026-05-15): Inference auf Cloudflare
Workers AI in EU-Edges. Daten verlassen das Cloudflare-Netzwerk nicht.
Embedding-Calls werden via Cloudflare AI Gateway `mcp-knowledge2` geroutet
(`collect_logs=true` für Audit). Risiko: bge-m3 ist Open-Source — Inversion-
Attacks könnten reproduzierbarer sein als bei closed-source Vertex.

`EMBED_PROVIDER=vertex` (Legacy-Fallback): text-multilingual-embedding-002
über Google Vertex AI EU. Daten verlassen die CF-Ebene Richtung GCP-EU.
Vertex-Model ist proprietary — weniger erforschte Inversion-Attacks.

Single-Tenant-Architektur: kein Multi-Tenant-Cross-Embedding-Risiko. Trotzdem
gilt: `embedding`-Column-Read = partial text leak; nur Owner + shared-with-User
(per RLS) kommen ran.

## Authentication — strict email allowlist

`ALLOWED_EMAILS` (CSV in Doppler) ist eine **strict whitelist** auf KC2's
`/auth/google/callback` — defense-in-depth zur OAuth-App's Test-Users-Liste
in der Google Cloud Console.

- Empty → open (jeder von Google verifizierte Login passes)
- Non-empty → nur gelistete Emails dürfen die OAuth-Callback abschließen
- Lower-case match nach `trim()`, case-insensitive
- Mismatch → HTTP 403 `email not in allowed users list`, Logging mit Email-Claim

**Warum doppelter Schutz?** Google's Test-Users-Liste ist eine OAuth-App-
Setting in der Cloud Console und kann (vergessenwerden zu) entfernt werden
beim Wechsel "Testing" → "In Production". `ALLOWED_EMAILS` ist app-seitig
enforced, robust gegen diese Drift.

Erstes Login eines `ALLOWED_EMAILS`-Emails wird automatisch `role='admin'`
(Bootstrap-Pattern in `src/users/api.ts`). Spätere Logins: `role='member'`,
admin kann via `setUserRole` promoten.

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

## Cross-provider deployment (mcp-approval2 on Cloudflare, mcp-knowledge2 on Fly/Hetzner/…)

When the two services live on different cloud providers, four risks
appear that don't exist in a single-provider deployment. None of them
fundamentally break the threat model — both providers are already
trusted parties under §"Trust boundaries" — but they're worth knowing.

### Risk A — DEK in transit across two TLS terminations

`POST mcp-approval2/internal/v1/dek/resolve` returns the user's raw
32-byte DEK in the response body (Variant B from PLAN §3.3). HTTPS
protects the bytes between the two services, but TLS is terminated
**twice**: once at mcp-approval2's edge (e.g. Cloudflare's TLS
terminator for Workers), once at mcp-knowledge2's load balancer (e.g.
Fly's). Both providers therefore see the DEK in plaintext at their
respective hop.

This is a real expansion of the operator-trust surface: two providers
now have key material visibility instead of one. It is still bounded
by the "operator-trust" assumption in the threat model.

**Hardening (production-grade):** wrap the DEK in JWE
(ECDH-ES + A256GCM) for a mcp-knowledge2-owned recipient public key.
mcp-approval2 encrypts → only mcp-knowledge2 can decrypt → the
intermediate TLS hops see opaque ciphertext. Phase 5+ task; not
implemented today.

### Risk B — Service-Token is the only auth on `/v1/internal/*`

Same-provider deployments can stack a network-layer allowlist on top
of the service-token (Caddy `@allowed remote_ip {APPROVAL2_IP}`).
Across CF Workers and Fly Free, **neither provider exposes static
egress IPs**, so the allowlist fall back to "match anything". The
single line of defence is the 32-byte hex `SERVICE_TOKEN` validated
in constant time.

The service-token is strong (32 bytes hex, constant-time-compare),
but it's a single secret with no second factor. Token leak →
internal-endpoint takeover.

**Hardening:** (a) rotate `SERVICE_TOKEN` on every deploy, not on
schedule; (b) add a per-IP rate-limit on failed-auth (~5/min → 429)
so brute-force is unrealistic; (c) include a `caller_env` claim in
the per-request JWT (e.g. `caller_env: 'cf-worker-prod'`) and check
it server-side.

### Risk C — Audit-correlation scattered across two log systems

`request_id` is propagated header-to-header, so logical correlation
still works. But operationally: an incident response needs access to
two providers' log retention. There's no single-pane-of-glass.

**Hardening:** ship both services' structured logs to one
aggregator (Grafana Loki, BetterStack, Honeycomb). Out-of-scope for
the privat-test deployment.

### Risk D — DSGVO sub-processor list grows

The DPA template needs to name **both** providers explicitly, with
the data-flow diagram showing cross-provider hops. For commercial
deployments this is real paperwork. For the privat-test (own data,
own infra, no third-party tenants) it's purely informational.

### Single-provider as the "honest" mitigation

The simplest way to remove A and B entirely is to host both services
on one provider (Hetzner CX22, both in Docker on the same internal
network; or both on Fly inside the same private network). Internal
service-to-service traffic never leaves the provider boundary —
TLS-terminator visibility shrinks to one party.

For the privat-test: cross-provider is acceptable. For production
with sensitive data and a real DPA, prefer single-provider, and
enable JWE-on-DEK if cross-provider is unavoidable.

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
