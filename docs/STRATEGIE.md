# Strategie — Dual-Runtime: Node + Cloudflare Workers aus einer Codebase

> **Status:** 🅿️ **Geparkt, 2026-05-16.** Nach Kosten- und Kompatibilitäts-Review (siehe [STRATEGIE-pilot.md](./STRATEGIE-pilot.md)) wird für den **privaten Pilot** ausschließlich der **Fly.io-Pfad** umgesetzt — der Refactor zu CF Workers würde 6-8 Tage kosten und die monatlichen Kosten um den Faktor 4-6 erhöhen (Neon Pro ≥19 €/mo + Hyperdrive vs. ~5-7 €/mo Fly), ohne dass einer der vier Workers-Trigger (Edge-Latenz, Coop-Bypass, Customer-Verlangen, Scale-to-Zero) zutrifft.
>
> Dieses Dokument bleibt **als Referenz erhalten** für den Fall, dass ein späteres Pilot-Szenario Workers-Compute verlangt. Die Adapter-Linie (Postgres-js als universal-Treiber, R2/GCS parallel, Plattform-Backup, Scheduler-Interface) ist auch isoliert wertvoll und kann phasen-weise gezogen werden, sobald ein konkreter Auslöser existiert.
>
> **Authoritative für die aktive Pilot-Linie:** [STRATEGIE-pilot.md](./STRATEGIE-pilot.md).
>
> **Owner:** Axel
> **Voraussetzung beim Wiederaufnehmen:** AS-3 Code-Complete auf `main`. Diese Strategie baut darauf auf, nicht neben.

Diese Datei beschreibt die Ziel-Architektur, mit der `mcp-knowledge2` aus **einer Codebase** sowohl als klassischer **Node-Service** (Fly.io / Cloud Run / Hetzner) als auch als **Cloudflare Worker** deployt werden kann. Sie ist die Grundlage für den nachfolgenden Implementation-Plan und legt explizit fest, **was per Env-Var, was beim Build und was beim Install entschieden wird** — damit der Trade-off im Nachhinein nicht wieder aufgemacht werden muss.

## 1. Ziel

Eine Codebase, drei Entscheidungs-Ebenen:

1. **Build-Zeit** wählt den Runtime-Bundle: Node-ESM (`dist/server.js`) oder CF-Worker (`.wrangler/`-Bundle). Das ist eine harte Trennung, kein Env-Var-Flip — Workers haben keinen `child_process`, kein `fs`, keinen TCP-Socket-Direct-Access.
2. **Install-Zeit** wählt das **Deploy-Target**: Fly, Cloud Run, Hetzner-VM/K8s, Cloudflare Workers. Eine einzige Variable `DEPLOY_TARGET` steuert, welches Deploy-Skript läuft und welcher Build-Output erzeugt wird.
3. **Run-Zeit** wählt die **Adapter** (DB-Host, Blob-Provider, Embed-Provider, KMS-Provider) per Env-Var aus den faktorisierten Factory-Pattern, die bereits existieren.

Die Business-Logik (`routes/`, `storage/`, `search/`, `auth/`, `crypto/`, `quota/`, `users/`, `mcp/`) bleibt **runtime-agnostisch** — sie sieht weder den HTTP-Server noch den Cron-Scheduler noch das Bundle-Format direkt.

## 2. Was per Env-Var (Run-Zeit)

| Env-Var | Optionen | Funktioniert in beiden Runtimes? |
|---|---|---|
| `DATABASE_URL` | Beliebige Postgres-URL: Cloud SQL, Fly Postgres, Neon, Supabase, Hetzner self-hosted, Hyperdrive | Ja (mit passendem DB-Treiber, siehe §5) |
| `DB_DRIVER` | `postgres-js` (Node, Workers via Hyperdrive) \| `neon-http` (Workers direkt zu Neon) | Build wählt Default per Target — env kann overriden |
| `BLOB_PROVIDER` | `s3` (R2/B2/Tigris/MinIO/GCS-S3-Interop) \| `gcs` (native, WIF) \| `r2` (CF R2-Binding, **Workers-only**) | `r2` nur in Workers-Build verfügbar |
| `EMBED_PROVIDER` | `cloudflare` (Workers AI bge-m3, 1024-dim) \| `vertex` (text-multilingual-embedding-002, 768-dim) | Ja, beide via HTTP |
| `KMS_PROVIDER` | `hkdf_local` \| `openbao` \| `cloud_kms` | Ja — `cloud_kms` braucht WIF/SA, in Workers via `@google-cloud/kms` REST nicht direkt verfügbar; Workaround siehe §7 |
| `EMBED_PROVIDER`-Dimension | Implizit: 768 oder 1024 — muss zur DB-Schema-Migration passen | Schema-bound, kein Live-Switch |

## 3. Was beim Build (Build-Zeit)

Eine Variable `BUILD_TARGET` steuert:

| `BUILD_TARGET=` | Entry-Point | Bundler | Output |
|---|---|---|---|
| `node` (default) | `src/server.node.ts` | esbuild → ESM | `dist/server.js`, gespielt von `Dockerfile` runtime stage |
| `worker` | `src/server.worker.ts` | wrangler / esbuild → Worker-Format | `.wrangler/`-Artefakte, deployt via `wrangler deploy` |

Die beiden Entry-Files importieren beide aus `src/app.ts` (die fertige Hono-Instanz inkl. Routen + Auth + Middleware) und unterscheiden sich nur in:

- **HTTP-Listener**: Node startet `@hono/node-server`, Worker exportiert `{ fetch }`
- **Cron**: Node startet `pg-boss`-Runner, Worker exportiert `scheduled(controller, env, ctx)`
- **Bootstrapping**: Node hat `main()` mit graceful Shutdown, Worker hat keinen Main

Die Trennung lebt sauber in `src/runtime/` (Node-spezifischer Code wie pg-boss-Runner, `serve()`, `child_process`-basierter Backup-Cron) und `src/runtime-worker/` (CF-spezifischer Code wie R2-Bindings, Cron-Trigger-Handler). Beide Verzeichnisse haben das gleiche Interface, das von `src/app.ts` und den `routes/` konsumiert wird.

## 4. Was beim Install (Install-Zeit)

```bash
# Beispiel: Pilot-Customer X bekommt Cloud Run
DEPLOY_TARGET=cloud-run bash deploy/install.sh

# Pilot-Customer Y bekommt CF Workers
DEPLOY_TARGET=workers   bash deploy/install.sh

# Solo-Pilot Axel bleibt auf Fly
DEPLOY_TARGET=fly       bash deploy/install.sh
```

Das Top-Level-Skript [`deploy/install.sh`](../deploy/install.sh) (neu) dispatcht auf:

| `DEPLOY_TARGET` | Build | Deploy-Skript | Manifest |
|---|---|---|---|
| `fly` | `BUILD_TARGET=node` | `deploy/fly/deploy.sh` (bestehend) | `fly.toml` |
| `cloud-run` | `BUILD_TARGET=node` | `deploy/gcp/sync-secrets.sh` + `gh workflow run deploy.yml` | `deployments/cloud-run/service.yaml` |
| `hetzner` | `BUILD_TARGET=node` | `deploy/hetzner/deploy.sh` (neu, basiert auf docker-compose.yml) | `deployments/docker-compose.yml` + `Caddyfile` |
| `workers` | `BUILD_TARGET=worker` | `deploy/cf/deploy.sh` (neu) → `wrangler deploy` | `wrangler.toml` (neu) |

## 5. Datenbank — Postgres überall, Treiber per Build/Env

Cloudflare bietet **keinen** nativen Postgres-Dienst. **D1** ist SQLite und nicht kompatibel mit pgvector / RLS / tsvector — würde eine Parallel-Implementierung erzwingen und ist deshalb ausgeschlossen (siehe §10).

### 5.1 Treiber-Wahl

Ein einziger ORM (Drizzle) und je nach Runtime ein anderer Underlying-Treiber, beide bereits Drizzle-supported:

| Runtime | Default-Treiber | Wann anders? |
|---|---|---|
| Node | `postgres-js` | nie — `postgres-js` ist in Node performant, RLS-tauglich, transaktionsstabil |
| Worker | `@neondatabase/serverless` (HTTP) wenn DB auf Neon liegt | Fallback `postgres-js` über **Cloudflare Hyperdrive** für jeden anderen Postgres |

Die Drizzle-Schema-Datei (`src/db/schema.ts`) ändert sich nicht — Postgres bleibt Postgres. Was sich ändert ist die Connection-Setup-Datei `src/db/client.ts`:

```ts
// src/db/client.ts — vereinfachtes Beispiel
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-http';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';

export function makeDb(env: Env) {
  switch (env.DB_DRIVER) {
    case 'neon-http':
      return drizzleNeon(neon(env.DATABASE_URL));
    case 'postgres-js':
    default:
      return drizzlePostgres(postgres(env.DATABASE_URL));
  }
}
```

### 5.2 RLS funktioniert in beiden Welten

`postgres-js` unterstützt `SET LOCAL app.current_user` in der Transaktion — kein Verhaltensunterschied zu `pg` heute. `@neondatabase/serverless` HTTP-Driver hat zwei Modi:
- **Pooled HTTP**: jeder Query ist eine eigene HTTP-Request → `SET LOCAL` funktioniert nicht (geht in einer Transaction). Pflicht-Modus für RLS-Calls.
- **Transaction-Mode** (`neonConfig.fetchEndpoint` + `transaction(...)`): explizite Transaktion über mehrere Queries → `SET LOCAL` funktioniert.

Konsequenz: alle Calls, die heute `withUserTx(...)` oder `withAdminTx(...)` verwenden (also fast alle), müssen den Transaction-Mode des Neon-Drivers verwenden. Das Helper-File `src/db/client.ts` wrappt das einheitlich, Aufrufer merken nichts.

### 5.3 Welche Postgres-Hoster passen

Auswahl per `DATABASE_URL` zur Install-Zeit:

| Hoster | Free-Tier-Pilot tauglich | Node-Build erreicht? | Worker-Build erreicht? |
|---|---|---|---|
| **Neon** (heutige Pilot-Default seit 2026-05-17) | Ja (Free 0,5 GB, eu-central-1 Frankfurt) | Ja, TCP via PGBouncer-Pooler | Ja, HTTP-Driver oder Hyperdrive |
| **Cloud SQL** | Nein (~50 €/mo Minimum) | Ja, Cloud-SQL-Proxy oder Public-IP | Via Hyperdrive (Public-IP + Authorized Network) |
| **Supabase** | Ja (500 MB) | Ja, TCP | Via Hyperdrive oder Supabase-Pooler |
| **Hetzner self-hosted** | Ja (CX22 ~5 €/mo) | Ja, TCP | Via Hyperdrive (öffentliche IP) |

**Empfohlene Pilot-Default-Wahl: Neon Free Tier.** Free, pgvector ist als Extension verfügbar, beide Runtimes erreichen es ohne Zusatz-Infra im Worker-Fall.

## 6. Blob-Storage — drei Adapter, Build entscheidet welche verfügbar sind

`BLOB_PROVIDER` (Run-Zeit):

| Wert | Backing | Verfügbar in |
|---|---|---|
| `s3` | AWS S3 / Cloudflare R2 (S3-API) / Backblaze B2 / Tigris / Hetzner OS / MinIO / GCS-S3-Interop | Node + Worker |
| `gcs` | Google Cloud Storage native via `@google-cloud/storage` (Workload Identity Federation) | **Node only** — `@google-cloud/storage` nutzt Metadata-Server-ADC, das ist in Workers nicht verfügbar |
| `r2` | Cloudflare R2 via native `R2Bucket`-Binding (kein HTTP-Overhead, kein `@aws-sdk` im Bundle) | **Worker only** — `R2Bucket` ist eine Worker-Binding |

Damit ist gleichzeitig erfüllt:
- „Google Cloud Storage UND R2 wählbar" — beide vorhanden, je nach Build-Target
- Kein AWS-SDK-Bloat im Worker-Bundle wenn man R2-native verwendet
- Cross-Target-Portabilität für s3-API-Provider (R2 als s3-Endpoint funktioniert auch von Node aus)

Adapter-Interface in [`src/adapters/blob/interface.ts`](../src/adapters/blob/interface.ts) bleibt unverändert (`put/get/delete/exists/presignPut/presignGet`).

## 7. KMS — Adapter bleibt, aber Worker-Constraint

`KMS_PROVIDER` heute: `hkdf_local` / `openbao` / `cloud_kms`.

| Provider | Funktioniert in Node? | Funktioniert in Worker? |
|---|---|---|
| `hkdf_local` | Ja | Ja (reines Node-Crypto, in Workers über `crypto.subtle` portierbar) |
| `openbao` | Ja, HTTP-API | Ja, HTTP-API — keine Binding-Abhängigkeit |
| `cloud_kms` | Ja, `@google-cloud/kms` SDK | **Nein** — SDK nutzt gRPC + Metadata-Server. **Workaround:** Cloud-KMS REST-API direkt per `fetch()` (Bearer-Token aus WIF). Zweite Implementierung als `cloud_kms_http`, gleicher Interface, ~50 LOC. |

Aufwand: `crypto.subtle`-Refactor in `hkdf_local.ts` (kompatibel zu Node 22, das `crypto.subtle` ebenfalls hat) + `cloud_kms_http.ts` als Worker-Variante.

## 8. Embed — bereits portabel

`EMBED_PROVIDER`:

| Provider | Node | Worker |
|---|---|---|
| `cloudflare` | HTTP `fetch` zu `https://gateway.ai.cloudflare.com/...` | Ja — kann optional via `env.AI`-Binding direkt aufrufen (kein Token nötig, billing-frei wenn intern), oder weiter via fetch |
| `vertex` | OAuth2-Token-Mint + REST | Ja, mit `VERTEX_SERVICE_ACCOUNT_JSON` (inline) — keine Metadata-Server-ADC-Pfad nutzbar |

Kein Refactor nötig, beide Adapter sind schon `fetch`-basiert. Bonus: im Worker-Build die optional-`AI`-Binding-Variante einbauen (`@cf/baai/bge-m3` als Direct-Call) — spart Roundtrip + Token.

## 9. Backup — an die Plattform delegiert

Heutiger Stand: `src/crons/backup.ts` spawnt `pg_dump --format=custom`, verschlüsselt mit `BACKUP_MASTER_KEY` (AES-256-GCM), schreibt nach S3. Das funktioniert in Node, aber **nicht in Workers** (kein `child_process`).

Strategie: **App-seitigen Backup-Cron entfernen.** Backup-Verantwortung liegt bei der Postgres-Plattform:

| Plattform | Backup-Mechanismus | Restore |
|---|---|---|
| Neon | PITR + branching, 7 Tage Free / 30+ Tage Pro | UI / API |
| ~~Fly Postgres~~ | _abgelöst durch Neon seit 2026-05-17 — siehe oben_ | — |
| Cloud SQL | Daily automated backups + PITR 7 Tage | gcloud / UI |
| Supabase | PITR 7 Tage Pro+ | UI |
| Hetzner self-hosted | externes `pg_dump` als systemd-timer oder docker sidecar | manuell |

`BACKUP_MASTER_KEY` bleibt — wird weiter für die OAuth-Facade `signing_keys`-AES-Verschlüsselung at-rest verwendet. Der File-Name ist semantisch unscharf nach Removal des Backup-Crons; Rename zu `SIGNING_KEY_WRAPPER_KEY` ist Follow-up-Cosmetic.

Konsequenz: [src/crons/backup.ts](../src/crons/backup.ts) wird gelöscht, [src/crons/runner.ts](../src/crons/runner.ts) verliert den `backup.daily` Job, `Dockerfile` braucht `postgresql17-client` nicht mehr.

## 10. Job-Scheduler — Adapter

Heute: `pg-boss` läuft im selben Node-Prozess wie der HTTP-Server, schedulet 4 Cron-Jobs (nach Backup-Removal).

Strategie: ein dünnes `JobScheduler`-Interface mit zwei Implementierungen.

```ts
// src/scheduler/interface.ts
export interface JobScheduler {
  register(name: string, cron: string, handler: () => Promise<void>): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

| Implementierung | Datei | Runtime | Mechanismus |
|---|---|---|---|
| `PgBossScheduler` | `src/scheduler/pgboss.ts` | Node | pg-boss wie heute, minus `backup.daily` |
| `CronTriggerScheduler` | `src/scheduler/cron_trigger.ts` | Worker | wrangler.toml `[triggers] crons = [...]` + dispatch im `scheduled()`-Handler nach `controller.cron` |

Die Job-Handler selbst (sweep, gc, orphan-cleanup) sind **runtime-agnostisch** — beide Scheduler rufen exakt dieselben Funktionen aus `src/storage/uploads.ts`, `src/middleware/idempotency.ts`, `src/storage/objects.ts` auf.

## 11. Build- und Deploy-Mechanik

### 11.1 Source-Layout nach Refactor

```
src/
├── app.ts                  ← NEU: Hono-Instanz inkl. Routes + Middleware (shared)
├── server.node.ts          ← UMBENANNT von server.ts
├── server.worker.ts        ← NEU: { fetch, scheduled } export
├── runtime-node/           ← NEU: serve(), graceful shutdown, pg-boss-Runner
├── runtime-worker/         ← NEU: cron-trigger-handler, R2-binding-resolver
├── routes/, storage/, search/, auth/, mcp/, ...   ← unverändert (runtime-agnostisch)
├── db/
│   ├── client.ts           ← REFACTOR: makeDb(env) wählt Treiber
│   └── schema.ts           ← unverändert
├── adapters/
│   ├── blob/
│   │   ├── s3.ts                 ← unverändert
│   │   ├── gcs.ts                ← unverändert (Node-only)
│   │   ├── r2.ts                 ← NEU (Worker-only)
│   │   └── index.ts              ← REFACTOR: r2 nur in Worker-Bundle inkludieren
│   ├── kms/
│   │   ├── cloud_kms.ts          ← unverändert (Node)
│   │   ├── cloud_kms_http.ts     ← NEU (Worker)
│   │   └── index.ts              ← REFACTOR: Provider-Wahl je Runtime
│   └── embed/                    ← unverändert
└── scheduler/                    ← NEU
    ├── interface.ts
    ├── pgboss.ts
    └── cron_trigger.ts
```

### 11.2 Top-Level Deploy-Skripte

```
deploy/
├── install.sh              ← NEU: Dispatcher auf DEPLOY_TARGET
├── fly/                    ← bestehend
├── gcp/                    ← bestehend
├── hetzner/                ← NEU: docker-compose + Caddyfile + secret-sync
└── cf/                     ← NEU: wrangler deploy + bindings-setup
```

### 11.3 Builds

```bash
# Node-Bundle (default)
npm run build            → esbuild dist/server.js

# Worker-Bundle
npm run build:worker     → wrangler build → .wrangler/dist/...
```

### 11.4 Configs

| Datei | Zweck | Status |
|---|---|---|
| `Dockerfile` | Node-Image für Fly/Cloud Run/Hetzner | refactor: `pg_dump`-Binary raus |
| `fly.toml` | Fly-Manifest | unverändert |
| `deployments/cloud-run/service.yaml` | Cloud Run Knative-Manifest | refactor: native GCS + Cloud-KMS-HTTP wirthen (oder weiter S3-Interop, je Pilot) |
| `deployments/docker-compose.yml` | Hetzner | unverändert, pgvector-Tag pinnen |
| `wrangler.toml` | CF Worker | **NEU** — Bindings für R2, Hyperdrive (optional), AI, Cron-Triggers |

## 12. Migration-Pfad ab Stand 2026-05-16

Phasen so geschnitten, dass jeder Schritt **deploy-bar** ist und keine Regression auf dem bestehenden Fly-Pfad einführt:

| Phase | Was | Risiko |
|---|---|---|
| **0** | DB-Treiber `pg` → `postgres-js`. `withUserTx`/`withAdminTx` neu auf postgres-js. Tests grün, Fly-Smoke grün. | Mittel — RLS-Verhalten muss verifiziert sein |
| **1** | Backup-Cron raus. `BACKUP_MASTER_KEY`-Verwendung bleibt nur für `signing_keys`. Plattform-Backups dokumentieren. | Niedrig |
| **2** | `src/app.ts` extrahieren, `src/server.ts` → `src/server.node.ts`, `JobScheduler`-Interface + Node-Impl. Fly-Smoke grün. | Niedrig — reine Refactor-Mechanik |
| **3** | R2-Adapter (`src/adapters/blob/r2.ts`) + Cloud-KMS-HTTP-Adapter, beide mit Node-Unit-Tests. | Niedrig |
| **4** | `src/server.worker.ts` + `wrangler.toml` + `src/scheduler/cron_trigger.ts`. Worker baut und antwortet `/health`. | Mittel — erstes echtes Worker-Bundle |
| **5** | Worker-End-to-End: `objects.create` via MCP-Tool gegen Neon Free Tier. RLS-Roundtrip verifiziert. Smoke-Script erweitert. | Hoch — neue Combination noch nie produktiv |
| **6** | `deploy/install.sh` + `deploy/cf/` + `deploy/hetzner/` Skripte. Runbook-Files. Doku-Update. | Niedrig |

## 13. Was NICHT geht und warum

| Wunsch | Status | Grund |
|---|---|---|
| Cloudflare D1 als Postgres-Ersatz | ❌ Ausgeschlossen | SQLite-Engine, keine pgvector / tsvector / RLS / Drizzle-Postgres-Schema-Kompatibilität. Wäre Parallel-Implementierung, nicht Switch. Wer D1+Vectorize will: das ist das alte Repo [`mcp-knowledge`](https://github.com/axel-rogg/mcp-knowledge). |
| `KMS_PROVIDER=cloud_kms` mit Google-SDK in Workers | ❌ Ohne Workaround | SDK nutzt gRPC + Metadata-Server. Lösung in §7: REST-API-Variante `cloud_kms_http`. |
| `BLOB_PROVIDER=gcs` (native SDK) in Workers | ❌ Ohne Workaround | `@google-cloud/storage` nutzt Metadata-Server. Lösung: `BLOB_PROVIDER=s3` mit GCS-S3-Interop oder native R2-Binding. |
| `pg_dump`-Backup-Cron in Workers | ❌ | Workers spawnen keine Binaries. §9 delegiert an Plattform. |
| OpenTelemetry-Tracing in Workers | ⚠️ Eingeschränkt | OTLP-Exporter über HTTP funktioniert, aber kein OS-Hook für CPU-Profile. Ausreichend für Pilot. |
| Live-Switch zwischen `BUILD_TARGET=node` und `=worker` ohne Re-Deploy | ❌ | Bundle-Format unterscheidet sich grundlegend, das ist Build-Zeit-Entscheidung. |

## 14. Aufwand

Realistische Schätzung für Solo-Entwickler:

| Phase | Aufwand |
|---|---|
| 0 — DB-Treiber-Refactor | 1 Tag |
| 1 — Backup-Cron raus | ½ Tag |
| 2 — App/Server-Split + JobScheduler | 1 Tag |
| 3 — R2 + Cloud-KMS-HTTP Adapter | 1 Tag |
| 4 — Worker-Entry + wrangler.toml + Cron-Trigger | 1 Tag |
| 5 — End-to-End Worker-Pilot gegen Neon | 1-2 Tage |
| 6 — Install-Skripte + Doku | 1 Tag |
| **Total** | **~6-8 Arbeitstage** |

Plus laufender Aufwand: CI baut **zwei Bundles**, Smoke läuft gegen **beide** (2× WebHook-Trigger oder Matrix-Job). Doppler-Configs pro Target.

## 15. Offene Risiken

- **Neon-Free-Tier-Limits.** 0,5 GB Storage + 100 Stunden Compute / Monat. Reicht für Pilot mit Test-Daten, **nicht** für echte Customer-Daten. Vor Pilot-Sign-off prüfen, ob Customer auf Pro (~19 €/mo) gehen muss.
- **Hyperdrive-Pricing-Drift.** [Aktuelle Konditionen](https://developers.cloudflare.com/hyperdrive/platform/pricing) vor Pilot prüfen, das Modell ändert sich gelegentlich.
- **`postgres-js` RLS-Verhalten** muss in Integration-Tests gegen die existierende Test-Suite verifiziert werden, bevor Phase 1 als „grün" gilt. Drizzle's `postgres-js`-Treiber wird in Production-Workloads inzwischen breit eingesetzt, aber `SET LOCAL` in nested transactions ist ein bekannter Edge-Case.
- **Worker-CPU-Limit (30 s)** für Embedding-Calls + Hybrid-Search. Heutiger Worst-Case ist `search` mit großen Limit-Werten + FTS-Re-Rank — vor Cutover Profiling, Limit-Caps prüfen.
- **OAuth-Facade in Workers.** `signing_keys`-Generation nutzt heute Node-`crypto` mit `generateKeyPairSync('ed25519')`. In Workers nur über `crypto.subtle.generateKey({ name: 'Ed25519' }, ...)` — relativ neu, Browser-/Workers-Support ist da, aber muss verifiziert werden.
- **Doppelt-Maintenance bleibt.** Jeder neue Storage-Aufruf muss in beiden Runtimes funktionieren (heißt: keine Node-spezifischen APIs in `routes/` einsmuggeln). Eslint-Rule + CI-Build gegen beide Targets fängt das.

## 16. Nicht-Ziele

- **Multi-Tenancy / White-Label.** Diese Strategie betrifft nur die Compute-Portierung; das Multi-Tenant-Modell ist separates Plan-Thema.
- **High Availability auf einem Target.** Single-Region, single-Instance bleibt für Pilot OK.
- **Performance-Parität** zwischen Node und Worker. Erwarten: Worker hat höhere DB-Latenz (Hyperdrive- oder HTTP-Hop), niedrigeren Cold-Start, geringere Memory-Allokation. Pilot-tolerierbar.

## 17. Nächste Schritte

1. **Diese Datei reviewen + bestätigen.**
2. Implementation-Plan unter `docs/plans/active/PLAN-dual-runtime.md` schreiben — übersetzt die Phasen 0-6 in konkrete Files + Tests + Migrations + Smoke-Steps.
3. Phase 0 in einem separaten Branch starten (`feat/dual-runtime-phase-0`) — DB-Treiber-Refactor isoliert + Fly-Smoke grün halten.

---

## Referenzen

- [CLAUDE.md](../CLAUDE.md) — Repo-Kontext, Compute-Target-Tabelle verlinkt hierher
- [PILOT-READINESS.md](./PILOT-READINESS.md) — aktueller Stand der Single-Target-Pilot-Reife
- [SECURITY.md](./SECURITY.md) — Threat-Model bleibt gültig, ergänzt um Cross-Provider-Risiken §"Cross-provider deployment"
- [ADR-0001 (superseded)](./adr/0001-dek-resolution-strategy.md), [ADR-0004 (current)](./adr/0004-generic-object-model.md)
- [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/) — TCP-Proxy + Pool für Postgres
- [Neon Serverless Driver](https://neon.tech/docs/serverless/serverless-driver) — HTTP-Postgres-Treiber für Workers
- [Drizzle ORM — postgres-js](https://orm.drizzle.team/docs/get-started-postgresql#postgresjs) und [neon-http](https://orm.drizzle.team/docs/get-started-postgresql#neon-http)
