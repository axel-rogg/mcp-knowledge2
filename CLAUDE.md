# mcp-knowledge2 — Kontext für Claude Code

> **Storage- und Sharing-Service** + **autonomer MCP-Server** (post-AS-3).
> Single-Tenant (1 Firma = 1 Instance), Multi-User mit Postgres-RLS.
> Schwester-Repo: [mcp-approval2](https://github.com/axel-rogg/mcp-approval2).
>
> **Status 2026-05-15:** AS-3-Code-Complete + **Generic-Object-Model implementiert** auf Branch `feat/as3-cutover`
> (19 Commits, 72 Tests grün). Cutover-Day pending — siehe
> [docs/runbooks/runbook-as3-cutover.md](docs/runbooks/runbook-as3-cutover.md).
>
> **Generic-Object-Model (ADR-0004, 2026-05-15)**: `kind`-Discriminator vollständig entfernt aus Schema, AAD, Routes, Types. Ein generischer Object-Typ mit free-form `subtype: string`. AAD-Format `<recordType>|<owner_id>|<object_id>`. Embedding uniform (`description != null + embed=true`). Memos uniformly shareable. Siehe [GENERIC-DATA-MODEL.md](GENERIC-DATA-MODEL.md) (v3, COMPLETE) + [docs/adr/0004-generic-object-model.md](docs/adr/0004-generic-object-model.md). Migration `0009_drop_kind.sql` deploy-ready.

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
        │                                          • S3-compat Blob (R2/B2/GCS)
        │ S2S:                                     • Vertex AI Embeddings (EU)
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
- KMS: eigenes Adapter-Interface — `hkdf_local` Default, `openbao` für Pilot
- MCP-Transport unter `POST /mcp` (Streamable-HTTP) — 16 Tool-Wrapper für die `/v1/*` REST-Surface
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
| [PLAN-architecture-DRAFT-from-mcp-approval2-view.md](docs/plans/active/PLAN-architecture-DRAFT-from-mcp-approval2-view.md) | Input | Caller-Sicht aus approval2, NICHT pushen (lokal). |
| [PLAN-hetzner-deployment.md](docs/plans/active/PLAN-hetzner-deployment.md) | ⚠️ Spec | Hetzner + GCP Multi-Instance |
| **[PLAN-as3-autonomous.md](docs/plans/active/PLAN-as3-autonomous.md)** | ✅ **CODE-COMPLETE 2026-05-15** | **AS-3-Migration: KC2 wird autonomer MCP-Server**. K1-K13 + T3 auf `feat/as3-cutover`. |
| **[PLAN-as3-bigbang.md](docs/plans/active/PLAN-as3-bigbang.md)** | ✅ **TIER 0-3 CODE-COMPLETE** | Cross-Repo-Cutover-Plan. Tier 4 (Cutover-Window) pending. |
| **[runbook-as3-cutover.md](docs/runbooks/runbook-as3-cutover.md)** | ✅ **Operator-Anleitung** | Step-by-Step T-7 bis T+7d für den Cutover-Tag. 452 Zeilen. |
| [CROSS-SERVICE-CONTRACT.md](docs/CROSS-SERVICE-CONTRACT.md) | ⚠️ Live (V1-Pattern, OBO-Erweiterung in AS-3-Spec dokumentiert) | Wire-Shape gegenüber mcp-approval2-Adapter |
| [SECURITY.md](docs/SECURITY.md) | ✅ Live | Threat-Model, Crypto-Stages, Embedding-Inversion-Risk |
| [PILOT-READINESS.md](docs/PILOT-READINESS.md) | ✅ Live | Pre-Pilot-Checkliste |

## Was bei Arbeit beachten

**Welcher Branch?** Pre-Cutover ist `main` der V1-Stand und `feat/as3-cutover` der AS-3-Stand. Wenn du AS-3-Code anfasst: auf dem Branch. Wenn du nur Docs/Specs änderst: nach `main`. Nach dem Cutover-Tag verschmelzen.

- **Auth-Code** (`src/auth/jwt.ts`, `src/auth/oauth_facade/`, `src/auth/on_behalf_of.ts`): Multi-Issuer-Pattern auf `feat/as3-cutover` umgesetzt. Bei Änderungen die JWT-Format anfassen: §1.1 + §2 im AS-3-Spec ist die Quelle, plus die Contract-Tests in `tests/contract/`.
- **KMS-Code** (`src/adapters/kms/`): `internal_api.ts` ist auf `feat/as3-cutover` gelöscht, durch `hkdf_local.ts` + `openbao.ts` ersetzt. KMS-Provider wird via `KMS_PROVIDER` env gewählt.
- **`users` + `invites` + `signing_keys` + `oauth_clients`** Tabellen sind auf `feat/as3-cutover` via Migrations 0005-0008 angelegt. RLS-Context kommt aus `current_user` = `users.id`.
- **MCP-Transport** unter `POST /mcp` auf `feat/as3-cutover` aktiv. 16 Tool-Wrapper für die `/v1/*` REST-Surface (`src/mcp/register_tools.ts`).
- **CROSS-SERVICE-CONTRACT.md** beschreibt den V1-Adapter (approval2 → KC2 mit JWT). AS-3-Erweiterungen sind im Spec dokumentiert, Contract-Tests in `tests/contract/` sind die ausführbare Wahrheit.
- **Generic-Object-Model (ADR-0004)**: `objects.kind` Column ist **weg**. Discriminator ist `subtype: text` (free-form, zod-Regex `^[a-z][a-z0-9_:-]{0,31}$`, erlaubt `:` für caller-namespacing wie `app:composable`). `share_grants.resource_kind` und `audit_log.resource_kind` auch gedropt. AAD ist `<recordType>|<owner_id>|<object_id>` ohne subtype-Slot. Embedding-Trigger: `description != null AND request.embed === true`. `composeEmbedSource()` ist uniform. Memos sind shareable (kein Block mehr). **Cross-Repo-Sync**: mcp-approval2 Adapter + Apps-Subsystem + 3 Zod-Duplikate ko-deployed im selben Branch.

## Repo-Struktur

```
mcp-knowledge2/
├── docs/plans/active/   — aktive Implementation-Specs (inkl. AS-3-Migration)
├── src/
│   ├── server.ts        — Hono-Entry
│   ├── routes/          — REST-Handler
│   ├── auth/            — JWT + Service-Token (AS-3: Multi-Issuer + OBO)
│   ├── adapters/
│   │   ├── blob/        — S3-API (R2/B2/GCS/MinIO)
│   │   ├── embed/       — Vertex AI text-embedding-005
│   │   └── kms/         — DEK-Resolver (AS-3: switch to local OpenBao/hkdf)
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

- **Web:** Hono.js + @hono/node-server
- **DB:** Postgres 16 + pgvector
- **ORM:** Drizzle (Postgres-RLS load-bearing)
- **Auth (heute):** JWT via JWKS gegen mcp-approval2
- **Auth (AS-3):** Multi-Issuer (Google OIDC + Self-Facade + OBO via approval2)
- **Crypto:** AES-256-GCM, per-user-DEK aus KMS
- **AI:** Vertex AI text-embedding-005 (EU)
- **Lang:** TypeScript strict + `noUncheckedIndexedAccess`

## Test-Strategie

- `npm run test:unit` — Unit-Tests
- `npm run test:integration` — Spawns Postgres testcontainer, validiert RLS + Migrations
- `bash scripts/dev.sh` — Postgres + MinIO + Mock-JWKS, dann watch
- `bash scripts/smoke.sh` — needs JWT from mock-jwks-server

## Konventionen

- Plan-Files haben Status-Banner oben (✅ live / ⚠️ Spec / ⚠️ Draft)
- Migrations sind sequentiell nummeriert (`0000_*.sql`, `0001_*.sql`, …)
- Cross-Repo-Referenzen via GitHub-URL (nicht relative Paths)
- Wenn ein Tool im AS-3-Spec auftaucht: erst Spec-Dokument lesen, dann Code
