#!/usr/bin/env bash
# Fly.io first-deploy script for mcp-knowledge2.
#
# Prereqs:
#   • flyctl installed and `fly auth login` done
#   • doppler CLI installed and `doppler setup --project mcp-knowledge2 --config prd_fly`
#     done. All sensitive values are pulled from Doppler; nothing is
#     prompted from the shell. See deploy/fly/README.md for the canonical
#     list of secrets you must have populated in Doppler before running
#     this script.
#   • jq installed (the secrets-sync step needs it)
#
# Re-runs are safe — `fly apps create` is the only step that errors on
# repeat; the others are idempotent or guarded.

set -euo pipefail

APP_NAME="${APP_NAME:-mcp-knowledge2}"
PG_NAME="${PG_NAME:-mcp-knowledge2-pg}"
REGION="${REGION:-fra}"
DOPPLER_PROJECT="${DOPPLER_PROJECT:-mcp-knowledge2}"
DOPPLER_CONFIG="${DOPPLER_CONFIG:-prd_fly}"

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }

command -v fly     >/dev/null 2>&1 || die "flyctl not on PATH — install from https://fly.io/docs/flyctl/install/"
command -v doppler >/dev/null 2>&1 || die "doppler CLI not installed — https://docs.doppler.com/docs/cli"
command -v jq      >/dev/null 2>&1 || die "jq not installed"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

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

step "Postgres: enable pgvector + pg_trgm (idempotent)"
cat <<'SQL' | fly postgres connect -a "$PG_NAME"
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
SQL

step "Postgres: create knowledge_admin role (BYPASSRLS) for /v1/internal/erase-user"
warn "Manual step — run this SQL inside the next \`fly postgres connect\` shell:"
cat <<'SQL'
  -- The DATABASE_ADMIN_URL secret in Doppler must use this password.
  -- Generate via: openssl rand -hex 24
  CREATE ROLE knowledge_admin LOGIN PASSWORD '<paste-from-doppler-DATABASE_ADMIN_URL>' BYPASSRLS;
  GRANT ALL ON DATABASE knowledge TO knowledge_admin;
  GRANT ALL ON ALL TABLES    IN SCHEMA public TO knowledge_admin;
  GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO knowledge_admin;
SQL
read -rp "Press <enter> once knowledge_admin exists, or Ctrl-C to abort: " _

# ─── 3. Sync secrets from Doppler ─────────────────────────────────────
step "Sync secrets from Doppler (project=$DOPPLER_PROJECT, config=$DOPPLER_CONFIG)"
DOPPLER_PROJECT="$DOPPLER_PROJECT" DOPPLER_CONFIG="$DOPPLER_CONFIG" APP_NAME="$APP_NAME" \
  bash "$ROOT/deploy/fly/sync-secrets.sh"

# ─── 4. Deploy ────────────────────────────────────────────────────────
step "Deploy: fly deploy (remote builder)"
cd "$ROOT"
fly deploy --config fly.toml --remote-only \
  --build-arg "BUILD_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo dev)"

# ─── 5. Post-deploy verify ────────────────────────────────────────────
step "Verify: health + version"
APP_URL="https://${APP_NAME}.fly.dev"
curl -sf -m 10 "${APP_URL}/health"  && echo
curl -sf -m 10 "${APP_URL}/version" && echo || warn "/version returned non-2xx — OK on first deploy"

step "Verify: readiness (DB + blob)"
curl -s "${APP_URL}/health/ready" | jq . || warn "readiness check failed — see logs"

step "Done — release deployed. Tail logs with: fly logs -a $APP_NAME"
