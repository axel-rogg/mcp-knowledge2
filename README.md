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

```
                            JWT (60s TTL, signed by mcp-approval2)
   mcp-approval2  ──────────────────────────────────────►   mcp-knowledge2
   (auth / tools)                                           (this repo)
                                                                │
                            ┌───────────────────────────────────┼─────────┐
                            ▼                                   ▼         ▼
                   Postgres + pgvector              S3-compat blob   Vertex AI
                   • objects + shares + audit          (R2/B2/GCS)   (text-embed-005)
                   • RLS on owner_or_shared
                   • per-user DEK envelope-encryption
```

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
├── auth/                 JWT + service-token middlewares
├── middleware/           context, idempotency, error, request_log
├── db/                   schema (Drizzle) + tx-scoped pool (`withUserTx`, `withAdminTx`)
├── storage/              objects, refs, tags, revisions, shares, uploads
├── search/               FTS + vector + RRF hybrid
├── adapters/
│   ├── blob/             S3-compatible (R2/B2/GCS/MinIO)
│   ├── embed/            Vertex AI (text-embedding-005, dim=768)
│   └── kms/              Internal-API DEK resolver (Variante B)
├── lib/
│   ├── crypto/           AES-256-GCM + AAD builder + serialise
│   ├── pii/              maskPII — applied BEFORE embedding
│   ├── context.ts        AsyncLocalStorage (current_user, request_id)
│   ├── errors.ts         RFC 7807 Problem Details
│   ├── ids.ts            UUID v4 + nowMs helpers
│   └── logger.ts         pino with PII-aware redact rules
├── quota/                per-user limits enforcement
├── observability/        audit emitter, prom-metrics
├── crons/                pg-boss schedules (sweep, gc, backup)
└── types/                env + domain primitives

drizzle/migrations/       0000_init.sql + 0001_rls.sql
deployments/              docker-compose (dev + prod), cloud-run yaml, caddy
tests/                    unit + integration (testcontainers) + smoke shell
```

## Auth model

- **`/v1/*` user routes** — JWT signed by mcp-approval2, validated via JWKS
  (cached 24h). `sub` claim is the user id, propagated as
  `app.current_user` into the Postgres session for RLS.
- **`/v1/internal/*` service routes** — static `SERVICE_TOKEN` (env). Use
  admin DB role (BYPASSRLS) for cross-user maintenance like
  `erase-user`.
- **No public endpoints other than** `/health`, `/version`, `/metrics`.

## Encryption summary

| Layer | Where | Key |
|---|---|---|
| Body + description (per object) | App | DEK from mcp-approval2 KMS (resolved per request, never stored) |
| Backups | `pg_dump` → AES-GCM → blob | `BACKUP_MASTER_KEY` env (separate from DEKs) |

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
