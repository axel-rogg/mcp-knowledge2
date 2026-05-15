# mcp-knowledge2 — Kontext für Claude Code

> **Storage- und Sharing-Service** für mcp-approval2 (heute) und langfristig **autonomer MCP-Server**
> mit eigenem OAuth-Login (AS-3-Ziel).
> Single-Tenant (1 Firma = 1 Instance), Multi-User mit Postgres-RLS.
> Schwester-Repo: [mcp-approval2](https://github.com/axel-rogg/mcp-approval2).

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

**Heutiger Stand (Pre-AS-3):**
- Phase 0-6 scaffolded (single-shot 2026-05-13), 148 Tests grün
- Auth: validiert mcp-approval2-signed JWT via `JWKS_URL`
- KMS: callt mcp-approval2 internal API für DEK-Resolution
- Kein MCP-Transport, nur REST
- Keine eigene `users`-Tabelle (Identity läuft komplett über approval2's JWT-`sub`)

Diese Punkte werden durch AS-3 alle umgestellt — siehe Plan-Index.

## Plan-Index

Status-Banner oben in jedem PLAN-File.

| Plan | Status | Zweck |
|---|---|---|
| [PLAN-architecture-v2.md](docs/plans/active/PLAN-architecture-v2.md) | ⚠️ Draft | Konsolidierte v2-Implementation-Spec (Phase 0-6 Baseline). §1 JWT-Pattern wird durch AS-3 abgelöst. |
| [PLAN-architecture-DRAFT-from-mcp-approval2-view.md](docs/plans/active/PLAN-architecture-DRAFT-from-mcp-approval2-view.md) | Input | Caller-Sicht aus approval2, NICHT pushen (lokal). |
| [PLAN-hetzner-deployment.md](docs/plans/active/PLAN-hetzner-deployment.md) | ⚠️ Spec | Hetzner + GCP Multi-Instance |
| **[PLAN-as3-autonomous.md](docs/plans/active/PLAN-as3-autonomous.md)** | ⚠️ **SPEC (2026-05-15)** | **AS-3-Migration: KC2 wird autonomer MCP-Server**. Definiert OAuth-Facade, `users`-Tabelle, OBO-Verify, MCP-Transport, KMS-Self-Management. Lies das _vor_ Auth-/KMS-Arbeit. |
| **[PLAN-as3-bigbang.md](docs/plans/active/PLAN-as3-bigbang.md)** | ⚠️ **SPEC (2026-05-15)** | **Cross-Repo-Cutover-Plan**. Ein-Wurf-Reihenfolge für AS-3-Umstellung beider Repos parallel. |
| [CROSS-SERVICE-CONTRACT.md](docs/CROSS-SERVICE-CONTRACT.md) | ✅ Live | Wire-Shape gegenüber mcp-approval2-Adapter (v1-Pattern, AS-3 erweitert das) |
| [SECURITY.md](docs/SECURITY.md) | ✅ Live | Threat-Model, Crypto-Stages, Embedding-Inversion-Risk |
| [PILOT-READINESS.md](docs/PILOT-READINESS.md) | ✅ Live | Pre-Pilot-Checkliste |

## Was bei Arbeit beachten

- **Auth-Code** (`src/auth/jwt.ts`): heute Single-Issuer (approval2). AS-3 macht das Multi-Issuer (Google + Self + OBO). Bei jeder Änderung erst [PLAN-as3-autonomous.md §1.1](docs/plans/active/PLAN-as3-autonomous.md) lesen.
- **KMS-Code** (`src/adapters/kms/internal_api.ts`): zum Löschen vorgesehen in AS-3. Nichts mehr drauf bauen. Neue KMS-Aufrufe gehen über das Interface, die Implementierung wechselt zu OpenBao oder hkdf_local.
- **`users`-Tabelle** existiert heute NICHT. AS-3 fügt sie hinzu (Migration 0005, siehe §1.2 im Spec). Bis dahin: jeder `current_user`-Setup kommt direkt aus JWT-`sub`, kein User-Lookup nötig.
- **MCP-Transport** ist NICHT da. AS-3 fügt das hinzu (§1.4). Alle Tool-Aufrufe heute laufen über REST.
- **CROSS-SERVICE-CONTRACT.md** beschreibt den V1-Adapter (approval2 → KC2 mit JWT). AS-3 erweitert das um OBO-Pattern; der Contract wird beim Cutover aktualisiert.

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
