#!/usr/bin/env bash
# Fly.io first-deploy script for mcp-knowledge2.
#
# Prereqs:
#   • flyctl installed and `fly auth login` done
#   • Organization picked (`fly orgs list`)
#   • mcp-approval2 already deployed at https://mcp-approval2.fly.dev
#     (or update fly.toml's MCP_APPROVAL_BASE_URL + JWKS_URL accordingly)
#   • Vertex AI service-account JSON available locally as ./vertex-sa.json
#   • Knowledge of the matching MCP_APPROVAL_INTERNAL_TOKEN set on
#     mcp-approval2 (must be identical on both sides for DEK resolve)
#
# Re-runs are safe — `fly apps create` is the only step that errors on
# repeat; the others are idempotent or guarded.

set -euo pipefail

APP_NAME="mcp-knowledge2"
PG_NAME="mcp-knowledge2-pg"
REGION="fra"
BLOB_BUCKET_NAME="${BLOB_BUCKET_NAME:-knowledge-eu}"
BACKUP_BUCKET_NAME="${BACKUP_BUCKET_NAME:-knowledge-backup-eu}"

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }

command -v fly >/dev/null 2>&1 || die "flyctl not on PATH — install from https://fly.io/docs/flyctl/install/"

# ─── 1. App ───────────────────────────────────────────────────────────
step "App: create '$APP_NAME' in org (if missing)"
if fly apps list 2>/dev/null | awk '{print $1}' | grep -qx "$APP_NAME"; then
  warn "app '$APP_NAME' already exists — skipping create"
else
  fly apps create "$APP_NAME" --org personal
fi

# ─── 2. Postgres cluster + pgvector ───────────────────────────────────
step "Postgres: provision cluster '$PG_NAME' (region=$REGION)"
if fly apps list 2>/dev/null | awk '{print $1}' | grep -qx "$PG_NAME"; then
  warn "postgres app '$PG_NAME' already exists — skipping create"
else
  fly postgres create \
    --name "$PG_NAME" \
    --region "$REGION" \
    --vm-size shared-cpu-1x \
    --volume-size 3 \
    --initial-cluster-size 1
fi

step "Postgres: attach to '$APP_NAME' (sets DATABASE_URL secret on the app)"
if fly secrets list -a "$APP_NAME" 2>/dev/null | grep -q '^DATABASE_URL'; then
  warn "DATABASE_URL already attached — skipping"
else
  fly postgres attach "$PG_NAME" --app "$APP_NAME"
fi

step "Postgres: enable pgvector extension"
cat <<'SQL' | fly postgres connect -a "$PG_NAME"
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
SQL

step "Postgres: create separate admin role (BYPASSRLS, for /v1/internal/erase-user)"
warn "Manual step recommended — fly postgres connect -a $PG_NAME and run:"
cat <<'SQL'
  -- Replace <strong-random-pw>; generate via: openssl rand -hex 24
  CREATE ROLE knowledge_admin LOGIN PASSWORD '<strong-random-pw>' BYPASSRLS;
  GRANT ALL ON DATABASE knowledge TO knowledge_admin;
  -- After app's first migration grants schema privileges to knowledge_app,
  -- also grant to knowledge_admin so it can SELECT/DELETE across users:
  GRANT ALL ON ALL TABLES    IN SCHEMA public TO knowledge_admin;
  GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO knowledge_admin;
SQL

# ─── 3. Secrets ───────────────────────────────────────────────────────
step "Secrets: set production secrets on '$APP_NAME'"
cat <<EOF
Please set the following secrets manually (values not echoed to the
shell/transcript). Use:

  fly secrets set --app $APP_NAME KEY=VALUE [KEY=VALUE ...]

Required secrets:
  ▸ SERVICE_TOKEN
      Random 32-byte hex; gates /v1/internal/*.
      Generate: openssl rand -hex 32

  ▸ MCP_APPROVAL_INTERNAL_TOKEN
      MUST match the value on mcp-approval2 — used by mcp-knowledge2 to
      call mcp-approval2's KMS internal API for DEK resolve.

  ▸ DATABASE_ADMIN_URL
      Connection string with the BYPASSRLS role created above. Format:
      postgres://knowledge_admin:<pw>@<pg-internal-host>.flycast:5432/knowledge
      Find the host with: fly postgres list ; then connect details in
      \`fly secrets list -a $APP_NAME\` (the regular DATABASE_URL has it).

  ▸ VERTEX_PROJECT
      GCP project id for Vertex AI.

  ▸ VERTEX_SERVICE_ACCOUNT_JSON
      Inline the service-account JSON contents (one-liner):
        fly secrets set --app $APP_NAME \\
          VERTEX_SERVICE_ACCOUNT_JSON="\$(cat vertex-sa.json | tr -d '\\n')"
      The app reads VERTEX_SERVICE_ACCOUNT_JSON if set, else falls back to
      VERTEX_SERVICE_ACCOUNT_JSON_PATH.

  ▸ BACKUP_MASTER_KEY
      base64(32 random bytes); independent of any DEK.
      Generate: openssl rand -base64 32

  ▸ BLOB_ENDPOINT / BLOB_REGION / BLOB_ACCESS_KEY / BLOB_SECRET_KEY /
    BLOB_BUCKET / BLOB_PATH_STYLE
      Pick a provider: Cloudflare R2, Backblaze B2, Tigris (Fly's native
      S3, https://fly.io/docs/reference/tigris/), or GCS. Tigris is the
      lowest-latency option since it runs inside the Fly network.

  ▸ BACKUP_BUCKET
      Separate bucket from BLOB_BUCKET (different lifecycle / retention).

EOF
read -p "Press <enter> once secrets are set, or Ctrl-C to abort: " _

# ─── 4. Deploy ────────────────────────────────────────────────────────
step "Deploy: fly deploy"
cd "$(git rev-parse --show-toplevel)"
fly deploy --config fly.toml --remote-only

# ─── 5. Post-deploy verify ────────────────────────────────────────────
step "Verify: health + version"
APP_URL="https://${APP_NAME}.fly.dev"
curl -sf -m 10 "${APP_URL}/health"  && echo
curl -sf -m 10 "${APP_URL}/version" && echo || warn "/version not yet implemented — OK"

step "Verify: JWKS reachable from inside the app"
fly ssh console -a "$APP_NAME" -C "node -e 'fetch(process.env.JWKS_URL).then(r=>console.log(r.status))'" || \
  warn "JWKS check failed — confirm mcp-approval2 is up and JWKS_URL is correct"

step "Done — release deployed. Tail logs with: fly logs -a $APP_NAME"
