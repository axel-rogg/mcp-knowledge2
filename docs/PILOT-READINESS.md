# mcp-knowledge2 — Pilot Readiness

> **Date**: 2026-05-16 (Doppler-Gap-Analyse + Audit-Verifikation)
> **Owner**: Axel
> **Target**: Solo-Pilot auf **Fly.io Frankfurt** (axelrogg@gmail.com), CF-Workers-Pfad bewusst geparkt — siehe [STRATEGIE-pilot.md](./STRATEGIE-pilot.md).
> **Sister service**: `mcp-approval2` (Approval-Proxy, optional via OBO-Bridge).

This document is the honest accounting of what's done, what's known
broken, and what's still required before we put data on this service.

**Update 2026-05-16:** Komplettes Doku-vs-Code-Audit durchgeführt (3 parallele Subagent-Pässe + Doppler-Live-Check). Drift-Korrekturen sind in dieselbe Commit-Reihe geflossen (README/CLAUDE.md/ADR-0001/runbook-gcp/service.yaml). Dual-Runtime-Pfad geprüft + bewusst geparkt zugunsten Fly-single-target. Verbleibender Pilot-Pfad: §"Verbleibender Aufwand" weiter unten.

## TL;DR

**Code is pilot-grade for both deployment targets (privat-Hetzner/Fly +
business-GCP).** Ops is pilot-grade for privat once `bash deploy/fly/deploy.sh`
runs cleanly once. CROSS-SERVICE D-9 (multi-subtype search) was resolved by
ADR-0004 (generic object model).

**Dual-Deploy-Architektur** (Stand 2026-05-15):

| Profile | BLOB_PROVIDER | EMBED_PROVIDER | KMS_PROVIDER | Compute | Postgres | Monthly cost |
|---|---|---|---|---|---|---|
| `privat` | s3 (R2/Hetzner/Tigris) | cloudflare (Workers AI bge-m3) | openbao or hkdf_local | Fly.io / Hetzner VM | Neon Free Tier (eu-central-1) | ~3-4 €/Monat |
| `business` | gcs (native, Workload Identity) | vertex (text-multilingual-embedding-002) | cloud_kms | Cloud Run gen2 | Cloud SQL Postgres 16 | 30-80 €/Monat |

Provider-switch is **env-driven**, no code edits. Both profiles share the
same container image — the deployment target only changes env-vars + service-
account-binding.

---

## What works (✅ Done)

### Application code

- **HTTP server** — Hono + `@hono/node-server`, graceful shutdown
  (SIGTERM/SIGINT → drain crons → close pg pool → exit), structured
  pino logs with PII-redact rules.
- **Database** — Drizzle ORM + pg pool, four migrations applied
  (`0000_init`, `0001_rls`, `0002_security_hardening`,
  `0003_drop_description_enc`, `0004_erase_cascade`). Per-request
  Postgres transaction sets `app.current_user` for **Row-Level Security**.
- **Auth** —
  - User routes: JWT verified via JWKS (24 h cache) against
    `mcp-approval2`. `sub` claim becomes `current_user`.
  - Internal routes: static `SERVICE_TOKEN` (constant-time compare).
- **Crypto** — AES-256-GCM with **AAD** (`<recordType>|<owner>|<id>`,
  see ADR-0004 — kind/subtype slot removed from AAD as part of generic
  object model)
  preventing cross-user / cross-object ciphertext replay. Per-user DEKs
  resolved on-demand via `mcp-approval2` KMS internal API; never
  persisted in `mcp-knowledge2`.
- **PII masking** — applied to text **before** it leaves the service for
  embedding. **Default provider since 2026-05-15: Cloudflare Workers AI
  (`@cf/baai/bge-m3`, 1024-dim, multilingual)** routed through a dedicated
  AI Gateway `mcp-knowledge2` (TF-managed via
  `mcp-approval2/terraform/environments/privat/knowledge2-cloudflare.tf`).
  Optional fallback via `EMBED_PROVIDER=vertex`. Either way, the embedding
  provider never sees raw emails / phones. (Embedding-inversion threat
  documented in [`SECURITY.md`](./SECURITY.md).)
- **Email-Whitelist** — `ALLOWED_EMAILS` CSV in Doppler is strictly
  enforced on `/auth/google/callback`. Empty = open. Non-empty = only
  listed emails complete OAuth. Defense-in-depth on top of the OAuth-App's
  Test-Users list in Google Cloud Console.
- **Object CRUD** — `/v1/objects` generic-object model (free-form
  `subtype` string, no DB-enforced discriminator — see ADR-0004),
  inline body ≤ 16 KB in Postgres or external blob via presigned upload
  pipeline (`/v1/uploads/init`).
- **Share grants** — `/v1/shares` with role-based access control,
  enforced by RLS predicate `owner_or_shared(object_id)`.
- **Hybrid search** — FTS (Postgres `tsvector`) ⊕ pgvector (cosine) →
  RRF fusion with `k=60`, optional `subtypes: string[]` filter.
- **Cross-service contracts** —
  - `/v1/internal/erase-user` — admin-role DELETE across all tables
    for a user id; uses `DATABASE_ADMIN_URL` (BYPASSRLS).
  - DEK resolve via `mcp-approval2` KMS internal API.
- **Crons** (pg-boss): upload sweep (30 m), upload purge (1 h),
  idempotency GC (1 h), encrypted daily backup (03:00 UTC), orphan
  blob cleanup (weekly placeholder).
- **Observability** — `/metrics` Prometheus, `/health` liveness,
  `/health/ready` deep check (db + blob + JWKS), pino structured logs
  with `request_id` propagation, `audit_events` table for all
  non-trivial writes.
- **Idempotency** — `Idempotency-Key` header de-dupes writes for 24 h
  via the `idempotency_records` table.
- **Body-size cap** — 64 KB hard limit on JSON; large objects must go
  through the presigned upload pipeline.

### Tests

- **Unit tests** — crypto AAD, RRF fusion, JWT issuer/audience
  validation, env-zod schema, PII mask, etc. (`tests/unit/`).
- **Contract tests** — wire-shape between approval2 ↔ KC2: `obo-jwt`,
  `oauth-self-token`, `user-sync`, `mcp-tools-list` (`tests/contract/`).
- **Integration tests** — testcontainers spin a Postgres+pgvector,
  apply migrations, exercise the RLS policy and the full
  objects-roundtrip (`tests/integration/`).
- Green when run with Docker available. CI runs them on every push to
  `main` and on PRs ([.github/workflows/ci.yml](../.github/workflows/ci.yml)).

### Operations

- **Dockerfile** — multi-stage (`deps` → `build` → `runtime`),
  non-root `app` user, `HEALTHCHECK` baked in.
- **`.dockerignore`** — production-grade, blocks `secrets/`, `.env*`,
  `vertex-sa.json`, tests, docs.
- **`fly.toml`** — Frankfurt single-region, 1 always-on machine,
  rolling deploys, release-command runs migrations.
- **`deploy/fly/deploy.sh`** — first-deploy automation (app create,
  secrets sync from Doppler, deploy, smoke). Postgres ist seit 2026-05-17
  TF-managed bei Neon (`mcp-approval2/terraform/environments/privat/neon-knowledge2.tf`);
  die `pgvector` + `pg_trgm` Extensions sind ein einmaliger
  `psql "$DATABASE_ADMIN_URL"` Bootstrap nach `terraform apply`.
- **Runbook** — `docs/runbooks/runbook-fly-deploy.md` covers deploy,
  rollback, scale, secrets rotation, backup/restore, failure modes.

---

## What's missing for pilot (⚠️ Open)

### Code blockers (must fix before pilot)

| ID | Item | Why blocking | Effort |
|---|---|---|---|
| ~~D-9~~ | ~~**Server-side multi-kind search**~~ | **Resolved by ADR-0004** — server accepts `subtypes: string[]` (free-form). | done |
| ~~AppRole~~ | ~~**Verify production AppRole boot path**~~ | **Obsolete after AS-3 (K9):** KMS is now in-process via the `KmsProvider` factory (`hkdf_local` / `openbao` / `cloud_kms`) — no approval2 round-trip. ADR-0001 is superseded. | done |
| GCP-wiring | **`deployments/cloud-run/service.yaml` still ships `BLOB_PROVIDER=s3` (GCS S3-Interop, HMAC) + `KMS_PROVIDER=hkdf_local`.** The native-GCS and Cloud-KMS adapters exist and are tested — they just need to be wired in the manifest + bootstrap. | Cosmetic for solo-pilot; required for the "business" profile spec'd in CLAUDE.md. | ½ day (edit manifest + drop HMAC step from `01-bootstrap.sh`, add WIF binding for GCS bucket) |
| GCP-dim | **Cloud Run manifest defaults `EMBED_PROVIDER=vertex` (768-dim) but schema is 1024-dim** (migration `0010`). | Vector inserts will fail until either schema rolls back or `EMBED_PROVIDER` flips. | 5 min in the manifest + 4 secrets |
| eslint | `src/crons/backup.ts` ESLint error (not runtime-affecting) | Quality only; not a pilot blocker but should be cleaned before "v1.0" | 10 min |

### Code follow-ups (post-pilot OK)

- **Backup-restore script** — `scripts/restore-backup.ts` is referenced
  in the runbook but doesn't exist yet. Manual decrypt steps documented.
- **Embedding-provider retry/backoff** — currently single-shot for both
  Cloudflare Workers AI (default) and Vertex AI (fallback). Under quota
  pressure the embed call will 5xx. Add `p-retry` w/ jitter in
  `src/adapters/embed/index.ts` once the pilot tells us their throughput.
- **Observability — tracing** — pino structured logs only. OpenTelemetry
  hooks are referenced in `.env.example` (`OTEL_EXPORTER_OTLP_ENDPOINT`)
  but not wired in.
- **Multi-region Postgres** — single-leader-fra is fine for pilot. Add a
  read-replica in ams when the pilot grows to a second region.

### Ops blockers (must do before pilot signs)

| ID | Item | Owner action |
|---|---|---|
| Ops-1 | **Run `deploy/fly/deploy.sh` against a clean Fly org once** end-to-end, verify health checks green | Manual; ~30 min |
| Ops-2 | **Verify Neon Branching / PITR active** — Free Tier: 6 h `history_retention_seconds`, branching via Neon Console. Bei echtem Customer-Volumen Upgrade auf Neon Launch (~$5/mo, 7d Retention) erwägen. | Neon Console → Project → Branches |
| Ops-3 | **Wire blob provider** — pick Tigris (recommended, in-network) or R2/B2, create bucket, set BLOB_* secrets | ~15 min |
| Ops-4 | **DNS + custom domain** — optional but recommended; default `*.fly.dev` works for pilot | `fly certs add knowledge.firma.invalid` |
| Ops-5 | **Smoke test from the customer's side** — issue them a `mcp-approval2` JWT, walk through put/get/search/share | Pair-session with the pilot |

### Docs blockers

| ID | Item |
|---|---|
| Docs-1 | **DPA-compliance clauses** in customer contract (referenced in `PLAN-architecture-v2.md`) — legal task, not engineering |
| Docs-2 | **Incident-response runbook** — current runbook covers operational fault recovery but not data-breach disclosure timelines |
| Docs-3 | **SOC2-light evidence binder** — audit-log retention, access-log retention, secrets-rotation log. The mechanisms exist; the evidence-pack is empty. |

---

## Smoke test (cuts the pilot-ready ribbon)

After running `deploy/fly/deploy.sh` end-to-end, the following must all
pass against `https://mcp-knowledge2.fly.dev`. The whole smoke is split
in two halves: **(I) öffentliche Endpoints** brauchen keinen Token,
**(II) authentisierte Endpoints** brauchen einen Token aus einem der
drei Pfade in [INTEGRATION.md](./INTEGRATION.md) (Default: Pfad A —
claude.ai-DCR-Flow, Token aus den DevTools/Connector-Settings).

> **Wichtiger Hinweis 2026-05-16:** Frühere Versionen dieser Datei
> verwiesen auf `https://mcp-approval2.fly.dev/v1/internal/debug-jwt`,
> um in Schritt 2 einen Token zu minten. **Dieser Endpoint existiert
> weder in mcp-approval2 noch in mcp-knowledge2** — seit AS-3 ist KC2
> der Token-Issuer über die eigene OAuth-Facade. Der Smoke-Token muss
> aus genau diesem Flow kommen.

```bash
# I. Public — keine Auth nötig
curl -sf https://mcp-knowledge2.fly.dev/health                                 | jq .
curl -sf https://mcp-knowledge2.fly.dev/health/ready                            | jq .
curl -sf https://mcp-knowledge2.fly.dev/.well-known/oauth-authorization-server  | jq .
curl -sf https://mcp-knowledge2.fly.dev/.well-known/jwks.json                   | jq .

# DCR — auch öffentlich (gibt einen frischen MCP-client-eintrag zurück, kann
# nach dem Smoke wieder ignoriert/gelöscht werden)
curl -sf -X POST https://mcp-knowledge2.fly.dev/oauth/register \
  -H "content-type: application/json" \
  -d '{"redirect_uris":["http://localhost/cb"],"client_name":"smoke"}' | jq .

# II. Authentisiert — Token aus INTEGRATION.md Pfad A holen
# (claude.ai → Connector → mcp-knowledge2 OAuth durchlaufen → Token aus DevTools)
export TOKEN="<paste-kc2-access-token-here>"

# Round-trip: create → get → list → search → delete
ID=$(curl -sf -X POST https://mcp-knowledge2.fly.dev/v1/objects \
  -H "authorization: bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"subtype":"doc","body_b64":"aGVsbG8gcGlsb3Q=","title":"smoke"}' | jq -r .id)

curl -sf -H "authorization: bearer $TOKEN" \
  "https://mcp-knowledge2.fly.dev/v1/objects/$ID?expand=body" | jq .

curl -sf -H "authorization: bearer $TOKEN" \
  "https://mcp-knowledge2.fly.dev/v1/objects?subtype=doc&limit=10" | jq .

curl -sf -X POST https://mcp-knowledge2.fly.dev/v1/search \
  -H "authorization: bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"query":"pilot","subtypes":["doc"]}' | jq .

curl -sf -X DELETE -H "authorization: bearer $TOKEN" \
  https://mcp-knowledge2.fly.dev/v1/objects/$ID

# Service-Token-Route — gates /v1/internal/*; nutzt den $SERVICE_TOKEN
# aus Doppler (NICHT den OAuth-access-token oben).
export SERVICE_TOKEN="$(doppler secrets get SERVICE_TOKEN --plain \
  --project mcp-knowledge2 --config fly)"

curl -sf -X POST https://mcp-knowledge2.fly.dev/v1/internal/health-deep \
  -H "authorization: bearer $SERVICE_TOKEN" | jq .

# RLS-Negativtest (optional, braucht zweiten User):
# Wiederholung Schritt II mit einem zweiten OAuth-Token, der für eine andere
# Email gemintet wurde. GET /v1/objects/<id-vom-ersten-user> muss 404 liefern.
```

Sobald die obigen authentisierten Calls grün sind, ist der **erste
Smoke-Pass** abgeschlossen. Der RLS-Negativtest braucht einen zweiten
Account und ist Teil des Sign-off, nicht des ersten Smokes.

---

## What pilot customers should expect

- **SLO**: 99 % uptime (Fly platform SLA + 1 instance + manual rollback);
  RPO < 24 h (daily encrypted backup); RTO < 4 h (restore-from-backup runbook).
- **Latency**: p50 < 80 ms for read/list, p95 < 250 ms (Frankfurt → EU);
  search p50 < 200 ms, p95 < 600 ms (vector + FTS round-trip).
- **Throughput**: untested. The pilot itself is the throughput test.
- **Data residency**: all data in EU (Frankfurt). Embedding-Requests:
  default Cloudflare Workers AI via AI Gateway in CF-EU-Edges (kein GCP-
  Egress); optional Vertex AI `europe-west4` als Fallback wenn
  `EMBED_PROVIDER=vertex`.
- **Encryption**: AES-256-GCM at rest (per-user DEK) + TLS in transit.
  Backups separately encrypted with `BACKUP_MASTER_KEY`. We never see
  plaintext keys at rest in `mcp-knowledge2`.
- **What we don't guarantee yet**: zero-downtime DB upgrades, multi-region,
  customer-managed keys (CMK), DPA-compliance sign-off (in legal review).

---

## Verbleibender Aufwand bis erster grüner Smoke (Stand 2026-05-16)

Nach dem End-to-End-Audit ist der konkrete Rest-Pfad bis `https://mcp-knowledge2.fly.dev` 200-grün:

### Doppler-Gap (Config `mcp-knowledge2 / fly` — live-verifiziert 2026-05-16)

Doppler hat das Project `mcp-knowledge2` mit Environments `dev`, `privat` (legacy backup) und `fly` (aktive Pilot-Config). Skript-Default 2026-05-16: erst `prd_fly` → `privat` aliasiert, dann auf `fly` umgestellt (klares Deploy-Target-Naming, parallel zum Schwester-Project `mcp-approval2/hetzner`). **Seit 2026-05-17 sind die DB-Keys TF-managed (Neon-Provider in `mcp-approval2`). 5 Blob-Keys bleiben User-Action-abhängig:**

| Key | Quelle / Wie generieren | Notiz |
|---|---|---|
| `SERVICE_TOKEN` | `openssl rand -hex 32` | Gates `/v1/internal/*`, auch S2S-Two-Factor mit OBO |
| `BACKUP_MASTER_KEY` | `openssl rand -base64 32` | AES-256-GCM für tägliche Backups + signing_keys at rest |
| `KMS_MASTER_KEY_B64` | `openssl rand -base64 32` | Master für HKDF-Derivation (KMS_PROVIDER=hkdf_local) |
| `DATABASE_URL` / `DATABASE_ADMIN_URL` / `DB_APP_PASSWORD` / `DB_ADMIN_PASSWORD` | **automatisch von TF aus Neon-Provider** | werden beim `terraform apply` von `neon-knowledge2.tf` in Doppler gepusht (Host `ep-young-term-alpu306x-pooler.c-3.eu-central-1.aws.neon.tech`) — kein manueller Step mehr nötig |
| `BLOB_ENDPOINT` | Tigris empfohlen: `https://fly.storage.tigris.dev` | alternativ R2 / B2 / Hetzner-OS |
| `BLOB_ACCESS_KEY` | Provider-Dashboard | |
| `BLOB_SECRET_KEY` | Provider-Dashboard | |
| `BLOB_BUCKET` | z.B. `mcp-knowledge2-blob-eu` | im Provider-Dashboard anlegen |
| `BACKUP_BUCKET` | z.B. `mcp-knowledge2-backup-eu` | separate Lifecycle: 30 d Retention |

**Schon gefüllt (verifiziert, len > 0):**

`GOOGLE_OAUTH_CLIENT_ID` (72) ✓, `GOOGLE_OAUTH_CLIENT_SECRET` (35) ✓, `CLOUDFLARE_ACCOUNT_ID` (32) ✓, `CLOUDFLARE_API_TOKEN` (53) ✓, `CLOUDFLARE_AI_GATEWAY_ID` (14) ✓, `CLOUDFLARE_AI_MODEL` (15) ✓, `EMBED_PROVIDER` (10) ✓, `ALLOWED_EMAILS` (40) ✓, `BLOB_REGION` (10) ✓, plus aller `[env]`-Mirror-Keys (`PORT`, `NODE_ENV`, `LOG_LEVEL`, `SELF_OAUTH_ISSUER`, etc.) — die werden vom Sync-Skript skipped, weil `fly.toml` sie direkt setzt.

**Empty + irrelevant** (KMS-Provider ist `hkdf_local`, OBO ist optional, Vertex ist Fallback, GCP-Custom-Domain unused):
`OPENBAO_ADDR`, `OPENBAO_TOKEN`, `MCP_APPROVAL_JWKS_URL`, `CLOUDFLARE_AI_GATEWAY_TOKEN`, `GOOGLE_HD_ALLOWLIST`, `VERTEX_PROJECT`, `VERTEX_SERVICE_ACCOUNT_JSON_PATH`, `DOMAIN_KNOWLEDGE`.

**Anomalien** (Doppler-Cross-Contamination, kann ignoriert oder gelöscht werden):
- `ALLOWED_ORIGINS` — kein env-Var in mcp-knowledge2 (gehört zu mcp-approval). Verursacht kein Problem, weil sync-Skript es einfach mitschiebt aber der Worker es nie liest.

### Code-Blocker (über die Doppler-Gap hinaus)

| ID | Item | Why blocking | Effort |
|---|---|---|---|
| ~~D-9~~ | ~~Server-side multi-kind search~~ | Resolved by ADR-0004. | done |
| ~~AppRole~~ | ~~Verify production AppRole boot path~~ | **Obsolete after AS-3 (K9):** KMS ist jetzt in-process. ADR-0001 ist superseded. | done |
| ~~GCP-Wiring + GCP-Dim-Mismatch~~ | ~~Cloud-Run-Manifest auf native GCS + Cloud KMS umstellen~~ | **Nicht im Pilot-Pfad** — Fly nutzt S3-Tigris + hkdf_local + Cloudflare-Embed. Cloud-Run-Migration ist Post-Pilot, falls überhaupt. | postponed |
| ~~eslint~~ | ~~`src/crons/backup.ts` ESLint-Warning~~ | `npm run lint` (max-warnings=0) ist clean per 2026-05-16 — der Punkt war offenbar mit dem AS-3-Code-Complete schon gelöst. | done |
| ~~restore-script~~ | ~~`scripts/restore-backup.ts` Placeholder im Runbook~~ | Geschrieben 2026-05-16 — siehe [scripts/restore-backup.ts](../scripts/restore-backup.ts). Spiegelt den Encrypt-Pfad von [src/crons/backup.ts](../src/crons/backup.ts): AES-256-GCM Decrypt + `pg_restore --clean --no-owner`. | done |

### Externe Vorarbeiten (außerhalb des Repos)

| ID | Item | Status |
|---|---|---|
| Ops-1 | `flyctl auth login` mit Fly-Account, der `mcp-knowledge2` als App erstellen darf | offen — User-Aktion |
| Ops-2 | Google OAuth 2.0 Client erstellt + Redirect-URI `https://mcp-knowledge2.fly.dev/auth/google/callback` registriert | ✅ Credentials liegen in Doppler |
| Ops-3 | Cloudflare-Account + API-Token (Workers AI Read + AI Gateway Run) + AI-Gateway `mcp-knowledge2` | ✅ alle Felder in Doppler gefüllt |
| Ops-4 | Blob-Provider entschieden + zwei Buckets erstellt (Data + Backup) | **offen — User-Aktion**, Tigris empfohlen |
| Ops-5 | DNS / Custom Domain | **optional**, Default `*.fly.dev` reicht für Solo-Pilot |

## Sign-off checklist

Vor dem ersten echten Pilot-Use:

- [x] D-9 multi-kind search — resolved by ADR-0004 (`subtypes: string[]`)
- [x] KMS in-process per `KmsProvider`-Factory (kein approval2-Round-Trip mehr nötig)
- [x] Doku-vs-Code-Audit 2026-05-16 done, alle Drift-Stellen korrigiert
- [x] Doppler-Stand live-verifiziert (Project `mcp-knowledge2`, Config `fly`)
- [x] Doppler-Config `fly` etabliert (Klartext am Deploy-Target; alte `privat`-Config bleibt als Backup)
- [ ] 5 leere Blob-Doppler-Keys gefüllt (siehe oben); DB-Keys kommen automatisch via TF
- [ ] Blob-Provider gewählt + zwei Buckets provisioniert
- [ ] `terraform apply` für `neon-knowledge2.tf` durchgelaufen (im Schwester-Repo `mcp-approval2`)
- [ ] Einmaliger Neon-Bootstrap: `psql "$DATABASE_ADMIN_URL" -c 'CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;'`
- [ ] `bash deploy/fly/deploy.sh` einmal komplett durchlaufen
- [ ] `/health` und `/health/ready` grün gegen `https://mcp-knowledge2.fly.dev`
- [ ] OAuth-Facade Discovery + JWKS public erreichbar (`curl /.well-known/oauth-authorization-server`)
- [ ] Smoke-Roundtrip put → get → list → search → share → delete grün — siehe Block weiter oben
- [ ] RLS-Isolation: zweiter Smoke-User kann den Object eines anderen nicht lesen
- [ ] Erstes Backup-File landet am nächsten Morgen 03:00 UTC im `BACKUP_BUCKET`
- [ ] [INTEGRATION.md](./INTEGRATION.md) durchgelesen + entschieden, wie der Service in den eigenen Workflow eingebunden wird (claude.ai DCR oder mcp-approval2-OBO)
- [ ] Restore-from-backup dry-run (`pg_restore` gegen Throwaway-DB) — **Post-Pilot acceptable**, Pflicht vor erstem echten User-Daten-Tag
