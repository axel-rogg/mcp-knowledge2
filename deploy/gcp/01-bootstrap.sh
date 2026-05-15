#!/usr/bin/env bash
# Bootstrap GCP resources for mcp-knowledge2 deploy to Cloud Run.
#
# Idempotent — re-runs skip resources that already exist. Order matters:
# every later step depends on the SA + APIs being live.
#
# Prereqs:
#   • gcloud CLI authenticated to an owner/editor account
#   • GCP_PROJECT env var or `gcloud config set project ...` done
#   • Billing enabled on the project
#
# What this creates:
#   1. Enables the required Google APIs
#   2. Artifact Registry repo `containers` in REGION
#   3. Cloud SQL Postgres 16 instance (knowledge) with pgvector flag
#   4. Two GCS buckets (knowledge-eu, knowledge-backup-eu)
#   5. HMAC keys for the runtime SA (GCS S3-Interop) — IMPORTANT: prints
#      ACCESS_KEY + SECRET_KEY to stdout once. Capture and store in Doppler.
#   6. Two service accounts:
#        knowledge-runtime  (used by Cloud Run service + job)
#        knowledge-deploy   (used by GitHub Actions Workload Identity)
#   7. Workload-Identity-Federation pool + provider for the deploy SA
#   8. IAM bindings for both SAs

set -euo pipefail

PROJECT="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-europe-west4}"
SQL_NAME="${SQL_NAME:-knowledge}"
SQL_TIER="${SQL_TIER:-db-custom-1-3840}"
RUNTIME_SA="${RUNTIME_SA:-knowledge-runtime}"
DEPLOY_SA="${DEPLOY_SA:-knowledge-deploy}"
WIF_POOL="${WIF_POOL:-github-actions}"
WIF_PROVIDER="${WIF_PROVIDER:-mcp-knowledge2}"
GH_REPO="${GH_REPO:-axel-rogg/mcp-knowledge2}"  # Workload-Identity attribute filter
BLOB_BUCKET="${BLOB_BUCKET:-knowledge-eu}"
BACKUP_BUCKET="${BACKUP_BUCKET:-knowledge-backup-eu}"

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }

command -v gcloud >/dev/null 2>&1 || die "gcloud CLI not installed"
[ -n "$PROJECT" ] || die "GCP_PROJECT not set and no gcloud default project"

RUNTIME_EMAIL="${RUNTIME_SA}@${PROJECT}.iam.gserviceaccount.com"
DEPLOY_EMAIL="${DEPLOY_SA}@${PROJECT}.iam.gserviceaccount.com"

# ─── 1. Enable APIs ───────────────────────────────────────────────────
step "Enable GCP APIs"
gcloud services enable --project "$PROJECT" \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  aiplatform.googleapis.com \
  iamcredentials.googleapis.com \
  cloudresourcemanager.googleapis.com \
  storage.googleapis.com

# ─── 2. Artifact Registry ─────────────────────────────────────────────
step "Artifact Registry: repo 'containers' in $REGION"
if gcloud artifacts repositories describe containers \
    --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then
  warn "repo 'containers' exists — skipping"
else
  gcloud artifacts repositories create containers \
    --project "$PROJECT" --location "$REGION" \
    --repository-format=docker \
    --description="mcp-knowledge2 + sister-service images"
fi

# ─── 3. Cloud SQL Postgres 16 with pgvector ───────────────────────────
step "Cloud SQL: instance '$SQL_NAME' (region=$REGION, tier=$SQL_TIER)"
if gcloud sql instances describe "$SQL_NAME" --project "$PROJECT" >/dev/null 2>&1; then
  warn "instance '$SQL_NAME' exists — skipping create"
else
  gcloud sql instances create "$SQL_NAME" \
    --project "$PROJECT" \
    --database-version=POSTGRES_16 \
    --region="$REGION" \
    --tier="$SQL_TIER" \
    --storage-type=SSD --storage-size=10GB \
    --availability-type=ZONAL \
    --backup --backup-start-time=02:00 \
    --enable-point-in-time-recovery \
    --database-flags=cloudsql.enable_pgvector_extension=on
fi

step "Cloud SQL: ensure 'knowledge' database exists"
if gcloud sql databases describe knowledge \
    --instance "$SQL_NAME" --project "$PROJECT" >/dev/null 2>&1; then
  warn "database 'knowledge' exists — skipping"
else
  gcloud sql databases create knowledge --instance "$SQL_NAME" --project "$PROJECT"
fi

warn "Cloud SQL roles knowledge_app + knowledge_admin must be created manually."
warn "Connect via Cloud Shell or 'gcloud sql connect' and run:"
cat <<'SQL'
  -- Passwords come from Doppler (will be referenced from DATABASE_URL +
  -- DATABASE_ADMIN_URL secrets). Generate with: openssl rand -hex 24
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS vector;

  CREATE ROLE knowledge_app   LOGIN PASSWORD '<app-password-from-doppler>';
  CREATE ROLE knowledge_admin LOGIN PASSWORD '<admin-password-from-doppler>' BYPASSRLS;

  GRANT CONNECT ON DATABASE knowledge TO knowledge_app, knowledge_admin;
  GRANT USAGE ON SCHEMA public         TO knowledge_app, knowledge_admin;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES   TO knowledge_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT ALL ON ALL TABLES, ALL SEQUENCES           TO knowledge_admin;
SQL

# ─── 4. GCS buckets ───────────────────────────────────────────────────
for bucket in "$BLOB_BUCKET" "$BACKUP_BUCKET"; do
  step "GCS bucket: gs://$bucket"
  if gcloud storage buckets describe "gs://$bucket" --project "$PROJECT" >/dev/null 2>&1; then
    warn "bucket gs://$bucket exists — skipping"
  else
    gcloud storage buckets create "gs://$bucket" \
      --project "$PROJECT" --location "$REGION" \
      --default-storage-class=STANDARD \
      --uniform-bucket-level-access
  fi
done

# ─── 5. Service accounts ──────────────────────────────────────────────
for sa_name in "$RUNTIME_SA" "$DEPLOY_SA"; do
  step "Service account: $sa_name"
  email="${sa_name}@${PROJECT}.iam.gserviceaccount.com"
  if gcloud iam service-accounts describe "$email" --project "$PROJECT" >/dev/null 2>&1; then
    warn "SA $sa_name exists — skipping"
  else
    gcloud iam service-accounts create "$sa_name" --project "$PROJECT" \
      --display-name="mcp-knowledge2 ${sa_name##knowledge-}"
  fi
done

# ─── 6. IAM bindings: runtime SA ──────────────────────────────────────
step "IAM: bind runtime SA roles"
for role in \
  roles/cloudsql.client \
  roles/secretmanager.secretAccessor \
  roles/aiplatform.user \
  roles/storage.objectUser \
; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${RUNTIME_EMAIL}" \
    --role="$role" \
    --condition=None \
    --quiet >/dev/null
done

# ─── 7. IAM bindings: deploy SA ───────────────────────────────────────
step "IAM: bind deploy SA roles"
for role in \
  roles/run.admin \
  roles/artifactregistry.writer \
  roles/iam.serviceAccountUser \
  roles/secretmanager.admin \
; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${DEPLOY_EMAIL}" \
    --role="$role" \
    --condition=None \
    --quiet >/dev/null
done

# Deploy SA must be able to actAs the runtime SA (to deploy the service).
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_EMAIL" \
  --project "$PROJECT" \
  --member="serviceAccount:${DEPLOY_EMAIL}" \
  --role="roles/iam.serviceAccountUser" \
  --quiet >/dev/null

# ─── 8. HMAC keys for GCS S3-Interop ──────────────────────────────────
step "HMAC keys: for runtime SA (BLOB_ACCESS_KEY / BLOB_SECRET_KEY)"
EXISTING_HMAC=$(gcloud storage hmac list --project "$PROJECT" \
  --filter="serviceAccountEmail=${RUNTIME_EMAIL} AND state=ACTIVE" \
  --format="value(accessId)" 2>/dev/null || true)
if [ -n "$EXISTING_HMAC" ]; then
  warn "active HMAC key already exists for $RUNTIME_EMAIL (accessId=$EXISTING_HMAC)"
  warn "If you don't have the secret, deactivate + delete it and re-run this script."
else
  echo "Creating HMAC key (one-time output — capture both values for Doppler):"
  gcloud storage hmac create "$RUNTIME_EMAIL" --project "$PROJECT" --format=json
  warn "Store accessId → BLOB_ACCESS_KEY and secret → BLOB_SECRET_KEY in Doppler."
fi

# ─── 9. Workload Identity Federation for GitHub Actions ───────────────
step "Workload Identity Federation: pool '$WIF_POOL'"
if gcloud iam workload-identity-pools describe "$WIF_POOL" \
    --project "$PROJECT" --location global >/dev/null 2>&1; then
  warn "pool '$WIF_POOL' exists — skipping"
else
  gcloud iam workload-identity-pools create "$WIF_POOL" \
    --project "$PROJECT" --location global \
    --display-name="GitHub Actions"
fi

step "WIF provider: '$WIF_PROVIDER' (filtered to repo $GH_REPO)"
if gcloud iam workload-identity-pools providers describe "$WIF_PROVIDER" \
    --project "$PROJECT" --location global --workload-identity-pool "$WIF_POOL" >/dev/null 2>&1; then
  warn "provider '$WIF_PROVIDER' exists — skipping"
else
  gcloud iam workload-identity-pools providers create-oidc "$WIF_PROVIDER" \
    --project "$PROJECT" --location global \
    --workload-identity-pool "$WIF_POOL" \
    --display-name="GitHub Actions mcp-knowledge2" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="attribute.repository == '${GH_REPO}'" \
    --issuer-uri="https://token.actions.githubusercontent.com"
fi

PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format="value(projectNumber)")
WIF_PROVIDER_FULL="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}/providers/${WIF_PROVIDER}"

step "Bind WIF principal → deploy SA"
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_EMAIL" \
  --project "$PROJECT" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}/attribute.repository/${GH_REPO}" \
  --role="roles/iam.workloadIdentityUser" \
  --quiet >/dev/null

step "Done. Set these GitHub repository secrets:"
cat <<EOF
  GCP_PROJECT      = ${PROJECT}
  GCP_DEPLOY_SA    = ${DEPLOY_EMAIL}
  GCP_WIF_PROVIDER = ${WIF_PROVIDER_FULL}

Next:
  1. Connect to Cloud SQL and run the SQL above to create roles + extensions.
  2. Populate Doppler config 'prd_gcp' (see deploy/gcp/README.md).
  3. Sync secrets:    bash deploy/gcp/sync-secrets.sh
  4. Deploy:          gh workflow run deploy.yml \\
                        -f sql_instance_connection=${PROJECT}:${REGION}:${SQL_NAME} \\
                        -f domain=<your-public-hostname> \\
                        -f region=${REGION}
EOF
