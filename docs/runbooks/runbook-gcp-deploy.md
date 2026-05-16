# Runbook — Deploy `mcp-knowledge2` to Google Cloud Run

Operational runbook for the Cloud Run deploy target. Covers fresh
bootstrap, day-2 operations, secret rotation, rollback, and disaster
recovery. Counterpart to [runbook-fly-deploy.md](runbook-fly-deploy.md);
the deploy-orchestration source lives in [deploy/gcp/](../../deploy/gcp/).

## At a glance

| Aspect | Value |
|---|---|
| Compute | Cloud Run gen2, region `europe-west4` |
| Database | Cloud SQL Postgres 16, `cloudsql.enable_pgvector_extension=on`, CMEK-encrypted |
| Blob storage | GCS Bucket EU-multi-region — **native SDK** (`BLOB_PROVIDER=gcs`) via Workload Identity Federation, no HMAC keys |
| Embeddings | Vertex AI (`text-multilingual-embedding-002`, 768-dim) via ADC — Workload Identity, no SA-JSON |
| KMS | Cloud KMS (`KMS_PROVIDER=cloud_kms`) — master key wrapped under `projects/.../cryptoKeys/master`, decrypted once at boot, then HKDF-derived per user |
| Terraform | `mcp-approval2/terraform/environments/business/` (versions.tf + backend.tf + variables.tf + main.tf) provisions all GCP-resources + Doppler-Project |
| Secrets | Doppler (project `mcp-knowledge2-business`, config `prd`) — DB-URL/blob/KMS/embed-vars auto-piped from TF outputs |
| Authn | KC2 OAuth-facade (issues its own JWTs to MCP clients after Google OIDC login) |
| Ingress | Public `*.run.app` (or custom-domain mapping) — required for OAuth callback |

## Bootstrap (one-time)

1. **Prerequisites**

   - `gcloud` authenticated as owner/editor on the target project
   - Billing enabled on the project
   - `doppler login` done; `doppler setup --project mcp-knowledge2 --config prd_gcp`
   - GitHub repo has `gh` CLI configured

2. **Run bootstrap script**

   ```bash
   GCP_PROJECT=<project> REGION=europe-west4 bash deploy/gcp/01-bootstrap.sh
   ```

   This is idempotent — re-runs skip resources that already exist.
   Output ends with the three GitHub repo secrets to register
   (`GCP_PROJECT`, `GCP_DEPLOY_SA`, `GCP_WIF_PROVIDER`) and the SQL
   statements to run inside Cloud SQL.

3. **Create Postgres roles + extensions**

   ```bash
   gcloud sql users set-password postgres --instance=knowledge --password=$(openssl rand -hex 24)
   gcloud sql connect knowledge --user=postgres
   ```

   Then paste the SQL the bootstrap script printed (creates
   `knowledge_app`, `knowledge_admin`, extensions, default privileges).
   The two passwords must match what you put into Doppler under
   `DATABASE_URL` and `DATABASE_ADMIN_URL`.

4. **Capture HMAC keys**

   The bootstrap script prints `accessId` + `secret` once. Store as
   `BLOB_ACCESS_KEY` and `BLOB_SECRET_KEY` in Doppler immediately —
   GCS does not let you retrieve a key's secret value after creation.

5. **Populate Doppler `prd_gcp`** — see
   [deploy/gcp/README.md](../../deploy/gcp/README.md) for the full key
   list. All values are minted locally (`openssl rand …`) or come from
   GCP Console (OAuth client) / bootstrap output (HMAC).

6. **Sync to Secret Manager**

   ```bash
   GCP_PROJECT=<project> bash deploy/gcp/sync-secrets.sh
   ```

   Creates any missing GSM secrets (with `replication-policy=automatic`),
   grants the runtime SA accessor permission, and writes a new version
   only when the Doppler value has changed.

7. **First deploy**

   ```bash
   gh workflow run deploy.yml \
     -f sql_instance_connection=<project>:europe-west4:knowledge \
     -f domain=<public-hostname> \
     -f region=europe-west4
   ```

   The workflow builds + pushes the image, runs the migrate Job, then
   replaces the Cloud Run service. If you don't have a custom domain
   mapped yet, use the `*.run.app` URL gcloud prints after the first
   deploy (and update the Google OAuth client's redirect-URI list).

## Verifying

```bash
URL=$(gcloud run services describe mcp-knowledge2 --region=europe-west4 --format='value(status.url)')

# Liveness — always 200
curl -sf "$URL/health"
# Readiness — DB + blob check
curl -s "$URL/health/ready" | jq
# Metrics endpoint (Prometheus)
curl -s "$URL/metrics" | head -20
# OAuth-facade discovery
curl -s "$URL/.well-known/oauth-authorization-server" | jq
```

## Day-2 operations

### Code-only deploy

`gh workflow run deploy.yml -f sql_instance_connection=… -f domain=… -f region=europe-west4`

The workflow always runs the migrate Job first; if there are no new
migration files in `drizzle/migrations/`, the Job is a no-op
(`_migrations` table dedup).

### Secret rotation

Rotate in Doppler. Then:

```bash
GCP_PROJECT=<project> bash deploy/gcp/sync-secrets.sh
# `latest` reference auto-updates; pin a new revision to pick it up:
gh workflow run deploy.yml -f sql_instance_connection=… -f domain=… -f region=europe-west4
```

If you need the change to land without a code rebuild, force a new
revision via `gcloud run services update mcp-knowledge2
--region=europe-west4 --update-env-vars=NOOP=$(date +%s)`.

### Migration without redeploy

```bash
gcloud run jobs execute migrate-knowledge2 --region=europe-west4 --wait
```

### Rollback

```bash
gcloud run revisions list --service=mcp-knowledge2 --region=europe-west4
gcloud run services update-traffic mcp-knowledge2 \
  --region=europe-west4 \
  --to-revisions=<previous-revision>=100
```

If you also need to roll back a migration: hot-fix forward instead of
rolling back. Revertible migrations aren't in scope.

### Scaling

- Vertical: `gcloud run services update mcp-knowledge2 --region=europe-west4
  --cpu=2 --memory=1Gi`
- Horizontal: edit `autoscaling.knative.dev/maxScale` in
  `deployments/cloud-run/service.yaml`. Remember to bump the Cloud SQL
  tier first — `maxScale × DATABASE_POOL_MAX` must stay within the
  instance's `max_connections`.

### Custom domain

```bash
gcloud run domain-mappings create \
  --service=mcp-knowledge2 \
  --domain=knowledge.example.com \
  --region=europe-west4
```

After DNS validation:

1. Update Doppler / GSM if `SELF_OAUTH_ISSUER` needs the new host (it's
   set from the workflow input, so re-trigger `deploy.yml` with the new
   `domain` input).
2. Add the new redirect URI to the Google OAuth client in Cloud Console.

## Disaster recovery

### Postgres restore

Cloud SQL keeps daily backups + PITR for 7 days (set during bootstrap).
Procedure:

```bash
gcloud sql backups list --instance=knowledge
gcloud sql backups restore <BACKUP_ID> --restore-instance=knowledge
```

For the application-level encrypted backups in `gs://knowledge-backup-eu/backup/`:
those are the source of truth older than the 7-day PITR window. Restore
script is application-side — decrypt with `BACKUP_MASTER_KEY` then
`pg_restore --no-owner` into the target instance.

### Service down + can't redeploy

1. Check Cloud SQL: `gcloud sql instances describe knowledge`
2. Check the runtime SA bindings (`gcloud projects get-iam-policy <project>
   | grep knowledge-runtime`) — most outages after a project-wide IAM
   change are missing roles.
3. Check Secret Manager versions: `gcloud secrets versions list
   knowledge-database-url` — if rotation deleted older versions and the
   current one is broken, restore by adding the old value as a new
   version.
4. Failover plan: re-deploy to Fly via `bash deploy/fly/deploy.sh` —
   different region, same Doppler keys (different config `prd_fly`),
   different DB but the application is stateless on top of Postgres.

## Costs (rough)

| Item | Monthly |
|---|---|
| Cloud Run minScale=1 (cpu=1, mem=512Mi, gen2) | ~7-8 EUR |
| Cloud SQL db-custom-1-3840, 10 GB SSD, ZONAL | ~50 EUR |
| GCS two buckets, light traffic | <1 EUR |
| Secret Manager versions | <1 EUR |
| Vertex AI embeddings | usage-based (~0.0001 EUR per request) |
| **Total baseline** | **~60 EUR/month** |

Compare to Fly baseline of ~10-15 EUR/month — GCP costs more, mostly
because of Cloud SQL. Use Fly for the pilot, switch to GCP when there
are compliance reasons (CMEK, VPC-SC, etc.) to justify the price.

## Related

- [deploy/gcp/](../../deploy/gcp/) — bootstrap + sync-secrets scripts
- [deployments/cloud-run/](../../deployments/cloud-run/) — Knative manifests
- [.github/workflows/deploy.yml](../../.github/workflows/deploy.yml) — CI/CD
- [runbook-fly-deploy.md](runbook-fly-deploy.md) — sister runbook for Fly.io
