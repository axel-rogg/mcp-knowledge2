# Runbook — Deploy on Hetzner VPS

## Goal

Get a single Hetzner CX22 (€6/month) running mcp-knowledge2 with TLS via
Caddy, Postgres + pgvector, and either MinIO (self-hosted blob) or an
external S3-compatible provider (Backblaze B2, Cloudflare R2).

## Prerequisites

- Hetzner Cloud account, project with API token
- DNS A record pointing `knowledge.firma.invalid` to your VPS public IP
- A pre-built image at `ghcr.io/axel-rogg/mcp-knowledge2:<tag>` (CI builds
  on every push to `main`)
- mcp-approval2 already deployed with a public JWKS endpoint (pre-AS-3 path) —
  oder KC2 autonom mit eigener OAuth-Facade (AS-3-Code-Complete-Pfad)
- Embedding-Provider gewählt: **`EMBED_PROVIDER=cloudflare`** (Default,
  Workers AI + AI Gateway — keine GCP-Creds nötig) ODER `vertex` (Legacy-
  Fallback — dann `vertex-sa.json` lokal vorbereiten)
- All secret values generated:
  - `DB_ROOT_PASSWORD`, `DB_APP_PASSWORD`, `DB_ADMIN_PASSWORD`
  - `SERVICE_TOKEN` (32 random bytes hex)
  - `MCP_APPROVAL_INTERNAL_TOKEN` (matches mcp-approval2)
  - `BACKUP_MASTER_KEY` (base64 of 32 random bytes)

## Steps

1. **Provision the VPS** (CX22 ≈ 2 vCPU, 4 GB RAM, 40 GB SSD, Ubuntu 24.04).
2. **Install Docker** and ensure your user is in the `docker` group.
3. **Copy the repo** (only the `deployments/` directory is strictly
   needed plus a `.env`):
   ```bash
   ssh root@<vps>
   mkdir -p /opt/mcp-knowledge2/secrets
   cd /opt/mcp-knowledge2
   git clone --depth=1 https://github.com/axel-rogg/mcp-knowledge2.git .
   ```
4. **Optional — only if `EMBED_PROVIDER=vertex`** — place the Vertex
   service-account JSON. For the default `cloudflare` provider this step
   is skipped (token comes from Doppler, no file needed):
   ```bash
   scp vertex-sa.json root@<vps>:/opt/mcp-knowledge2/secrets/vertex-sa.json
   chmod 600 secrets/vertex-sa.json
   ```
5. **Create `.env`** next to `deployments/docker-compose.yml`:
   ```bash
   cat > .env <<EOF
   IMAGE_TAG=latest
   DB_ROOT_PASSWORD=...
   DB_APP_PASSWORD=...
   DB_ADMIN_PASSWORD=...
   SERVICE_TOKEN=...
   MCP_APPROVAL_BASE_URL=https://approval.firma.invalid
   MCP_APPROVAL_INTERNAL_TOKEN=...
   BACKUP_MASTER_KEY=...
   BACKUP_BUCKET=knowledge-backup
   JWKS_URL=https://approval.firma.invalid/.well-known/jwks.json
   JWT_ISSUER=mcp-approval2
   JWT_AUDIENCE=mcp-knowledge2
   BLOB_ENDPOINT=https://s3.eu-central-003.backblazeb2.com
   BLOB_REGION=eu-central-003
   BLOB_ACCESS_KEY=...
   BLOB_SECRET_KEY=...
   BLOB_BUCKET=knowledge
   BLOB_PATH_STYLE=true
   VERTEX_PROJECT=...
   VERTEX_LOCATION=europe-west4
   VERTEX_MODEL=text-embedding-005
   DOMAIN=knowledge.firma.invalid
   ACME_EMAIL=ops@firma.invalid
   APPROVAL2_IP_ALLOWLIST=...   # comma-separated, mcp-approval2 egress IPs
   EOF
   chmod 600 .env
   ```
6. **Apply migrations** before first start:
   ```bash
   docker compose -f deployments/docker-compose.yml --env-file .env run --rm app npm run db:migrate
   ```
7. **Bring up the stack**:
   ```bash
   docker compose -f deployments/docker-compose.yml --env-file .env up -d
   ```
8. **Verify**:
   ```bash
   curl -sf https://knowledge.firma.invalid/health
   curl -sf https://knowledge.firma.invalid/version
   ```

## Backup retrieval

Backups live in your blob bucket under `backup/<ts>.dump.enc`. To
download and decrypt:

```bash
# 1. Download
aws s3 cp s3://knowledge-backup/backup/2026-05-13T03-00-00.dump.enc ./backup.enc

# 2. Decrypt — script TBD; for now use a node one-liner with BACKUP_MASTER_KEY
# (see src/lib/crypto/serialize.ts + aes_gcm.ts)

# 3. Restore
pg_restore --dbname=knowledge --clean --no-owner backup.dump
```

## Updates

```bash
cd /opt/mcp-knowledge2
git pull
docker compose -f deployments/docker-compose.yml --env-file .env pull app
docker compose -f deployments/docker-compose.yml --env-file .env run --rm app npm run db:migrate
docker compose -f deployments/docker-compose.yml --env-file .env up -d --no-deps app
```

## Troubleshooting

- **App doesn't start** → `docker compose logs app` — look for env
  validation errors (Zod prints the offending key and reason).
- **`/health/ready` returns 503** → check the `checks` field; it lists
  which dependency is down (db, blob).
- **Embedding calls fail** (default Cloudflare provider) → verify
  `CLOUDFLARE_API_TOKEN` Permissions im CF Dashboard (Workers AI Read +
  AI Gateway Run), und `CLOUDFLARE_AI_GATEWAY_ID` matched einen existing
  Gateway. Probe via `curl https://api.cloudflare.com/client/v4/accounts/<acc>/ai/run/@cf/baai/bge-m3 -d '{"text":["test"]}'`.
- **Vertex calls fail** (`EMBED_PROVIDER=vertex`) → check the service-account JSON is mounted
  (`docker compose exec app ls /etc/secrets/`) and Vertex API is
  enabled in the GCP project.
- **JWKS unreachable** → mcp-approval2 must expose
  `/.well-known/jwks.json` publicly; check from the VPS:
  `curl -sf $JWKS_URL`.
