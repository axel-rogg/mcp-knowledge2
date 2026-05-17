# PLAN — Dual-Runtime: Node + Cloudflare Workers aus einer Codebase

> **Status:** 🅿️ **Geparkt 2026-05-16** zusammen mit der zugehörigen Strategie. Kein Phase-Start. Die aktive Pilot-Linie ist Fly.io single-target — siehe [docs/STRATEGIE-pilot.md](../../STRATEGIE-pilot.md). Dieser Plan bleibt als ausgearbeiteter Wiederanlauf-Pfad erhalten, falls ein konkreter Workers-Trigger (Edge-Latenz, Coop-Bypass, Customer-Verlangen, Scale-to-Zero) eintritt.
>
> **Owner:** Axel
> **Strategie-Grundlage (geparkt):** [docs/STRATEGIE.md](../../STRATEGIE.md). Dieser Plan übersetzt die geparkte Strategie in konkrete Files, Migrations, Tests und Smoke-Schritte.
> **Branch-Strategie (für später):** Jede Phase auf eigenem Feature-Branch (`feat/dual-runtime-phase-N`), erst PR + Smoke-grün auf Fly, dann Merge nach `main`.

## Voraussetzungen

- [x] AS-3 Code-Complete auf `feat/as3-cutover`
- [x] Generic-Object-Model (ADR-0004) implementiert
- [x] PILOT-READINESS.md spiegelt aktuellen Stand
- [x] STRATEGIE.md geschrieben + verlinkt aus CLAUDE.md + README.md
- [ ] Diese PLAN-Datei reviewed und approved

## Acceptance Criteria (Definition of Done für den Gesamt-Plan)

1. **Eine Codebase** auf `main` (post-AS-3-Cutover), kein Code-Fork zwischen Runtimes.
2. **`DEPLOY_TARGET={fly|cloud-run|hetzner|workers}`** wählt zur Install-Zeit den passenden Build + Deploy-Path.
3. **Beide Runtimes durchlaufen denselben Smoke-Test** (`scripts/smoke.sh` mit Target-Parameter) — `objects.create`, `search`, `shares.create`, RLS-Isolation zwischen zwei Usern, OAuth-Facade `/oauth/token`-Roundtrip.
4. **Doppler-Configs** für vier Targets gepflegt: `privat` (Fly heute), `prd_gcp`, `prd_hetzner`, `prd_workers`. Anmerkung: dieser Plan war ursprünglich für `prd_fly` konzipiert; der aktive Pilot-Pfad nutzt seit 2026-05-16 `privat` als Default — bei Wiederaufnahme dieses Plans wäre `prd_fly` als zweiter Fly-Config (z.B. für Customer-Pilot-Trennung) zu führen.
5. **CI baut beide Bundles** (Node + Worker) auf jedem Push zu `main`.
6. **Doku** (STRATEGIE + Runbooks + CLAUDE.md) zeigt für jedes Target den fertigen Path.

---

## Phase 0 — DB-Treiber-Refactor (`pg` → `postgres-js`)

**Branch:** `feat/dual-runtime-phase-0`
**Aufwand:** 1 Tag
**Risiko:** Mittel (RLS-Verhalten muss verifiziert sein)

### Files

- `package.json` — `pg` raus, `postgres@^3.x` rein. `@types/pg` raus.
- `src/db/client.ts` — komplettes Rewrite:
  ```ts
  import postgres from 'postgres';
  import { drizzle } from 'drizzle-orm/postgres-js';
  import * as schema from './schema.ts';

  const userPool = postgres(env.DATABASE_URL, {
    max: env.DATABASE_POOL_MAX,
    onnotice: () => {},  // suppress notices
    transform: postgres.camel,
  });
  const adminPool = postgres(env.DATABASE_ADMIN_URL, { max: 5 });

  export const userDb = drizzle(userPool, { schema });
  export const adminDb = drizzle(adminPool, { schema });

  export async function withUserTx<T>(userId: string, fn: (tx) => Promise<T>): Promise<T> {
    return userPool.begin(async (sql) => {
      await sql`SELECT set_config('app.current_user', ${userId}, true)`;
      return fn(drizzle(sql, { schema }));
    });
  }

  export async function withAdminTx<T>(fn: (tx) => Promise<T>): Promise<T> {
    return adminPool.begin((sql) => fn(drizzle(sql, { schema })));
  }

  export async function closeDbPools(): Promise<void> {
    await Promise.all([userPool.end({ timeout: 5 }), adminPool.end({ timeout: 5 })]);
  }
  ```
- `src/crons/backup.ts` — `pg_dump`-Spawn nutzt heute `DATABASE_URL` via env, unverändert (wird in Phase 1 gelöscht).
- `scripts/migrate.ts` — wenn der Migrate-Runner heute `pg.Client` verwendet, auf `postgres()` umstellen.

### Tests

- **Unit:** keine neuen.
- **Integration:** [`tests/integration/rls.test.ts`](../../../tests/integration/rls.test.ts) + [`objects-roundtrip.test.ts`](../../../tests/integration/objects-roundtrip.test.ts) müssen grün bleiben. Diese sind die Wahrheits-Quelle für RLS-Korrektheit.
- **Neuer Integration-Test:** `tests/integration/postgres-js-transaction.test.ts` — explizit testen dass `SET LOCAL app.current_user` innerhalb `pool.begin(async sql => ...)` für die ganze Transaction sichtbar bleibt + nach Commit/Rollback wieder verschwindet.

### Smoke

- `bash scripts/smoke.sh` lokal gegen docker-compose.dev.yml: alle 67 Tests grün.
- Optional Pre-Push: gegen produktive Fly-Instance — aber **nicht deployen**. Nur lokaler/CI-Test, weil Phase 0 noch nicht prod-fähig sein muss.

### Merge-Gate

- CI ci.yml grün (typecheck + lint + audit + test:unit + test:integration)
- Code-Review (Self)
- Merge nach `feat/as3-cutover`

---

## Phase 1 — Backup-Cron entfernen, Plattform übernimmt

**Branch:** `feat/dual-runtime-phase-1`
**Aufwand:** ½ Tag
**Risiko:** Niedrig

### Files

- **Löschen:** `src/crons/backup.ts`
- **Anpassen:** `src/crons/runner.ts` — `backup.daily`-Registration raus.
- **Anpassen:** `Dockerfile` — `RUN apk add --no-cache postgresql17-client` raus (keine `pg_dump`-Binary mehr nötig). Build-Größe schrumpft um ~5 MB.
- **Anpassen:** `src/types/env.ts` — `BACKUP_RETENTION_DAYS` löschen, `BACKUP_BUCKET` zu optional machen.
- **Anpassen:** [`docs/runbooks/runbook-fly-deploy.md`](../../runbooks/runbook-fly-deploy.md) Section "Postgres backup & restore" — App-Cron-Pfad raus, nur noch Fly volume snapshots + Postgres-Plattform-Backups dokumentieren.
- **Anpassen:** [`docs/runbooks/runbook-gcp-deploy.md`](../../runbooks/runbook-gcp-deploy.md) Section "Disaster recovery" — App-Backup-Pfad raus, Cloud SQL automated backups + PITR ist die einzige Quelle.
- **Anpassen:** `docs/SECURITY.md` Encryption-Tabelle — Backup-Layer-Zeile raus oder umformuliert auf "Signing keys (at rest, via `BACKUP_MASTER_KEY` — name kept for backward compat with Doppler)".
- **Anpassen:** [`docs/PILOT-READINESS.md`](../../PILOT-READINESS.md) — Backup-Hinweis updaten + Restore-Skript-Followup-Punkt entfernen.

### Tests

- Existing Tests müssen grün bleiben, keine neuen.
- Smoke Cron-Liste verifizieren: nach Boot loggt `runner.ts` welche Jobs registriert sind → erwartet **4 Jobs** (sweep, purge, idempotency.gc, blob-orphan-cleanup) statt heute 5.

### Smoke

- `scripts/smoke.sh` grün gegen prod-Fly-Smoke-Account.
- Deploy nach Fly als `[deploy]`-Push. Verifizieren `fly logs` zeigt 4 Cron-Jobs, kein `backup.daily`-Eintrag, kein `pg_dump`-Aufruf um 03:00 UTC am Tag nach Deploy.

### Merge-Gate

- Phase 0 muss live sein.
- CI grün.
- Fly-Deploy successful + 24h ohne Cron-Errors.

---

## Phase 2 — App/Server-Split + JobScheduler-Interface

**Branch:** `feat/dual-runtime-phase-2`
**Aufwand:** 1 Tag
**Risiko:** Niedrig (reine Refactor-Mechanik)

### Files

- **Neu:** `src/app.ts` — exportiert die fertige `Hono`-Instanz, inkl. aller Routes, Middleware, Body-Limit, CORS, OAuth-Facade, MCP-Router. Boot-spezifisches (`serve`, `startCrons`, `closeDbPools`, `process.on('SIGTERM')`) bleibt **außerhalb**.
- **Umbenannt:** `src/server.ts` → `src/server.node.ts`. Inhalt: `import { app } from './app.ts';` + `serve(...)` + `startCrons()` + graceful shutdown. Reduziert auf ~50 LOC.
- **Neu:** `src/scheduler/interface.ts`:
  ```ts
  export interface JobScheduler {
    register(name: string, cron: string, handler: () => Promise<void>): void;
    start(): Promise<void>;
    stop(): Promise<void>;
  }
  ```
- **Neu:** `src/scheduler/pgboss.ts` — extrahiert die aktuelle `src/crons/runner.ts`-Logik in eine `class PgBossScheduler implements JobScheduler`. Job-Handler-Funktionen (sweep, gc, blob-orphan-cleanup) bleiben in ihren bestehenden Modulen, der Scheduler ist nur Glue.
- **Anpassen:** `src/crons/runner.ts` — wird zum dünnen Wrapper, der `new PgBossScheduler()` instanziert und die 4 Jobs registriert. Bleibt rückwärtskompatibel zur bestehenden `startCrons()` / `stopCrons()`-API.
- **Anpassen:** `package.json` — `"build": "tsc --noEmit -p tsconfig.build.json && esbuild src/server.node.ts --bundle ..."` (Entry-Point-Pfad-Update).
- **Anpassen:** `Dockerfile` — `dist/server.js` Pfad bleibt (esbuild-Output-Name `dist/server.js` aus `src/server.node.ts` ist unverändert).
- **Anpassen:** `tsconfig.build.json` — include `src/app.ts` + `src/server.node.ts` + alles transitive.

### Tests

- Existing Tests müssen grün bleiben.
- Smoke: keine semantischen Änderungen erwartet.

### Smoke

- Build + Docker-Image bauen + lokal `docker run` mit minio + postgres compose → `/health` antwortet.
- Fly-Deploy + Fly-Smoke grün.

### Merge-Gate

- Phase 1 live.
- CI grün.
- Fly-Smoke grün.

---

## Phase 3 — R2-Adapter + Cloud-KMS-HTTP-Adapter

**Branch:** `feat/dual-runtime-phase-3`
**Aufwand:** 1 Tag
**Risiko:** Niedrig (additiv, niemand nutzt sie noch)

### Files

- **Neu:** `src/adapters/blob/r2.ts`:
  ```ts
  // R2 via native CF-Worker R2Bucket-Binding (no fetch overhead, no SDK)
  // Constructor receives the binding from the Workers env.
  // In Node this adapter is unreachable — factory falls back.
  export class R2BlobStore implements BlobStore {
    constructor(private bucket: R2Bucket) {}
    async put(key: string, body: Uint8Array, opts?: PutOptions): Promise<void> { ... }
    async get(key: string): Promise<Uint8Array | null> { ... }
    async delete(key: string): Promise<void> { ... }
    async exists(key: string): Promise<boolean> { ... }
    async presignPut(key: string, opts: PresignOptions): Promise<string> { ... }
    async presignGet(key: string, opts: PresignOptions): Promise<string> { ... }
  }
  ```
- **Anpassen:** `src/adapters/blob/index.ts` — `BLOB_PROVIDER=r2` Case. Bezug der `R2Bucket`-Binding aus einem Worker-side-Injection-Point (siehe Phase 4 für die Binding-Wiring); in Node wirft `r2` einen Error mit klarer Botschaft.
- **Anpassen:** `src/types/env.ts` — `BLOB_PROVIDER` enum erweitern `['s3', 'gcs', 'r2']`.
- **Neu:** `src/adapters/kms/cloud_kms_http.ts` — REST-API-Variante von Cloud-KMS, nutzt `fetch()` + WIF-Token statt `@google-cloud/kms`. Implementiert dasselbe `KmsProvider`-Interface. Token-Mint via Workload-Identity-Federation analog zu `vertex.ts:getAccessTokenViaSa()`.
- **Anpassen:** `src/adapters/kms/index.ts` — `KMS_PROVIDER=cloud_kms_http` Case (parallel zu `cloud_kms`, weil der SDK-Variant in Node weiter nützlich ist).
- **Anpassen:** `src/types/env.ts` — `KMS_PROVIDER` enum erweitern um `'cloud_kms_http'`.

### Tests

- **Neu:** `tests/unit/r2-adapter.test.ts` — mock R2Bucket, Roundtrip put/get/delete.
- **Neu:** `tests/unit/cloud-kms-http.test.ts` — mock fetch, verifizieren dass HKDF-Derive korrekt aus der REST-decrypt-Response abläuft.

### Smoke

- Keine Live-Smokes für die neuen Adapter (Node-Build benutzt sie noch nicht).

### Merge-Gate

- Phase 2 live.
- Unit-Tests grün.

---

## Phase 4 — Worker-Entry + wrangler.toml + Cron-Trigger-Scheduler

**Branch:** `feat/dual-runtime-phase-4`
**Aufwand:** 1 Tag
**Risiko:** Mittel (erstes echtes Worker-Bundle)

### Files

- **Neu:** `src/server.worker.ts`:
  ```ts
  import { app } from './app.ts';
  import { handleScheduled } from './scheduler/cron_trigger.ts';
  import { bindWorkerEnv } from './runtime-worker/env.ts';

  export default {
    async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
      bindWorkerEnv(env);  // exposes env to loadEnv() + bindings (R2, AI, Hyperdrive)
      return app.fetch(request, env, ctx);
    },
    async scheduled(controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
      bindWorkerEnv(env);
      return handleScheduled(controller, ctx);
    },
  };
  ```
- **Neu:** `src/runtime-worker/env.ts` — bridge: setzt `process.env` aus dem `env`-Argument (in Workers ist `process.env` leer; `loadEnv()` aus `src/types/env.ts` muss eine Worker-aware Variante haben).
- **Anpassen:** `src/types/env.ts` — `loadEnv()` akzeptiert einen optionalen `source: Record<string, string>` (heute schon, aber Default ist `process.env`). Worker-Bridge ruft mit dem Worker-env-Objekt.
- **Neu:** `src/scheduler/cron_trigger.ts`:
  ```ts
  // Map controller.cron string -> handler.
  // wrangler.toml registers the cron expressions; this file dispatches.
  const handlers: Record<string, () => Promise<void>> = {
    '*/30 * * * *': sweepExpiredUploads,
    '0 * * * *':    purgeExpiredUploads,  // and idempotency.gc co-scheduled
    '0 6 * * 0':    cleanupOrphanBlobs,
  };
  export async function handleScheduled(controller: ScheduledController, ctx: ExecutionContext): Promise<void> {
    const handler = handlers[controller.cron];
    if (!handler) { console.warn('unknown cron', controller.cron); return; }
    ctx.waitUntil(handler());
  }
  ```
- **Neu:** `wrangler.toml`:
  ```toml
  name = "mcp-knowledge2"
  main = "src/server.worker.ts"
  compatibility_date = "2026-05-01"
  compatibility_flags = ["nodejs_compat"]

  [[r2_buckets]]
  binding = "BLOB"
  bucket_name = "mcp-knowledge2-blob"

  [[r2_buckets]]
  binding = "BACKUP"
  bucket_name = "mcp-knowledge2-backup"

  [ai]
  binding = "AI"   # optional, for direct Workers AI Embedding-Call

  [[hyperdrive]]
  binding = "DB"
  id = "<hyperdrive-id>"  # set per-environment via wrangler secret/env

  [triggers]
  crons = ["*/30 * * * *", "0 * * * *", "0 6 * * 0"]
  ```
- **Neu:** `deploy/cf/deploy.sh` — wrangler-basierter Deploy (login-check, secret-sync aus Doppler, `wrangler deploy`).
- **Neu:** `deploy/cf/sync-secrets.sh` — analog zu `deploy/fly/sync-secrets.sh`, aber via `wrangler secret put`.
- **Anpassen:** `package.json` — `"build:worker": "wrangler build"`, `"deploy:worker": "wrangler deploy"`.
- **Anpassen:** `.dockerignore` — `.wrangler/` rein.
- **Anpassen:** `.gitignore` — `.wrangler/` rein.

### Tests

- **Lokal:** `wrangler dev` → `/health` antwortet.
- **Lokal:** `wrangler dev --remote` mit Test-Hyperdrive (pointet auf docker-compose-Postgres) → `/v1/objects` GET (auth-mocked) antwortet 200 mit leerer Liste.
- **Worker-Bundle-Size-Smoke:** `npm run build:worker` muss unter dem Worker-Free-Tier-Limit von 10 MB bleiben (3 MB-Marge wäre sicher).

### Smoke

- **Live-Smoke:** `wrangler deploy` zu einem Test-Worker (`mcp-knowledge2-staging.<acct>.workers.dev`). `curl /health` muss 200 antworten. `/v1/objects` muss 401 ohne JWT antworten.

### Merge-Gate

- Phase 3 live.
- Worker-Bundle-Build erfolgreich.
- Worker antwortet `/health` 200.
- Bundle-Size < 10 MB.

---

## Phase 5 — End-to-End Worker-Pilot gegen Neon Free Tier

**Branch:** `feat/dual-runtime-phase-5`
**Aufwand:** 1-2 Tage
**Risiko:** Hoch (neue Combination noch nie produktiv)

### Files

- **Anpassen:** `src/db/client.ts` — `DB_DRIVER` Switch:
  ```ts
  switch (env.DB_DRIVER ?? 'postgres-js') {
    case 'neon-http':  return makeNeonDb(env.DATABASE_URL);
    case 'postgres-js':
    default:           return makePostgresJsDb(env.DATABASE_URL);
  }
  ```
- **Anpassen:** `src/types/env.ts` — `DB_DRIVER` enum optional `['postgres-js', 'neon-http']`.
- **Anpassen:** `wrangler.toml` — Hyperdrive-Binding optional machen; wenn die DB Neon ist, geht der HTTP-Driver direkt.
- **Anpassen:** `scripts/smoke.sh` — neue ENV-Variable `SMOKE_TARGET=node|worker`, dispatcht auf URL und JWT-Quelle:
  ```bash
  if [[ "${SMOKE_TARGET:-node}" == "worker" ]]; then
    BASE_URL="${WORKER_BASE_URL}"
    TOKEN="$(mint_jwt_for_smoke_worker)"
  else
    BASE_URL="${NODE_BASE_URL}"
    TOKEN="$(mint_jwt_for_smoke_node)"
  fi
  ```
- **Neu:** Neon-Project anlegen (manuell, Free-Tier), pgvector enablen, Migrations laufen lassen (`npm run db:migrate` mit `DATABASE_URL=<neon-url>`).

### Tests

- Vollständiger Smoke gegen Worker-Endpoint mit Neon-Backend:
  1. `POST /v1/objects` (create, subtype=doc, body) → 200 + id
  2. `GET /v1/objects/{id}?expand=body` → 200 + body intakt
  3. `POST /v1/search` → 200 + Hit in Top-3
  4. `POST /v1/objects/{id}/shares` (User-B) → 200
  5. zweiter Smoke-Account → `GET /v1/objects/{id}` → 200 (geshared), `GET /shared-with-me` → enthält id
  6. erster Account `DELETE /v1/objects/{id}` → 200
  7. RLS-Negativtest: dritter User → `GET /v1/objects/{id}` → 404
  8. `POST /v1/internal/erase-user` mit Service-Token → 200 mit row-counts

- OAuth-Facade-Roundtrip:
  1. `GET /.well-known/oauth-authorization-server` → 200
  2. `POST /oauth/register` → 200 mit `client_id`
  3. `GET /oauth/authorize?response_type=code&client_id=...` → 302 zu Google
  4. (mock-Google) `GET /auth/google/callback?code=...&state=...` → 302 mit `?code=...`
  5. `POST /oauth/token` mit dem code → 200 mit `access_token` + `refresh_token`
  6. `GET /v1/objects` mit Access-Token → 200

### Smoke

- `SMOKE_TARGET=worker bash scripts/smoke.sh` muss vollständig grün sein.
- `SMOKE_TARGET=node bash scripts/smoke.sh` weiter grün (keine Regression).

### Merge-Gate

- Phase 4 live.
- Beide Smokes grün.
- Latenz-Messung: Worker p50 < 200ms für `/v1/objects` GET (Neon HTTP-Roundtrip). Wenn >500ms → Investigation, vielleicht Hyperdrive nötig.

---

## Phase 6 — Install-Skripte + Hetzner-Pfad + Doku

**Branch:** `feat/dual-runtime-phase-6`
**Aufwand:** 1 Tag
**Risiko:** Niedrig

### Files

- **Neu:** `deploy/install.sh` — Top-Level-Dispatcher:
  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  TARGET="${DEPLOY_TARGET:-fly}"
  case "$TARGET" in
    fly)       exec bash "$(dirname "$0")/fly/deploy.sh" "$@" ;;
    cloud-run) exec bash "$(dirname "$0")/gcp/deploy.sh" "$@" ;;
    hetzner)   exec bash "$(dirname "$0")/hetzner/deploy.sh" "$@" ;;
    workers)   exec bash "$(dirname "$0")/cf/deploy.sh" "$@" ;;
    *) echo "unknown DEPLOY_TARGET=$TARGET (fly|cloud-run|hetzner|workers)"; exit 2 ;;
  esac
  ```
- **Neu:** `deploy/gcp/deploy.sh` (heute fehlt es — nur `01-bootstrap.sh` und `sync-secrets.sh` existieren). Wrappt `gh workflow run deploy.yml` oder `gcloud run deploy` direkt.
- **Neu:** `deploy/hetzner/deploy.sh` — `docker compose -f deployments/docker-compose.yml up -d`, Doppler-secrets-Sync via `doppler run --`, Caddy-Reload.
- **Neu:** `deploy/hetzner/sync-secrets.sh` — schreibt Doppler-Secrets in `.env` für docker-compose (oder direkt in systemd-EnvFile).
- **Anpassen:** [`docs/STRATEGIE.md`](../../STRATEGIE.md) — Tabelle in §4 verifizieren + alle Pfade jetzt-existent.
- **Anpassen:** [`docs/PILOT-READINESS.md`](../../PILOT-READINESS.md) — Pilot-Check pro Target.
- **Neu:** `docs/runbooks/runbook-cf-deploy.md` — Operativ-Runbook für CF Workers Deploy.
- **Neu:** `docs/runbooks/runbook-deploy-hetzner.md` (existiert schon als Skeleton — komplettieren).
- **Anpassen:** `CLAUDE.md` Compute-Target-Tabelle — alle vier auf ✅.
- **Anpassen:** `README.md` Architecture-Section — Dual-Runtime ist nicht mehr „geplant", sondern „live".

### Tests

- Smoke gegen alle vier Targets:
  - `DEPLOY_TARGET=fly       bash deploy/install.sh` → Fly-Test-App → smoke grün
  - `DEPLOY_TARGET=cloud-run bash deploy/install.sh` → Cloud-Run-Test-Service → smoke grün
  - `DEPLOY_TARGET=hetzner   bash deploy/install.sh` → docker-compose lokal → smoke grün
  - `DEPLOY_TARGET=workers   bash deploy/install.sh` → Test-Worker → smoke grün

### Merge-Gate

- Alle vier Smokes grün.
- Doku-Review.
- Final-Merge `feat/dual-runtime-phase-6` → `main` (oder gemerged in `feat/as3-cutover` falls AS-3-Cutover-Day noch offen).

---

## Aufwand-Übersicht

| Phase | Aufwand |
|---|---|
| 0 | 1 Tag |
| 1 | ½ Tag |
| 2 | 1 Tag |
| 3 | 1 Tag |
| 4 | 1 Tag |
| 5 | 1-2 Tage |
| 6 | 1 Tag |
| **Total** | **~6-8 Arbeitstage** |

Plus laufender Aufwand: CI baut zwei Bundles auf jedem Push, Smoke-Matrix gegen vier Targets, Doppler-Configs pro Target.

## Abhängigkeiten + Reihenfolge

```
Phase 0 (DB-Treiber)
  └─► Phase 1 (Backup raus)
        └─► Phase 2 (App/Server-Split + Scheduler-Interface)
              └─► Phase 3 (R2 + Cloud-KMS-HTTP Adapter)
                    └─► Phase 4 (Worker-Entry + wrangler.toml)
                          └─► Phase 5 (E2E Worker gegen Neon)
                                └─► Phase 6 (Install-Skripte + Hetzner + Doku)
```

Phasen sind seriell — jede setzt auf dem stabilen Ergebnis der vorigen auf, jede ist deploy-bar (kein Big-Bang am Ende).

## Risiken + Mitigations

| Risiko | Phase | Mitigation |
|---|---|---|
| `postgres-js` RLS-Bug oder Transaction-Edge-Case | 0 | Neuer Integration-Test mit explizitem `SET LOCAL`-Lifecycle. Wenn Phase-0-Smoke rot ist, Rollback auf `pg`-Treiber + Strategie überarbeiten. |
| Neon-Free-Tier nicht ausreichend | 5 | Pilot mit kleinen Daten anfangen, vor Customer-Sign-off auf Neon-Pro (~19 €/mo) upgraden. |
| Worker-Bundle > 10 MB (Free-Tier-Limit) | 4 | Bei Build-Output-Check abbrechen, Tree-Shake-Audit, `@aws-sdk` rauswerfen wenn unbenutzt im Worker-Pfad. Worst-Case: Workers Paid Tier 25 USD/mo lifted auf 50 MB. |
| OAuth-Facade Ed25519-Key-Generation in Workers nicht stabil | 4-5 | Vorab `crypto.subtle.generateKey('Ed25519', ...)`-Smoke schreiben. Fallback: pre-generated Keypair aus Secret laden. |
| Hyperdrive-Kosten-Explosion bei höherer Last | 5 | Vor Pilot-Sign-off Pricing prüfen + Read-Cache-TTL konservativ konfigurieren. |
| Doppelt-Maintenance schleift sich ein (Worker-Pfad bleibt zurück) | post-6 | CI baut beide auf jedem Push. Beide Smokes auf täglichem Cron. Wenn einer rot: Issue + Triage. |

## Referenzen

- [docs/STRATEGIE.md](../../STRATEGIE.md) — autoritative Strategie
- [docs/PILOT-READINESS.md](../../PILOT-READINESS.md) — aktueller Single-Target-Pilot-Stand
- [docs/SECURITY.md](../../SECURITY.md) — Threat-Model, gilt für beide Runtimes
- [CLAUDE.md](../../../CLAUDE.md) — Repo-Kontext mit Compute-Target-Tabelle
- [Cloudflare Workers Limits](https://developers.cloudflare.com/workers/platform/limits/) — Bundle-Size + CPU-Time
- [Cloudflare Hyperdrive Pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing) — vor Pilot prüfen
- [Drizzle ORM + postgres-js](https://orm.drizzle.team/docs/get-started-postgresql#postgresjs)
- [Drizzle ORM + Neon-HTTP](https://orm.drizzle.team/docs/get-started-postgresql#neon-http)
