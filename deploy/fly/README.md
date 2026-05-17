# Deploy `mcp-knowledge2` to Fly.io

Single-region (Frankfurt) Fly.io deployment. Postgres läuft seit
2026-05-17 auf **Neon Free Tier** (eu-central-1 Frankfurt, TF-managed
in `mcp-approval2/terraform/environments/privat/neon-knowledge2.tf`).
**All sensitive values are managed in Doppler** (project
`mcp-knowledge2`, config `fly`) — die DB-URLs werden vom TF beim
`apply` automatisch reingepusht; das Deploy-Skript pullt sie und
pushed via `fly secrets set` an die App. Override via
`DOPPLER_CONFIG=…` if you maintain a customer-specific config.

## TL;DR

```bash
# One-time: doppler setup
doppler login
doppler setup --project mcp-knowledge2 --config fly

# One-shot first deploy
bash deploy/fly/deploy.sh
```

The script is idempotent — re-running skips any step whose result
already exists.

## Prerequisites

- **flyctl** installed and authenticated: `fly auth login`
- **doppler** CLI installed and scoped:
  `doppler setup --project mcp-knowledge2 --config fly`
- **jq** installed (the secrets-sync step parses Doppler's JSON output)

That's it. Nothing else lives outside Doppler.

## Architecture

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
                   │ TLS (Neon-managed)
                   ▼
         ┌─────────────────────────────────────────────┐
         │ Neon Project mcp-knowledge2                 │  eu-central-1 (AWS)
         │ ep-young-term-alpu306x-pooler               │  Free Tier 0.5 GB
         │ knowledge_app (RLS) + knowledge_admin       │  beide in neon_superuser
         │ pgvector + pg_trgm extensions               │  (BYPASSRLS)
         └─────────────────────────────────────────────┘
```

AS-3 (autonomous) mode: KC2 issues its own MCP-client JWTs via the
OAuth-facade and accepts user tokens directly. No mcp-approval2 dependency
in the default path — optional OBO bridge by setting `MCP_APPROVAL_JWKS_URL`
in Doppler.

## What `deploy.sh` does

| # | Step | Idempotent? |
|---|---|---|
| 1 | `fly apps create mcp-knowledge2` | yes (skips if exists; TF-managed alternativ) |
| 2 | Verify `DATABASE_URL` is staged in Doppler from `terraform apply` of `neon-knowledge2.tf` | yes (read-only check) |
| 3 | Calls `deploy/fly/sync-secrets.sh` → pulls from Doppler, pushes to Fly | yes |
| 4 | `fly deploy --remote-only --build-arg BUILD_SHA=$(git rev-parse --short HEAD)` | yes |
| 5 | Curls `/health`, `/version`, `/health/ready` | yes |

**Postgres-Bootstrap** (vor dem ersten Deploy einmalig, kein Skript-Step weil
ausserhalb der Fly-Surface): `terraform apply` für `neon-knowledge2.tf` im
Schwester-Repo, dann
`psql "$(doppler secrets get DATABASE_ADMIN_URL --plain --project mcp-knowledge2 --config fly)" -c 'CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;'`.
Beide Rollen sind in `neon_superuser` → keine extra GRANTs.

## Secrets — managed in Doppler

The single source of truth is Doppler. Populate these keys in your
`mcp-knowledge2 / fly` config:

### Required

| Key | What | Where it comes from |
|---|---|---|
| `DATABASE_URL` | Neon pooled-Connection-String (role `knowledge_app`, via PGBouncer) | Automatisch von TF aus `neon-knowledge2.tf` in Doppler gepusht |
| `DATABASE_ADMIN_URL` | Neon direct-Connection-String (role `knowledge_admin`, für Migrations + Erase + Extensions) | Automatisch von TF aus `neon-knowledge2.tf` in Doppler gepusht |
| `SERVICE_TOKEN` | 32-byte hex; gates `/v1/internal/*` | `openssl rand -hex 32` |
| `BACKUP_MASTER_KEY` | 32 random bytes, base64 | `openssl rand -base64 32` |
| `KMS_MASTER_KEY_B64` | 32 random bytes, base64 | `openssl rand -base64 32` |
| `GOOGLE_OAUTH_CLIENT_ID` | OAuth-facade Google client | Google Cloud Console → OAuth 2.0 Client IDs |
| `GOOGLE_OAUTH_CLIENT_SECRET` | OAuth-facade Google secret | same |
| `CLOUDFLARE_ACCOUNT_ID` | Workers AI account | Cloudflare dashboard |
| `CLOUDFLARE_API_TOKEN` | Token with `Workers AI Read` + `AI Gateway Run` scopes | Cloudflare → API Tokens |
| `BLOB_ENDPOINT` | e.g. `https://fly.storage.tigris.dev` (Tigris) | Provider dashboard |
| `BLOB_REGION` | e.g. `auto` (Tigris) / `eu-central` (Backblaze) | Provider |
| `BLOB_ACCESS_KEY` | S3-style access key | Provider |
| `BLOB_SECRET_KEY` | S3-style secret | Provider |
| `BLOB_BUCKET` | e.g. `knowledge-eu` | Provider |
| `BACKUP_BUCKET` | e.g. `knowledge-backup-eu` (separate lifecycle policy) | Provider |

### Optional

| Key | When to set |
|---|---|
| `CLOUDFLARE_AI_GATEWAY_TOKEN` | If your AI Gateway runs in Authenticated mode |
| `MCP_APPROVAL_JWKS_URL` | Enables OBO proxy from mcp-approval2 |
| `ALLOWED_EMAILS` | CSV — strict email whitelist on `/auth/google/callback` |
| `GOOGLE_HD_ALLOWLIST` | CSV — restrict to specific Workspace `hd` domains |
| `OPENBAO_ADDR` + `OPENBAO_TOKEN` | When you migrate from `hkdf_local` to OpenBao Transit |

### Vertex AI (only if you switch `EMBED_PROVIDER=vertex`)

| Key | What |
|---|---|
| `EMBED_PROVIDER` | Set to `vertex` (overrides fly.toml default `cloudflare`) |
| `VERTEX_PROJECT` | GCP project id |
| `VERTEX_SERVICE_ACCOUNT_JSON` | Inline SA JSON (one-line) — the adapter parses it directly, no file mount needed |

### TF-managed in Doppler — DO NOT set manually

| Key | Why |
|---|---|
| `DATABASE_URL` / `DATABASE_ADMIN_URL` / `DB_APP_PASSWORD` / `DB_ADMIN_PASSWORD` | Pushed automatically by Terraform when `neon-knowledge2.tf` is applied. Editing them manually drifts against the TF state. |

### Set via `fly.toml [env]` — DO NOT put in Doppler

The sync script skips these to avoid silently shadowing the TOML defaults:
`PORT`, `NODE_ENV`, `LOG_LEVEL`, `SELF_OAUTH_ISSUER`,
`GOOGLE_OAUTH_REDIRECT_URI`, `JWKS_CACHE_TTL_SECONDS`, `EMBED_PROVIDER`,
`CLOUDFLARE_AI_GATEWAY_ID`, `CLOUDFLARE_AI_MODEL`, `KMS_PROVIDER`,
`BLOB_PATH_STYLE`, `DATABASE_POOL_MAX`, `BACKUP_RETENTION_DAYS`.

If you need to override one (e.g. flip `EMBED_PROVIDER` to `vertex`),
either edit `fly.toml` or put it in Doppler AND remove it from the
sync-script's skip-list.

## Re-syncing secrets later

When you rotate any value in Doppler:

```bash
bash deploy/fly/sync-secrets.sh   # staged, no redeploy
fly deploy                         # picks up the new staged secrets
```

## What `fly.toml` configures (non-secret)

- **`primary_region = "fra"`** — DSGVO posture. All data stays in EU.
- **`release_command = "npm run db:migrate"`** — applies new
  `drizzle/migrations/*.sql` against the attached Postgres before swapping
  traffic. Failure aborts the deploy. `scripts/migrate.ts` and the
  `drizzle/migrations/` tree are copied into the runtime image (see
  `Dockerfile` runtime stage), so this works on the release VM.
- **Boot order**: `serve()` starts BEFORE `pg-boss` so `/health` answers
  immediately on cold-start. `/health/ready` is the readiness gate.
- **Two health checks** — `/health` (liveness, 10s grace) and
  `/health/ready` (db + blob reachability, 30s grace).
- **`auto_stop_machines = "stop"` + `min_machines_running = 1`** —
  keeps one warm machine so JWKS-cache and pg-pool stay warm.
- **`[metrics]`** — Fly's Prometheus scraper pulls `/metrics`.

## After deploy

```bash
fly logs -a mcp-knowledge2                  # tail structured logs
fly ssh console -a mcp-knowledge2           # shell into the VM
psql "$(doppler secrets get DATABASE_ADMIN_URL --plain --project mcp-knowledge2 --config fly)"  # psql to Neon
fly secrets list -a mcp-knowledge2          # names only — values never echo
fly ssh console -a mcp-knowledge2 -C "npm run db:migrate"  # manual re-run

fly scale count 2 -a mcp-knowledge2
fly scale vm shared-cpu-2x --memory 1024 -a mcp-knowledge2

fly releases list -a mcp-knowledge2
fly releases rollback <version> -a mcp-knowledge2
```

## Smoke against the live service

```bash
# Public liveness — should always return 200
curl -sf https://mcp-knowledge2.fly.dev/health

# Readiness — checks db + blob; 503 with details if either is down
curl -s https://mcp-knowledge2.fly.dev/health/ready | jq

# Authenticated route requires a JWT issued by KC2's own OAuth-facade
# (or Google directly when caller is the human). DCR + /oauth/token live
# at /.well-known/oauth-authorization-server.
TOKEN=$(...)
curl -sf -H "authorization: bearer $TOKEN" \
  https://mcp-knowledge2.fly.dev/v1/objects | jq .
```

## Known limitations / gotchas

- **Neon Free Tier limits** — 0.5 GB Storage, 0.25 CU shared compute,
  `history_retention_seconds` max 6 h, kein `suspend_timeout_seconds`-Override
  (Auto-Suspend on idle, ~300 ms Cold-Start). Reicht für Solo-Pilot; bei
  Customer-Volumen Upgrade auf Neon Launch (~$5/mo, 7d Retention) evaluieren.
- **Blob storage is not auto-provisioned** — pick a provider before deploy.
  Recommended for low-latency: Tigris (Fly's native S3, lives in the same
  private network).
- **Vertex AI ADC on Fly** — Fly is not on GCP's metadata network, so
  EMBED_PROVIDER=vertex requires `VERTEX_SERVICE_ACCOUNT_JSON` (inline SA
  JSON) in Doppler. The path/ADC modes are for k8s/Cloud Run.
