# Deploy `mcp-knowledge2` to Fly.io

Single-region (Frankfurt) Fly.io deployment with attached Postgres +
pgvector, talking back to **mcp-approval2** for JWKS and DEKs.

## TL;DR

```bash
# From repo root, one-shot first deploy:
bash deploy/fly/deploy.sh
```

The script is idempotent — re-running skips any step whose result
already exists, and re-runs the rest.

## Prerequisites

- **flyctl** installed and authenticated: `fly auth login`
- **mcp-approval2** already deployed at `https://mcp-approval2.fly.dev`
  (if your sister-service lives elsewhere, edit `fly.toml`:
  `JWKS_URL` + `MCP_APPROVAL_BASE_URL`)
- A **Vertex AI service account JSON** with the
  `aiplatform.endpoints.predict` permission on the chosen GCP project
- The matching value of **`MCP_APPROVAL_INTERNAL_TOKEN`** that
  mcp-approval2 will accept for the KMS internal API — set on
  mcp-approval2 first, then pasted as a secret here

## Architecture (Fly.io edition)

```
                   ┌─ Internet ─┐
                   ▼            │
   https://mcp-knowledge2.fly.dev (Fly Anycast, force_https)
                   │
                   ▼   8080
         ┌─────────────────────┐
         │  Hono app, 1 VM     │   shared-cpu-1x / 512 MB
         │  region=fra         │   min_machines_running=1
         └─────────────────────┘
                   │ flycast (private 6PN)
                   ▼
         ┌─────────────────────┐
         │ mcp-knowledge2-pg   │   pgvector pg16, volume=3 GB
         │ knowledge_app (RLS) │   knowledge_admin (BYPASSRLS)
         └─────────────────────┘
```

## What `deploy.sh` does

| # | Step | Idempotent? |
|---|---|---|
| 1 | `fly apps create mcp-knowledge2` | yes (skips if exists) |
| 2 | `fly postgres create mcp-knowledge2-pg` | yes (skips if exists) |
| 3 | `fly postgres attach` → sets `DATABASE_URL` | yes (skips if set) |
| 4 | `CREATE EXTENSION vector; pg_trgm;` | yes (`IF NOT EXISTS`) |
| 5 | Prints `CREATE ROLE knowledge_admin BYPASSRLS …` for you to run | manual |
| 6 | Pause — you set secrets manually (see below) | manual |
| 7 | `fly deploy --remote-only` | yes |
| 8 | Curl `/health` + `/version` | yes |

## Secrets you must set before deploy

```bash
fly secrets set --app mcp-knowledge2 \
  SERVICE_TOKEN="$(openssl rand -hex 32)" \
  MCP_APPROVAL_INTERNAL_TOKEN="<copy-from-mcp-approval2>" \
  BACKUP_MASTER_KEY="$(openssl rand -base64 32)" \
  VERTEX_PROJECT="my-gcp-project" \
  VERTEX_SERVICE_ACCOUNT_JSON="$(cat vertex-sa.json | tr -d '\n')" \
  DATABASE_ADMIN_URL="postgres://knowledge_admin:<pw>@mcp-knowledge2-pg.flycast:5432/knowledge" \
  BLOB_ENDPOINT="https://fly.storage.tigris.dev" \
  BLOB_REGION="auto" \
  BLOB_ACCESS_KEY="<tigris-or-r2-key>" \
  BLOB_SECRET_KEY="<tigris-or-r2-secret>" \
  BLOB_BUCKET="knowledge-eu" \
  BLOB_PATH_STYLE="true" \
  BACKUP_BUCKET="knowledge-backup-eu"
```

> Secrets in Fly are encrypted at rest and only injected as env vars at
> container start — they never appear in the image or build logs.

## What `fly.toml` configures (high level)

- **`primary_region = "fra"`** — DSGVO posture. All data stays in EU.
- **`release_command = "npm run db:migrate"`** — applies every
  `drizzle/migrations/*.sql` that isn't yet in `_migrations` against
  the freshly attached Postgres before swapping traffic. Failure aborts
  the deploy.
- **Two health checks** — `/health` (liveness, 30s) and
  `/health/ready` (db + blob + JWKS reachability, 60s).
- **`auto_stop_machines = "stop"` + `min_machines_running = 1`** —
  keeps one warm machine so JWKS cache and the pg pool stay warm, but
  any scaled-up replicas can hibernate during low traffic.
- **`[metrics]`** — Fly's Prometheus scraper pulls `/metrics` from the
  app's internal port.

## After deploy

```bash
# Tail structured logs
fly logs -a mcp-knowledge2

# SSH into the running VM
fly ssh console -a mcp-knowledge2

# Open a psql session against the cluster
fly postgres connect -a mcp-knowledge2-pg

# Show secrets metadata (names only, no values)
fly secrets list -a mcp-knowledge2

# Manual migration re-run (release_command does this automatically)
fly ssh console -a mcp-knowledge2 -C "npm run db:migrate"

# Scale up if traffic warrants (each replica costs ~$2/mo idle)
fly scale count 2 -a mcp-knowledge2
fly scale vm shared-cpu-2x --memory 1024 -a mcp-knowledge2

# Rollback (uses Fly's image registry — instant)
fly releases list -a mcp-knowledge2
fly releases rollback <version> -a mcp-knowledge2
```

## Smoke against the live service

```bash
# Public liveness — should always return 200
curl -sf https://mcp-knowledge2.fly.dev/health

# Readiness — checks db + blob + JWKS; 503 with details if any down
curl -s https://mcp-knowledge2.fly.dev/health/ready | jq

# Authenticated route requires a JWT minted by mcp-approval2.
# Use mcp-approval2's debug-jwt tool, then:
TOKEN=$(...)
curl -sf -H "authorization: bearer $TOKEN" \
  https://mcp-knowledge2.fly.dev/v1/objects | jq .
```

## Known limitations / gotchas

- **No Postgres HA** by default — `--initial-cluster-size 1` keeps the
  cost low. For pilot this is acceptable; for production scale-out, see
  [runbook-fly-deploy.md](../../docs/runbooks/runbook-fly-deploy.md) →
  *Scaling Postgres*.
- **Blob storage is not auto-provisioned** — pick a provider before
  deploy. Recommended for low-latency: Tigris (Fly's native S3, lives
  in the same private network).
- **Vertex AI is reached over the public Internet** — egress to GCP is
  not metered separately on Fly, but watch your Vertex quota.
- **DEK resolution adds ~50–150 ms** per encrypted write/read (KMS
  round-trip to mcp-approval2). Cache headers in the KMS API may help
  later; not in pilot scope.
