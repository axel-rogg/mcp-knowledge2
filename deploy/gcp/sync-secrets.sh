#!/usr/bin/env bash
# Sync secrets from Doppler → Google Secret Manager for mcp-knowledge2.
#
# Doppler is the single source of truth. Cloud Run reads secrets via
# `secretKeyRef` from Secret Manager. This script bridges the two.
#
# Re-runs are safe: existing secrets get a new version, the Cloud Run
# service.yaml always references :latest.
#
# Doppler scope:
#   doppler setup --project mcp-knowledge2 --config prd_gcp

set -euo pipefail

PROJECT="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
DOPPLER_PROJECT="${DOPPLER_PROJECT:-mcp-knowledge2}"
DOPPLER_CONFIG="${DOPPLER_CONFIG:-prd_gcp}"
RUNTIME_SA="${RUNTIME_SA:-knowledge-runtime}"

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }

command -v doppler >/dev/null 2>&1 || die "doppler CLI not installed"
command -v gcloud  >/dev/null 2>&1 || die "gcloud CLI not installed"
command -v jq      >/dev/null 2>&1 || die "jq not installed"
[ -n "$PROJECT" ] || die "GCP_PROJECT not set and no gcloud default project"

RUNTIME_EMAIL="${RUNTIME_SA}@${PROJECT}.iam.gserviceaccount.com"

# Doppler keys → Secret Manager secret names. Only secrets referenced by
# `secretKeyRef` in deployments/cloud-run/*.yaml are mapped here. Anything
# else (plaintext config like EMBED_PROVIDER) is set directly in service.yaml.
#
# Keep this map in sync with deployments/cloud-run/service.yaml + migrate-job.yaml.
declare -A SECRET_MAP=(
  [DATABASE_URL]=knowledge-database-url
  [DATABASE_ADMIN_URL]=knowledge-database-admin-url
  [SERVICE_TOKEN]=knowledge-service-token
  [KMS_MASTER_KEY_B64]=knowledge-kms-master-key
  [BACKUP_MASTER_KEY]=knowledge-backup-master
  [GOOGLE_OAUTH_CLIENT_ID]=knowledge-google-oauth-client-id
  [GOOGLE_OAUTH_CLIENT_SECRET]=knowledge-google-oauth-client-secret
  [BLOB_ACCESS_KEY]=knowledge-blob-access-key
  [BLOB_SECRET_KEY]=knowledge-blob-secret-key
  # Cloudflare AI — used only when EMBED_PROVIDER=cloudflare
  [CLOUDFLARE_ACCOUNT_ID]=knowledge-cf-account-id
  [CLOUDFLARE_API_TOKEN]=knowledge-cf-api-token
  # Optional
  [MCP_APPROVAL_JWKS_URL]=knowledge-approval-jwks-url
  [GOOGLE_HD_ALLOWLIST]=knowledge-google-hd-allowlist
  [ALLOWED_EMAILS]=knowledge-allowed-emails
)

step "Doppler scope: project=$DOPPLER_PROJECT config=$DOPPLER_CONFIG"
doppler configure get project config --plain \
  --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" >/dev/null \
  || die "Doppler scope not accessible — run 'doppler setup' first"

step "Fetch secrets from Doppler"
SECRETS_JSON="$(doppler secrets download \
  --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" \
  --no-file --format=json)"

UPSERTED=0
SKIPPED=()
for key in "${!SECRET_MAP[@]}"; do
  sm_name="${SECRET_MAP[$key]}"
  value="$(echo "$SECRETS_JSON" | jq -r --arg k "$key" '.[$k].computed // empty')"
  if [ -z "$value" ] || [ "$value" = "null" ]; then
    SKIPPED+=("$key")
    continue
  fi

  # Create the secret if missing.
  if ! gcloud secrets describe "$sm_name" --project "$PROJECT" >/dev/null 2>&1; then
    printf '  · creating %s\n' "$sm_name"
    gcloud secrets create "$sm_name" \
      --project "$PROJECT" \
      --replication-policy=automatic >/dev/null
    # Grant the runtime SA accessor permission (idempotent).
    gcloud secrets add-iam-policy-binding "$sm_name" \
      --project "$PROJECT" \
      --member="serviceAccount:${RUNTIME_EMAIL}" \
      --role="roles/secretmanager.secretAccessor" \
      --condition=None \
      --quiet >/dev/null
  fi

  # Compare latest version with new value; skip if unchanged.
  CURRENT="$(gcloud secrets versions access latest --secret="$sm_name" \
    --project "$PROJECT" 2>/dev/null || true)"
  if [ "$CURRENT" = "$value" ]; then
    printf '  · %s unchanged\n' "$sm_name"
    continue
  fi

  printf '  · pushing new version → %s\n' "$sm_name"
  printf '%s' "$value" \
    | gcloud secrets versions add "$sm_name" --project "$PROJECT" --data-file=- >/dev/null
  UPSERTED=$((UPSERTED + 1))
done

if [ ${#SKIPPED[@]} -gt 0 ]; then
  warn "Doppler keys not present (skipped): ${SKIPPED[*]}"
fi
step "Done — $UPSERTED secrets upserted in project $PROJECT"
