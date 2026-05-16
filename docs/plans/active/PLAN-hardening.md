# PLAN — Pre-Pilot-Hardening

> **Status:** ⚠️ **Teilweise umgesetzt 2026-05-16.** Code-Side (Rate-Limit-Middleware) live; TF-Side (CF-Reverse-Proxy + WAF) prep-only mit `enable_knowledge2_fly_cf=false` Default. Activation pending User-Go nach Cleanup des existierenden Hetzner-knowledge2-A-Records in CF.
> **Owner:** Axel
> **Auslöser:** User-Frage „Wenn wir das Aufrufen ist die Umgebung geschützt for dritte?" (2026-05-16) → Hardening-Audit in STRATEGIE-pilot.md §"Konkrete Hardening-Empfehlungen" → User-Entscheidung „muss + sollte berücksichtigen + in Terraform implementieren wo möglich".
> **Schwester-Dokus:** [STRATEGIE-pilot.md](../../STRATEGIE-pilot.md), [SECURITY.md](../../SECURITY.md), [PLAN-fly-terraform.md](./PLAN-fly-terraform.md).

## 1. Umfang

Die Hardening-Items aus dem Threat-Model-Audit:

| ID | Maßnahme | Modus | Status |
|---|---|---|---|
| H1 | `ALLOWED_EMAILS=axelrogg@gmail.com` strict whitelist | Doppler-Secret | ✅ erledigt 2026-05-16 (len=40 verifiziert) |
| H2 | Backup-Restore-Dry-Run | Manual-Op | ⏳ pending nach erstem Backup-Run (Tag 2) |
| H3 | Cloudflare Reverse-Proxy (CNAME + Bot-Fight + SSL-strict) | Terraform | ✅ Code vorbereitet 2026-05-16 (`enable_knowledge2_fly_cf=false` Default) |
| H4 | WAF-Rate-Limit-Rule auf `/oauth/register` (CF-Edge) | Terraform | ✅ Code vorbereitet 2026-05-16 |
| H5 | Rate-Limit-Middleware auf `/oauth/*` (App-Defense-in-Depth) | Code (Hono) | ✅ live 2026-05-16, 6 Unit-Tests |
| H6 | Doppler-Personal-Token-Rotation 90-Tage-Cadence | Operations-Reminder | ✅ dokumentiert in [docs/runbooks/runbook-token-rotation.md](../../runbooks/runbook-token-rotation.md) |
| H7 | `/v1/internal/*` flycast-only Lockdown | fly.toml | ⏳ Postpone — nur sinnvoll wenn OBO-Pfad aktiviert wird |
| H8 | **Embed-API Retry-Logic mit Cap** (Cloudflare + Vertex) | Code | ✅ live 2026-05-16, 7 Unit-Tests — siehe §8 |
| H9 | **Search-Query-Truncation vor Embed** (1500 chars Hard-Cap) | Code | ✅ live 2026-05-16 — siehe §9 |
| H10 | **Embed-Quota-Threshold-Warning bei 80%** | Code | ✅ live 2026-05-16 — siehe §10 |
| H11 | **Object-Ref Cycle-Detection** in `addRef()` | Code | ✅ live 2026-05-16 (BFS bis Tiefe 32, Self-Ref-Guard) — siehe §11 |
| H12 | **Blob-Deletion-Queue Max-Age-Cap** (7 d / 8 attempts → give-up + ERROR-Log) | Code | ✅ live 2026-05-16 — siehe §12 |

## 2. H3 + H4 — Cloudflare TF (Reverse-Proxy + WAF)

**File:** [`mcp-approval2/terraform/environments/privat/knowledge2-fly-cf.tf`](https://github.com/axel-rogg/mcp-approval2/blob/main/terraform/environments/privat/knowledge2-fly-cf.tf) (NEU 2026-05-16).

**Was es macht:**
- `cloudflare_dns_record.knowledge2_fly_cname` — CNAME `knowledge2.ai-toolhub.org` → `mcp-knowledge2.fly.dev` mit `proxied=true`
- `cloudflare_zone_setting.knowledge2_ssl_full_strict` — SSL/TLS-Mode = strict (CF erwartet gültiges Cert auf Origin; Fly hat Let's Encrypt auf `*.fly.dev`)
- `cloudflare_zone_setting.knowledge2_always_use_https` — HTTP → HTTPS Redirect
- `cloudflare_ruleset.knowledge2_rate_limit` — Free-Tier Rate-Limit-Rule: 10 req/min pro IP auf `/oauth/register`, bei Übersteigen 10 min Block

**Activation-Voraussetzungen (Conflict-Risk-Mitigation):**

1. **CF-Dashboard prüfen:** Existiert noch ein A-Record `knowledge2.ai-toolhub.org` aus dem destroyed Hetzner-Pilot (2026-05-14)? Falls ja → manuell im Dashboard löschen ODER `terraform destroy -target=module.dns.cloudflare_dns_record.knowledge`.
2. **`fly.toml` umstellen:** `SELF_OAUTH_ISSUER` + `GOOGLE_OAUTH_REDIRECT_URI` von `https://mcp-knowledge2.fly.dev` auf `https://knowledge2.ai-toolhub.org` ändern. Re-deploy.
3. **Google Cloud Console → OAuth Client:** Authorized Redirect URI `https://knowledge2.ai-toolhub.org/auth/google/callback` ergänzen (alte URL kann parallel bleiben für Übergangs-Smoke).
4. **`fly certs add knowledge2.ai-toolhub.org -a mcp-knowledge2`** — Fly konfiguriert TLS-Origin-Cert für die Custom-Domain.
5. **TF apply:**
   ```bash
   cd /workspaces/mcp-approval2/terraform/environments/privat
   echo 'enable_knowledge2_fly_cf = true' >> terraform.tfvars
   bash ../../../scripts/doppler-run-terraform.sh plan -out=/tmp/cf.tfplan
   bash ../../../scripts/doppler-run-terraform.sh apply /tmp/cf.tfplan
   ```

**Designentscheidungen:**
- **CF Free Tier ausreichend** für Solo-Pilot — Bot Fight Mode + 1 Rate-Limit-Rule sind im Free Tier inkludiert.
- **Pro+ Geo-Blocking nicht aktiviert** — `ALLOWED_EMAILS` macht es funktional überflüssig.
- **Zone-Settings könnten kollidieren mit mcp-approval/terraform/** (das schon `ssl=strict` setzt) — kein Problem, idempotent.

## 3. H5 — Rate-Limit-Middleware (App-Code)

**Files:**
- [`src/middleware/rate_limit.ts`](../../../src/middleware/rate_limit.ts) — In-process sliding-window limiter, per-IP keyed
- [`src/auth/oauth_facade/index.ts`](../../../src/auth/oauth_facade/index.ts) — Wiring auf 4 Routen
- [`tests/unit/rate_limit.test.ts`](../../../tests/unit/rate_limit.test.ts) — 6 Unit-Tests

**Konfiguration:**

| Route | Limit | Begründung |
|---|---|---|
| `/oauth/register` | 10 / min | DCR: legit MCP-Clients registrieren ~1x/Tag, Spam-Bots gefährden DB |
| `/oauth/authorize` | 30 / min | Authorize-Flow startet pro Session 1-3x, hohe Spam-Mauer reicht |
| `/auth/google/callback` | 30 / min | 1:1 mit authorize, gleiche Throttle |
| `/oauth/token` | 60 / min | PKCE-verified + DB-Lookup expensive; Refresh-Rotation ~1/h legit |

**IP-Resolution-Priorität** (für korrekte Keying hinter Proxies):
1. `Cf-Connecting-Ip` (CF-Proxy, höchste Genauigkeit)
2. `Fly-Client-Ip` (Fly direct)
3. `X-Forwarded-For` (leftmost client-IP)
4. `unknown` (lokale Curl, akzeptabel als shared bucket)

**Defense-in-Depth-Reasoning:** CF (H4) blockt ~99% der Spam-Flut am Edge. Diese App-seitige Middleware fängt die restlichen 1% — z.B. direkter `*.fly.dev`-Hit unter Umgehung der Custom-Domain, oder falls CF-Proxy temporär deaktiviert wird.

## 4. H6 — Doppler-Token-Rotation-Reminder

**File:** [`docs/runbooks/runbook-token-rotation.md`](../../runbooks/runbook-token-rotation.md) (NEU 2026-05-16).

**Cadence:**
- **Doppler Personal-Token** (`workplace:admin`): alle 90 Tage
- **`SERVICE_TOKEN`**: pro `[deploy]`-Push (siehe runbook-fly-deploy.md §"Secrets rotation")
- **`BACKUP_MASTER_KEY`**: NIE rotieren (würde alte Backups un-dekryptierbar machen)
- **`KMS_MASTER_KEY_B64`**: nur bei Suspicion eines Leaks (würde alle Body-Bodies re-encrypt erfordern)
- **`CLOUDFLARE_API_TOKEN`**: quartalsweise
- **Google OAuth Client Secret**: bei Personalwechsel oder Suspicion

## 5. H2 — Backup-Restore-Dry-Run

**Wann:** Tag 2 nach erstem Deploy, sobald der 03:00 UTC Backup-Cron einmal gelaufen ist und ein File in `BACKUP_BUCKET/backup/<ts>.dump.enc` existiert.

**Wie:**
```bash
cd /workspaces/mcp-knowledge2
doppler run --project mcp-knowledge2 --config fly -- \
  tsx scripts/restore-backup.ts backup/<latest-ts>.dump.enc /tmp/restore.dump

# Test gegen lokale Throwaway-Postgres:
createdb -h localhost -p 5432 -U postgres knowledge_restore_test
pg_restore --clean --no-owner --no-acl \
  --dbname=knowledge_restore_test /tmp/restore.dump
psql -h localhost -p 5432 -U postgres knowledge_restore_test \
  -c 'SELECT count(*) FROM objects'
# Erwartet: > 0 wenn der Pilot schon Daten enthält

dropdb -h localhost -p 5432 -U postgres knowledge_restore_test
rm /tmp/restore.dump
```

**Sign-off:** Wenn die Test-DB die erwarteten Objects enthält → Backup-Pipeline funktional. PILOT-READINESS Sign-off-Checklist Punkt „Restore-from-backup dry-run completed" abhaken.

## 6. H7 — `/v1/internal/*` Lockdown (Postpone)

**Aktueller Stand:** `/v1/internal/*` ist hinter `SERVICE_TOKEN`-Gate via `require_service_token` Middleware. Public über Internet erreichbar.

**Mögliches Hardening:** Fly hat flycast (private 6PN) zwischen Apps in derselben Org. Wenn `mcp-approval2` auf Fly läuft und OBO als Proxy aktiviert wird, könnte `/v1/internal/*` auf flycast-only restricted werden via fly.toml `[[services]] internal_port`. Bedeutet: nur Apps im selben Org-Netzwerk können calling.

**Warum postponed:** OBO-Pfad ist heute nicht aktiv (`MCP_APPROVAL_JWKS_URL` leer in Doppler). Solange Pfad A (claude.ai direct) der einzige Caller-Path ist, wird `/v1/internal/*` nur vom Backup-Cron + Erase-User-Operations genutzt — beide intern im selben Fly-Machine, nicht über Public-Internet. Aktuelles `SERVICE_TOKEN`-Gate reicht.

**Trigger zum Umsetzen:** Sobald approval2 als OBO-Proxy konfiguriert wird UND Cross-Provider (z.B. approval2 auf CF Workers, knowledge2 auf Fly) — dann ist die zusätzliche Netzwerk-Layer-Schicht sinnvoll.

## 7. Verifizierung nach Aktivierung

Wenn `enable_knowledge2_fly_cf = true` + Cert + DNS done:

```bash
# 1. DNS resolution
dig knowledge2.ai-toolhub.org CNAME +short
# Erwartet: mcp-knowledge2.fly.dev.

# 2. CF-Proxy aktiv (CF-IPs antworten, nicht Fly-IPs)
curl -sI https://knowledge2.ai-toolhub.org/health | grep -i 'server\|cf-ray'
# Erwartet: 'server: cloudflare' oder 'cf-ray: ...'

# 3. SSL Full-strict
curl -sI https://knowledge2.ai-toolhub.org/health | grep -i 'strict-transport\|alt-svc'
# Erwartet: HSTS und HTTP/2

# 4. Rate-Limit (CF-Edge + App-Middleware doppelt)
for i in $(seq 1 15); do
  curl -s -o /dev/null -w '%{http_code}\n' \
    -X POST https://knowledge2.ai-toolhub.org/oauth/register \
    -H 'content-type: application/json' \
    -d '{"redirect_uris":["http://localhost/cb"]}'
done
# Erwartet: erste 10 mit 200, danach 429 (CF-Block oder App-Limiter)
```

## 8. H8 — Embed-API Retry-Logic mit Cap

**Auslöser:** Audit 2026-05-16 → Embedding-Adapter (`cloudflare.ts`, `vertex.ts`) hatten kein Retry bei 5xx-Errors. Bei CF-Outage/Maintenance failed jeder Object-Create und jede Search.

**Lösung:** [`src/lib/retry.ts`](../../../src/lib/retry.ts) — kleine Util mit folgenden Eigenschaften:

- **Max 3 Attempts** — kein Pile-up bei dauerhaftem Upstream-Fail
- **Exponential Backoff** mit ±25% Jitter (250 ms → 4 s, capped)
- **Total-Budget-Cap** 25 s — passt in Cloud-Run's 60 s Request-Timeout
- **Retry NUR auf retryable Errors** (5xx, 429, Network) — NIE auf 4xx (deterministisch, retry verdoppelt nur die Kosten)

**Wiring:**
- [`src/adapters/embed/cloudflare.ts`](../../../src/adapters/embed/cloudflare.ts) — fetch-Block in `retryWithBackoff()` gewrapped, custom `CloudflareEmbedError` mit `status`-Property für Retry-Klassifizierung
- [`src/adapters/embed/vertex.ts`](../../../src/adapters/embed/vertex.ts) — analog, plus Token-Refresh innerhalb der Retry-Schleife

**Tests:** [`tests/unit/retry.test.ts`](../../../tests/unit/retry.test.ts) — 7 Cases: 5xx-retry, 4xx-no-retry, 429-retry, network-failure-retry, attempts-cap, budget-cap, onRetry-hook.

## 9. H9 — Search-Query-Truncation vor Embed

**Auslöser:** `search`-MCP-Tool und `/v1/search` akzeptieren Queries bis 2000 chars. Cloudflare bge-m3 hat ein Token-Limit von ~512 (etwa 2000 chars UTF-8) — bei UTF-8 mit Multi-Byte-Chars kann das überschritten werden. Vertex akzeptiert mehr, aber lange Queries verlieren ohnehin semantischen Focus.

**Lösung:** [`src/search/hybrid.ts`](../../../src/search/hybrid.ts) Z. 84-92 — Query wird vor dem Embed-Call auf 1500 chars conservativ truncated. FTS-Branch sieht weiterhin den vollen 2000-char-Input (lexical matching profitiert von langen Queries).

```ts
const queryForEmbed = query.length > 1500 ? query.slice(0, 1500) : query;
```

## 10. H10 — Embed-Quota-Threshold-Warning bei 80%

**Auslöser:** Default-Quota ist 5000 Embed-Calls/User/Tag (bumped 2026-05-16 von 1000 auf 5000, Migration `0011_embed_quota_5000.sql`). Wenn User unbemerkt Richtung Limit läuft, gibt's heute keine Warnung — nur ein hartes 429 wenn er es überschreitet. Operator sieht das erst im Audit-Log.

**Lösung:** [`src/quota/check.ts`](../../../src/quota/check.ts) — nach successful `assertEmbedQuota` wird die aktuelle Nutzung gegen 80% des Limits geprüft. Bei Überschreiten: `logger.warn({userId, used, max, pct, resetAt}, 'embed quota >=80%...')`. Idempotent pro `(userId, resetAt)` via in-process-Map mit selbstlimitierender Größe (Eviction bei >1000 Einträgen).

**Tests:** keine direkten Unit-Tests (würde DB-Mock erfordern); funktionaler Test durch Integration-Test-Suite abgedeckt.

## 11. H11 — Object-Ref Cycle-Detection

**Auslöser:** `addRef(from, to, role)` hatte keine Schutzlogik gegen Zyklen. User konnte A→B + B→A + B→C + C→A anlegen — DB-bleibt-konsistent, aber Graph-Traversal-Logik (Cascade-Delete, Reachability-Queries) könnte unbounded laufen.

**Lösung:** [`src/storage/refs.ts`](../../../src/storage/refs.ts) `addRef()`:

1. **Self-Ref-Guard:** `from === to` → `400 self-ref not allowed`
2. **BFS Cycle-Check:** Bevor der Ref geschrieben wird, prüft ein Bounded-BFS (max 32 Hops Tiefe) vom `to` aus, ob `from` rückwärts erreichbar ist. Wenn ja → `400 ref would create a cycle in the knowledge graph`.

Die BFS-Tiefe von 32 ist großzügig — typische Knowledge-Graphs bleiben in Tiefe ≤5, aber der Cap schützt gegen Worst-Case-Query-Cost. Wenn ein User wirklich einen 32-stufigen Pfad bauen möchte, ist das ein Anzeichen für ein anderes Design-Problem.

## 12. H12 — Blob-Deletion-Queue Max-Age-Cap

**Auslöser:** [`src/crons/sweep.ts`](../../../src/crons/sweep.ts) `cleanupOrphanBlobs()` re-tried Blob-Delete-Failures unbeschränkt mit Exponential-Backoff. Wenn das Blob-Backend dauerhaft ausfällt oder ein Key out-of-band bereits gelöscht wurde, wächst die Queue ewig.

**Lösung:** Nach 7 Tagen ODER 8 Attempts wird der Eintrag verworfen, der Job loggt `error`-level für Operator-Alerting:

```ts
if (attempts >= 8 || ageMs >= 7 * DAYS) {
  await db.delete(blobDeletionQueue).where(...);
  logger.error({...}, 'giving up after exhausting retries — manual cleanup may be needed');
  continue;
}
```

Der ERROR-Log-Pfad ist absichtlich — der Operator (du) bekommt damit ein Signal via Fly-Log-Tail oder externes Log-Aggregation, dass etwas dauerhaft schief läuft.

## 13. Referenzen

- [docs/STRATEGIE-pilot.md §"Was offen / nicht abgedeckt ist"](../../STRATEGIE-pilot.md)
- [docs/SECURITY.md](../../SECURITY.md) — Threat-Model, Cross-Provider-Risiken
- [docs/PILOT-READINESS.md](../../PILOT-READINESS.md) — Sign-off-Checkliste
- [docs/runbooks/runbook-token-rotation.md](../../runbooks/runbook-token-rotation.md) — Rotation-Cadence
- [PLAN-fly-terraform.md](./PLAN-fly-terraform.md) — Fly-Resources-Verwaltung
- [mcp-approval2/terraform/environments/privat/knowledge2-fly-cf.tf](https://github.com/axel-rogg/mcp-approval2/blob/main/terraform/environments/privat/knowledge2-fly-cf.tf)
- [src/middleware/rate_limit.ts](../../../src/middleware/rate_limit.ts)
