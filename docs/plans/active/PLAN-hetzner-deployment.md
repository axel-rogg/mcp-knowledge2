# PLAN — Hetzner Deployment fuer mcp-knowledge2

> **Status: ⚠️ DRAFT — Implementation-Spec fuer separaten Agent**
>
> Erstellt: 2026-05-13 nach Multi-Cloud-Review im Schwester-Repo.
> Dieser Plan ist self-contained und konkret genug fuer einen
> dedizierten Agent zum Abarbeiten — er beschreibt was zu tun ist,
> welche Files zu erstellen sind, und welche Architektur-Constraints
> verbindlich sind.
>
> **Wichtig:** mcp-approval2 und mcp-knowledge2 laufen auf derselben
> Hetzner-VM (Single-VM-Pattern), aber als getrennte Docker-Container im
> selben docker-compose-Stack. Dieser Plan ist die mcp-knowledge2-Seite.
>
> **Schwester-Plan:** [mcp-approval2 PLAN-hetzner-deployment](https://github.com/axel-rogg/mcp-approval2/blob/main/docs/plans/active/PLAN-hetzner-deployment.md)
> — definiert das Gesamtbild + docker-compose.yml. Konflikte resolven
> durch Cross-Repo-Doku.

---

## 0. TL;DR fuer den Agent

Aufgabe: mcp-knowledge2 Deploy-bar auf **Hetzner** UND **GCP Cloud Run**
machen — beide Plattformen parallel-betreibbar. Identische Codebase,
Workspace-spezifische Terraform-Configs.

- **Keine grossen Refactors noetig** — der bestehende Node + pg + pg-boss +
  pino-Stack funktioniert auf Hetzner + Cloud Run out-of-the-box (im
  Gegensatz zu CF Workers wo signifikanter Refactor noetig waere).
- **Multi-Instance:** privat (Hetzner) + business (GCP) parallel,
  getrennte DBs, getrennte Container, gemeinsames Container-Image.
- **Domain:** `ai-toolhub.org`-Zone bei Cloudflare (terraform-managed,
  bestehend in mcp-approval-Repo). Subdomain-Schema: `knowledge2.ai-toolhub.org`
  privat, business-Subdomain konfigurierbar.
- **Aufgaben fokussieren auf**: Dockerfile-Optimierung (Multi-Stage),
  Migration-CLI, docker-compose-Fragment (Hetzner), Cloud Run Service-YAML
  (GCP), Environment-Variables-Schema, JWKS-Integration zu mcp-approval2,
  Health-Checks, Terraform-Module.
- **Aufwand:** ~3-4 Tage Engineering (1 Tag Hetzner, 1 Tag GCP, 1 Tag
  Terraform, 1 Tag Tests+Doku).

**Schwester-Plan:** [mcp-approval2 PLAN-hetzner-deployment](https://github.com/axel-rogg/mcp-approval2/blob/main/docs/plans/active/PLAN-hetzner-deployment.md)
hat das Master-Architecture-Picture inkl. Multi-Instance-Pattern,
Terraform-Workspaces, Cloudflare-DNS-Strategy. Lies das ZUERST.

---

## 1. Architektur-Constraints (verbindlich)

### 1.1 Gemeinsame VM-Topologie

mcp-knowledge2 laeuft als **eigener Container** auf derselben Hetzner-VM
wie mcp-approval2. Beide sind im `internal`-Docker-Network und sehen sich
unter ihren Service-Namen:

```
mcp-approval2  → http://mcp-approval2:8787   (internal, intra-network)
mcp-knowledge2 → http://mcp-knowledge2:8788  (internal, intra-network)
```

Public sind sie unter Caddy-Routes:
- `https://mcp-approval2.firma.de` → mcp-approval2:8787
- `https://knowledge.firma.de`      → mcp-knowledge2:8788

### 1.2 Postgres (shared)

**Eine Postgres-Instance, zwei DBs:**

```
postgres:5432
  ├── DB: approval2  ← gehoert mcp-approval2
  └── DB: knowledge2 ← gehoert mcp-knowledge2
```

DB-User `app` hat Zugriff auf beide. RLS-Policies sind pro-DB konfiguriert.
Cross-DB-Calls existieren NICHT (Service-Boundary via HTTPS+JWT).

**pgvector** muss in der knowledge2-DB aktiviert sein (`CREATE EXTENSION vector`).

### 1.3 Service-Auth gegenueber mcp-approval2

mcp-knowledge2 validiert JWTs gegen mcp-approval2's JWKS-Endpoint:

```
JWKS_URL=http://mcp-approval2:8787/.well-known/jwks.json
JWT_ISSUER=mcp-approval2
JWT_AUDIENCE=mcp-knowledge2
```

Die URL ist **intra-network** (kein TLS noetig, kein public-DNS-Lookup).

### 1.4 DEK-Resolve gegenueber mcp-approval2

mcp-knowledge2 callt mcp-approval2's Internal-API fuer per-User-DEKs:

```
MCP_APPROVAL_BASE_URL=http://mcp-approval2:8787
MCP_APPROVAL_INTERNAL_TOKEN=<shared with mcp-approval2 .env>
```

Pattern: ADR-0001 Variant B (Internal-API DEK-Resolver, schon implementiert
in `src/adapters/kms/internal_api.ts`).

### 1.5 AI-Embeddings via Vertex

Vertex AI Service-Account-Key bleibt wie heute. EU-Region
(`europe-west4`). Vertex ist HTTP-API → laeuft cross-cloud unproblematisch.

```
VERTEX_REGION=europe-west4
VERTEX_SERVICE_ACCOUNT_JSON_B64=<base64 of vertex-sa.json>
```

---

## 2. Decisions (final fuer Hetzner-Deploy)

| Decision | Wahl | Begruendung |
|---|---|---|
| Postgres-Backend | Im docker-compose (shared mit mcp-approval2) | Einfach, schnelle Latency, kein extra Cost |
| pg-boss bleibt | ✅ Ja | Laeuft auf Node + Postgres ohne Probleme |
| pino bleibt | ✅ Ja | stdout-JSON → Docker-Logs → Cloud-Logging-ready |
| prom-client bleibt | ✅ Ja | `/metrics`-Endpoint via Caddy weitergeleitet (optional public) |
| Body-Encryption-Material | Via mcp-approval2-Internal-API (ADR-0001 Variant B) | Single-Source-of-KMS-Truth |
| Blob-Storage | S3-API (MinIO im docker-compose ODER R2-extern) | Spaeter-Migration zu GCS trivial via S3-API |
| Health-Checks | `/health`, `/health/ready`, `/metrics` (Phase 2) | docker-compose healthcheck + Caddy upstream-check |
| Migration-Run | Beim Container-Start ueber release_command | Wie bei Fly schon implementiert |

---

## 3. Files die der Agent erstellen muss

### 3.1 Deploy-Fragment Hetzner (im Repo committed)

```
deploy/hetzner/
├── README.md                       — Agent-Instructions + Deploy-Verfahren
├── docker-compose.fragment.yml     — knowledge2-Service-Block fuer Master-Compose
├── .env.example                    — Env-Vars-Katalog (knowledge2-spezifisch)
├── postgres-init-knowledge2.sql    — CREATE EXTENSION vector + initial Setup
├── migrate.sh                      — Container-Entry-Point Migration-Runner
└── healthcheck.sh                  — Status der knowledge2-Service-Dependencies
```

### 3.1b Deploy-Files GCP Cloud Run (im Repo committed)

```
deploy/gcp/
├── README.md                       — GCP-Deploy-Verfahren (Cloud Run Service)
├── Dockerfile.cloudrun             — Cloud-Run-optimiert (PORT-Env-Variable)
├── cloudbuild.yaml                 — GCP Cloud Build pipeline
├── service.yaml                    — Cloud Run Service-Definition (terraform-managed alternative)
├── migrate-job.yaml                — Cloud Run Job fuer DB-Migration beim Deploy
├── cloud-scheduler.yaml            — pg-boss-Replacement: Cloud Scheduler → HTTP-Cron
└── secret-manager.tf               — Secret-Manager-Eintrag-Skeleton (von Terraform befuellt)
```

### 3.2 Dockerfile-Pruefung

Existierender Dockerfile in `/workspaces/mcp-knowledge2/Dockerfile`
funktioniert bereits fuer Container-Deployment (war fuer Fly.io gebaut).

Agent muss pruefen:
- [ ] Multi-Stage-Build optimieren (deps → build → runtime)
- [ ] Final-Stage als non-root user
- [ ] HEALTHCHECK-Direktive
- [ ] Image-Size minimieren (alpine, npm prune)
- [ ] CMD nutzt `dist/server.js` (esbuild-bundled)

### 3.3 Container-Image-Publishing

```
.github/workflows/build-and-push.yml
  - Trigger: push auf main mit Tag [build]
  - Build via Docker BuildKit
  - Push zu ghcr.io/axel-rogg/mcp-knowledge2:<tag>
  - Multi-Arch (amd64 + arm64 optional)
```

### 3.4 Runbooks

```
docs/runbooks/runbook-hetzner-deploy.md          — Deploy-Verfahren
docs/runbooks/runbook-hetzner-rotate-secrets.md  — Vertex-SA + INTERNAL-Token
docs/runbooks/runbook-hetzner-postgres-backup.md — DB-Dump-Strategy
```

### 3.5 Status-Update

```
docs/STATUS.md          → Hetzner-Section ergaenzen
docs/PILOT-READINESS.md → Hetzner-Pfad als "ready" markieren (post-Implementation)
```

---

## 4. docker-compose-Fragment (Vorlage fuer Agent)

Master-`docker-compose.yml` wohnt im mcp-approval2-Repo unter
`deploy/hetzner/docker-compose.yml`. mcp-knowledge2 contributing einen
Service-Block den der mcp-approval2-Operator includes:

```yaml
# deploy/hetzner/docker-compose.fragment.yml

services:
  mcp-knowledge2:
    image: ghcr.io/axel-rogg/mcp-knowledge2:${KNOWLEDGE_TAG:-latest}
    container_name: mcp-knowledge2
    restart: unless-stopped
    
    environment:
      # Database (shared Postgres-Instance, eigene DB)
      DATABASE_URL: postgres://app:${POSTGRES_PASSWORD}@postgres:5432/knowledge2
      DATABASE_POOL_MAX: ${KNOWLEDGE_DB_POOL_MAX:-10}
      
      # Service Boundary zu mcp-approval2 (intra-Docker-network)
      JWKS_URL: http://mcp-approval2:8787/.well-known/jwks.json
      JWT_ISSUER: mcp-approval2
      JWT_AUDIENCE: mcp-knowledge2
      JWKS_CACHE_TTL_SECONDS: 300
      
      # DEK-Resolver (ADR-0001 Variant B)
      MCP_APPROVAL_BASE_URL: http://mcp-approval2:8787
      MCP_APPROVAL_INTERNAL_TOKEN: ${MCP_APPROVAL_INTERNAL_TOKEN}
      
      # Service-Token fuer GDPR-Erase-Cascade (von mcp-approval2 zu uns)
      SERVICE_TOKEN: ${KNOWLEDGE2_SERVICE_TOKEN}
      
      # Vertex AI
      VERTEX_REGION: europe-west4
      VERTEX_SERVICE_ACCOUNT_JSON: ${VERTEX_SERVICE_ACCOUNT_JSON_B64}
      VERTEX_PROJECT_ID: ${VERTEX_AI_PROJECT_ID}
      
      # Master-Key fuer eigene Backup-Encryption (NICHT user-DEK)
      BACKUP_MASTER_KEY: ${KNOWLEDGE_BACKUP_MASTER_KEY_BASE64}
      
      # Blob-Storage (S3-API)
      S3_ENDPOINT: ${KNOWLEDGE_S3_ENDPOINT}        # z.B. http://minio:9000 (im compose) ODER R2-Endpoint
      S3_ACCESS_KEY_ID: ${KNOWLEDGE_S3_ACCESS_KEY}
      S3_SECRET_ACCESS_KEY: ${KNOWLEDGE_S3_SECRET}
      S3_BUCKET: ${KNOWLEDGE_S3_BUCKET}
      
      # Logging
      LOG_LEVEL: ${KNOWLEDGE_LOG_LEVEL:-info}
      
      # Server
      PORT: 8788
      NODE_ENV: production
    
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:8788/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    
    depends_on:
      postgres:
        condition: service_healthy
      mcp-approval2:
        condition: service_started
    
    networks:
      - internal

# Networks werden vom mcp-approval2-Master-Compose deklariert
```

---

## 5. .env.example (knowledge2-Spezifisch)

```bash
# === mcp-knowledge2 spezifische Env-Vars ===

# Database
KNOWLEDGE_DB_POOL_MAX=10
POSTGRES_PASSWORD=<changeme>           # ← shared mit mcp-approval2

# Service Auth (intra-Docker-network)
# JWKS_URL, JWT_ISSUER, JWT_AUDIENCE sind im docker-compose hardcoded

# Internal-API
MCP_APPROVAL_INTERNAL_TOKEN=<sync mit mcp-approval2 .env>
KNOWLEDGE2_SERVICE_TOKEN=<openssl rand -hex 32>

# Vertex AI
VERTEX_AI_PROJECT_ID=
VERTEX_SERVICE_ACCOUNT_JSON_B64=
VERTEX_REGION=europe-west4

# Encryption
KNOWLEDGE_BACKUP_MASTER_KEY_BASE64=<openssl rand 32 | base64>

# Blob-Storage (S3-API)
KNOWLEDGE_S3_ENDPOINT=http://minio:9000        # oder z.B. https://<account>.r2.cloudflarestorage.com
KNOWLEDGE_S3_ACCESS_KEY=
KNOWLEDGE_S3_SECRET=
KNOWLEDGE_S3_BUCKET=mcp-knowledge2-storage

# Logging
KNOWLEDGE_LOG_LEVEL=info

# Container-Tag
KNOWLEDGE_TAG=latest
```

---

## 6. Build + Publish (CI-Workflow)

```yaml
# .github/workflows/build-and-push.yml

name: Build & Push Container
on:
  push:
    tags: [ 'v*.*.*' ]
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: |
            ghcr.io/${{ github.repository }}:${{ github.ref_name }}
            ghcr.io/${{ github.repository }}:latest
          platforms: linux/amd64,linux/arm64
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

---

## 7. Migration-Runner (Container-Entry)

Bestehende `scripts/migrate.ts` reicht. Container-Start-Sequenz:

```
1. wait for postgres healthy (via depends_on)
2. run migrations (release_command-Pattern)
3. start server
```

In Dockerfile als HEALTHCHECK + ENTRYPOINT-Script:

```bash
#!/bin/sh
# entrypoint.sh
set -e

echo "→ Waiting for Postgres..."
until pg_isready -h postgres -U app; do sleep 1; done

echo "→ Running migrations..."
node --enable-source-maps scripts/migrate.js

echo "→ Starting server..."
exec node --enable-source-maps dist/server.js
```

---

## 8. Health-Checks

Existierende `/health` und `/health/ready` Endpoints bleiben.

`/health/ready` muss zusaetzlich pruefen:
- [ ] Postgres-Reachable + pgvector-Extension installiert
- [ ] JWKS-URL fetchbar von mcp-approval2 (deep-check optional)
- [ ] Vertex AI Service-Account-Token-Fetch erfolgreich (deep-check optional)
- [ ] Blob-Storage-Backend reachable (S3-HEAD)

`docker-compose-healthcheck` ruft nur `/health` (liveness).

---

## 9. Sub-Decisions die der Agent treffen kann

Diese sind nicht-blocking und koennen vom Agent selbst entschieden werden:

- [ ] Migration-Tracking: drizzle-kit vs eigenes scripts/migrate.ts? **Empfehlung:** bleib bei eigenem migrate.ts.
- [ ] release_command vs init-container vs entrypoint-script? **Empfehlung:** entrypoint-script (siehe §7).
- [ ] MinIO im docker-compose oder R2-extern? **Empfehlung:** MinIO im compose fuer Phase 1 (alles auf einer VM), R2 als Option fuer Phase 2.
- [ ] Multi-Arch-Build oder nur amd64? **Empfehlung:** beides (arm64 ist trivial mit buildx).
- [ ] Image-Size-Optimierung: alpine vs debian-slim? **Empfehlung:** alpine.
- [ ] pg-boss-Jobs: behalten oder durch cron-trigger ersetzen? **Empfehlung:** behalten (laeuft auf Node-Container ohne Probleme).
- [ ] prom-client-`/metrics`-Endpoint public oder nur internal? **Empfehlung:** internal (nur via Caddy mit Basic-Auth wenn public).

---

## 10. Coordination mit mcp-approval2-Agent

Der mcp-approval2-Agent ist verantwortlich fuer:
- Das Master-`docker-compose.yml` mit allen Services
- `Caddyfile` (inkl. knowledge.firma.de Route)
- Postgres-Initial-Setup-Script (mit `CREATE DATABASE knowledge2`)
- Generierung von `MCP_APPROVAL_INTERNAL_TOKEN` (shared mit mcp-knowledge2)
- VM-Bootstrap (cloud-init, docker-Installation)
- Backup-Skript (DB-Dumps fuer beide DBs)

Was der mcp-knowledge2-Agent zur Verfuegung stellen muss:
- `docker-compose.fragment.yml` (kopiert vom mcp-approval2-Operator)
- `.env.example` mit knowledge2-spezifischen Vars
- Container-Image auf ghcr.io
- Doku: README.md erklaert wie der mcp-approval2-Operator den Service includes

---

## 11. Implementation-Tasks fuer den Agent

### Task 1 — Dockerfile-Audit + Optimierung (0.5 Tag)
- [ ] Multi-Stage-Build verifizieren
- [ ] Non-root user
- [ ] HEALTHCHECK direktive
- [ ] esbuild-bundle als CMD-target
- [ ] Image-Size <100 MB ideal

### Task 2 — Deploy-Fragment (0.5 Tag)
- [ ] `deploy/hetzner/docker-compose.fragment.yml`
- [ ] `deploy/hetzner/.env.example`
- [ ] `deploy/hetzner/postgres-init-knowledge2.sql`
- [ ] `deploy/hetzner/entrypoint.sh`
- [ ] `deploy/hetzner/healthcheck.sh`
- [ ] `deploy/hetzner/README.md`

### Task 3 — CI Build+Push (0.5 Tag)
- [ ] `.github/workflows/build-and-push.yml`
- [ ] ghcr.io-Token konfigurieren (falls noch nicht)
- [ ] Multi-Arch verifizieren

### Task 4 — Health-Check-Erweiterung (0.5 Tag)
- [ ] `/health/ready` mit Deep-Checks (Postgres, JWKS-Fetch, Vertex-Token-Test, S3-HEAD)
- [ ] `/metrics` public-Gate (default deny)
- [ ] Tests fuer Health-Endpoints

### Task 5 — Runbooks (0.5 Tag)
- [ ] `docs/runbooks/runbook-hetzner-deploy.md`
- [ ] `docs/runbooks/runbook-hetzner-rotate-secrets.md`
- [ ] `docs/runbooks/runbook-hetzner-postgres-backup.md`

### Task 6 — Smoke-Test (0.5 Tag)
- [ ] Lokales docker-compose-up gegen mcp-approval2-Stack
- [ ] JWT-Roundtrip mit mcp-approval2-JWKS verifizieren
- [ ] DEK-Resolve-Call verifizieren
- [ ] Object-CRUD-Roundtrip
- [ ] Search-Roundtrip mit Vertex-Embedding

### Task 7 — GCP Cloud Run Deploy-Files (1 Tag)
- [ ] `deploy/gcp/Dockerfile.cloudrun` (Cloud-Run-optimiert, PORT-Env)
- [ ] `deploy/gcp/cloudbuild.yaml`
- [ ] `deploy/gcp/migrate-job.yaml`
- [ ] `deploy/gcp/cloud-scheduler.yaml` (Cron-Definitionen)
- [ ] `deploy/gcp/service.yaml`
- [ ] `deploy/gcp/README.md`

### Task 8 — Cron-Refactor fuer Multi-Backend (1 Tag)
- [ ] Config-Schema erweitern: `CRON_BACKEND=pg-boss|cloud-scheduler|none`
- [ ] `src/crons/runner.ts` mit Backend-Switch
- [ ] HTTP-Endpoints `/internal/v1/cron/<task>` fuer Cloud-Scheduler-Trigger
- [ ] Tests fuer beide Modi

### Task 9 — Status-Update (0.25 Tag)
- [ ] `docs/STATUS.md` Hetzner + GCP-Section
- [ ] `docs/PILOT-READINESS.md` beide Pfade

**Gesamt-Aufwand:** ~3.5-4.5 Tage Engineering (inkl. GCP Cloud Run +
Cron-Refactor fuer Plattform-Switch).

---

## 12. Acceptance-Kriterien

Diese muss der Agent erfuellen damit der Plan abgeschlossen ist:

- [ ] `npm test` gruen (alle existierenden Tests bleiben gruen)
- [ ] `npm run typecheck` clean
- [ ] Lokales `docker-compose up` (in /workspaces/mcp-approval2/deploy/hetzner/) startet mcp-knowledge2 ohne Errors
- [ ] mcp-knowledge2 Health-Check returnt 200 bei healthy state
- [ ] JWT-Auth mit mcp-approval2-JWKS funktioniert (via Smoke-Script)
- [ ] DEK-Resolve via Internal-API funktioniert
- [ ] Postgres-Migration laeuft beim Container-Start
- [ ] Container-Image laeuft auf ghcr.io published (latest + tag)
- [ ] README.md erklaert klar wie mcp-approval2-Operator den Service includes

---

## 13. Risiken + Mitigations

- **Risiko:** Postgres-Schema-Konflikt wenn approval2 + knowledge2 dieselbe DB nutzen
  → Mitigation: getrennte DBs (`approval2` vs `knowledge2`), kein cross-DB-Zugriff
  
- **Risiko:** JWKS-URL nicht erreichbar wenn mcp-approval2 noch nicht startet
  → Mitigation: `depends_on: mcp-approval2 service_started` + JWKS-Cache-on-fail-empty-Pattern
  
- **Risiko:** MCP_APPROVAL_INTERNAL_TOKEN-Drift zwischen approval2 + knowledge2
  → Mitigation: ein Master-`.env`-File auf der VM, beide Services lesen dieselbe Variable

- **Risiko:** Vertex-Service-Account-Key Leak ueber docker-compose-env
  → Mitigation: VERTEX_SERVICE_ACCOUNT_JSON_B64 als Docker-Secret statt Env-Var (Phase 2)

---

## 14. GCP Cloud Run Parallel-Deploy (NICHT spaeter — PARALLEL)

User-Anforderung: privat (Hetzner) UND business (GCP) **parallel** in
Betrieb. Beide Instances haben **getrennte Daten**, **eigene Domains**,
**identische Codebase**.

### 14.1 GCP-Stack pro Instance

```
Cloud Run Service: mcp-knowledge2-service-business
  - Image: ghcr.io/axel-rogg/mcp-knowledge2:vN.M
  - Min instances: 1 (warm-start) oder 0 (scale-to-zero, cold-start akzeptabel)
  - Max instances: 10 (Pilot)
  - Memory: 1 GiB
  - Service Account: cloudrun-knowledge2@<project>.iam
  - Env-Vars:
      DATABASE_URL=postgres://app:<pwd>@/knowledge2?host=/cloudsql/<conn>
      JWKS_URL=https://<approval2-cloudrun-url>/.well-known/jwks.json
      MCP_APPROVAL_BASE_URL=https://<approval2-cloudrun-url>
      MCP_APPROVAL_INTERNAL_TOKEN=<from Secret Manager>
      VERTEX_REGION=europe-west4
      VERTEX_SERVICE_ACCOUNT_JSON=<workload-identity, kein JSON nötig>
      BACKUP_MASTER_KEY=<projects/<id>/locations/eu/keyRings/.../cryptoKeys/master>
      S3_ENDPOINT=https://storage.googleapis.com
      S3_BUCKET=mcp-knowledge2-business-eu

Cloud SQL Postgres: mcp-knowledge2-pg-business
  - Tier: db-custom-1-3840 (1 vCPU, 3.75 GB) — Pilot
  - pgvector enabled
  - HA: optional (Pilot: nein, Production: ja)
  - Backups: automated daily

Cloud KMS:
  - Key-Ring: mcp-knowledge2-business-eu
  - Crypto-Key: master-key (rotated annually)
  - Service Account: cloudrun-knowledge2 has roles/cloudkms.cryptoKeyEncrypterDecrypter

Cloud Scheduler (replaces pg-boss):
  - Job: knowledge2-cron-sweep-uploads  (every 30 min)
      → POST https://<knowledge2-cloudrun-url>/internal/v1/cron/sweep-uploads
      Headers: X-Cron-Token: <secret>
  - Job: knowledge2-cron-purge-uploads  (every hour)
  - Job: knowledge2-cron-weekly-backup  (every Sunday 03:00)

GCS Bucket: mcp-knowledge2-business-eu
  - Location: europe-west4
  - Storage Class: STANDARD
  - Versioning: enabled
  - Service Account: cloudrun-knowledge2 has roles/storage.objectAdmin
```

### 14.2 Was sich pro Plattform unterscheidet (Env-Var-Tabelle)

| Env-Var | Hetzner | GCP Cloud Run |
|---|---|---|
| `DATABASE_URL` | `postgres://app:pw@postgres:5432/knowledge2` | `postgres://app:pw@/knowledge2?host=/cloudsql/<conn>` |
| `JWKS_URL` | `http://mcp-approval2:8787/.well-known/jwks.json` | `https://mcp-approval2-business-<hash>-ew.a.run.app/.well-known/jwks.json` |
| `MCP_APPROVAL_BASE_URL` | `http://mcp-approval2:8787` | `https://mcp-approval2-business-<hash>-ew.a.run.app` |
| `S3_ENDPOINT` | `http://minio:9000` | `https://storage.googleapis.com` |
| `BACKUP_MASTER_KEY` | `<base64-32-bytes>` | KMS-Reference `projects/.../cryptoKeys/master` |
| `LOG_LEVEL` | `info` | `info` (Cloud Logging picks up automatically) |

Code-seitig: pro Env-Var ein zod-validated Schema, das beide Welten
akzeptiert. Plattform-Detection ueber `RUNTIME=node-hetzner|node-cloudrun`.

### 14.3 pg-boss vs Cloud Scheduler

**Wichtig:** pg-boss in `src/crons/runner.ts` ist Postgres-basiert und
laeuft technisch **auch auf Cloud Run**, ABER:
- Cloud Run autoscaled (min instances=0): wenn Container wegskaliert,
  laufen Jobs nicht
- Cloud Run hat 1-Hour-Request-Timeout fuer Background-Tasks

**Loesung fuer GCP:** pg-boss raus, durch Cloud Scheduler ersetzen.

Im Code:
- Bestehende `src/crons/*.ts`-Files werden zu **HTTP-Endpoints** unter
  `/internal/v1/cron/<task>` (analog zu mcp-approval2-Pattern)
- pg-boss ist optional (Hetzner: aktiviert; GCP: deaktiviert via `CRON_BACKEND=cloud-scheduler`)
- Config-Schema: `CRON_BACKEND=pg-boss|cloud-scheduler`

### 14.4 Terraform-Workspace-Pattern

Schwester-Repo (mcp-approval2) hat das Master-Terraform unter:
`terraform/environments/business/main.tf`

mcp-knowledge2-Service wird **vom Master-Terraform** referenziert
(als Cloud-Run-Service-Resource). Dieser Plan beschreibt nur das
WAS, nicht das WIE — Terraform-Code lebt im Schwester-Repo.

Was mcp-knowledge2 liefern muss:
- Container-Image auf ghcr.io
- `deploy/gcp/service.yaml` als Referenz fuer Terraform-Generation
- `deploy/gcp/cloud-scheduler.yaml` mit Cron-Definitionen

### 14.5 Operations privat vs business

```bash
# Privat: SSH + docker-compose update
ssh root@<hetzner-vm>
cd /opt/mcp-knowledge2
git pull
docker compose pull
docker compose up -d

# Business: Cloud Build trigger + Cloud Run revision
gcloud builds submit --config deploy/gcp/cloudbuild.yaml
# (Cloud Build erstellt neues Image, Cloud Run deployt automatisch neue Revision)
```

---

## 15. Referenzen

- [Schwester-Plan mcp-approval2 Hetzner](https://github.com/axel-rogg/mcp-approval2/blob/main/docs/plans/active/PLAN-hetzner-deployment.md) — Master-Plan
- [ADR-0001 DEK-Resolution-Strategy](../../adr/0001-dek-resolution-strategy.md) — Variant B Internal-API
- [PLAN-architecture-v2](./PLAN-architecture-v2.md) — Service-Architektur
- [CROSS-SERVICE-CONTRACT.md](../../CROSS-SERVICE-CONTRACT.md) — API-Drift-Status
- [Fly-Deploy als Vorbild](../../runbooks/runbook-fly-deploy.md) — bestehender Container-Workflow

---

## 16. Naechste Schritte (fuer den Agent)

1. Diesen Plan komplett lesen
2. Existing Files inspizieren:
   - `/workspaces/mcp-knowledge2/Dockerfile`
   - `/workspaces/mcp-knowledge2/deploy/fly/*` (als Vorbild)
   - `/workspaces/mcp-knowledge2/src/server.ts` (Entry-Point)
   - `/workspaces/mcp-knowledge2/scripts/migrate.ts` (Migration-CLI)
3. Tasks 1-7 abarbeiten (parallel wo moeglich)
4. Smoke gegen lokales docker-compose-Stack
5. PR erstellen, Reviewer ist Schwester-Repo-Agent

**Kein Code committed bevor lokaler Smoke gegen Schwester-Stack gruen ist.**
