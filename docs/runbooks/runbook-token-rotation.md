# Runbook — Token + Secret Rotation

> **Owner:** Axel
> **Stand:** 2026-05-16
> **Schwester-Dokus:** [SECURITY.md](../SECURITY.md), [PLAN-hardening.md](../plans/active/PLAN-hardening.md), [runbook-fly-deploy.md §"Secrets rotation"](./runbook-fly-deploy.md)

Cadenz-Übersicht für alle rotations-relevanten Secrets + Tokens. Kalendrisch in einem Apple-Calendar / Google-Calendar wiederkehrend einplanen.

## Cadenz-Übersicht

| Secret | Cadenz | Aktion bei Rotation | Risiko bei Skip |
|---|---|---|---|
| **Doppler Personal-Token** (`workplace:admin`) | 90 Tage | UI: Profile → Personal Tokens → Generate + Revoke alt. `.dev.vars` updaten lokal. | Kompromittierter Token = volle Doppler-Workplace-Lesemöglichkeit aller Projekte |
| **Doppler Service-Tokens** (`hetzner-vm-readonly`, `github-actions-readonly`) | 180 Tage | `terraform apply -replace=doppler_service_token.knowledge2_hetzner_vm` (im mcp-approval2/terraform/environments/privat) ODER UI → Service Tokens → Regenerate. VM .doppler-token aktualisieren, GH-Repo-Secret aktualisieren. | Read-only auf privat-Config → Daten-Read ohne Write-Möglichkeit |
| **`SERVICE_TOKEN`** | pro `[deploy]`-Push (~bei jedem Code-Deploy) | `SERVICE_TOKEN=$(openssl rand -hex 32) doppler secrets set SERVICE_TOKEN="$SERVICE_TOKEN" --project mcp-knowledge2 --config fly --silent && unset SERVICE_TOKEN`. Re-sync + redeploy. **Wenn OBO aktiv ist:** approval2-Side parallel updaten (Config `hetzner`). | Kompromittierter Token = `/v1/internal/*`-Vollzugriff (Erase-User, Health-Deep) |
| **`CLOUDFLARE_API_TOKEN`** | quartalsweise (4x/Jahr) | CF Dashboard → My Profile → API Tokens → Roll. Doppler updaten + sync + redeploy. | Embedding-API-Quota-Misuse, Gateway-Hijack |
| **`CLOUDFLARE_AI_GATEWAY_TOKEN`** (falls Authenticated-Mode) | quartalsweise | CF Dashboard → AI Gateway → Settings → Regenerate. Doppler updaten + sync + redeploy. | Direkter Embedding-API-Bypass |
| **Google OAuth Client Secret** | bei Personalwechsel / Suspicion / max 1x/Jahr | GCP Console → APIs & Services → Credentials → OAuth 2.0 Client → Reset Secret. Doppler updaten + sync + redeploy. | Login-Flow-Hijack möglich (aber `ALLOWED_EMAILS` schützt) |
| **`DB_ADMIN_PASSWORD`** (Postgres `knowledge_admin`) | bei Suspicion oder 1x/Jahr | Neon Console → Project `mcp-knowledge2` → Roles → `knowledge_admin` → Reset Password. Anschliessend `terraform apply` in `mcp-approval2/terraform/environments/privat/` (pusht neue `DATABASE_ADMIN_URL` in Doppler) + sync + redeploy. | `BYPASSRLS`-Zugriff auf Postgres |
| **`DB_APP_PASSWORD`** (Postgres `knowledge_app`) | bei Suspicion | Neon Console → Roles → `knowledge_app` → Reset Password. `terraform apply` pusht neue `DATABASE_URL` automatisch in Doppler. | RLS-bounded Zugriff |
| **`BACKUP_MASTER_KEY`** | **NIE** routinemäßig rotieren | Wenn Rotation Pflicht: alten Key in separater Vault aufbewahren, ein Migrations-Skript schreiben das alle bestehenden encrypted Files mit altem Key decryptet + neuem Key re-encryptet. | Alte Backups un-dekryptierbar |
| **`KMS_MASTER_KEY_B64`** (KMS_PROVIDER=hkdf_local) | **NIE** routinemäßig | Wenn Pflicht: alle Object-Bodies offline re-encrypt mit neuem Key (selbe Problematik wie BACKUP). Bei `KMS_PROVIDER=openbao` wird stattdessen die Transit-Engine versionsbasiert rotiert (multi-version reads). | Alle Bodies un-dekryptierbar |
| **Fly `FLY_API_TOKEN`** (für TF) | 180 Tage | `fly auth logout && fly auth login && fly auth token` → in lokale ENV / Doppler `FLY_API_TOKEN` updaten. | Fly-App-Steuerung-Hijack |
| **EdDSA Signing Keys** (OAuth-Facade) | 90 Tage (automatisch via `rotateSigningKey()`) | Cron in src/auth/signing_keys.ts triggert automatisch — manuelle Aktion nicht nötig. Alte Keys bleiben für Token-Verify-Fenster aktiv. | Token-Forgery wenn Key leaked |

## Kalender-Setup

**Empfohlene Recurring Events in Apple/Google Calendar:**

| Event-Titel | Cadenz | Erinnerung | Action-Items im Notes-Feld |
|---|---|---|---|
| 🔑 `mcp-knowledge2`: Doppler Personal-Token rotieren | alle 90 Tage | 1 Tag vorher | „Profile → Personal Tokens → Generate, in .dev.vars eintragen, alten revoken" |
| 🔑 `mcp-knowledge2`: CF API Token + AI Gateway Token rotieren | quartalsweise | 1 Tag vorher | „CF Dashboard → API Tokens → Roll. Doppler updaten + bash sync-secrets.sh + fly deploy" |
| 🔑 `mcp-knowledge2`: Doppler Service-Token rotieren | alle 180 Tage | 1 Tag vorher | „terraform apply -replace=doppler_service_token.knowledge2_*. VM + GH-Repo-Secrets updaten" |
| 🔑 `mcp-knowledge2`: Fly API Token rotieren | alle 180 Tage | 1 Tag vorher | „fly auth logout && fly auth login && fly auth token. TF_VAR oder Doppler updaten" |
| 🔍 `mcp-knowledge2`: Doppler-Audit-Log review | quartalsweise | 1 Tag vorher | „Dashboard → Activity Logs → unbekannte Zugriffe seit letztem Quartal?" |
| 🔄 `mcp-knowledge2`: Restore-Dry-Run | jährlich | 1 Woche vorher | „PLAN-hardening.md §5 — `tsx scripts/restore-backup.ts` gegen Throwaway-DB" |

## Notfall-Rotation (Kompromittierungs-Verdacht)

Wenn ein Secret als geleakt eingestuft wird:

1. **Sofort** in Doppler revoken (UI → Secret → Roll Value)
2. `bash deploy/fly/sync-secrets.sh` + `fly deploy -a mcp-knowledge2` für sofortiges Pickup
3. Bei `SERVICE_TOKEN`: approval2-Side parallel updaten falls OBO aktiv ist (Race-Window von ~30s mit „401 from approval"-Brücke)
4. Bei `BACKUP_MASTER_KEY` / `KMS_MASTER_KEY_B64`: **NICHT panisch rotieren** — erst Re-Encrypt-Skript schreiben, sonst sind Daten verloren
5. Audit-Log in `audit_log`-Tabelle checken auf verdächtige Aktivitäten
6. CF-Logs (wenn `enable_knowledge2_fly_cf=true`): Dashboard → Security → Events
7. Doppler-Activity-Log: Dashboard → Activity → unbekannte Zugriffe identifizieren

## Was NICHT rotiert wird

- **Vertex AI Service Account JSON**: nur wenn `EMBED_PROVIDER=vertex` aktiv (Default ist `cloudflare`, also irrelevant)
- **OpenBao Token**: nur wenn `KMS_PROVIDER=openbao` aktiv (Default `hkdf_local`)
- **GitHub Personal Access Token** (`GHCR_TOKEN`): nur für private container-image-Pulls, optional

## Referenzen

- [SECURITY.md](../SECURITY.md) — Threat-Model + Rotation-Risk-Diskussion
- [PLAN-hardening.md](../plans/active/PLAN-hardening.md) — H6 ist dieses Runbook
- [runbook-fly-deploy.md §"Secrets rotation"](./runbook-fly-deploy.md) — App-spezifische Befehle
- [`scripts/restore-backup.ts`](../../scripts/restore-backup.ts) — Restore-Test-Skript für Backup-Verify
