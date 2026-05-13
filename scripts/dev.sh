#!/usr/bin/env bash
# Local dev bootstrap: bring up dependencies, run migrations, start watch mode.
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=".env"
if [[ ! -f "$ENV_FILE" ]]; then
  cp .env.example "$ENV_FILE"
  # dev defaults: app talks to compose-network services
  sed -i.bak 's|@postgres:5432|@localhost:5432|g' "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  sed -i.bak 's|http://minio:9000|http://localhost:9000|g' "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  sed -i.bak 's|http://mock-jwks:9090|http://localhost:9090|g' "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  echo "▸ created $ENV_FILE from .env.example"
fi

echo "▸ starting docker compose dev stack"
docker compose -f deployments/docker-compose.dev.yml up -d

echo "▸ waiting for postgres..."
until docker compose -f deployments/docker-compose.dev.yml exec -T postgres pg_isready -U postgres >/dev/null 2>&1; do
  sleep 1
done

echo "▸ applying migrations"
set -a; source "$ENV_FILE"; set +a
DATABASE_ADMIN_URL="postgres://postgres:postgres@localhost:5432/knowledge" npx tsx scripts/migrate.ts

echo "▸ launching watch server"
exec npx tsx watch src/server.ts
