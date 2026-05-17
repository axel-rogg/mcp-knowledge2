#!/usr/bin/env bash
# Fly.io first-deploy script for mcp-knowledge2.
#
# Prereqs:
#   • flyctl installed and `fly auth login` done
#   • doppler CLI installed and `doppler setup --project mcp-knowledge2 --config fly`
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
# PG is Neon now (TF-managed in mcp-approval2/terraform/environments/privat/
# neon-knowledge2.tf). Region var kept for the Fly app only.
REGION="${REGION:-fra}"
DOPPLER_PROJECT="${DOPPLER_PROJECT:-mcp-knowledge2}"
# Default `fly` — deploy-target-named Doppler-config (clear matching for
# the Fly.io compute-target). Older setups used `privat`; that config
# still exists as backup. Override via `DOPPLER_CONFIG=…` if you maintain
# a customer-specific config (e.g. `fly_pilot1`).
DOPPLER_CONFIG="${DOPPLER_CONFIG:-fly}"

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }

command -v fly     >/dev/null 2>&1 || die "flyctl not on PATH — install from https://fly.io/docs/flyctl/install/"
command -v doppler >/dev/null 2>&1 || die "doppler CLI not installed — https://docs.doppler.com/docs/cli"
command -v jq      >/dev/null 2>&1 || die "jq not installed"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# ─── 1. App ───────────────────────────────────────────────────────────
# Alternativ kann die App-Existenz via Terraform gemanagt werden — siehe
# docs/plans/active/PLAN-fly-terraform.md + mcp-approval2/terraform/
# environments/privat/knowledge2-fly.tf. In dem Fall hat `terraform apply`
# die App bereits angelegt; der Check unten skippt dann sauber.
step "App: create '$APP_NAME' in org (if missing)"
if fly apps list 2>/dev/null | awk '{print $1}' | grep -qx "$APP_NAME"; then
  warn "app '$APP_NAME' already exists — skipping create (TF-managed or prior flyctl run)"
else
  fly apps create "$APP_NAME" --org personal
fi

# ─── 2. Postgres ──────────────────────────────────────────────────────
# Postgres is Neon now — see TF in
# mcp-approval2/terraform/environments/privat/neon-knowledge2.tf.
# `terraform apply` provisions the project, roles (knowledge_app + knowledge_admin,
# both in neon_superuser → BYPASSRLS, no extra GRANTs), and pushes
# DATABASE_URL / DATABASE_ADMIN_URL / DB_APP_PASSWORD / DB_ADMIN_PASSWORD
# into Doppler. One-time bootstrap after first apply:
#   psql "$DATABASE_ADMIN_URL" -c 'CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;'
step "Postgres: TF-managed at Neon — verify DATABASE_URL is staged in Doppler"
if doppler secrets get DATABASE_URL --plain --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" >/dev/null 2>&1; then
  warn "DATABASE_URL present in Doppler ($DOPPLER_PROJECT/$DOPPLER_CONFIG)"
else
  die "DATABASE_URL not staged in Doppler — run \`terraform apply\` for neon-knowledge2.tf first"
fi

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
curl -sf -m 10 "${APP_URL}/version" && echo || warn "/version not yet implemented — OK"

step "Verify: readiness (DB + blob)"
curl -s "${APP_URL}/health/ready" | jq . || warn "readiness check failed — see logs"

step "Done — release deployed. Tail logs with: fly logs -a $APP_NAME"
