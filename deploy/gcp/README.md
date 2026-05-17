# Deploy `mcp-knowledge2` to Google Cloud (Cloud Run + Cloud SQL)

EU-region (europe-west4) deploy with Cloud SQL Postgres 16 + pgvector,
GCS via S3-Interop for blob storage (HMAC keys; a native-GCS adapter
exists in code but isn't wired into `service.yaml` yet — see open items
in [PILOT-READINESS](../../docs/PILOT-READINESS.md)), and Vertex AI for
embeddings (via the runtime SA's ADC). Secrets are sourced from Doppler
and mirrored to Google Secret Manager — Cloud Run reads them via
`secretKeyRef`.

> ⚠️ **Vector-dim mismatch warning:** the schema (migration `0010`)
> ships at 1024-dim for Cloudflare `bge-m3`. Vertex
> `text-multilingual-embedding-002` returns 768-dim. Either flip
> `EMBED_PROVIDER=cloudflare` (and add the four CF secrets below) or
> roll the schema back to 768-dim before going live with Vertex.

## TL;DR

```bash
# 0. One-time Doppler setup:
doppler login
doppler setup --project mcp-knowledge2 --config prd_gcp

# 1. Bootstrap GCP project (idempotent — APIs, SA, Cloud SQL, buckets, WIF):
GCP_PROJECT=<your-project> REGION=europe-west4 bash deploy/gcp/01-bootstrap.sh

# 2. Run the printed SQL inside the new Cloud SQL instance to create
#    knowledge_app + knowledge_admin roles (the bootstrap script prints
#    the exact statements).

# 3. Populate Doppler 'prd_gcp' (see "Secrets" below).

# 4. Sync secrets to Secret Manager:
GCP_PROJECT=<your-project> bash deploy/gcp/sync-secrets.sh

# 5. Deploy (uses .github/workflows/deploy.yml):
gh workflow run deploy.yml \
  -f sql_instance_connection=<project>:<region>:knowledge \
  -f domain=knowledge.example.com \
  -f region=europe-west4
```

## Prerequisites

- **gcloud CLI** authenticated to an owner/editor account on a GCP project
  with billing enabled
- **doppler CLI** scoped to project `mcp-knowledge2`, config `prd_gcp`
- **jq** (used by sync-secrets.sh)
- **gh CLI** (only for triggering the deploy workflow)
- GitHub repository secrets configured (printed at the end of `01-bootstrap.sh`):
  `GCP_PROJECT`, `GCP_DEPLOY_SA`, `GCP_WIF_PROVIDER`

## Architecture

```
                  ┌── Internet ──┐
                  ▼              │
   https://knowledge.example.com  (Cloud Run external HTTPS LB)
                  │
                  ▼   8080
        ┌────────────────────────┐
        │ Cloud Run (gen2)       │  cpu=1, mem=512Mi
        │ minScale=1 maxScale=10 │  knowledge-runtime SA
        └────────────────────────┘
              │              │             │
       /cloudsql socket   GCS S3-Interop   Vertex AI (ADC)
              │              │             │
        ┌───────────┐ ┌──────────────┐ ┌────────────────────┐
        │ Cloud SQL │ │ knowledge-eu │ │ text-multilingual- │
        │ pg16+vec  │ │ knowledge-   │ │ embedding-002      │
        └───────────┘ │ backup-eu    │ └────────────────────┘
                      └──────────────┘
```

## What `01-bootstrap.sh` does

| # | Resource | Idempotent |
|---|---|---|
| 1 | Enables 8 GCP APIs (Run, AR, SQL, SM, AI Platform, IAM-Creds, RM, GCS) | yes |
| 2 | Artifact Registry `containers` (europe-west4, docker) | yes |
| 3 | Cloud SQL `knowledge` (pg16, db-custom-1-3840, `cloudsql.enable_pgvector_extension=on`, daily backups, PITR) | yes |
| 4 | Database `knowledge` inside the SQL instance | yes |
| 5 | Two GCS buckets: `knowledge-eu`, `knowledge-backup-eu` | yes |
| 6 | Two service accounts: `knowledge-runtime` (CR runtime), `knowledge-deploy` (CI) | yes |
| 7 | IAM bindings — runtime SA gets cloudsql.client, secretmanager.secretAccessor, aiplatform.user, storage.objectUser | yes |
| 8 | IAM bindings — deploy SA gets run.admin, artifactregistry.writer, iam.serviceAccountUser, secretmanager.admin, plus actAs on runtime SA | yes |
| 9 | HMAC keys for runtime SA (for `BLOB_ACCESS_KEY`/`BLOB_SECRET_KEY`) — printed once; capture into Doppler | partial |
| 10 | WIF pool `github-actions` + provider `mcp-knowledge2` (scoped to repo) | yes |

**Manual step after bootstrap:** create the two Postgres roles. The script
prints the exact SQL. Connect with:

```bash
gcloud sql connect knowledge --user=postgres --project=<your-project>
```

You'll need the `postgres` user's password (set with `gcloud sql users set-password postgres ...`).

## Secrets — populate Doppler `prd_gcp`

`sync-secrets.sh` maps Doppler keys → Secret Manager names. The mapping
lives in [`sync-secrets.sh`](sync-secrets.sh) (search for `SECRET_MAP`).
Keep the list there in sync with `deployments/cloud-run/service.yaml`.

### Required

| Doppler key | Secret Manager name | Notes |
|---|---|---|
| `DATABASE_URL` | `knowledge-database-url` | `postgres://knowledge_app:<pw>@/knowledge?host=/cloudsql/<project>:<region>:knowledge` |
| `DATABASE_ADMIN_URL` | `knowledge-database-admin-url` | same shape, `knowledge_admin` + its password |
| `SERVICE_TOKEN` | `knowledge-service-token` | `openssl rand -hex 32` |
| `KMS_MASTER_KEY_B64` | `knowledge-kms-master-key` | `openssl rand -base64 32` |
| `BACKUP_MASTER_KEY` | `knowledge-backup-master` | `openssl rand -base64 32` |
| `GOOGLE_OAUTH_CLIENT_ID` | `knowledge-google-oauth-client-id` | from GCP Console |
| `GOOGLE_OAUTH_CLIENT_SECRET` | `knowledge-google-oauth-client-secret` | from GCP Console |
| `BLOB_ACCESS_KEY` | `knowledge-blob-access-key` | HMAC accessId printed by bootstrap |
| `BLOB_SECRET_KEY` | `knowledge-blob-secret-key` | HMAC secret printed by bootstrap |

### Optional

| Doppler key | Secret Manager name | When |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` | `knowledge-cf-*` | only if you switch `EMBED_PROVIDER` to `cloudflare` |
| `MCP_APPROVAL_JWKS_URL` | `knowledge-approval-jwks-url` | enable OBO-proxy from mcp-approval2 |
| `GOOGLE_HD_ALLOWLIST` | `knowledge-google-hd-allowlist` | CSV of Workspace `hd` values |
| `ALLOWED_EMAILS` | `knowledge-allowed-emails` | CSV strict allowlist (recommended for solo: `axelrogg@gmail.com`) |

> Doppler is the single source of truth: rotate there, then run
> `sync-secrets.sh` to publish a new Secret Manager version. Cloud Run
> picks up `:latest` references on its next revision (next deploy or
> traffic-split shuffle).

## After deploy

```bash
# Tail logs
gcloud run services logs read mcp-knowledge2 --region=europe-west4

# Curl the service
URL=$(gcloud run services describe mcp-knowledge2 --region=europe-west4 --format='value(status.url)')
curl -sf "$URL/health"
curl -s  "$URL/health/ready" | jq

# Re-run migrations only (no service redeploy)
gcloud run jobs execute migrate-knowledge2 --region=europe-west4 --wait

# Manual rollback
gcloud run services update-traffic mcp-knowledge2 \
  --region=europe-west4 \
  --to-revisions=<previous-revision>=100
```

## Custom domain (required for OAuth callback)

`GOOGLE_OAUTH_REDIRECT_URI` is built from the `domain` workflow input. To
serve from a custom hostname:

1. Map the domain in Cloud Run:
   ```bash
   gcloud run domain-mappings create \
     --service=mcp-knowledge2 \
     --domain=knowledge.example.com \
     --region=europe-west4
   ```
2. Add the CNAME / A record gcloud prints to your DNS.
3. Add `https://knowledge.example.com/auth/google/callback` to the
   "Authorized redirect URIs" of the Google OAuth client in Cloud Console.
4. Re-deploy via `gh workflow run deploy.yml -f domain=knowledge.example.com ...`.

## Known limitations / gotchas

- **pgvector flag must be set at SQL-instance create time.** The
  bootstrap script does this via `--database-flags=cloudsql.enable_pgvector_extension=on`.
  If you ever drop and recreate the instance without this flag, migration
  `0000_init.sql`'s `CREATE EXTENSION vector` will fail.
- **GCS S3-Interop ≠ native GCS.** The runtime accesses GCS through the
  S3-compatible API with HMAC keys, not the native GCS API. The
  `roles/storage.objectUser` binding still applies because the HMAC keys
  authenticate AS the runtime SA. Rotate HMAC keys via
  `gcloud storage hmac create/delete` (new keys → update Doppler →
  `sync-secrets.sh` → redeploy).
- **`minScale: 1` means one instance is billed 24/7.** ~7-8 EUR/month
  baseline for the Cloud Run instance plus Cloud SQL. Set to 0 for true
  scale-to-zero, but expect 1.5-3s cold-start latency.
- **Pool sizing.** `DATABASE_POOL_MAX × maxScale = 10 × 10 = 100`,
  matching the db-custom-1-3840 connection limit. Bump SQL tier before
  raising `maxScale`.
- **Ingress = `all` by default.** The OAuth callback needs to be
  reachable by the user's browser, so the manifest uses the public
  *.run.app endpoint. Switch to `internal-and-cloud-load-balancing` only
  after fronting with an external HTTPS LB.
