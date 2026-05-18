# mcp-knowledge2 — Kontext für Claude Code

> **Storage- und Sharing-Service** + **autonomer MCP-Server** (post-AS-3).
> Single-Tenant (1 Firma = 1 Instance), Multi-User mit Postgres-RLS.
> Schwester-Repo: [mcp-approval2](https://github.com/axel-rogg/mcp-approval2).
>
> **🚀 Update 2026-05-18 — Group-Sharing Phase 2 Code-Complete, Deploy-pending.** KC2-Side der cross-repo Phase-2-Welle. Migrationen 0023 (Cross-Member-Visibility via `is_active_member_of` SECURITY DEFINER), 0024 (`owner_or_writer_modify` mit group-write-Pfad), 0025 (`groups_owner_modify` split fuer Owner-Transfer mit WITH-CHECK auf is_active_member_of), 0026 (`rewrap_jobs` async-Worker-Queue + KMS-wrapped Old-Master + status-state-machine). `src/storage/groups.ts` mit `transferGroupOwnership`-TX (FOR UPDATE auf groups.id, new-owner muss aktives Member sein, beide bleiben admin). `src/storage/rewrap.ts` mit `processRewrapJobsTick`-Worker (admin-TX, batch=100, idempotent via group_master_version-Filter, post-completion-wipe old_master_kms_wrapped). `src/routes/internal.ts` um `POST /v1/internal/rewrap-tick` + `GET /v1/internal/rewrap-jobs` (Service-Token scope=ops). `src/routes/groups.ts` um `POST /v1/groups/:id/transfer-ownership`. `src/routes/shares.ts` CreateShareWithGroupBody scope auf `read|write` erweitert. Test-Coverage: 34 RLS-Integration-Tests (Phase 1: 31, +3 p2-3-a/b/c + 3 p2-4-a/b/c). **Deploy-Blocker:** Neon-Role-Grant noetig (knowledge_app fehlt REFERENCES auf users-Tabelle aus Mig 0006-REVOKE). Operator-Step in [docs/runbooks/runbook-neon-role-grants.md](docs/runbooks/runbook-neon-role-grants.md). GH-Actions Cron `*/2` fuer rewrap-tick in `.github/workflows/rewrap-tick.yml`.
>
> **🚀 Update 2026-05-17 spätabend — Phase-1 Group-Sharing LIVE-Deploy.** Cross-Repo-Feature komplett: Schema-Migrationen 0019 (groups + group_members + share_grants extension + RLS-Patch + RESTRICTIVE-INSERT) + 0020 (object_revisions.dek_scheme + Diamond-Index Split + FK-Constraints). AAD-Discriminated-Union v2 für per_object-DEK. KMS wrapBytes/unwrapBytes auf KmsProvider-Interface (CloudKms via GCP-Roundtrip, HKDF-Local via AES-Master, OpenBao deprecated). `src/storage/group-crypto.ts` mit 3 Wrap-Schichten (owner / member / object-via-group) + 5min Process-Cache. Lazy-Migration owner_hkdf→per_object beim ersten Share (R2-Caveat dokumentiert). readObject/updateObject Dispatch je dek_scheme (501-Throw raus). `src/storage/groups.ts` mit Member-Remove-Master-Rotation in einer TX (FOR UPDATE auf groups.id, Hard-Cap 1000 Grants). `src/storage/shares.ts` createShareWithGroup + revokeCascadeSharesFrom. `src/routes/groups.ts` mit 7 Endpoints unter /v1/groups/*. Cascade-Hook in `refs.ts:addRef` mit Subtype-Filter (`parent.subtype='skill_manifest'` + `parent.cascade_on_share=TRUE` + `role IN BUNDLE_ROLES`). Test-Coverage: 19 group-crypto Unit-Tests + 5 AAD-Domain-Separation + 15 RLS-Integration-Tests in `tests/integration/groups.test.ts`. Volle Pre-Build-Reviews (Crypto, Plan, Test) in docs/security/.
>
> **Status 2026-05-15:** AS-3-Code-Complete + **Generic-Object-Model** + **Vulnerabilities-Fix** + **CF Workers AI Embeddings** + **subtype_prefix Query** auf Branch `feat/as3-cutover`. Cutover-Day pending — siehe
> [docs/runbooks/runbook-as3-cutover.md](docs/runbooks/runbook-as3-cutover.md).
>
> **Update 2026-05-17 Multi-User-Sprint:** Sicherheits-Sprint abgeschlossen. Alle 3 grossen Multi-User-Blocker gefixt: SEC-K-005 (HKDF-Salt mit `users.dek_salt`-Mix + Re-Encrypt-Script), SEC-K-009 (Service-Token-Split scope-spezifisch ERASE/SYNC/OPS), SEC-K-016 (Erase-Receipt-JWS mit `payload.sub===body.user_id`-Binding). Plus SEC-K-024 (embed-salt postfix gegen Cross-User-Inference-Oracle), MUSS-Items §4.1.1/2/3 (audit-strip 3→9 keys, hardDelete-receipt-flag, displayName-control-chars-sanitize), rls.test.ts auf alle 9 RLS-Tabellen — die Erweiterung deckte 1 neue CRITICAL SEC-K-NEW auf (share_grants PERMISSIVE-OR-Bypass → Migration 0016 RESTRICTIVE-policy). Sprint-Closure-Matrix + Operator-Activate-Steps in [docs/plans/active/PLAN-multi-user-readiness.md](docs/plans/active/PLAN-multi-user-readiness.md). Status-Übersicht aller Findings in [docs/security/SECURITY_ISSUES.md](docs/security/SECURITY_ISSUES.md) Sprint-Stand-Block. **Cross-Repo-Pendant** in [mcp-approval2 commit 9c4813f](https://github.com/axel-rogg/mcp-approval2/commit/9c4813f) (scope-tokens + signEraseReceipt).
>
> **Update 2026-05-17 Pilot-Deploy-Day:** Pilot ist **end-to-end LIVE** auf Fly.io fra. `https://mcp-knowledge2.fly.dev/health/ready` → `{"status":"ready","checks":{"db":"ok","blob":"ok"}}`. Schwester-Service `https://mcp2.ai-toolhub.org/health` ebenfalls grün. TLS-Cert für `knowledge2.ai-toolhub.org` validating via DNS-01 (managed by `fly_cert.knowledge2` im Schwester-Repo TF, freshly imported heute). **Postgres**: Neon Free Tier `mcp-knowledge2` in eu-central-1 Frankfurt, pgvector 0.8.0 + pg_trgm 1.6 installiert, 12 Migrations 0001-0011 + `_meta` durch `release_command = "npm run db:migrate"` auf jedem Deploy auto-applied (idempotent). Beide Rollen `knowledge_app` + `knowledge_admin` sind Mitglied der `neon_superuser`-Gruppe → keine extra GRANTs nötig (anders als Schwester-Service approval2). **KEK-Provider**: Google Cloud KMS `europe-west3` (single-region, NICHT `eu` multi-region — bekannter google-Provider-6.x-Bug `KMS_RESOURCE_NOT_FOUND_IN_LOCATION`). Service-Account `mcp-knowledge2-fly@axelrogg-ai-tools.iam.gserviceaccount.com` mit `cloudkms.cryptoKeyDecrypter` auf shared KeyRing. `CLOUD_KMS_WRAPPED_MASTER_B64` in Doppler, `KEK_PROVIDER=cloud_kms`. **Vertex AI**: separater SA `mcp-knowledge2-vertex@axelrogg-ai-tools.iam.gserviceaccount.com` mit `aiplatform.user`, Embeddings via Vertex `text-multilingual-embedding-002` in `europe-west4`. **3 Deploy-Bugs gefixt** (commit 49cdb9a + 61cdfb9): pg-boss v10 `createQueue()`-Requirement vor `work()`/`schedule()` (sonst Boot-Crash `Queue uploads.sweep_expired not found`); `/health/ready` differenziert DB (load-bearing, fail → 503) vs Blob (opportunistic, fail → `status="degraded"` HTTP 200 damit Fly-Proxy weiter routet); R2 EU-jurisdiction-Endpoint `https://<account>.eu.r2.cloudflarestorage.com` (mit `.eu.`) statt Global — Global gibt 403 "bucket not found" für EU-Buckets, Token war korrekt scoped (Doppler-Fix, kein Code-Change). **Offene Punkte für 2026-05-18**: Token-Rotation (Doppler-Leak-Hygiene 2026-05-16: Google-OAuth-Client-Secret, R2-Tokens, JWT-Keys, internal Tokens, meist External-Console); GCP-Console OAuth-Client Redirect-URI von `https://knowledge.ai-toolhub.org/auth/google/callback` auf `https://knowledge2.ai-toolhub.org/auth/google/callback` umstellen (1 Klick); TLS-Cert für `knowledge2.ai-toolhub.org` (DNS-01 sollte morgen früh durch sein); End-to-End MCP-Test via Claude.ai (Hand-Test, exercised whole flow). **Hinweis: 5 weitere Pilot-Bug-Fixes am Abend 2026-05-17 fielen im Schwester-Repo (mcp-approval2) an** (INET-CSV, cross-subdomain cookies, drizzle parsers, OAuth-callback-redirect, audit_log-schema-drift) — siehe approval2-CLAUDE.md. KC2 ist von diesen Bugs **nicht betroffen**: eigener node-pg-Pool (kein Drizzle-scoped/transaction-Wrapper), kein PWA-Cookie-Flow, eigenes audit-Schema mit `via_proxy`+`approval_id`-Spalten (Migration 0007/0011).
>
> **Generic-Object-Model (ADR-0004, 2026-05-15)**: `kind`-Discriminator vollständig entfernt aus Schema, AAD, Routes, Types. Ein generischer Object-Typ mit free-form `subtype: string`. Convention `doc` als universaler Standard-Subtype. AAD-Format `<recordType>|<owner_id>|<object_id>`. Embedding uniform (`description != null + embed=true`). Memos uniformly shareable. Subtype-Prefix-Filter via `?subtype_prefix=` (für `app:`-Familie + ähnliche Namespaces). Siehe [GENERIC-DATA-MODEL.md](GENERIC-DATA-MODEL.md) (v3, COMPLETE) + [docs/adr/0004-generic-object-model.md](docs/adr/0004-generic-object-model.md). Migration `0009_drop_kind.sql` deploy-ready.
>
> **Vulnerabilities-Fix (2026-05-15)**: npm audit von 11 → 4 transitive moderate (alle via `@esbuild-kit/*` im drizzle-kit-Tree — kein upstream fix verfügbar, build-time-only acceptable risk). HIGH undici via testcontainers@11 gefixt. vite@8 + vitest@4 + drizzle-kit@0.31 + esbuild@0.27. Siehe [docs/plans/active/PLAN-vulnerabilities-2026-05-15.md](docs/plans/active/PLAN-vulnerabilities-2026-05-15.md).

## Architektur (Stand 2026-05-15)

```
                       Google OIDC (Authoritative IdP, AS-3-Ziel)
                                 ▲
                                 │ ID-Token verify via JWKS
                                 │
        ┌────────────────────────┴───────────────────────┐
        │                                                │
   mcp-approval2                                  mcp-knowledge2 (THIS REPO)
   (Approval-Proxy, optional)                     • Postgres + pgvector (RLS)
        │                                          • Blob: S3 (R2/B2/Hetzner) or native GCS
        │ S2S:                                     • Embeddings: CF Workers AI bge-m3 (default) or Vertex AI
        │ X-On-Behalf-Of                           • REST /v1/* + MCP /mcp (AS-3)
        │ + SERVICE_TOKEN                          • own DCR-OAuth-Facade (AS-3)
        │                                          • own users + invites (AS-3)
        ▼                                          • own KMS (OpenBao or hkdf)
   mcp-knowledge2 REST + MCP ───────────────────────────────────────────────
                                                            ▲
                                                            │  Direkt-Pfad
                                                            │  (Claude.ai
                                                            │   ohne approval2)
                                                       Claude.ai
```

**Ziel-Architektur AS-3 (Greenfield-2026-05-15):**
- Google OIDC ist Authoritative IdP für Users.
- mcp-knowledge2 wird autonom betreibbar — mit eigener DCR-OAuth-2.1-Facade für MCP-Clients (Claude.ai), eigener `users`-Tabelle, eigenem KMS.
- mcp-approval2 bleibt **optional als Approval-Proxy** davor (S2S via OBO-JWT + Service-Token).
- Beide MCP-Pfade laufen parallel: Claude.ai entscheidet per registrierter URL ob direkt zu KC2 oder via approval2.

**Stand auf `feat/as3-cutover` (AS-3 Code-Complete 2026-05-15):**
- Phase 0-6 baseline (single-shot 2026-05-13) + AS-3-Migration K1-K13 + T3
- Auth: Multi-Issuer-Verifier — Google OIDC + Self-Facade + OBO via approval2
- Eigene DCR-OAuth-2.1-Facade unter `src/auth/oauth_facade/` (Discovery, DCR, JWKS, /authorize+Google-redirect, /token+PKCE+refresh-rotation)
- Eigene `users` + `invites` + `signing_keys` + `oauth_clients` Tabellen (Migrations 0005-0008)
- KMS: eigenes Adapter-Interface — **`cloud_kms` Default seit 2026-05-17** (Google Cloud KMS **single-region `europe-west3`** seit Pilot-Deploy-Day-Fix — `eu` multi-region funktioniert mit `hashicorp/google` 6.x-Provider nicht (`KMS_RESOURCE_NOT_FOUND_IN_LOCATION, request misrouted to global`-Bug); Cost-identisch, Failover für 1 Solo-Key überdimensioniert. Siehe [mcp-approval2/docs/adr/0011-cloud-kms-kek-provider.md](https://github.com/axel-rogg/mcp-approval2/blob/main/docs/adr/0011-cloud-kms-kek-provider.md)). `openbao` ist alternative Selfhosting-Variante (verlangt Offline-Unseal-Key-Storage), `hkdf_local` ist Dev/Test-Fallback.
- MCP-Transport unter `POST /mcp` (Streamable-HTTP) — 17 Tool-Wrapper für die `/v1/*` REST-Surface (9 objects.* / 4 shares.* / 1 search / 3 uploads.*)
- Audit-Log mit `via_proxy` + `approval_id` Spalten (Cross-Service-Trail)
- Cross-Service-Contract-Tests fixieren das Wire-Format zwischen approval2 ↔ KC2

**Was auf `main` ist (pre-cutover):** nur die AS-3-Specs + dieses CLAUDE.md.
Die Code-Änderungen liegen auf `feat/as3-cutover` und werden beim Cutover gemerged.

## Plan-Index

Status-Banner oben in jedem PLAN-File.

| Plan | Status | Zweck |
|---|---|---|
| [PLAN-architecture-v2.md](docs/plans/active/PLAN-architecture-v2.md) | ⚠️ Draft (§1 JWT-Pattern superseded by AS-3; §§2.1/3.5/5.x superseded by ADR-0004) | Konsolidierte v2-Implementation-Spec (Phase 0-6 Baseline). |
| **[GENERIC-DATA-MODEL.md](GENERIC-DATA-MODEL.md)** | ✅ **IMPLEMENTED 2026-05-15** | **Generic Object Model**: kind raus, subtype free-form. Brief v3 (~720 LOC) + ADR-0004 + Migration 0009. |
| **[PLAN-vulnerabilities-2026-05-15.md](docs/plans/active/PLAN-vulnerabilities-2026-05-15.md)** | ✅ **Live 2026-05-15** | npm audit Cleanup: testcontainers@11 (HIGH undici) + vite@8 + vitest@4 + drizzle-kit@0.31 + esbuild@0.27. 4 transitive @esbuild-kit/* bleiben (acceptable risk, build-time-only). |
| [PLAN-architecture-DRAFT-from-mcp-approval2-view.md](docs/plans/active/PLAN-architecture-DRAFT-from-mcp-approval2-view.md) | Input | Caller-Sicht aus approval2, NICHT pushen (lokal). |
| [PLAN-hetzner-deployment.md](docs/plans/active/PLAN-hetzner-deployment.md) | ⚠️ Spec | Hetzner + GCP Multi-Instance |
| **[PLAN-as3-autonomous.md](docs/plans/active/PLAN-as3-autonomous.md)** | ✅ **CODE-COMPLETE 2026-05-15** | **AS-3-Migration: KC2 wird autonomer MCP-Server**. K1-K13 + T3 auf `feat/as3-cutover`. |
| **[PLAN-as3-bigbang.md](docs/plans/active/PLAN-as3-bigbang.md)** | ✅ **TIER 0-3 CODE-COMPLETE** | Cross-Repo-Cutover-Plan. Tier 4 (Cutover-Window) pending. |
| **[runbook-as3-cutover.md](docs/runbooks/runbook-as3-cutover.md)** | ✅ **Operator-Anleitung** | Step-by-Step T-7 bis T+7d für den Cutover-Tag. 452 Zeilen. |
| **[STRATEGIE-pilot.md](docs/STRATEGIE-pilot.md)** | ✅ **Aktiv 2026-05-16** | **Pilot-Linie:** Fly.io single-target. Railway dokumentiert als Fallback. CF Workers bewusst geparkt. |
| **[STRATEGIE.md](docs/STRATEGIE.md)** | 🅿️ **Geparkt 2026-05-16** | Dual-Runtime (Node + CF Workers) — Wiederanlauf-Pfad falls Workers-Trigger eintritt. |
| **[PLAN-dual-runtime.md](docs/plans/active/PLAN-dual-runtime.md)** | 🅿️ **Geparkt 2026-05-16** | Implementation-Plan zur geparkten STRATEGIE. 6 Phasen, ~6-8 Arbeitstage. |
| **[PLAN-fly-terraform.md](docs/plans/active/PLAN-fly-terraform.md)** | ⚠️ **Code vorbereitet 2026-05-16, Apply pending** | Fly via Terraform-Provider hybrid. `mcp-approval2/terraform/environments/privat/knowledge2-fly.tf` + Provider in versions.tf + fly_org-Var + tfvars-Block + deploy.sh-Notiz. Verbleibend: ~15 min für `terraform plan` + `apply`. |
| **[PLAN-hardening.md](docs/plans/active/PLAN-hardening.md)** | ⚠️ **Teilweise umgesetzt 2026-05-16** | Pre-Pilot-Hardening. Code-Side (Rate-Limit-Middleware in oauth_facade, 6 Unit-Tests) live. TF-Side (CF-Reverse-Proxy + WAF in `knowledge2-fly-cf.tf`) prep-only mit `enable_knowledge2_fly_cf=false`. Token-Rotation-Runbook neu. |
| **[INTEGRATION.md](docs/INTEGRATION.md)** | ⚠️ **Entwurf 2026-05-16** | Wie der Service nach Deploy in den eigenen Workflow eingebunden wird (claude.ai DCR-Flow + mcp-approval2-OBO-Bridge). |
| [CROSS-SERVICE-CONTRACT.md](docs/CROSS-SERVICE-CONTRACT.md) | ⚠️ Live (V1-Pattern, OBO-Erweiterung in AS-3-Spec dokumentiert) | Wire-Shape gegenüber mcp-approval2-Adapter |
| [SECURITY.md](docs/SECURITY.md) | ✅ Live | Threat-Model, Crypto-Stages, Embedding-Inversion-Risk |
| [PILOT-READINESS.md](docs/PILOT-READINESS.md) | ✅ Live | Pre-Pilot-Checkliste |

## Was bei Arbeit beachten

**Welcher Branch?** Pre-Cutover ist `main` der V1-Stand und `feat/as3-cutover` der AS-3-Stand. Wenn du AS-3-Code anfasst: auf dem Branch. Wenn du nur Docs/Specs änderst: nach `main`. Nach dem Cutover-Tag verschmelzen.

- **Auth-Code** (`src/auth/jwt.ts`, `src/auth/oauth_facade/`, `src/auth/on_behalf_of.ts`): Multi-Issuer-Pattern auf `feat/as3-cutover` umgesetzt. Bei Änderungen die JWT-Format anfassen: §1.1 + §2 im AS-3-Spec ist die Quelle, plus die Contract-Tests in `tests/contract/`.
- **KMS-Code** (`src/adapters/kms/`): drei Adapter — `cloud_kms.ts` (Default privat-Mode seit 2026-05-17), `openbao.ts` (alternative Selfhosting-Variante), `hkdf_local.ts` (Dev/Test-Fallback). Auswahl via `KMS_PROVIDER` env. **TF-managed**: das gesamte Cloud-KMS-Setup (KeyRing, CryptoKey, Service-Account `mcp-knowledge2-fly`, IAM-Binding, JSON-Key in Doppler) lebt im Schwester-Repo unter [mcp-approval2/terraform/environments/privat/gcp-kms.tf](https://github.com/axel-rogg/mcp-approval2/blob/main/terraform/environments/privat/gcp-kms.tf) — KC2 hat keinen eigenen TF-State. Project `axelrogg-ai-tools`, Location **`europe-west3`** (single-region; `eu` multi-region wegen Provider-Bug nicht möglich, siehe oben).
- **Vertex-AI-Adapter** (`src/adapters/embed/vertex.ts`): nutzt **eigenen, isolierten Service-Account** `mcp-knowledge2-vertex@axelrogg-ai-tools.iam.gserviceaccount.com` mit `roles/aiplatform.user` (Predict-only — kein Model-Training). Env-Vars `VERTEX_SERVICE_ACCOUNT_JSON`, `VERTEX_PROJECT`, `VERTEX_LOCATION` (= `europe-west4`) sind TF-managed in [mcp-approval2/terraform/environments/privat/gcp-vertex.tf](https://github.com/axel-rogg/mcp-approval2/blob/main/terraform/environments/privat/gcp-vertex.tf). Getrennter SA vom KMS-SA → Leak einer Doppler-Variable kompromittiert nur einen Concern.
- **`users` + `invites` + `signing_keys` + `oauth_clients`** Tabellen sind auf `feat/as3-cutover` via Migrations 0005-0008 angelegt. RLS-Context kommt aus `current_user` = `users.id`.
- **MCP-Transport** unter `POST /mcp` auf `feat/as3-cutover` aktiv. 17 Tool-Wrapper für die `/v1/*` REST-Surface (`src/mcp/register_tools.ts`).
- **CROSS-SERVICE-CONTRACT.md** beschreibt den V1-Adapter (approval2 → KC2 mit JWT). AS-3-Erweiterungen sind im Spec dokumentiert, Contract-Tests in `tests/contract/` sind die ausführbare Wahrheit.
- **Generic-Object-Model (ADR-0004)**: `objects.kind` Column ist **weg**. Discriminator ist `subtype: text` (free-form, zod-Regex `^[a-z][a-z0-9_:-]{0,31}$`, erlaubt `:` für caller-namespacing wie `app:composable`). `share_grants.resource_kind` und `audit_log.resource_kind` auch gedropt. AAD ist `<recordType>|<owner_id>|<object_id>` ohne subtype-Slot. Embedding-Trigger: `description != null AND request.embed === true`. `composeEmbedSource()` ist uniform. Memos sind shareable (kein Block mehr). **Cross-Repo-Sync**: mcp-approval2 Adapter + Apps-Subsystem + 3 Zod-Duplikate ko-deployed im selben Branch.
- **subtype_prefix Filter (2026-05-15, Commit `c3f72df`)**: `GET /v1/objects?subtype_prefix=app:` macht left-anchored LIKE-Match (nutzt B-Tree-Index). Mutually-exclusive mit `subtype=` (400 BAD_REQUEST wenn beide). Hybrid-Search Body: `subtype_prefixes: string[]` (kombinierbar mit `subtypes`). MCP `objects.list`-Tool unterstützt beides. Caller (mcp-approval2) hat ko-deployten Adapter (`subtypePrefix?: string`) + Apps-Subsystem nutzt serverseitig `subtypePrefix='app:'`.

## Repo-Struktur

```
mcp-knowledge2/
├── docs/plans/active/   — aktive Implementation-Specs (inkl. AS-3-Migration)
├── src/
│   ├── server.ts        — Hono-Entry
│   ├── routes/          — REST-Handler
│   ├── auth/            — JWT + Service-Token (AS-3: Multi-Issuer + OBO)
│   ├── adapters/
│   │   ├── blob/        — Factory: S3 (R2/B2/Hetzner/MinIO, default) ODER
│   │   │                  native GCS (Workload Identity, business)
│   │   ├── embed/       — Factory: Cloudflare Workers AI bge-m3 (default,
│   │   │                  via AI Gateway) ODER Vertex AI fallback
│   │   └── kms/         — DEK-Resolver: openbao (Hetzner) / cloud_kms (GCP)
│   │                      / hkdf_local (dev)
│   ├── db/              — Drizzle Schema + tx-scoped Pools
│   ├── storage/         — objects/refs/tags/revisions/shares/uploads
│   ├── search/          — FTS + Vector + RRF Hybrid
│   ├── crons/           — pg-boss Schedules
│   └── ... (lib, types, observability, quota)
├── drizzle/migrations/  — 0000_init + 0001_rls + Security-Sprints
├── tests/               — unit + integration (testcontainers) + smoke
└── deployments/         — docker-compose + cloud-run yaml + caddy
```

## Tech-Stack

- **Web:** Hono.js + @hono/node-server (klassisches Node-22-Runtime, **kein Cloudflare-Worker-Compute**)
- **DB:** Postgres 16 + pgvector
- **ORM:** Drizzle (Postgres-RLS load-bearing)
- **Auth (heute):** JWT via JWKS gegen mcp-approval2
- **Auth (AS-3):** Multi-Issuer (Google OIDC + Self-Facade + OBO via approval2)
- **Crypto:** AES-256-GCM, per-user-DEK aus KMS
- **Embed (default):** Cloudflare Workers AI `@cf/baai/bge-m3` (1024-dim, multilingual) via AI Gateway
- **Embed (fallback):** Vertex AI `text-multilingual-embedding-002` (768-dim, `europe-west4`) — requires schema rollback to 768-dim if switched
- **Lang:** TypeScript strict + `noUncheckedIndexedAccess`

## Compute-Target — aktive Pilot-Linie

> **Aktive Strategie:** [docs/STRATEGIE-pilot.md](docs/STRATEGIE-pilot.md) — Single-Target **Fly.io Frankfurt** für den privaten Pilot, Railway als Fallback dokumentiert. CF-Workers + Cloud-Run sind geprüft + bewusst zurückgestellt. **Dual-Runtime-Refactor** ([docs/STRATEGIE.md](docs/STRATEGIE.md) + [PLAN-dual-runtime.md](docs/plans/active/PLAN-dual-runtime.md)) bleibt als wiederanlauffähiges Konzept geparkt, falls ein konkreter Workers-Trigger eintritt (Customer-Verlangen, Coop-Bypass, Edge-Latenz, Scale-to-Zero).

| Target | Status |
|---|---|
| **Fly.io** (Frankfurt) | ✅ **aktive Pilot-Plattform**: [fly.toml](fly.toml) + [deploy/fly/](deploy/fly/) + [runbook-fly-deploy.md](docs/runbooks/runbook-fly-deploy.md). Sign-off-Stand 2026-05-16: Doppler-Config `mcp-knowledge2 / fly` (statt früher `privat`, klares Deploy-Target-Naming) live-verifiziert, Skript-Defaults aliasiert. **Postgres seit 2026-05-17 auf Neon Free Tier** (eu-central-1 Frankfurt, TF-managed in `mcp-approval2/terraform/environments/privat/neon-knowledge2.tf`) — Fly MPG (~38 $/mo) für Solo-Pilot zu teuer. 5 leere Blob-Keys offen → siehe [PILOT-READINESS.md](docs/PILOT-READINESS.md). |
| **Railway** (EU-Region) | 🅿️ **Fallback dokumentiert**, nicht aktiv umgesetzt. Würde dasselbe Dockerfile nutzen. Aufwand ~½ Tag wenn nötig. |
| **Google Cloud Run** (europe-west4) | ⚠️ Scripts + Manifest da ([deploy/gcp/](deploy/gcp/), [deployments/cloud-run/service.yaml](deployments/cloud-run/service.yaml), [runbook-gcp-deploy.md](docs/runbooks/runbook-gcp-deploy.md)), aber Manifest nutzt noch S3-Interop + `hkdf_local` + `EMBED_PROVIDER=vertex` (dim-Mismatch zu 1024-dim Schema). Lohnt erst bei CMEK/VPC-SC. |
| **Hetzner VM / K8s** | ⚠️ Skeleton: [deployments/docker-compose.yml](deployments/docker-compose.yml) + [Caddyfile](deployments/caddy/Caddyfile) + [deployments/k8s/README.md](deployments/k8s/README.md) (Stub) + [runbook-deploy-hetzner.md](docs/runbooks/runbook-deploy-hetzner.md). Compose-Pinning auf `pgvector:pg16` ist mutable Tag (F-23). |
| **Cloudflare Workers** (Compute) | 🅿️ **Geparkt, geprüft + bewertet** (2026-05-16). Höhere Monatskosten (Neon Pro 19 €/mo bei echtem Volumen + Hyperdrive vs. Fly+Neon-Free ~3-4 €/mo) und 6-8 Tage Refactor (`@hono/node-server` → Worker-Entry, `pg` → postgres-js/neon-http, `pg-boss` → Cron-Triggers, `pg_dump`-Spawn an Plattform delegieren, R2-Adapter, App/Server-Split). Wiederanlauf-Pfad in [PLAN-dual-runtime.md](docs/plans/active/PLAN-dual-runtime.md). **D1 wird nicht unterstützt** — bleibt SQLite-Sache des Legacy-Repos [`mcp-knowledge`](https://github.com/axel-rogg/mcp-knowledge). |

## Test-Strategie

- `npm run test:unit` — Unit-Tests
- `npm run test:integration` — Spawns Postgres testcontainer, validiert RLS + Migrations
- `bash scripts/dev.sh` — Postgres + MinIO + Mock-JWKS, dann watch
- `bash scripts/smoke.sh` — needs JWT from mock-jwks-server

## Branch / Push

- `main` ist Default-Branch
- Branch-Strategie: direkt auf `main`, kleine atomare Commits
- **CI-Trigger:**
  - `ci.yml` läuft auf `push.main` UND auf jedem PR — mit `concurrency: cancel-in-progress` (alte Runs werden bei Folge-Pushes gecancelled).
  - **Docs-only-Pushes (`**.md` / `docs/**` / `LICENSE` / `.gitignore`) triggern KEINEN CI-Run** (`paths-ignore`-Filter). Spart Testcontainers-Spin + npm-audit + Build-Image-Layer.
  - `build-image`-Job läuft nur nach grünem `test`-Job UND nur bei `push.main` — pusht GHCR-Image für jeden Code-Commit. (Anders als approval2: hier kein `[deploy]`-Tag-Gate, weil CR-Deploy `workflow_dispatch`-only ist und das Image für lokale/manuelle Pulls auch ohne Deploy nützlich bleibt.)
- **Deploy (Cloud Run):** `deploy.yml` ist `workflow_dispatch`-only. `[deploy]`-Tag in Commit-Subject ist Konvention für künftige automatische Pipelines (z.B. wenn Cloud-Run-Auto-Deploy aktiviert wird) — analog zum Schwester-Repo mcp-approval2.
- Co-Authored-By-Footer für Claude-generierte Commits

### Atomar-Commit-Pattern (gegen parallel laufende Cloud-Agents)

Cloud-Agents arbeiten parallel auf `main` und können staged Files mit-committen wenn das Race-Window offen ist. Pflicht-Sequenz pro Commit als **EIN Bash-Aufruf** mit `&&`-Chain:

```bash
cd /workspaces/mcp-knowledge2 && \
  git status --short && \                  # 1. fremde Files identifizieren
  git pull --rebase 2>&1 | tail -3 && \   # 2. fast-forward
  git add <file1> <file2> && \             # 3. NUR explizite Files, nie -A/-.
  git diff --cached --stat && \            # 4. sanity-check vor commit
  git commit -m "..." && \                 # 5. atomar
  git push 2>&1 | tail -6                  # 6. sofort raus
```

Sechs Regeln: `cd` immer am Anfang (Shell-State kann reset werden), `pull --rebase` IMMER, explizite Pfad-Liste, `diff --cached --stat` als Pre-Commit-Check, kein Tool-Call zwischen `add` und `commit`, `push` sofort. Bei `push` non-fast-forward: erneut pullen, dann pushen. Niemals `--force` / `--no-verify` / `add -A` / `add .`.

**Cross-Repo-Reihenfolge:** Wenn Feature beide Repos braucht (KC2 + mcp-approval2): **KC2 zuerst** vollständig committen+pushen (Producer-Side), **dann approval2** (Consumer-Side — Adapter, Tools, PWA). Niemals beide in einer Bash-Sequence.

Volle Memory-Doku: `feedback_cloud_agent_staging_race.md` (auto-Memory in der Claude-Code-Session).

## Konventionen

- Plan-Files haben Status-Banner oben (✅ live / ⚠️ Spec / ⚠️ Draft)
- Migrations sind sequentiell nummeriert (`0000_*.sql`, `0001_*.sql`, …)
- Cross-Repo-Referenzen via GitHub-URL (nicht relative Paths)
- Wenn ein Tool im AS-3-Spec auftaucht: erst Spec-Dokument lesen, dann Code

## Infrastructure-Policy: alles via Terraform

**Default: Infrastruktur-Änderungen (Cloudflare AI Gateway, DNS, Doppler-Secrets,
Cloud-Provider-Resources, GitHub-Repo-Settings) werden in
`/workspaces/mcp-approval2/terraform/` gemacht, NICHT im Dashboard.**

Schwester-Repo `mcp-approval2` ist der Terraform-Root (auch für KC2-Infrastruktur).
Wenn du etwas für KC2 brauchst (eigener AI Gateway, API-Tokens, DNS-Record,
Doppler-Project/Secrets, Hetzner-Volume, etc.):

1. Datei unter `mcp-approval2/terraform/*.tf` editieren oder neu anlegen
2. `terraform plan` zeigen — User reviewed Diff
3. `terraform apply` — TF ruft die Provider-APIs
4. Live verifizieren (`curl -I`, Dashboard-Stichprobe)
5. Commit + push

**Anti-Reflex-Test:** Wenn du gerade Dashboard-Klicks aufschreibst ("CF-Dashboard
→ ...", "Doppler-UI → ..."): stop, prüfe ob es einen TF-Provider dafür gibt.
Wenn ja → neu starten mit `.tf`-Edit. Auch Token-Werte können meist via
TF-Resource-Outputs in Doppler gepiped werden (kein Copy-Paste).

**Dokumentierte Ausnahmen** (Dashboard-Pfad legitim):
- Provider unterstützt die Ressource nicht (z.B. AI Gateway Authentication Token
  ist gateway-intern, kein eigenes TF-Resource — fallback: Authenticated=false)
- Einmalige Operations-Tasks (Token-Revoke, Cache-Purge, Notfall-Toggle)
- Out-of-Band-Resources die in `terraform/README.md` so markiert sind
