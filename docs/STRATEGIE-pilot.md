# Strategie — Pilot auf Fly.io (aktive Linie)

> **Stand 2026-05-17 Pilot-Deploy-Day:** Pilot ist **end-to-end LIVE**. `https://mcp-knowledge2.fly.dev/health/ready` grün (`{"status":"ready","checks":{"db":"ok","blob":"ok"}}`). Schwester `https://mcp2.ai-toolhub.org/health` ebenfalls grün. 3 Deploy-Bugs gefixt (pg-boss v10 createQueue, `/health/ready`-Differenzierung, R2 EU-jurisdiction-Endpoint mit `.eu.`). 4 Punkte offen für 2026-05-18 — siehe [PILOT-READINESS.md §"Offen für 2026-05-18"](./PILOT-READINESS.md#offen-für-2026-05-18-pilot-deploy-day-tail). Schwester-Doku: [`mcp-approval2/docs/privat.md`](https://github.com/axel-rogg/mcp-approval2/blob/main/docs/privat.md).
>
> **Stand 2026-05-17:** Postgres-Backend von Fly MPG auf Neon Free Tier umgestellt — siehe [PLAN-fly-terraform.md](plans/active/PLAN-fly-terraform.md) + Schwester-Repo [`mcp-approval2/terraform/environments/privat/neon-knowledge2.tf`](https://github.com/axel-rogg/mcp-approval2/blob/main/terraform/environments/privat/neon-knowledge2.tf).
>
> **Status:** ✅ **Live, 2026-05-17** — Authoritative für die produktive Inbetriebnahme. Single-Target auf Fly.io (Frankfurt). Railway als optionaler Fallback dokumentiert. Cloudflare Workers als Compute-Target ist geprüft + bewusst geparkt (siehe [STRATEGIE.md](./STRATEGIE.md)).
> **Owner:** Axel
> **Voraussetzung:** AS-3 Code-Complete auf `feat/as3-cutover`.

Dieses Dokument legt die ehrliche Pilot-Linie fest, nachdem die Dual-Runtime-Idee (Node + CF Workers aus einer Codebase) gegen Kosten und Aufwand gerechnet wurde. Es ersetzt die früher autoritative [STRATEGIE.md](./STRATEGIE.md), die jetzt als „geparkt, wiederanlauffähig" gekennzeichnet ist.

## 1. Entscheidung

| Was | Entscheidung | Begründung in einem Satz |
|---|---|---|
| Compute-Target privat-Pilot | **Fly.io Frankfurt** | passt 1:1 zum heutigen Code (`@hono/node-server` + `pg` + `pg-boss`), DSGVO-tauglich, ~3-4 €/Monat (Postgres separat auf Neon Free), Runbook + Deploy-Skript existieren |
| Postgres-Backend | **Neon Free Tier (eu-central-1 Frankfurt)** | 0 €/mo, pgvector + pg_trgm built-in, TF-managed in `mcp-approval2/terraform/environments/privat/neon-knowledge2.tf`. Ersetzt Fly MPG (~38 $/mo Basic-Plan) für Solo-Pilot. |
| Fallback-Target | **Railway (EU-Region)** | gleiches Dockerfile, kein Code-Refactor, ~5-10 €/mo Hobby-Tier — als Reissleine wenn Fly mal preislich rauskommt oder ein Zweit-Standort gewünscht wird |
| Cloud Run / Hetzner | weiter dokumentiert, aber nicht im Pilot-Pfad | Cloud Run lohnt erst bei CMEK/VPC-SC; Hetzner-Compose-Skeleton bleibt für Selbsthosting-Pilot-Customer |
| Cloudflare Workers | 🅿️ **geparkt** | 6-8 Tage Refactor + Faktor 4-6 höhere Kosten (Neon Pro), kein konkreter Trigger heute. Siehe [STRATEGIE.md](./STRATEGIE.md) für den Wiederanlauf-Pfad. |
| D1 als Postgres-Ersatz | ❌ ausgeschlossen | SQLite-Engine, keine pgvector/RLS/tsvector-Kompatibilität — Parallel-Implementierung, kein Switch. Wer das will: Legacy-Repo [`mcp-knowledge`](https://github.com/axel-rogg/mcp-knowledge). |

## 2. Kosten- und Effort-Vergleich (Grundlage der Entscheidung)

Stand-Check 2026-05-16, Pilot-Volumen (Solo-User, niedrige Last). Vor Pilot-Sign-off einmal frisch verifizieren — die Provider-Preise ändern sich gelegentlich.

| Stack | Compute | DB | Blob | Extra | **Realistisch / Monat** | **Aufwand bis Pilot** |
|---|---|---|---|---|---|---|
| **Fly.io** (gewählt) | shared-cpu-1x 512 MB always-on ~3 € | Neon Free Tier (0,5 GB, 0,25 CU shared) 0 € | Tigris/R2 <1 € | — | **~3-4 €** | **0-½ Tag** (Doppler füllen + Deploy einmal durchziehen) |
| **Railway** (Fallback) | Hobby-Plan $5 inkl. Usage-Credit | Postgres-Add-on aus Credit | externes R2/B2 <1 € | — | **~5-10 €** | **½ Tag** (neues Deploy-Skript + Doppler-Config + EU-Region-Verify) |
| **Cloud Run** | minScale=1 ~7-8 € | Cloud SQL db-custom-1-3840 ~50 € | GCS <1 € | — | **~60 €** | **½-1 Tag** (Manifest-Dim-Mismatch fixen) |
| **CF Workers + Neon + Hyperdrive** | Workers Free oder $5 | Neon Pro ~$19 (Free-Tier 0,5 GB reicht nicht) | R2 Free <10 GB | Hyperdrive ~$5-15 | **~25-40 €** | **6-8 Tage Refactor** + laufende Doppel-Maintenance |

## 3. DSGVO-Posture für privat-Pilot

- **Compute** Fly.io Frankfurt — EU-only, etablierte Region für DE/EU-Solo-Operatoren.
- **Datenbank** Neon Free Tier `eu-central-1` (Frankfurt-AWS), pooled via PGBouncer-Endpoint. TLS via Neon, kein Public-Hop ausserhalb EU.
- **Blob** Tigris EU-Region (empfohlen, weil flycast-nah) oder R2 EU (Cloudflare-EU-PoPs). Hetzner OS EU als Alternative.
- **Embedding** Cloudflare Workers AI in CF-EU-Edges via dedicated AI Gateway `mcp-knowledge2`. Bge-m3 ist Open-Source — Inversion-Mitigation siehe [SECURITY.md §"Embedding-inversion attack"](./SECURITY.md#embedding-inversion-attack--residual-risk).
- **PII** wird vor jedem Embedding-Call durch `maskPII` ersetzt (Emails, IBAN, IPs, Phones, UUIDs, URLs → Sentinels).

Keine Cross-Provider-Hops im Default-Pfad. OBO-Bridge zu mcp-approval2 ist opt-in (nur wenn `MCP_APPROVAL_JWKS_URL` gesetzt).

## 4. Verbleibender Aufwand bis erster grüner Smoke

Siehe [PILOT-READINESS.md §"Sign-off checklist"](./PILOT-READINESS.md#sign-off-checklist) — die kanonische Checkliste. Kurzfassung mit Stand 2026-05-16:

1. **Doppler-Secrets** (Config `mcp-knowledge2 / fly`):
   - ✅ `SERVICE_TOKEN`, `BACKUP_MASTER_KEY`, `KMS_MASTER_KEY_B64`, `DB_ADMIN_PASSWORD` am 2026-05-16 generiert + gepusht (4 von 11)
   - ✅ `DATABASE_URL`, `DATABASE_ADMIN_URL`, `DB_APP_PASSWORD`, `DB_ADMIN_PASSWORD` werden seit 2026-05-17 von Terraform (Neon-Provider in `mcp-approval2/terraform/environments/privat/neon-knowledge2.tf`) automatisch in Doppler gepusht — kein manuelles `fly postgres`-Step mehr nötig.
   - ⚠️ Offen (5 Keys, alle User-Action-abhängig): `BLOB_ENDPOINT`, `BLOB_ACCESS_KEY`, `BLOB_SECRET_KEY`, `BLOB_BUCKET`, `BACKUP_BUCKET` (Blob-Provider provisionieren)
2. ~~**Skript-Default Doppler-Config-Slug**~~ ✅ 2026-05-16 zwei Schritte: erst von `prd_fly` auf `privat` aliasiert, dann auf `fly` umgestellt — Klartext am Deploy-Target (`deploy/fly/deploy.sh` + `deploy/fly/sync-secrets.sh` + `deploy/fly/README.md` + `fly.toml`-Kommentar).
3. ~~**Restore-Skript schreiben**~~ ✅ am 2026-05-16 — [scripts/restore-backup.ts](../scripts/restore-backup.ts) als Inverse von [src/crons/backup.ts](../src/crons/backup.ts) (AES-256-GCM-decrypt, mirrored AAD-Format).
4. **Blob-Provider entscheiden** (Tigris empfohlen) + 2 Buckets erstellen (`mcp-knowledge2-blob-eu` + `mcp-knowledge2-backup-eu`, letzteres mit 30d-Lifecycle). → **User-Aktion**
5. **Neon-Bootstrap einmalig**: `psql "$DATABASE_ADMIN_URL" -c 'CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;'` (beide Rollen `knowledge_app` + `knowledge_admin` sind Mitglied der Neon-`neon_superuser`-Gruppe inkl. BYPASSRLS — keine extra GRANTs nötig).
6. **`bash deploy/fly/deploy.sh`** einmal komplett durchziehen. Die früheren Postgres-Schritte (`fly postgres create` + `attach` + manuelles `knowledge_admin`-SQL) sind obsolet — TF hat alles vorbereitet. → **User-Aktion**
7. **Smoke-Test** gegen `https://mcp-knowledge2.fly.dev` (Health + Round-Trip + RLS-Isolation, siehe [PILOT-READINESS Sign-off-Checklist](./PILOT-READINESS.md#sign-off-checklist)).
7. **Auth-Pfad festlegen** — für Solo-User axelrogg@gmail.com: Google-OAuth-Login an der eigenen KC2-Facade. Details im [Integration-Guide](./INTEGRATION.md).

## 5. Fly + Terraform (Code vorbereitet 2026-05-16)

**Entscheidung 2026-05-16:** Hybrid umsetzen — TF managt die stabilen Fly-Resources (App + IPv6) sowie seit 2026-05-17 das gesamte Postgres-Backend bei Neon. flyctl bleibt für Image-Build, Deploy und Fly-Secret-Sync verantwortlich.

**Vorbereitet** in `mcp-approval2/terraform/`:
- `fly-apps/fly`-Provider in `versions.tf` (Root + `environments/privat/`) deklariert (`~> 0.0.23`)
- `environments/privat/knowledge2-fly.tf` neu — `fly_app.knowledge2` + `fly_ip.knowledge2_v6` (dedicated IPv6 free, dedicated IPv4 bewusst weggelassen weil shared-v4 reicht für Pilot)
- `variables.tf` um `fly_org` (default `personal`) ergänzt
- `terraform.tfvars.example` mit Fly-Block: `FLY_API_TOKEN` via env-var (nicht in tfvars, vermeidet State-Leak)
- `deploy/fly/deploy.sh` Schritt 1 sieht TF-managed App und skippt sauber

**Verbleibend für User:** `export FLY_API_TOKEN=$(fly auth token)` + `terraform plan` + `apply` (~15 min). Falls die App vorher schon via flyctl existierte: `terraform import fly_app.knowledge2 mcp-knowledge2` zuerst.

Coverage-Matrix + Apply-Pfad + Plan-File-Status siehe [PLAN-fly-terraform.md](./plans/active/PLAN-fly-terraform.md).

## 6. Operative Mechanik

### Wie Pilot-Pfad heute aussieht (kein Refactor nötig)

```bash
# Voraussetzung: flyctl + doppler + jq installiert, Doppler-Login + Project-Setup gemacht
DOPPLER_CONFIG=privat bash deploy/fly/deploy.sh
```

Skript ist idempotent. Postgres ist seit 2026-05-17 TF-managed bei Neon — die früheren `fly postgres create`/`attach`-Schritte und das manuelle `knowledge_admin`-SQL entfallen. Nach Deploy:

```bash
fly logs -a mcp-knowledge2
fly secrets list -a mcp-knowledge2
curl -sf https://mcp-knowledge2.fly.dev/health
```

### Wie Railway-Fallback aussehen würde (zukünftig)

```bash
DEPLOY_TARGET=railway bash deploy/install.sh
```

Würde voraussetzen: `deploy/railway/deploy.sh` neu (existiert noch nicht), nutzt das vorhandene Dockerfile, eigenen Doppler-Config `prd_railway`. **Nicht im aktuellen Pilot-Scope** — erst wenn Fly konkret rauskommt.

### Wie CF Workers wieder ins Spiel käme

Nur wenn einer der vier Trigger eintritt:
- Pilot-Customer verlangt explizit CF Workers (Coop-/Enterprise-Setup)
- Echte globale Edge-Latenz-Anforderung (<100 ms p95 weltweit) — für Single-User-Pilot irrelevant
- Coop-Zscaler-Bypass-Pattern (wie bei [mcp-approval](https://github.com/axel-rogg/mcp-approval) mit `*.workers.dev` als parallele Domain)
- Scale-to-zero ohne Cold-Start-Pain bei extrem schwankender Last

Dann: PLAN-dual-runtime.md aus der Geparkt-Liste ziehen, Phase 0 starten — siehe [PLAN-dual-runtime.md](./plans/active/PLAN-dual-runtime.md).

## 7. Backup-Strategie (Pilot-Default)

**Heutiger Stand bleibt:** in-App-Cron `src/crons/backup.ts` macht täglich 03:00 UTC ein `pg_dump --format=custom`, verschlüsselt mit `BACKUP_MASTER_KEY`, lädt nach `s3://${BACKUP_BUCKET}/backup/<ts>.dump.enc`. Retention: `BACKUP_RETENTION_DAYS=30`.

**Plus Neon's eingebauter Backup-/PITR-Layer** — Free Tier hält `history_retention_seconds` bis 6 h (Hard-Limit), Branching für Point-in-Time-Recovery. UI: Neon Console → Project → Branches. Falls echtes Customer-Volumen kommt, lohnt sich der Upgrade auf Neon Launch (~$5/mo, 7d Retention).

**Restore-Pfad heute:** Manuell — decrypt + `pg_restore`, dokumentiert in [runbook-fly-deploy.md §"Manual disaster restore"](./runbooks/runbook-fly-deploy.md#manual-disaster-restore-app-level-backup). `scripts/restore-backup.ts` ist im Runbook referenziert, existiert aber nicht — Post-Pilot-Followup.

Die in [STRATEGIE.md §9](./STRATEGIE.md) skizzierte „Backup-an-Plattform-delegieren"-Linie bleibt korrekt, ist aber nur dann Pflicht, wenn der Workers-Refactor wiederaufgenommen wird (weil Workers `pg_dump` nicht spawnen können). Für Fly-only ist der jetzige In-App-Cron acceptable.

## 8. Was sich beim Pilot-Cutover NICHT mehr ändert

Damit der Aufwand wirklich klein bleibt:

- **Keine Treiber-Wahl** — `pg` bleibt.
- **Keine Adapter-Multiplikation** — kein R2-Native-Binding, kein Cloud-KMS-HTTP, kein Scheduler-Interface.
- **Kein Source-Layout-Refactor** — `src/server.ts` bleibt der einzige Entry-Point.
- **Keine zweite Build-Pipeline** — `npm run build` wie heute, `Dockerfile` unverändert.
- **Keine wrangler.toml**, kein zweiter CI-Build.

Alles davon ist in STRATEGIE.md / PLAN-dual-runtime.md ausgearbeitet, aber **nicht jetzt nötig**.

## 9. Nächste Schritte (konkret, Stand 2026-05-16)

**Erledigt (autonom durch Agent vorbereitet):**

1. ~~[PILOT-READINESS.md](./PILOT-READINESS.md) auf heutigen Stand bringen~~ ✅ 2026-05-16
2. ~~4 Random-Doppler-Secrets generieren + pushen~~ ✅ 2026-05-16 (`SERVICE_TOKEN`, `BACKUP_MASTER_KEY`, `KMS_MASTER_KEY_B64`, `DB_ADMIN_PASSWORD`)
3. ~~Doppler-Config-Slug klar am Deploy-Target benannt: `fly`~~ ✅ 2026-05-16 (alte `privat`-Config bleibt als Backup)
4. ~~Restore-Skript schreiben~~ ✅ 2026-05-16 — [scripts/restore-backup.ts](../scripts/restore-backup.ts)
5. ~~`npm run lint` clean machen~~ ✅ — war bereits clean (max-warnings=0 exit 0)
6. ~~Compute-Target-Doku auf Fly-primary umstellen~~ ✅ (CLAUDE.md, README.md, STRATEGIE-Banner)
7. ~~Integration-Guide schreiben~~ ✅ [INTEGRATION.md](./INTEGRATION.md)
8. ~~Fly-Terraform-Files vorbereiten~~ ✅ 2026-05-16 — `mcp-approval2/terraform/environments/privat/knowledge2-fly.tf` + Provider in `versions.tf` + `fly_org`-Var + tfvars-Example-Block + deploy.sh-Idempotenz-Notiz
9. ~~Rate-Limit-Middleware live~~ ✅ 2026-05-16 — [src/middleware/rate_limit.ts](../src/middleware/rate_limit.ts) auf 4 OAuth-Routen (register/authorize/callback/token), 6 Unit-Tests, 22/22 grün
10. ~~CF-Reverse-Proxy-TF vorbereitet~~ ✅ 2026-05-16 — `knowledge2-fly-cf.tf` mit CNAME + WAF-Rate-Limit + SSL-strict, prep-only mit `enable_knowledge2_fly_cf=false` Default (siehe [PLAN-hardening.md §2](./plans/active/PLAN-hardening.md))
11. ~~Token-Rotation-Runbook~~ ✅ 2026-05-16 — [runbook-token-rotation.md](./runbooks/runbook-token-rotation.md) mit Cadenz-Tabelle + Kalender-Setup

**Offen (User-Aktion benötigt):**

9. Blob-Provider entscheiden + 2 Buckets erstellen (Tigris empfohlen) — Accounts, Billing-Decision.
10. 5 Blob-bezogene Doppler-Keys füllen sobald Buckets stehen (`BLOB_ENDPOINT`, `BLOB_ACCESS_KEY`, `BLOB_SECRET_KEY`, `BLOB_BUCKET`, `BACKUP_BUCKET`).
11. `flyctl auth login` — Browser-Login auf User-Maschine.
12. `export FLY_API_TOKEN=$(fly auth token)` + `terraform plan -target=fly_app.knowledge2 -target=fly_ip.knowledge2_v6` + `apply` aus `mcp-approval2/terraform/environments/privat/`. Siehe [PLAN-fly-terraform.md §8](./plans/active/PLAN-fly-terraform.md). Falls die Fly-App vorher schon manuell angelegt wurde: zuerst `terraform import fly_app.knowledge2 mcp-knowledge2`.
13. `bash deploy/fly/deploy.sh` einmal durchziehen — Schritt 1 (App-Create) skippt weil TF die App schon angelegt hat; Postgres-Schritte sind obsolet (Neon TF-managed); Secrets + Deploy laufen weiter.
14. **Neon-Bootstrap (einmalig):** `psql "$(doppler secrets get DATABASE_ADMIN_URL --plain --project mcp-knowledge2 --config fly)" -c 'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;'`. Danach `bash deploy/fly/sync-secrets.sh && fly deploy -a mcp-knowledge2` falls ein nachträgliches Secret-Refresh nötig wurde.
15. Smoke-Test gegen `https://mcp-knowledge2.fly.dev` (siehe [PILOT-READINESS Smoke-Section](./PILOT-READINESS.md#smoke-test-cuts-the-pilot-ready-ribbon)).
16. Erste 24h beobachten: Backup-Cron läuft 03:00 UTC → Datei in `BACKUP_BUCKET/backup/` checken, dann Restore-Dry-Run mit `scripts/restore-backup.ts` als Sign-off-Beweis.

## 10. Referenzen

- [`mcp-approval2/docs/privat.md`](https://github.com/axel-rogg/mcp-approval2/blob/main/docs/privat.md) — Spiegel-Doku im Schwester-Repo: approval2 privat-Mode + Shared-Resource-Strategie mit knowledge2 + Provider-Switch-Matrix zu Google Cloud
- [PILOT-READINESS.md](./PILOT-READINESS.md) — kanonische Sign-off-Checkliste
- [INTEGRATION.md](./INTEGRATION.md) — wie der Service in den eigenen Workflow (claude.ai, mcp-approval2) eingebunden wird
- [PLAN-fly-terraform.md](./plans/active/PLAN-fly-terraform.md) — Fly-IaC, Code vorbereitet 2026-05-16, `terraform apply` pending User-Go
- [PLAN-hardening.md](./plans/active/PLAN-hardening.md) — Pre-Pilot-Hardening (H1-H7), 2026-05-16 teilweise live
- [runbook-fly-deploy.md](./runbooks/runbook-fly-deploy.md) — Day-2-Ops auf Fly
- [runbook-token-rotation.md](./runbooks/runbook-token-rotation.md) — Cadenz für Secret-Rotation
- [deploy/fly/README.md](../deploy/fly/README.md) — Erst-Deploy-Mechanik
- [STRATEGIE.md](./STRATEGIE.md) — geparkter Dual-Runtime-Plan, falls Workers-Trigger eintritt
- [PLAN-dual-runtime.md](./plans/active/PLAN-dual-runtime.md) — geparkte Implementation-Phases
- [CLAUDE.md](../CLAUDE.md) — Repo-Kontext, Compute-Target-Tabelle
