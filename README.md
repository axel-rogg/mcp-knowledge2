# mcp-knowledge2

Storage + Sharing + Hybrid-Search service for the **mcp-approval2** ecosystem.
Single-tenant (1 firma = 1 instance), multi-user, per-object sharing via RLS.

> Status (2026-05-15): **AS-3 code-complete + Generic-Object-Model (ADR-0004)
> implemented** on branch `feat/as3-cutover`. Cutover-Day pending — see
> [docs/runbooks/runbook-as3-cutover.md](./docs/runbooks/runbook-as3-cutover.md).
>
> - **ADR-0004**: kind-Discriminator entfernt, free-form `subtype` mit
>   namespace-Support (`app:composable`, `app:shopping-list`, …).
>   Migration `0009_drop_kind.sql` deploy-ready. Spec:
>   [GENERIC-DATA-MODEL.md](./GENERIC-DATA-MODEL.md).
> - **subtype_prefix Query** (REST + MCP + Hybrid-Search) für effiziente
>   Namespace-Filter (z.B. alle `app:*` Subtypes).
> - Plan: [docs/plans/active/PLAN-architecture-v2.md](./docs/plans/active/PLAN-architecture-v2.md)
>   (§§2.1+3.5+5.x sind durch ADR-0004 superseded).

## Architecture in 30 seconds

Post AS-3 (2026-05-15) `mcp-knowledge2` is an **autonomous** MCP- and
REST-service. It runs its own OAuth-2.1 facade (DCR + Google login) and
verifies tokens from three issuers in parallel:

```
   Google OIDC (authoritative IdP)
        ▲
        │ id_token verify via JWKS
        │
   ┌────┴───────────────────────────────────────────────────────────┐
   │                                                                │
   ▼                                                                ▼
   mcp-approval2 (optional approval-proxy)                  Claude.ai / direct caller
        │                                                                 │
        │ S2S: Bearer <SERVICE_TOKEN> + X-On-Behalf-Of: <jwt>             │ Bearer <kc2-jwt>
        ▼                                                                 │
   mcp-knowledge2  ◄─────────────────────────────────────────────────────┘
        │
        ├─► Postgres 16 + pgvector (RLS, per-request `app.current_user`)
        ├─► Blob: S3-compatible (R2 / B2 / Hetzner OS / MinIO / Tigris) — or native GCS
        ├─► Embeddings: Cloudflare Workers AI bge-m3 (default, 1024-dim) — or Vertex AI fallback
        └─► KMS: HKDF-local (dev) / OpenBao (Hetzner) / Cloud KMS (GCP)
```

User-routes accept either a JWT issued by KC2's own facade or one issued
by Google OIDC. Approval-proxy mode is an **opt-in** path enabled by
setting `MCP_APPROVAL_JWKS_URL` (see [CROSS-SERVICE-CONTRACT.md](./docs/CROSS-SERVICE-CONTRACT.md)).

**Compute-Targets.** Active pilot line is **Fly.io Frankfurt** as a
Node-22 container (Cloud Run / Hetzner / Railway documented as
alternatives). Cloudflare Workers as a compute target has been
evaluated and intentionally parked — cost factor 4-6× higher (Neon Pro
required) and 6-8 days of refactor work without a concrete trigger.
Active pilot strategy: [docs/STRATEGIE-pilot.md](./docs/STRATEGIE-pilot.md).
Parked dual-runtime architecture (re-startable if a Workers trigger appears):
[docs/STRATEGIE.md](./docs/STRATEGIE.md).

## Quickstart (local dev)

```bash
# 1. Bring up Postgres + MinIO + Mock-JWKS, run migrations, start watch
bash scripts/dev.sh

# 2. Run unit tests
npm run test:unit

# 3. Run RLS integration tests (spawns Postgres testcontainer)
npm run test:integration

# 4. Smoke (needs JWT from mock-jwks-server)
bash scripts/smoke.sh
```

## Project layout

```
src/
├── server.ts             Entry point — Hono app + crons + graceful shutdown
├── routes/               REST handlers (objects, shares, search, uploads, internal, health)
├── auth/                 multi-issuer JWT verifier (Google + KC2-self + OBO) + service-token
│   └── oauth_facade/     DCR + /authorize + /token + JWKS + discovery (RFC-8414)
├── mcp/                  Streamable-HTTP /mcp endpoint + 17 REST-wrapped tools
├── users/                users + invites registry (AS-3 K2)
├── middleware/           context, idempotency, error, request_log
├── db/                   schema (Drizzle) + tx-scoped pool (`withUserTx`, `withAdminTx`)
├── storage/              objects, refs, tags, revisions, shares, uploads
├── search/               FTS + vector + RRF hybrid
├── adapters/
│   ├── blob/             factory: `s3` (R2/B2/Hetzner OS/MinIO/GCS-S3-Interop) | `gcs` (native, Workload Identity)
│   ├── embed/            factory: `cloudflare` (Workers AI bge-m3, 1024-dim, default) | `vertex` (text-multilingual-embedding-002, 768-dim)
│   └── kms/              factory: `hkdf_local` (dev) | `openbao` (Hetzner Transit) | `cloud_kms` (GCP wrapped master + HKDF derive)
├── lib/
│   ├── crypto/           AES-256-GCM + AAD builder + serialise
│   ├── pii/              maskPII — applied BEFORE embedding
│   ├── context.ts        AsyncLocalStorage (current_user, request_id)
│   ├── errors.ts         RFC 7807 Problem Details
│   ├── ids.ts            UUID v4 + nowMs helpers
│   └── logger.ts         pino with PII-aware redact rules
├── quota/                per-user limits enforcement
├── observability/        audit emitter, prom-metrics
├── crons/                pg-boss schedules (sweep, gc, backup, orphan-blob-cleanup)
└── types/                env + domain primitives

drizzle/migrations/       0000_init … 0010_embedding_dim_1024 (11 sequential migrations)
deployments/              docker-compose (dev + prod), cloud-run yaml, caddy
deploy/                   fly/ + gcp/ — provider-specific bootstrap + secret-sync
tests/                    unit + contract (4) + integration (testcontainers)
```

## Auth model (post AS-3)

- **`/v1/*` user routes** — accept either:
  1. A JWT issued by KC2's own OAuth-facade (`iss = SELF_OAUTH_ISSUER`,
     `aud = mcp-knowledge2`) — minted via the DCR flow at
     `/.well-known/oauth-authorization-server`.
  2. A Google OIDC `id_token` (`iss = https://accounts.google.com`,
     `aud = GOOGLE_OAUTH_CLIENT_ID`) — used by direct Claude.ai access.
  3. Optional proxy-mode: `mcp-approval2` forwards calls with
     `Authorization: Bearer <SERVICE_TOKEN>` + `X-On-Behalf-Of: <jwt>`.
     Enabled by setting `MCP_APPROVAL_JWKS_URL` — off by default.
  The `sub` claim resolves through `users` to a UUID propagated as
  `app.current_user` into the Postgres session for RLS.
- **`/v1/internal/*` service routes** — static `SERVICE_TOKEN` (env,
  constant-time-compared). Uses the admin DB role (BYPASSRLS) for
  cross-user maintenance like `erase-user` and `users/sync`.
- **`/mcp`** — same auth stack as `/v1/*` (JWT or OBO). Streamable-HTTP
  transport. 17 tools registered (objects.* / shares.* / search /
  uploads.*) — see [`src/mcp/register_tools.ts`](./src/mcp/register_tools.ts).
- **Public**: `/health`, `/health/ready`, `/version`, `/metrics`,
  `/.well-known/oauth-authorization-server`, `/.well-known/jwks.json`,
  `/oauth/*` (DCR + authorize + token + Google-callback).
- **Optional strict allowlist**: `ALLOWED_EMAILS` (CSV) blocks any
  OAuth-callback whose verified email is not in the list — defense-in-depth
  on top of Google's own Test-Users config. Empty = open.

## Encryption summary

| Layer | Where | Key |
|---|---|---|
| Object body (per object) | App | Per-user DEK from `KmsProvider` factory: `hkdf_local` (env-master) / `openbao` (Transit-Engine) / `cloud_kms` (Cloud-KMS-wrapped master + HKDF derive). Resolved per request, never stored. |
| Backups | `pg_dump` → AES-GCM → blob | `BACKUP_MASTER_KEY` env (separate from DEKs; also used to encrypt the OAuth-facade signing keys at rest) |
| OAuth-facade signing keys | `signing_keys` table, EdDSA | private key AES-256-GCM-wrapped under `BACKUP_MASTER_KEY` |

Plaintext-by-design columns: `title`, `description`, `keywords_json`,
`trigger_hints` — they feed FTS and the embedding pipeline. Put sensitive
content into `body` (encrypted). See [docs/SECURITY.md §"Plaintext-by-design columns"](./docs/SECURITY.md#plaintext-by-design-columns-f-22-from-2026-05-13-audit).

**AAD** = `<recordType>|<owner_id>|<object_id>` (post-ADR-0004) —
prevents cross-user and cross-object ciphertext replay. Owner-transfer
requires explicit re-encryption. Subtype-Slot ist seit ADR-0004 entfernt
(subtype ist free-form Caller-Convention, hat keine Storage-Semantik).

**See [docs/SECURITY.md](./docs/SECURITY.md)** for the full threat model
(including the operator-trust assumption and embedding-inversion risk).

## Configuration

All settings come from environment variables — see
[`.env.example`](./.env.example) for the full list. The Zod schema in
[`src/types/env.ts`](./src/types/env.ts) validates at startup and fails
fast on missing values.

## Operations

| Command | What it does |
|---|---|
| `npm run db:migrate` | Apply pending SQL migrations |
| `npm run typecheck` | Type-check without emitting |
| `npm run lint` | ESLint (max-warnings=0) |
| `npm run test` | Full test suite |
| `npm run build` | tsc + esbuild → `dist/server.js` |
| `npm start` | Run `dist/server.js` |

### Backup / restore

- Daily `pg_dump --format=custom`, encrypted with `BACKUP_MASTER_KEY`,
  uploaded to blob under `backup/<ts>.dump.enc`
- Retention: 30 days (configurable via `BACKUP_RETENTION_DAYS`)
- Restore: download → `aes-gcm` decrypt (script TBD in `docs/runbooks/`) →
  `pg_restore`

### Cron jobs (pg-boss, scheduled in `src/crons/runner.ts`)

| Schedule | Job |
|---|---|
| `*/30 * * * *` | upload sweep (pending → expired) |
| `0 * * * *` | upload purge (expired → hard_deleted) |
| `0 * * * *` | idempotency GC |
| `0 3 * * *` | encrypted daily backup |
| `0 6 * * 0` | orphan blob cleanup (placeholder, phase 5+) |

## Related

- [mcp-approval2](https://github.com/axel-rogg/mcp-approval2) — sister
  service: auth, sessions, approval flow, tools, credential vault
- [PLAN-architecture-v2.md](./docs/plans/active/PLAN-architecture-v2.md) —
  authoritative implementation spec

## License

Internal / private — see organisation policy.
