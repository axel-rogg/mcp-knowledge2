# Deploy `mcp-knowledge2` to Fly.io

Single-region (Frankfurt) Fly.io deployment with attached Postgres +
pgvector. Secrets live in Doppler — no plaintext credentials in this repo
or in your shell history.

## TL;DR

```bash
# 0. One-time Doppler setup:
doppler login
doppler setup --project mcp-knowledge2 --config prd_fly

# 1. First deploy (idempotent):
bash deploy/fly/deploy.sh

# 2. Subsequent deploys (just code):
fly deploy --remote-only --build-arg "BUILD_SHA=$(git rev-parse --short HEAD)"

# 3. Secret rotation (without redeploy):
bash deploy/fly/sync-secrets.sh
fly deploy   # picks up new secrets on next release
```

## Prerequisites

- **flyctl** installed and authenticated: `fly auth login`
- **doppler CLI** installed and scoped to this project — guide:
  <https://docs.doppler.com/docs/cli>
- **jq** (used by the secrets-sync script)
- The Doppler config `prd_fly` populated — see *Secrets* below

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
| 6 | `sync-secrets.sh` pushes Doppler → Fly | yes |
| 7 | `fly deploy --remote-only` with `BUILD_SHA` arg | yes |
| 8 | Curl `/health` + `/version` + `/health/ready` | yes |

## Secrets — populate Doppler `prd_fly`

These are the keys the runtime reads at boot. Set them in Doppler under
project `mcp-knowledge2`, config `prd_fly`. Anything in `fly.toml [env]`
is **excluded** by `sync-secrets.sh` and must NOT be set in Doppler (or
it would shadow the TOML default).

### Required

| Key | Notes |
|---|---|
| `DATABASE_ADMIN_URL` | `postgres://knowledge_admin:<pw>@<PG_NAME>.flycast:5432/knowledge` — password matches the manual `CREATE ROLE` step |
| `SERVICE_TOKEN` | `openssl rand -hex 32` — gates `/v1/internal/*` |
| `KMS_MASTER_KEY_B64` | `openssl rand -base64 32` — used by `KMS_PROVIDER=hkdf_local` |
| `BACKUP_MASTER_KEY` | `openssl rand -base64 32` — independent of any DEK; also encrypts OAuth-facade signing keys at rest |
| `GOOGLE_OAUTH_CLIENT_ID` | from Google Cloud Console → APIs & Services → Credentials |
| `GOOGLE_OAUTH_CLIENT_SECRET` | same screen as above |
| `CLOUDFLARE_ACCOUNT_ID` | from Cloudflare dashboard (any zone, sidebar) |
| `CLOUDFLARE_API_TOKEN` | token with scopes: Workers AI Read + AI Gateway Run |
| `BLOB_ENDPOINT` | recommended Tigris: `https://fly.storage.tigris.dev`. Alt: R2, Backblaze |
| `BLOB_REGION` | Tigris: `auto`. R2: `auto`. Backblaze: bucket region |
| `BLOB_ACCESS_KEY` | provider-issued access key |
| `BLOB_SECRET_KEY` | provider-issued secret |
| `BLOB_BUCKET` | e.g. `knowledge-eu` |

### Optional

| Key | Reason |
|---|---|
| `BACKUP_BUCKET` | distinct bucket (different lifecycle/retention) for `backup/*.dump.enc`. Falls back to `BLOB_BUCKET` if unset. |
| `GOOGLE_HD_ALLOWLIST` | CSV of Workspace `hd` claims allowed to log in |
| `ALLOWED_EMAILS` | strict CSV email allowlist (recommended for solo deploy: `axelrogg@gmail.com`) |
| `MCP_APPROVAL_JWKS_URL` | enable the OBO-proxy path from mcp-approval2 |
| `CLOUDFLARE_AI_GATEWAY_TOKEN` | only if your AI Gateway runs in *Authenticated* mode |
| `VERTEX_PROJECT` + `VERTEX_SERVICE_ACCOUNT_JSON` | only if you switch `EMBED_PROVIDER` to `vertex` (also override `EMBED_PROVIDER` here) |

> Secrets in Fly are encrypted at rest and only injected as env vars at
> container start — they never appear in the image or build logs.
> Doppler is the single source of truth: rotate there, then run
> `sync-secrets.sh`.

### Vars `sync-secrets.sh` skips on purpose

`fly.toml [env]` already sets these — Doppler entries with the same key
would shadow them silently, so the sync script skips them:

```
PORT NODE_ENV LOG_LEVEL
SELF_OAUTH_ISSUER GOOGLE_OAUTH_REDIRECT_URI
JWKS_CACHE_TTL_SECONDS
EMBED_PROVIDER CLOUDFLARE_AI_GATEWAY_ID CLOUDFLARE_AI_MODEL
KMS_PROVIDER BLOB_PATH_STYLE
DATABASE_POOL_MAX BACKUP_RETENTION_DAYS
```

Plus `DATABASE_URL` (Fly sets it via `fly postgres attach`).

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

# Readiness — checks DB + blob; 503 if either is down
curl -s https://mcp-knowledge2.fly.dev/health/ready | jq

# Authenticated route requires a JWT minted by KC2's own /oauth/token
# (or by Google directly, then exchanged via Discovery). Run the full
# OAuth flow via scripts/smoke.sh once a JWT is in hand.
TOKEN=$(...)
curl -sf -H "authorization: bearer $TOKEN" \
  https://mcp-knowledge2.fly.dev/v1/objects | jq .
```

## Known limitations / gotchas

- **No Postgres HA** by default — `--initial-cluster-size 1` keeps the
  cost low. For pilot this is acceptable; for production scale-out, see
  [runbook-fly-deploy.md](../../docs/runbooks/runbook-fly-deploy.md).
- **Blob storage is not auto-provisioned** — pick a provider before
  deploy. Recommended for low-latency: Tigris (Fly's native S3, lives
  in the same private network).
- **Embedding traffic egresses Fly** — Cloudflare Workers AI is reached
  over the public Internet. No egress fees on Fly, but watch Cloudflare
  AI quota.
- **OAuth callback URL** — `GOOGLE_OAUTH_REDIRECT_URI` is set in
  `fly.toml [env]` to `https://mcp-knowledge2.fly.dev/auth/google/callback`.
  If you map a custom domain, update both the TOML default AND the
  redirect URI registered in Google Cloud Console.
