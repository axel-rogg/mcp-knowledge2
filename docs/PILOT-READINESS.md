# mcp-knowledge2 — Pilot Readiness

> **Date**: 2026-05-13
> **Owner**: Axel
> **Target**: first paying-pilot customer hosted on Fly.io
> **Sister service**: `mcp-approval2` (auth, sessions, KMS, approval flow)

This document is the honest accounting of what's done, what's known
broken, and what's still required before we put a customer's data on
this service.

## TL;DR

**Code is pilot-grade. Ops is pilot-grade once `bash deploy/fly/deploy.sh`
runs cleanly once. CROSS-SERVICE D-9 (multi-subtype search) was resolved
by ADR-0004 (generic object model); the remaining blocker is verifying
the production AppRole boot path against a real `mcp-approval2`.**

---

## What works (✅ Done)

### Application code

- **HTTP server** — Hono + `@hono/node-server`, graceful shutdown
  (SIGTERM/SIGINT → drain crons → close pg pool → exit), structured
  pino logs with PII-redact rules.
- **Database** — Drizzle ORM + pg pool, four migrations applied
  (`0000_init`, `0001_rls`, `0002_security_hardening`,
  `0003_drop_description_enc`, `0004_erase_cascade`). Per-request
  Postgres transaction sets `app.current_user` for **Row-Level Security**.
- **Auth** —
  - User routes: JWT verified via JWKS (24 h cache) against
    `mcp-approval2`. `sub` claim becomes `current_user`.
  - Internal routes: static `SERVICE_TOKEN` (constant-time compare).
- **Crypto** — AES-256-GCM with **AAD** (`<recordType>|<owner>|<id>`,
  see ADR-0004 — kind/subtype slot removed from AAD as part of generic
  object model)
  preventing cross-user / cross-object ciphertext replay. Per-user DEKs
  resolved on-demand via `mcp-approval2` KMS internal API; never
  persisted in `mcp-knowledge2`.
- **PII masking** — applied to text **before** it leaves the service for
  embedding. **Default provider since 2026-05-15: Cloudflare Workers AI
  (`@cf/baai/bge-m3`, 1024-dim, multilingual)** routed through a dedicated
  AI Gateway `mcp-knowledge2` (TF-managed via
  `mcp-approval2/terraform/environments/privat/knowledge2-cloudflare.tf`).
  Optional fallback via `EMBED_PROVIDER=vertex`. Either way, the embedding
  provider never sees raw emails / phones. (Embedding-inversion threat
  documented in [`SECURITY.md`](./SECURITY.md).)
- **Email-Whitelist** — `ALLOWED_EMAILS` CSV in Doppler is strictly
  enforced on `/auth/google/callback`. Empty = open. Non-empty = only
  listed emails complete OAuth. Defense-in-depth on top of the OAuth-App's
  Test-Users list in Google Cloud Console.
- **Object CRUD** — `/v1/objects` generic-object model (free-form
  `subtype` string, no DB-enforced discriminator — see ADR-0004),
  inline body ≤ 16 KB in Postgres or external blob via presigned upload
  pipeline (`/v1/uploads/init`).
- **Share grants** — `/v1/shares` with role-based access control,
  enforced by RLS predicate `owner_or_shared(object_id)`.
- **Hybrid search** — FTS (Postgres `tsvector`) ⊕ pgvector (cosine) →
  RRF fusion with `k=60`, optional `subtypes: string[]` filter.
- **Cross-service contracts** —
  - `/v1/internal/erase-user` — admin-role DELETE across all tables
    for a user id; uses `DATABASE_ADMIN_URL` (BYPASSRLS).
  - DEK resolve via `mcp-approval2` KMS internal API.
- **Crons** (pg-boss): upload sweep (30 m), upload purge (1 h),
  idempotency GC (1 h), encrypted daily backup (03:00 UTC), orphan
  blob cleanup (weekly placeholder).
- **Observability** — `/metrics` Prometheus, `/health` liveness,
  `/health/ready` deep check (db + blob + JWKS), pino structured logs
  with `request_id` propagation, `audit_events` table for all
  non-trivial writes.
- **Idempotency** — `Idempotency-Key` header de-dupes writes for 24 h
  via the `idempotency_records` table.
- **Body-size cap** — 64 KB hard limit on JSON; large objects must go
  through the presigned upload pipeline.

### Tests

- **16 unit tests** — crypto AAD, RRF fusion, JWT issuer/audience
  validation, env-zod schema, PII mask, etc.
- **1 integration test** — testcontainers spins a Postgres+pgvector,
  applies migrations, exercises the RLS policy with two synthetic users.
- All green as of 2026-05-13.

### Operations

- **Dockerfile** — multi-stage (`deps` → `build` → `runtime`),
  non-root `app` user, `HEALTHCHECK` baked in.
- **`.dockerignore`** — production-grade, blocks `secrets/`, `.env*`,
  `vertex-sa.json`, tests, docs.
- **`fly.toml`** — Frankfurt single-region, 1 always-on machine,
  rolling deploys, release-command runs migrations.
- **`deploy/fly/deploy.sh`** — first-deploy automation (app create,
  pg create + attach, pgvector + pg_trgm extensions, secrets prompt,
  deploy, smoke).
- **Runbook** — `docs/runbooks/runbook-fly-deploy.md` covers deploy,
  rollback, scale, secrets rotation, backup/restore, failure modes.

---

## What's missing for pilot (⚠️ Open)

### Code blockers (must fix before pilot)

| ID | Item | Why blocking | Effort |
|---|---|---|---|
| ~~D-9~~ | ~~**Server-side multi-kind search**~~ | **Resolved by ADR-0004** — server accepts `subtypes: string[]` (free-form). | done |
| AppRole | **Verify production AppRole boot path** — `mcp-approval2` KMS API works under load | KMS-Internal-API code is in but never exercised against a real prod approval | ½ day — load-test once `mcp-approval2` is deployed to Fly |
| eslint | `src/crons/backup.ts` ESLint error (not runtime-affecting) | Quality only; not a pilot blocker but should be cleaned before "v1.0" | 10 min |

### Code follow-ups (post-pilot OK)

- **Backup-restore script** — `scripts/restore-backup.ts` is referenced
  in the runbook but doesn't exist yet. Manual decrypt steps documented.
- **Embedding-provider retry/backoff** — currently single-shot for both
  Cloudflare Workers AI (default) and Vertex AI (fallback). Under quota
  pressure the embed call will 5xx. Add `p-retry` w/ jitter in
  `src/adapters/embed/index.ts` once the pilot tells us their throughput.
- **Observability — tracing** — pino structured logs only. OpenTelemetry
  hooks are referenced in `.env.example` (`OTEL_EXPORTER_OTLP_ENDPOINT`)
  but not wired in.
- **Multi-region Postgres** — single-leader-fra is fine for pilot. Add a
  read-replica in ams when the pilot grows to a second region.

### Ops blockers (must do before pilot signs)

| ID | Item | Owner action |
|---|---|---|
| Ops-1 | **Run `deploy/fly/deploy.sh` against a clean Fly org once** end-to-end, verify health checks green | Manual; ~30 min |
| Ops-2 | **Set up Postgres backups beyond the app-cron** — enable Fly's volume snapshots (free, automatic; just verify) | `fly volumes snapshots list` — confirm cadence |
| Ops-3 | **Wire blob provider** — pick Tigris (recommended, in-network) or R2/B2, create bucket, set BLOB_* secrets | ~15 min |
| Ops-4 | **DNS + custom domain** — optional but recommended; default `*.fly.dev` works for pilot | `fly certs add knowledge.firma.invalid` |
| Ops-5 | **Smoke test from the customer's side** — issue them a `mcp-approval2` JWT, walk through put/get/search/share | Pair-session with the pilot |

### Docs blockers

| ID | Item |
|---|---|
| Docs-1 | **DPA-compliance clauses** in customer contract (referenced in `PLAN-architecture-v2.md`) — legal task, not engineering |
| Docs-2 | **Incident-response runbook** — current runbook covers operational fault recovery but not data-breach disclosure timelines |
| Docs-3 | **SOC2-light evidence binder** — audit-log retention, access-log retention, secrets-rotation log. The mechanisms exist; the evidence-pack is empty. |

---

## Smoke test (cuts the pilot-ready ribbon)

After running `deploy/fly/deploy.sh` end-to-end, the following must all
pass against `https://mcp-knowledge2.fly.dev`:

```bash
# 1. Public health
curl -sf https://mcp-knowledge2.fly.dev/health                | jq .
curl -sf https://mcp-knowledge2.fly.dev/health/ready          | jq .

# 2. Issue a JWT from mcp-approval2 for a synthetic user
TOKEN=$(curl -sf https://mcp-approval2.fly.dev/v1/internal/debug-jwt \
  -H "authorization: bearer $SERVICE_TOKEN" \
  -d '{"sub":"smoke-user","scope":"knowledge:rw"}' | jq -r .jwt)

# 3. Round-trip: put → get → list → search → delete
ID=$(curl -sf -X PUT https://mcp-knowledge2.fly.dev/v1/objects \
  -H "authorization: bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"subtype":"doc","body":"hello pilot"}' | jq -r .id)

curl -sf -H "authorization: bearer $TOKEN" \
  https://mcp-knowledge2.fly.dev/v1/objects/$ID | jq .

curl -sf -H "authorization: bearer $TOKEN" \
  "https://mcp-knowledge2.fly.dev/v1/objects?subtype=doc&limit=10" | jq .

curl -sf -H "authorization: bearer $TOKEN" \
  -X POST -H "content-type: application/json" \
  -d '{"q":"pilot","subtypes":["doc"]}' \
  https://mcp-knowledge2.fly.dev/v1/search | jq .

curl -sf -X DELETE -H "authorization: bearer $TOKEN" \
  https://mcp-knowledge2.fly.dev/v1/objects/$ID

# 4. RLS isolation — second user cannot see first user's data
TOKEN2=$(... # JWT for "smoke-user-2")
curl -s -H "authorization: bearer $TOKEN2" \
  https://mcp-knowledge2.fly.dev/v1/objects/$ID
# Expect: 404 (or 403; never 200)

# 5. Internal erase-user round-trip
curl -sf -X POST https://mcp-knowledge2.fly.dev/v1/internal/erase-user \
  -H "authorization: bearer $SERVICE_TOKEN" \
  -d '{"user_id":"smoke-user"}'
# Expect: 200 with rows-deleted breakdown
```

When all 5 pass, we are **pilot-ready**.

---

## What pilot customers should expect

- **SLO**: 99 % uptime (Fly platform SLA + 1 instance + manual rollback);
  RPO < 24 h (daily encrypted backup); RTO < 4 h (restore-from-backup runbook).
- **Latency**: p50 < 80 ms for read/list, p95 < 250 ms (Frankfurt → EU);
  search p50 < 200 ms, p95 < 600 ms (vector + FTS round-trip).
- **Throughput**: untested. The pilot itself is the throughput test.
- **Data residency**: all data in EU (Frankfurt). Embedding-Requests:
  default Cloudflare Workers AI via AI Gateway in CF-EU-Edges (kein GCP-
  Egress); optional Vertex AI `europe-west4` als Fallback wenn
  `EMBED_PROVIDER=vertex`.
- **Encryption**: AES-256-GCM at rest (per-user DEK) + TLS in transit.
  Backups separately encrypted with `BACKUP_MASTER_KEY`. We never see
  plaintext keys at rest in `mcp-knowledge2`.
- **What we don't guarantee yet**: zero-downtime DB upgrades, multi-region,
  customer-managed keys (CMK), DPA-compliance sign-off (in legal review).

---

## Sign-off checklist

Before flipping the pilot live:

- [x] D-9 multi-kind search — resolved by ADR-0004 (`subtypes: string[]`)
- [ ] AppRole/KMS roundtrip verified against deployed mcp-approval2
- [ ] `deploy/fly/deploy.sh` run end-to-end on a clean Fly org
- [ ] All 5 smoke-test steps pass
- [ ] Blob provider chosen + secrets set + first object round-trips
- [ ] Backup job's first run lands in the blob bucket (check after
      03:00 UTC the day after deploy)
- [ ] Customer signed DPA + has their own `mcp-approval2` instance
      issuing JWTs for their users
- [ ] On-call rota established (who responds to `/health/ready` 503?)
- [ ] Restore-from-backup dry-run completed (`pg_restore` against a
      throwaway db from the encrypted dump)
