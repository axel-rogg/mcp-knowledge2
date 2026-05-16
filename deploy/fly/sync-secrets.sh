#!/usr/bin/env bash
# Sync secrets from Doppler → Fly.io for mcp-knowledge2.
#
# Single source of truth for credentials is Doppler:
#   doppler login
#   doppler setup --project mcp-knowledge2 --config fly
#
# This script reads every key from the configured Doppler config and
# pushes it to `fly secrets set` in one staged batch. Staging means Fly
# stores the new values WITHOUT triggering a redeploy — the next
# `fly deploy` picks them up.
#
# Re-runs are safe: Fly diffs against the existing secret-set and only
# rewrites changed values.

set -euo pipefail

APP_NAME="${APP_NAME:-mcp-knowledge2}"
DOPPLER_PROJECT="${DOPPLER_PROJECT:-mcp-knowledge2}"
# Default `fly` — deploy-target-named Doppler-config (clear matching for
# the Fly.io compute-target). Override via `DOPPLER_CONFIG=…` if you
# maintain a customer-specific config (e.g. `fly_pilot1`).
DOPPLER_CONFIG="${DOPPLER_CONFIG:-fly}"

# Keys that fly.toml [env] sets directly — never push them as secrets,
# Fly's "secret beats env" rule would silently shadow the TOML defaults.
# Keep this list in sync with the keys you set under [env] in fly.toml.
FLY_ENV_KEYS=(
  PORT NODE_ENV LOG_LEVEL
  SELF_OAUTH_ISSUER GOOGLE_OAUTH_REDIRECT_URI
  JWKS_CACHE_TTL_SECONDS
  EMBED_PROVIDER CLOUDFLARE_AI_GATEWAY_ID CLOUDFLARE_AI_MODEL
  KMS_PROVIDER BLOB_PATH_STYLE
  DATABASE_POOL_MAX BACKUP_RETENTION_DAYS
)

# Keys that Fly manages itself — DON'T push from Doppler:
#   DATABASE_URL → set by `fly postgres attach`
FLY_MANAGED_KEYS=( DATABASE_URL )

die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }

command -v doppler >/dev/null 2>&1 || die "doppler CLI not installed — https://docs.doppler.com/docs/cli"
command -v fly     >/dev/null 2>&1 || die "fly CLI not installed — https://fly.io/docs/flyctl/install/"
command -v jq      >/dev/null 2>&1 || die "jq not installed"

step "Verify Doppler scope: project=$DOPPLER_PROJECT config=$DOPPLER_CONFIG"
doppler configure get project config --plain \
  --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" >/dev/null \
  || die "Doppler project/config not accessible — run 'doppler setup' first"

step "Verify Fly app exists: $APP_NAME"
fly apps list 2>/dev/null | awk '{print $1}' | grep -qx "$APP_NAME" \
  || die "Fly app '$APP_NAME' not found — run 'bash deploy/fly/deploy.sh' first"

step "Fetch secrets from Doppler"
# Doppler emits JSON: { "KEY": { "computed": "..." }, ... }
SECRETS_JSON="$(doppler secrets download \
  --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" \
  --no-file --format=json)"

# Build the `fly secrets set` argument list, skipping anything in
# FLY_ENV_KEYS or FLY_MANAGED_KEYS.
declare -a SECRET_ARGS=()
SKIPPED_ENV=()
SKIPPED_MANAGED=()
COUNT=0
while IFS=$'\t' read -r key value; do
  # Skip Doppler metadata keys (start with DOPPLER_)
  case "$key" in DOPPLER_*) continue ;; esac

  # Skip empty values — Fly would error
  [ -z "$value" ] && continue

  if printf '%s\n' "${FLY_ENV_KEYS[@]}" | grep -qx "$key"; then
    SKIPPED_ENV+=("$key")
    continue
  fi
  if printf '%s\n' "${FLY_MANAGED_KEYS[@]}" | grep -qx "$key"; then
    SKIPPED_MANAGED+=("$key")
    continue
  fi

  SECRET_ARGS+=( "${key}=${value}" )
  COUNT=$((COUNT + 1))
done < <(echo "$SECRETS_JSON" | jq -r 'to_entries | .[] | "\(.key)\t\(.value.computed)"')

if [ ${#SKIPPED_ENV[@]} -gt 0 ]; then
  printf '  · skipped (set via fly.toml [env]): %s\n' "${SKIPPED_ENV[*]}"
fi
if [ ${#SKIPPED_MANAGED[@]} -gt 0 ]; then
  printf '  · skipped (fly-managed): %s\n' "${SKIPPED_MANAGED[*]}"
fi

[ "$COUNT" -eq 0 ] && die "no secrets to push — Doppler config is empty?"

step "Push $COUNT secrets to Fly app '$APP_NAME' (staged — no redeploy)"
fly secrets set --app "$APP_NAME" --stage "${SECRET_ARGS[@]}"

step "Done. Run 'fly deploy' to roll out a release that picks them up."
