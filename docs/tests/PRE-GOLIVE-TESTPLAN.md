# Pre-Go-Live Testplan — mcp-knowledge2

> **Status:** Entwurf 2026-05-19, vor erstem realen User-Daten-Tag
> **Owner:** Axel
> **Scope:** Was muss VOR Go-Live einmal grün gewesen sein.
> Komplementär zu:
> - [TEST-STRATEGY.md](TEST-STRATEGY.md) — Test-Varianten, Coverage-Matrix, Lessons aus dem Wrapper-Sprint (WIE testen wir)
> - [PILOT-READINESS.md](../PILOT-READINESS.md) (Code-Stand)
> - [security/SECURITY_ISSUES.md](../security/SECURITY_ISSUES.md) (Findings)

Diese Liste ist eine **Akzeptanz-Matrix**, kein Test-Code. Pro Zeile:

- **Automated** — existiert in `tests/{unit,integration,contract,sanity}/`. Muss in CI grün sein.
- **Smoke** — Live-Call gegen die deployte Instance (`bash deploy/fly/smoke.sh` o.ä.).
- **Manual** — Browser-/PWA-Click-Through oder zwei-User-Pair-Session.
- **Drill** — Operator-Übung (Restore, Token-Rotation, Rollback).
- **Pending** — Test fehlt, muss vor Go-Live geschrieben/durchgeführt werden.

Reihenfolge ist nach Blast-Radius (zuerst alles was bei Bruch Daten verliert
oder leakt), nicht nach Aufwand.

---

## 1. Crypto & Schlüssel-Management

Bei einem Bruch hier sind alle gespeicherten Inhalte kompromittiert.
Höchste Priorität, weil nach Go-Live nicht rückwärts re-encrypt-bar.

| # | Test | Modus | Quelle |
|---|---|---|---|
| 1.1 | AAD-Domain-Separation: gleicher Ciphertext einer anderen `owner_id`/`object_id` einsetzen → Decrypt-Fail | Automated | `tests/unit/crypto.test.ts` |
| 1.2 | Per-User-DEK-Salt mit `users.dek_salt`-Mix (SEC-K-005) — DEKs zweier User mit gleichem KMS-Master sind disjunkt | Automated | `tests/unit/crypto.test.ts` |
| 1.3 | Re-Encrypt-Skript `scripts/re-encrypt-dek-v2.ts` gegen Throwaway-DB (v1→v2 Migration vor erstem Multi-User-Daten-Tag) | Drill | Operator |
| 1.4 | KMS-Adapter-Auswahl: env `KMS_PROVIDER=cloud_kms` resolved zu Google Cloud KMS `europe-west3` (single-region, nicht `eu` multi-region wegen Provider-Bug) | Smoke | `/health/ready` zeigt `kms:"ok"` (falls deep-check ergänzt) |
| 1.5 | Cloud-KMS-Service-Account-Key kann decrypten — Test mit künstlich verfälschtem Ciphertext gibt klares 5xx, nicht silent-empty | Manual | Direkt-Call mit modifiziertem `objects.body_cipher` |
| 1.6 | `KMS_MASTER_KEY_B64` Rotation (HKDF-Mode): 2 Master-Keys parallel, alte Daten lesen, neue mit neuem Key encrypten | Drill | [runbook-token-rotation.md](../runbooks/runbook-token-rotation.md) §KMS |
| 1.7 | Group-Crypto 3 Wrap-Schichten: owner→master, member→master, object→via-group | Automated | `tests/unit/group-crypto.test.ts` (19 Tests) |
| 1.8 | AAD-Discriminated-Union v2 (per_object DEK) — 5 Domain-Separation-Cases | Automated | `tests/unit/group-crypto.test.ts` |
| 1.9 | Lazy-Migration `owner_hkdf` → `per_object` beim ersten Share, **inklusive R2/Blob-Pfad** (>16 KB Bodies) — alte Bodies müssen nach erstem Share entschlüsselbar bleiben | **Pending** | Integration-Test fehlt für Blob-Pfad |
| 1.10 | Member-Remove rotiert Group-Master in einer TX (FOR UPDATE), alte Member sieht nach Revoke 0 Bodies | Automated | `tests/integration/groups.test.ts` |
| 1.11 | `rewrap_jobs` Worker idempotent (Re-Run gleicher Batch wirft nicht doppelt), post-completion wipe `old_master_kms_wrapped` | Automated | `tests/integration/groups.test.ts` |
| 1.12 | `KMS_RESOURCE_NOT_FOUND_IN_LOCATION` smoke — wenn jemand versehentlich `eu` multi-region in Terraform setzt, Boot scheitert klar (nicht stille degradation) | Manual | TF-Diff erzwingt, Boot-Log prüfen |

## 2. Postgres Row-Level Security

| # | Test | Modus | Quelle |
|---|---|---|---|
| 2.1 | RLS auf allen 9 RLS-Tabellen (`objects`, `object_refs`, `object_tags`, `object_revisions`, `share_grants`, `audit_log`, `idempotency_records`, `groups`, `group_members`) | Automated | `tests/integration/rls.test.ts` |
| 2.2 | App-Role ist NICHT BYPASSRLS — Boot fail-closed wenn falsche Rolle aus Neon kommt | Automated + Smoke | `tests/integration/rls.test.ts` + `/health/ready` deep-check |
| 2.3 | RESTRICTIVE `share_grants` policy (SEC-K-NEW Mig 0016) — PERMISSIVE-OR-Bypass ist tot | Automated | `tests/integration/rls.test.ts` |
| 2.4 | Cross-User-Read 404 (nicht 403, kein User-ID-Leak) | Automated | `tests/integration/rls.test.ts` |
| 2.5 | `is_active_member_of` SECURITY DEFINER blockt Recursion (Migs 0021/0022/0023) | Automated | `tests/integration/groups.test.ts` |
| 2.6 | `groups_owner_modify` split — Owner-Transfer mit WITH-CHECK auf `is_active_member_of` (Mig 0025) | Automated | `tests/integration/groups.test.ts` Phase-2-Tests |
| 2.7 | `owner_or_writer_modify` — Group-Write-Pfad (Mig 0024): Member mit `role='write'` schreibt im Group-Kontext, `read` nicht | Automated | `tests/integration/groups.test.ts` |
| 2.8 | `object_owning_group` + Mig 0028 — Group-owned Objects sichtbar für aktive Members | Automated | `tests/integration/groups.test.ts` |
| 2.9 | Neon-spezifisch: `knowledge_app` darf NICHT BYPASSRLS sein; `knowledge_admin` JA. Boot-Time Assertion | **Pending** | `src/db/role-check.ts` falls noch nicht da |
| 2.10 | Neon-Pooler-Fall: nach `connect` muss `RESET ROLE` laufen (Pooler injected `SET ROLE neon_superuser`) | Smoke | Migrate-Run gegen Production-Neon (das Schema-Apply würde sonst silent fehlschlagen) |

## 3. Auth & Sessions

| # | Test | Modus | Quelle |
|---|---|---|---|
| 3.1 | DCR-Flow: `POST /oauth/register` → frischer Client → `/authorize` → Google-Login → Callback → `/token` mit PKCE → Access+Refresh-Token | Manual | INTEGRATION.md Pfad A |
| 3.2 | Refresh-Token-Rotation: alter RT nach Tausch ist sofort revoked, zwei parallele Refreshes → einer gewinnt, der zweite 400 | Automated | `tests/contract/oauth-self-token.test.ts` |
| 3.3 | JWT-Issuer + Audience-Validation: Self-Tokens, Google-OIDC-Direct, approval2-OBO werden korrekt unterschieden | Automated | `tests/contract/obo-jwt.test.ts` |
| 3.4 | JWKS rotation: zwei aktive `signing_keys`, beide Token-Sets verifizieren ok | Automated | `tests/contract/oauth-self-token.test.ts` |
| 3.5 | OBO-JWT von approval2: `X-On-Behalf-Of`-Header + `SERVICE_TOKEN_OPS` → `current_user` aus `payload.sub` | Automated | `tests/contract/obo-jwt.test.ts` |
| 3.6 | Erase-Receipt-JWS Binding (SEC-K-016): `payload.sub === body.user_id`, sonst 403 | Automated | `tests/contract/user-sync.test.ts` (oder Pending) |
| 3.7 | `REQUIRE_ERASE_RECEIPT=true` enforced — legacy-Fallback off | Smoke | Doppler-Check vor Go-Live |
| 3.8 | `ALLOWED_EMAILS`-Whitelist auf `/auth/google/callback`: Email **nicht** auf Liste → 403, ohne User-Create | Automated | `tests/contract/oauth-self-token.test.ts` (oder Pending) |
| 3.9 | Service-Token-Split (SEC-K-009): `SERVICE_TOKEN_ERASE` ≠ `SERVICE_TOKEN_SYNC` ≠ `SERVICE_TOKEN_OPS`; falsch-scope = 403 | Automated | `tests/contract/user-sync.test.ts` |
| 3.10 | Rate-Limit auf `/oauth/register` + `/oauth/token` (PLAN-hardening): nach N Requests/Min 429 | Automated | `tests/unit/rate_limit.test.ts` + Smoke-Burst gegen Live |
| 3.11 | DCR-Initial-Access-Token Pflicht falls `DCR_INITIAL_ACCESS_TOKEN` gesetzt — sonst registration offen | Manual | `curl /oauth/register` ohne Token → 401 |
| 3.12 | Cookie-Flags auf OAuth-Flow-Cookies: `Secure`, `HttpOnly`, `SameSite=Lax`, korrekter Domain-Scope | Manual | DevTools im Browser nach `/authorize` |

## 4. Sharing Surface (User + Group)

| # | Test | Modus | Quelle |
|---|---|---|---|
| 4.1 | Per-User-Share: A teilt object mit B (`read`), B liest, B kann NICHT schreiben | Automated | `tests/integration/rls.test.ts` |
| 4.2 | Per-User-Share `write`: B liest+schreibt, kann nicht reshare | Automated | `tests/integration/rls.test.ts` |
| 4.3 | Group-Share: A teilt object mit Group G, alle aktiven Members lesen | Automated | `tests/integration/groups.test.ts` |
| 4.4 | Group-Member entfernen: Member sieht Group-Objects sofort nicht mehr (Master-Rotation in derselben TX) | Automated | `tests/integration/groups.test.ts` |
| 4.5 | Group-Archive: keine neuen Member, existing Members lesen weiterhin | Automated | `tests/integration/groups.test.ts` |
| 4.6 | Cascade-Hook in `refs.ts:addRef`: skill_manifest mit `cascade_on_share=TRUE` teilt seine BUNDLE_ROLES-Resources mit | Automated | `tests/integration/groups.test.ts` |
| 4.7 | Hard-Cap 1000 Grants pro Object — 1001. fail mit klarem Error | Automated | `tests/integration/groups.test.ts` oder Pending |
| 4.8 | Owner-Transfer: alter Owner bleibt admin, neuer Owner muss aktives Member sein, TX ist atomar (FOR UPDATE) | Automated | `tests/integration/groups.test.ts` |
| 4.9 | Revoke-Cascade: nach `revokeCascadeSharesFrom` sind ALLE Sub-Grants des Bundles weg | Automated | `tests/integration/groups.test.ts` |
| 4.10 | `shares.list_my_shares` + `shares.list_for_group` zeigen keine Cross-User-Daten (RLS-Check) | Automated | `tests/integration/groups.test.ts` |
| 4.11 | PWA-Sicht: Storage-Detail-View zeigt "In Gruppen geteilt" korrekt | Manual | mcp-approval2 PWA |

## 5. Object-Lifecycle CRUD

| # | Test | Modus | Quelle |
|---|---|---|---|
| 5.1 | Roundtrip put → get → list → delete für Subtypes `doc`, `skill_manifest`, `memo`, `list`, `note`, `app:composable` | Automated | `tests/integration/objects-roundtrip.test.ts` |
| 5.2 | Inline-Body ≤16 KB bleibt in Postgres `body_cipher`; >16 KB geht in Blob | Automated | `tests/integration/objects-roundtrip.test.ts` |
| 5.3 | Body-Cap 64 KB JSON-Hard-Limit auf `POST /v1/objects` (Smoke gegen Live + Test) | Automated + Smoke | `tests/integration/objects-roundtrip.test.ts` |
| 5.4 | `Idempotency-Key`-Header dedupliziert 24h, gleicher Body returns gleichen Hit, anderer Body → 409 | Automated | `tests/integration/objects-roundtrip.test.ts` oder Pending |
| 5.5 | Subtype-Validation: zod-Regex `^[a-z][a-z0-9_:-]{0,31}$` — `UPPER`, leading-digit, leeres String → 400 | Automated | `tests/integration/objects-roundtrip.test.ts` |
| 5.6 | `subtype_prefix=app:` Left-Anchored LIKE-Match (B-Tree-Index hit) | Automated | `tests/integration/objects-roundtrip.test.ts` |
| 5.7 | `subtype` + `subtype_prefix` zusammen → 400 BAD_REQUEST | Automated | wie oben |
| 5.8 | `object_refs` Multi-Link-Graph: doc als Resource an 3 skills, refcount=3, beim letzten remove geht doc weg (oder GC läuft) | Automated | `tests/integration/objects-roundtrip.test.ts` |
| 5.9 | `object_revisions`: skill-manifest mit 5 Versionen, alte lesbar, Diamond-Index split greift | Automated | `tests/integration/objects-roundtrip.test.ts` |
| 5.10 | Soft-Delete + Hard-Delete (Trash-Pfad bei Apps-Subsystem) | Automated | wie oben |

## 5b. Upload-Pipeline (Presigned URLs)

Eigenständige Surface neben den Objects-CRUD-Routes — alles >16 KB läuft hier durch.

| # | Test | Modus | Quelle |
|---|---|---|---|
| 5b.1 | `POST /v1/uploads/init` returnt presigned PUT-URL mit korrektem `BLOB_ENDPOINT` (R2-EU `.eu.r2.cloudflarestorage.com`) | Smoke | curl |
| 5b.2 | PUT auf presigned URL gegen R2 funktioniert (Content-Length + SHA256 wie signed) | Smoke | wie oben |
| 5b.3 | `POST /v1/uploads/finalize` flippt `objects.body_blob_key`, prüft ETag + Size gegen Init-Spec | Automated | `tests/integration/objects-roundtrip.test.ts` |
| 5b.4 | Finalize ohne vorherige Init (forged blob_key) → 404/403 | **Pending** | Security-Test fehlt |
| 5b.5 | Finalize zweimal mit gleicher upload-id → idempotent (kein zweites Object) | **Pending** | wie oben |
| 5b.6 | Init ohne Finalize wird vom `upload-sweep`-Cron nach Frist gemarkiert + vom `upload-purge`-Cron aus Blob gelöscht | Automated | Integration |
| 5b.7 | Wrong content-type bei PUT → S3-Side error, Finalize kann es nicht rescue'n | Manual | curl |
| 5b.8 | Upload-Init per-User-Quota (falls implementiert): N parallele Inits → N+1 → 429 | **Pending** | hängt von Quota-Modul ab |
| 5b.9 | Blob-Body crypto-AAD nutzt gleiche `<recordType>|<owner_id>|<object_id>`-Formel wie Inline-Body | Automated | `tests/integration/objects-roundtrip.test.ts` |
| 5b.10 | Orphan-Blob nach Object-Delete: Cron läuft, R2-Object wird gelöscht — RLS-deletet Object darf kein Blob hängen lassen | Automated | Integration + Cron-Test |

## 6. Search

| # | Test | Modus | Quelle |
|---|---|---|---|
| 6.1 | RRF-Fusion (`k=60`) FTS+Vector — bekannter Korpus, top-3 deterministisch | Automated | `tests/unit/rrf.test.ts` |
| 6.2 | Subtype-Filter (`subtypes: string[]`, `subtype_prefixes: string[]`) | Automated | `tests/integration/objects-roundtrip.test.ts` |
| 6.3 | Embedding-Pfad: Workers AI bge-m3 (default 1024-dim) — Insert produziert tatsächlich 1024-dim Vector | Smoke | direkt SELECT auf `objects.embedding` nach Smoke-Insert |
| 6.4 | Embedding-Fallback Vertex 768-dim: **Dim-Mismatch ist Boot-Fail-Closed**, nicht silent | Manual | env `EMBED_PROVIDER=vertex` gegen 1024-dim Schema → klarer Error |
| 6.5 | PII-Mask vor Embedding: Email + Phone werden gemasked bevor Provider sie sieht | Automated | `tests/unit/pii.test.ts` + Mock-Provider |
| 6.6 | Salt-Postfix bei Embed (SEC-K-024): zwei User mit gleichem Text → unterschiedliche Vectoren | Automated | `tests/unit/pii.test.ts` (oder Pending) |
| 6.7 | RLS in Search: User B kann Object von A nicht via Search treffen | Automated | `tests/integration/rls.test.ts` |
| 6.8 | Sub-Doc-Annotation in `used_by[]` (max 2 + `used_by_truncated_count`, 0.7× score-penalty) | Automated | `tests/integration/objects-roundtrip.test.ts` (oder Pending) |
| 6.9 | Embed-Retry/Backoff bei Provider-5xx — nicht single-shot fail (siehe PILOT-READINESS Follow-up) | **Pending** | falls noch nicht implementiert: Skip + dokumentieren |
| 6.10 | `composeEmbedSource()` baut deterministisch: gleicher Object-State → gleicher Embed-Text (sonst Re-Embed-Schleifen) | **Pending** | Unit-Test fehlt |
| 6.11 | Embed-Trigger: `description != null AND request.embed === true` — sonst kein Vector. Object ohne Embed-Trigger taucht nur in FTS-only-Pfad auf | Automated | Integration |
| 6.12 | Hybrid-Subset: Objects ohne Embedding fallen NICHT raus, sondern bekommen RRF-Score nur aus FTS-Half | Automated | Integration |
| 6.13 | `docs.update_summary` triggert Re-Embed mit korrekter `body_cipher`-Re-Encryption falls Summary teil des Embed-Source ist | Automated | Integration |
| 6.14 | tsvector-Config: `simple` oder language-specific? Bei DE-Content prüfen ob Stemming greift (`gegangen` matches `gehen`)? | Manual | SQL-Query gegen Production-Sample |
| 6.15 | Special-Chars in Search-Query (FTS-Operatoren `&`, `|`, `!`, `(`, `)`) werden korrekt escaped/quoted (websearch_to_tsquery oder Plain-Mode) | **Pending** | Integration + Security (siehe §14.9) |

## 7. MCP-Server-Funktionalität

KC2 ist seit AS-3 ein **autonomer MCP-Server** auf `POST /mcp` (Streamable-HTTP).
Das ist der wichtigste neue Surface seit dem Cutover und gleichzeitig der
am dünnsten von den existierenden Tests abgedeckte Block. Diese Sektion ist
deshalb tiefer als die anderen.

### 7a. Transport — JSON-RPC 2.0 over Streamable-HTTP

Spec-Quelle: [src/mcp/transport.ts](../../src/mcp/transport.ts) +
[src/mcp/server.ts](../../src/mcp/server.ts) +
MCP-Streamable-HTTP-Transport-Doc.

| # | Test | Modus | Quelle |
|---|---|---|---|
| 7a.1 | `Accept`-Header muss `application/json` enthalten — fehlend/nur `text/event-stream` → 400 mit klarem Error | **Pending** | `tests/contract/mcp-transport.test.ts` fehlt |
| 7a.2 | `Accept: */*` und `Accept: application/json` passieren beide | **Pending** | wie oben |
| 7a.3 | Invalid JSON-Body → 400 mit `code: -32700` (PARSE) | **Pending** | wie oben |
| 7a.4 | Request ohne `jsonrpc:"2.0"`-Feld → 400 mit `code: -32600` (INVALID_REQUEST) | **Pending** | wie oben |
| 7a.5 | Request ohne `method` oder mit leerem `method` → -32600 | **Pending** | wie oben |
| 7a.6 | Batch-Request (Array): N Requests → N Responses, gleiche Reihenfolge | **Pending** | wie oben |
| 7a.7 | Leere Batch `[]` → 400 mit `code: -32600` "empty batch" | **Pending** | wie oben |
| 7a.8 | Notification (Request **ohne** `id`-Feld) → kein Response-Body, HTTP-Status 202 | **Pending** | wie oben |
| 7a.9 | Gemischte Batch (Request + Notification) → nur Responses für die Requests im Array | **Pending** | wie oben |
| 7a.10 | Tool-Handler wirft → JSON-RPC-Error `code: -32002` (TOOL_EXECUTION), id propagiert | **Pending** | wie oben |
| 7a.11 | `id` darf string, number, null sein — alle drei round-trippen unverändert | **Pending** | wie oben |
| 7a.12 | Unsupported method (z.B. `prompts/list`, die KC2 nicht anbietet) → `code: -32601` (METHOD_NOT_FOUND) | **Pending** | wie oben |
| 7a.13 | Internal-Dispatch-Throw → `code: -32603` (INTERNAL), kein Stacktrace im response.error.data | **Pending** | wie oben |
| 7a.14 | Server-Side-Streaming via `text/event-stream` ist **nicht** implementiert — wenn ein Client das erwartet, dokumentiert das `serverInfo`/`capabilities` korrekt? | Manual | `initialize`-Response review |

### 7b. Lifecycle — Initialize / Capabilities / Ping

| # | Test | Modus | Quelle |
|---|---|---|---|
| 7b.1 | `initialize` returns `protocolVersion: "2024-11-05"` (`MCP_PROTOCOL_VERSION` in [src/mcp/types.ts](../../src/mcp/types.ts)) | **Pending** | `tests/contract/mcp-lifecycle.test.ts` fehlt |
| 7b.2 | `initialize` returns `capabilities.tools.listChanged: false` (KC2 emittiert keine list_changed-Notifications) | **Pending** | wie oben |
| 7b.3 | `initialize` returns `serverInfo: {name: "mcp-knowledge2", version: "<package.json>"}` | **Pending** | wie oben |
| 7b.4 | `notifications/initialized` + `initialized` werden als Notification swallowed (200 mit leerer body oder 202) | **Pending** | wie oben |
| 7b.5 | `notifications/cancelled` swallowed (no-op, kein Crash) | **Pending** | wie oben |
| 7b.6 | `ping` returns `{}` | **Pending** | wie oben |
| 7b.7 | Protocol-Version-Mismatch: Client schickt unbekanntes `protocolVersion` in `initialize` — Server akzeptiert (keine Verhandlung) oder lehnt klar ab? Entscheidung dokumentieren | Manual | INTEGRATION.md §Protocol-Compat |
| 7b.8 | Re-Initialize: nach erstem `initialize` + `initialized` kommt zweites `initialize` — Server bleibt stateless und akzeptiert | **Pending** | wie oben |

### 7c. Service-Mode-Filter (S2S-Discovery vs User-Calls)

[src/mcp/server.ts:35](../../src/mcp/server.ts#L35) — `SERVICE_MODE_ALLOWED_METHODS`
ist die wichtigste Auth-Gate-Linie nach dem JWT-Middleware-Stack.

| # | Test | Modus | Quelle |
|---|---|---|---|
| 7c.1 | Bearer `SERVICE_TOKEN_OPS` (authMode=`service`) darf `initialize`, `notifications/initialized`, `ping`, `tools/list` | **Pending** | `tests/contract/mcp-service-mode.test.ts` fehlt |
| 7c.2 | Bearer `SERVICE_TOKEN_OPS` auf `tools/call` → `-32601` METHOD_NOT_FOUND mit "use OBO or user JWT" message | **Pending** | wie oben |
| 7c.3 | Bearer `SERVICE_TOKEN_OPS` auf `resources/list` (falls je implementiert) → blocked | **Pending** | wie oben |
| 7c.4 | User-JWT auf `tools/call` → passt | **Pending** | wie oben |
| 7c.5 | OBO (`X-On-Behalf-Of` + `SERVICE_TOKEN_OPS`) auf `tools/call` → passt, `current_user` aus `payload.sub` | **Pending** | wie oben |
| 7c.6 | Ohne Authorization → 401 (Middleware `requireJwtOrOnBehalfOf` ist davor) | **Pending** | wie oben |
| 7c.7 | Wrong-aud / wrong-iss JWT → 401, klare Error-Message ohne Token-Leak | Automated | `tests/contract/obo-jwt.test.ts` |

### 7d. Tools-Surface — tools/list + tools/call

| # | Test | Modus | Quelle |
|---|---|---|---|
| 7d.1 | `tools/list` Schema-Invariante: alle Tools haben `name`, `description`, `inputSchema` (Pflicht für approval2-manifest-client) | Automated | `tests/contract/mcp-tools-list.test.ts` |
| 7d.2 | 47 High-Level-Wrapper sind alle registriert: 7 docs, 9 skills, 4 memorize, 6 lists, 5 notes, 10 groups, 4 sharing, 2 browse — Count-Assertion | **Pending** | Count-Test fehlt in `tests/sanity/tools-sanity.test.ts` |
| 7d.3 | 16 Low-Level-Primitive haben `annotations.tags:['low-level']` (approval2-Filter funktioniert) | Automated | `tests/sanity/wrapper-migration-fixes.test.ts` |
| 7d.4 | Mandatory-Tool-Surface (approval2-side §1.4): `objects.{create,get,list,update,delete}`, `shares.{create,list,revoke}`, `search` | Automated | `tests/contract/mcp-tools-list.test.ts` |
| 7d.5 | Tool-Names matchen `^[a-z][a-z0-9._-]+$` (approval2-mcp.protocol.registry-Constraint) | Automated | `tests/contract/mcp-tools-list.test.ts` |
| 7d.6 | `inputSchema.type === "object"` für alle Tools (sonst wrapped approval2 args in `_input`) | Automated | `tests/contract/mcp-tools-list.test.ts` |
| 7d.7 | Keine Duplicate-Names (`registerTool` wirft bei `registry.has(name)`) | Automated | wäre via beforeAll-Replay schon im Sanity-Test sichtbar |
| 7d.8 | `tools/call` mit nicht-registriertem name → `-32001` TOOL_NOT_FOUND | **Pending** | `tests/contract/mcp-service-mode.test.ts` |
| 7d.9 | `tools/call` ohne `name` oder mit leerem `name` → `-32602` INVALID_PARAMS | **Pending** | wie oben |
| 7d.10 | `tools/call` Handler returnt `isError: true` bei Domain-Errors (z.B. RLS-403, 404) statt JSON-RPC-Envelope-Error — semantischer Unterschied muss konsistent sein | **Pending** | per-Tool Integration-Suite |
| 7d.11 | Cursor-Aliasing: Input `cursor` (snake_case), Output **beide** `cursor`+`next_cursor`+`nextCursor` parallel emittiert | Automated | `tests/sanity/wrapper-migration-fixes.test.ts` |
| 7d.12 | `memorize.search` emittiert **beide** `hits` UND `items` parallel (approval2-Compat) | Automated | runtime-test, in Integration-Suite |

### 7e. CallToolResult Content-Types

| # | Test | Modus | Quelle |
|---|---|---|---|
| 7e.1 | Text-Content: `{type:"text", text:"..."}` ist Default für die meisten Wrappers | Automated | per-Tool Integration |
| 7e.2 | `resource_link` (PLAN-document-linking objects.get): `{type:"resource_link", uri, name, description?, mimeType?, _meta?}` ohne Body | **Pending** | `tests/integration/objects-roundtrip.test.ts` falls noch nicht abgedeckt |
| 7e.3 | `image` (base64 + mimeType) für `docs.get` mit Bild-Body | **Pending** | bei Bedarf |
| 7e.4 | `resource` (inline mit URI) für skill-Bundle reads | **Pending** | per-Tool |
| 7e.5 | `structuredContent` optional gefüllt für strukturierte Tool-Returns (z.B. `objects.list`) | **Pending** | per-Tool |
| 7e.6 | Body > 64 KB JSON-Cap in Result: wird truncated mit `resource_link` zurückgegeben statt inline (`objects.browse_read` semantics) | **Pending** | per-Tool |

### 7f. WYSIWYS + Approval2-Bridge

| # | Test | Modus | Quelle |
|---|---|---|---|
| 7f.1 | Jeder write-Tool (`sensitivity in {write,danger,destructive}` oder `write:true`) hat `annotations.wysiwys.display_template` | Automated | `tests/contract/mcp-tools-list.test.ts` |
| 7f.2 | Nested `wysiwys.display_template` ist canonical (snake_case), nicht flat `displayTemplate` — KC2 emittiert nested | Automated | `tests/contract/mcp-tools-list.test.ts` |
| 7f.3 | approval2 manifest-client parsed KC2-tools/list ohne Runtime-Error (Cross-Service-Contract) | Automated | `tests/contract/mcp-tools-list.test.ts` |
| 7f.4 | approval2's `resolveSensitivity` Fallback-Chain: `annotations.sensitivity` > `annotations.write` > `destructiveHint` → konsistente Result für jeden Tool | Manual | Cross-Repo-Snapshot-Test (approval2-Side) |
| 7f.5 | `destructive`→`danger`-Migration: kein Tool emittiert noch `sensitivity:"destructive"` | Automated | `tests/sanity/wrapper-migration-fixes.test.ts` |
| 7f.6 | Display-Template-Mustache-Render: alle Templates rendern ohne Throw bei sample args (z.B. `{{title}}` mit String, `{{count}}` mit Number) | **Pending** | Snapshot-Test pro Tool |
| 7f.7 | approval2's PWA zeigt korrekt was KC2 ausführt — kein Drift zwischen `display_template` und tatsächlichem Call-Args (WYSIWYS-Principle) | Manual | Pair-Session approval2-PWA + KC2-Audit-Log |

### 7g. MCP End-to-End mit echten Clients

| # | Test | Modus | Quelle |
|---|---|---|---|
| 7g.1 | claude.ai (Pfad A — DCR direkt): Connector-Add → DCR-Register → Authorize → Token → `tools/list` zeigt alle 47 Wrapper | Manual | INTEGRATION.md Pfad A |
| 7g.2 | claude.ai: `docs.put` (write) → Approval-Prompt korrekt (display_template) → ausführen → `objects.browse_list` zeigt Doc | Manual | Pair-Session |
| 7g.3 | claude.ai: `search` (read) → keine Approval, direkt Resultat | Manual | wie oben |
| 7g.4 | Pfad B (approval2-Proxy): gleicher Roundtrip mit OBO-Token statt direkter DCR — claude.ai sieht KC2-Tools via approval2's auto-forwarder | Manual | INTEGRATION.md Pfad B |
| 7g.5 | MCP-Inspector (`@modelcontextprotocol/inspector`) gegen `https://knowledge2.ai-toolhub.org/mcp`: initialize → tools/list → tools/call grün | Manual | Debug-Tool |
| 7g.6 | Reconnect-Resilience: Client schliesst Connection mitten in `tools/call`, retried mit gleicher Request-id → Server hat keinen Hung-State | Manual | claude.ai-Disconnect-Test |
| 7g.7 | Multi-Client-Parallelität: claude.ai + MCP-Inspector parallel, beide `tools/list` + `tools/call`, kein Cross-Talk in Logs (request_id discriminiert) | Manual | concurrent session test |

## 7h. JSON-Schema-Konverter (zod → JSON-Schema)

[src/mcp/json-schema.ts](../../src/mcp/json-schema.ts) ist hauseigen (kein
`zod-to-json-schema` npm-Paket). Bei neuen Zod-Konstrukten in Tool-Inputs
ist das eine stille Drift-Quelle.

| # | Test | Modus | Quelle |
|---|---|---|---|
| 7h.1 | `ZodOptional` + `ZodDefault` unwrappen korrekt | **Pending** | `tests/unit/json-schema.test.ts` fehlt |
| 7h.2 | `ZodEffects` (`.refine()`, `.transform()`, `.superRefine()`) descenden zur inner shape | **Pending** | wie oben |
| 7h.3 | `ZodNullable` produziert `type: ['<inner>', 'null']` (approval2 erwartet das) | **Pending** | wie oben |
| 7h.4 | `ZodEnum` produziert `type:"string", enum:[...]` | **Pending** | wie oben |
| 7h.5 | `ZodArray`, `ZodRecord`, `ZodObject` produzieren korrekte Shapes mit `items`/`additionalProperties`/`properties`+`required` | **Pending** | wie oben |
| 7h.6 | `ZodUnion`, `ZodDiscriminatedUnion`, `ZodIntersection`, `ZodTuple` — was passiert? Sind sie in den Wrappern verwendet? Falls ja: ergänzen, falls nein: Boot-Time-Assertion das sie nicht auftauchen | Manual | grep über `src/mcp/tools/*.ts` |
| 7h.7 | Unknown Zod type → Konverter wirft KLAR (nicht silent `{}`) | **Pending** | wie oben |
| 7h.8 | Format-Constraints (`.uuid()`, `.url()`, `.regex(...)`): emittiert der Konverter `format`? Falls ja: konsistent mit approval2-side (`tests/sanity/wrapper-migration-fixes.test.ts` zeigt dass uuid-Format BEWUSST nicht emittiert wird) | Automated | Sanity |

## 8. Cross-Service-Contract (approval2 ↔ KC2)

| # | Test | Modus | Quelle |
|---|---|---|---|
| 8.1 | OBO-JWT Wire-Shape (`X-On-Behalf-Of`-Header + `SERVICE_TOKEN_OPS`) | Automated | `tests/contract/obo-jwt.test.ts` |
| 8.2 | `/v1/internal/sync-user` Schema (approval2 pushed Email/Display) | Automated | `tests/contract/user-sync.test.ts` |
| 8.3 | `/v1/internal/erase-user` mit signed Erase-Receipt | Automated | `tests/contract/user-sync.test.ts` |
| 8.4 | `tools/list` Wire-Shape gegenüber `kc_wrappers/manifest-client.ts` (snake_case `wysiwys.display_template`) | Automated | `tests/contract/mcp-tools-list.test.ts` |
| 8.5 | Round-Trip Pilot: approval2 macht `tools/call docs.put` → KC2 schreibt → KC2 macht `search` → approval2 zeigt Hit | Smoke | `bash scripts/smoke-prod.sh` aus approval2-Repo |
| 8.6 | approval2's `/admin/kc-proxy/*` PWA-Pfad funktioniert nach Cutover (Storage-Tab listet KC2-Objects via approval2-PWA) | Manual | PWA-Check |
| 8.7 | OpenAPI-Konsistenz: [docs/openapi.yaml](../openapi.yaml) ist Source-of-Truth — alle Routes in `src/routes/*.ts` haben einen OpenAPI-Eintrag und umgekehrt | **Pending** | Drift-Check-Script fehlt |
| 8.8 | approval2-kc_wrappers-Auto-Generator: nach `tools/list`-Aufruf werden alle 47 Wrapper als approval2-Tools registriert ohne Fehler | Automated | Cross-Repo: approval2 `tests/.../kc_wrappers.test.ts` |
| 8.9 | OBO + S2S-Two-Factor: Header `X-On-Behalf-Of` ohne `SERVICE_TOKEN_OPS` → 401; mit falschem Service-Token → 403; nur beides zusammen passt | Automated | `tests/contract/obo-jwt.test.ts` |
| 8.10 | Audit-Trail: nach approval2-Roundtrip steht in `audit_log` Eintrag mit `via_proxy=true` UND `approval_id` (Cross-Service-Tracing) | Automated | Integration |

## 9. Backup & Restore

**Pflicht vor erstem echten User-Daten-Tag.** Backup ohne verifiziertem
Restore ist kein Backup.

| # | Test | Modus | Quelle |
|---|---|---|---|
| 9.1 | Daily-Backup-Cron läuft 03:00 UTC, schreibt encrypted Dump nach `BACKUP_BUCKET` | Smoke | nach 24h: `aws s3 ls` (R2-EU-Endpoint) |
| 9.2 | Backup-Datei ist tatsächlich AES-256-GCM encrypted (nicht plaintext, nicht falscher Master-Key) | Manual | hexdump Header-Check + Decrypt mit `BACKUP_MASTER_KEY` |
| 9.3 | `scripts/restore-backup.ts` Dry-Run gegen Throwaway-Neon-Branch | Drill | runbook-fly-deploy.md §Restore |
| 9.4 | Restored DB ist functional: User-Login, Object-Read, Search produzieren gleiche Resultate wie Original-Snapshot | Drill | manueller Vergleich |
| 9.5 | `BACKUP_MASTER_KEY` Verlust-Szenario: gibt es ein zweites Hold-Storage? (private Doppler-Note? Offline-Print?) | Manual | Operator-Check |
| 9.6 | Orphan-Blob-Cleanup-Cron (weekly placeholder) — sieht keine Live-Blobs irrtümlich als orphan an | **Pending** | falls Implementation noch placeholder ist |
| 9.7 | Idempotency-GC-Cron (1h) leakt nichts ausserhalb 24h TTL | Automated | Integration |

## 10. Crons & Async-Jobs

| # | Test | Modus | Quelle |
|---|---|---|---|
| 10.1 | pg-boss v10 `createQueue()`-Pflicht vor `work()`/`schedule()` — Boot crasht nicht mit "Queue not found" | Smoke | Boot-Log auf Fly nach Deploy |
| 10.2 | Upload-Sweep (30min) expired `pending` Uploads | Automated | Integration |
| 10.3 | Upload-Purge (1h) löscht Blob-Garbage von gecancelten Uploads | Automated | Integration |
| 10.4 | `rewrap_jobs`-Worker via GitHub-Actions-Cron `*/2` + `POST /v1/internal/rewrap-tick` | Smoke | nach Member-Remove: Job läuft, Status `completed` |
| 10.5 | Worker idempotent: zweimal `POST /rewrap-tick` direkt nacheinander → identisches Resultat | Automated | Integration |

## 11. Resilienz / Operations

| # | Test | Modus | Quelle |
|---|---|---|---|
| 11.1 | Graceful Shutdown: SIGTERM → drain crons → close pg pool → exit ≤30s | Manual | `flyctl deploy` Rolling-Deploy beobachten |
| 11.2 | `/health` liveness (immer 200 wenn Process lebt) | Smoke | jeder Deploy |
| 11.3 | `/health/ready` deep: DB load-bearing (fail → 503), Blob opportunistic (fail → 200 + `status:"degraded"`) | Smoke | mit künstlichem Blob-Outage testen (z.B. R2-Token-Drop) |
| 11.4 | Postgres-Connection-Loss → Retry mit Backoff (nicht crash-loop) | Automated | `tests/unit/retry.test.ts` |
| 11.5 | Rate-Limit-Middleware blockt Burst auf `/oauth/*` | Automated | `tests/unit/rate_limit.test.ts` |
| 11.6 | Release-Command `npm run db:migrate` idempotent — zweimal direkt hintereinander → keine Doppel-Apply | Smoke | `flyctl deploy` zweimal |
| 11.7 | Rollback-Drill: `flyctl releases list` + `flyctl releases rollback <prev>` zurück auf vorherige Version, smoke grün | Drill | [runbook-fly-deploy.md](../runbooks/runbook-fly-deploy.md) |
| 11.8 | Neon-Branch + PITR (Free-Tier 6h Retention) — Branch-Create + Restore-from-PITR | Drill | Neon Console |

## 12. Observability

| # | Test | Modus | Quelle |
|---|---|---|---|
| 12.1 | `/metrics` Prometheus liefert nicht-zero Counter nach Smoke-Roundtrip | Smoke | `curl /metrics` |
| 12.2 | Pino-Logs strukturiert mit `request_id`, PII-redact für `email`, `phone`, `body` | Manual | `flyctl logs` review |
| 12.3 | `audit_log` schreibt alle non-trivial Writes inkl. `via_proxy` + `approval_id` (Cross-Service-Trail) | Automated | Integration |
| 12.4 | Audit-Strip: Erase-Pfad lässt 9 Felder stehen (Multi-User-Sprint §4.1.1), nicht mehr | Automated | Integration |
| 12.5 | OTEL-Hooks (env `OTEL_EXPORTER_OTLP_ENDPOINT`) — Boot mit Endpoint setzen, Traces erscheinen | **Pending** | falls noch nicht wired |

## 13. Deployment & Secrets

| # | Test | Modus | Quelle |
|---|---|---|---|
| 13.1 | Doppler-Config `fly` hat alle Required-Keys gefüllt (siehe PILOT-READINESS Doppler-Gap) | Smoke | `doppler secrets --project mcp-knowledge2 --config fly --only-names` review |
| 13.2 | R2-EU-Jurisdiction-Endpoint `https://<account>.eu.r2.cloudflarestorage.com` (mit `.eu.`, Global-Endpoint gibt 403) | Smoke | `BLOB_ENDPOINT` value-check + Test-PUT |
| 13.3 | Neon-Pooler-Endpoint korrekt (`-pooler.c-3.eu-central-1.aws.neon.tech`), nicht Direct-Endpoint | Smoke | `DATABASE_URL` value-check |
| 13.4 | `SERVICE_TOKEN` Rotation-Drill: alten + neuen parallel, alter ist nach Frist invalid | Drill | runbook-token-rotation |
| 13.5 | Google-OAuth-Client-Secret Rotation: alter Refresh-Token-Sessions sterben sauber (clients re-login) | Drill | runbook-token-rotation |
| 13.6 | TLS-Cert für `knowledge2.ai-toolhub.org` ist DV-validated und auto-renewed (fly_cert + DNS-01) | Smoke | `curl -vI https://knowledge2.ai-toolhub.org` |
| 13.7 | Bootstrap fail-closed: fehlende KEY-Env-Vars → Boot-Crash mit klarem Error, nicht Default | Manual | env-Drop-Test |
| 13.8 | `DCR_INITIAL_ACCESS_TOKEN` Production-Setting prüfen — wenn DCR offen, dokumentierter Reason | Manual | Doppler-Check |

## 14. Negative / Security-Tests

| # | Test | Modus | Quelle |
|---|---|---|---|
| 14.1 | Cross-User-Body-Replay: gleicher ciphertext mit anderer `owner_id` injecten → Decrypt-Fail (AAD) | Automated | `tests/unit/crypto.test.ts` |
| 14.2 | Cross-User-Search via Vector-Direct-Query (bypass owner-filter) → 0 Hits dank RLS | Automated | `tests/integration/rls.test.ts` |
| 14.3 | Manipulated JWT (signature broken, exp expired, wrong-aud) → 401 | Automated | `tests/contract/obo-jwt.test.ts` |
| 14.4 | Missing `SERVICE_TOKEN` auf `/v1/internal/*` → 401 | Automated | `tests/contract/user-sync.test.ts` |
| 14.5 | DisplayName mit Control-Chars wird sanitized (Multi-User-Sprint §4.1.3) | Automated | `tests/contract/user-sync.test.ts` |
| 14.6 | INET-CSV mit malformed IP (approval2-Bugfix-Pendant) — falls KC2 INETs verarbeitet | Automated | Pending falls nicht abgedeckt |
| 14.7 | CORS auf `/v1/internal/*` ist NICHT `*` (SEC-K-009 gefixt) | Manual | `curl -H "Origin: https://evil.invalid"` Preflight |
| 14.8 | Embedding-Inversion-Risk: PII-mask vor Vertex/Workers-AI greift in allen Codepfaden (search-query, object-insert, update) | Automated | `tests/unit/pii.test.ts` + Integration |
| 14.9 | SQL-Injection-Probe gegen Search-Query (FTS `tsquery`-Parser) — special-chars werden escaped | **Pending** | falls noch nicht abgedeckt |

## 15. Performance / Load (Soft-Gate)

Pilot ist Solo, deshalb nicht blockierend. Aber einmal messen bevor zweiter User dazukommt.

| # | Test | Modus |
|---|---|---|
| 15.1 | Object-Get p50 < 80ms, p95 < 250ms (Frankfurt → EU) gegen 100-Object-Korpus | Manual |
| 15.2 | Search p50 < 200ms, p95 < 600ms gegen 100-Object-Korpus | Manual |
| 15.3 | Embed-Provider-Quota: 10 parallele puts → kein 429 von Workers AI Gateway | Manual |
| 15.4 | Blob-Upload-Pipeline (presigned URL → PUT → finalize) für 5 MB File: <10s total | Manual |
| 15.5 | RLS-Predicate `owner_or_shared(object_id)` mit 10k Objects + 100 Shares — Query-Plan bleibt index-only | Manual |

## 15b. Quota & Limits

Eigene Sektion weil bei Multi-User kritisch — ein User darf das System nicht
für andere lahmlegen.

| # | Test | Modus | Quelle |
|---|---|---|---|
| 15b.1 | Per-User-Storage-Cap (Anzahl Objects oder Bytes): wenn implementiert in `src/quota/`, dann Hard-Cap-Test | **Pending** | hängt davon ab ob Quota-Modul existiert |
| 15b.2 | Body-Cap 64 KB JSON (siehe §5.3) | Automated | Integration |
| 15b.3 | Per-Object refs-Cap (Multi-Link-Graph): 1000+ refs an einem doc → was passiert? | **Pending** | Edge-Case-Test |
| 15b.4 | Share-Cap pro Object (Hard-Cap 1000 Grants, siehe §4.7) | Automated | Integration |
| 15b.5 | Embed-Quota (Workers AI Gateway): wenn überschritten → graceful Degradation (Object wird ohne Vector gespeichert, dokumentiert in Audit) | **Pending** | Integration mit Mock-Provider |
| 15b.6 | Rate-Limit auf `/v1/objects` write-Routes (nicht nur `/oauth/*`)? Solo-Pilot okay ohne, vor Multi-User Pflicht | **Pending** | Hardening-Phase-2 |
| 15b.7 | Postgres-Connection-Pool-Cap: N parallele Calls → kein Pool-Exhaustion-Hang, sondern klare 503 | Manual | Load-Test |

## 16. Multi-User-Activation (Tier 1 → 2)

Erst aktivieren wenn alles oben grün. Tier 1 = Solo-Pilot (das bist du selbst), Tier 2 = erster externer Tester.

| # | Test | Modus |
|---|---|---|
| 16.1 | Re-Encrypt-Skript v1→v2 (SEC-K-005 Step B) gegen Production-Throwaway-Snapshot | Drill |
| 16.2 | `SERVICE_TOKEN_ERASE/SYNC/OPS` getrennt provisioniert in beiden Repos (SEC-K-009) | Smoke |
| 16.3 | `REQUIRE_ERASE_RECEIPT=true` enforced (SEC-K-016) | Smoke |
| 16.4 | Lockdown auf Fly Private Network (`.flycast` / 6PN-only) — siehe SECURITY_ISSUES "Top-Recommendation" | Drill (post-pilot, vor zweitem User) |
| 16.5 | Pair-Session mit zweitem User: er bekommt Invite via PWA, registriert, schreibt sein erstes Object, teilt mit dir, du liest | Manual |
| 16.6 | RLS-Negativtest mit echtem zweiten Account (nicht nur synthetic UUID): seine Reads sehen deine Objects nicht | Manual |
| 16.7 | Erase-User-Flow: zweiter User wird gelöscht, alle seine Objects + DEKs + Audit-Log-Crumbs sauber weg | Drill |

---

## Go-Live-Gate

Vor erstem realen Pilot-User-Daten-Tag müssen mindestens grün sein:

**Block A — Daten-Integrität (alle):**
- §1.1 – §1.4, §1.7 – §1.11
- §2.1 – §2.5, §2.8 – §2.10
- §9.1 – §9.4 (Backup + restored Drill **einmal** durchgespielt)

**Block B — Auth (alle):**
- §3.1, §3.3, §3.5, §3.8, §3.9, §3.11

**Block C — Surface (alle):**
- §5.1 – §5.5
- §5b.1 – §5b.3, §5b.6, §5b.9
- §6.1, §6.2, §6.5, §6.7, §6.11, §6.12
- §7a.1, §7a.3 – §7a.8, §7a.10, §7a.12 (MCP-Transport-Grundlagen)
- §7b.1 – §7b.6 (Lifecycle)
- §7c.1 – §7c.6 (Service-Mode-Filter)
- §7d.1 – §7d.7 (Tools-Surface-Invarianten)
- §7e.1, §7e.2 (Content-Types)
- §7f.1 – §7f.5 (WYSIWYS-Bridge)
- §7g.1, §7g.2, §7g.4 (End-to-End mit echten Clients — beide Pfade)
- §7h.1 – §7h.5, §7h.7 (Schema-Konverter)
- §8.1 – §8.5, §8.8, §8.9, §8.10 (Cross-Service)

**Block D — Operations (alle):**
- §10.1
- §11.1 – §11.3, §11.6, §11.7
- §13.1 – §13.3, §13.6, §13.7

**Block E — Security-Gate (alle):**
- §14.1 – §14.5, §14.7

**Soft (nice-to-have vor zweitem User, nicht für Solo-Pilot blockierend):**
- §15.* (Performance), §15b.* (Quota)
- §1.6, §13.4, §13.5 (Rotation-Drills)
- §16.* (zweiter User)
- §6.9, §9.6, §12.5, §14.6, §14.9 (Pending-Tests schreiben)
- §7a.14, §7b.7, §7b.8, §7e.3 – §7e.6, §7f.6, §7f.7, §7g.5 – §7g.7 (MCP-Edge-Cases)

## Pending-Tests, die noch geschrieben werden müssen

Die mit **Pending** markierten Zeilen sind echte Test-Lücken (nicht nur
unvorgenommene Drills). Konsolidiert nach Prio:

**P0 — Vor Solo-Pilot-Go-Live schreiben:**

*MCP-Server-Layer (komplett neuer Test-File-Cluster):*
- §7a.* — `tests/contract/mcp-transport.test.ts` (JSON-RPC-Envelope, Accept-Header,
  Batch, Notifications, Error-Codes). Heute nur tools/list geprüft, der Rest
  ist Trust-Me-It-Works.
- §7b.* — `tests/contract/mcp-lifecycle.test.ts` (initialize/initialized/ping/
  protocolVersion, serverInfo, capabilities). Heute null Coverage.
- §7c.* — `tests/contract/mcp-service-mode.test.ts` (SERVICE_MODE_ALLOWED_METHODS
  enforce). Das ist die wichtigste Auth-Gate-Linie nach JWT-Middleware.
- §7d.8 / §7d.9 — tools/call mit unknown name + missing name (TOOL_NOT_FOUND vs
  INVALID_PARAMS Diskriminierung).
- §7h.* — `tests/unit/json-schema.test.ts` (eigener Zod→JSON-Schema-Konverter).
  Bei neuen Zod-Konstrukten in Tool-Inputs drift-quelle.

*Datenpfad:*
- §1.9 — Lazy-Migration v1→v2 für Blob-Pfad-Bodies (>16 KB) **vor erstem
  Group-Share-Live-Use**.
- §5.4 — `Idempotency-Key`-Header (24h-Dedup, body-mismatch 409).
- §5b.4 / §5b.5 — Upload-Pipeline Security (Forged blob_key + Finalize-
  Idempotency).
- §6.6 — Embed-Salt-Postfix (SEC-K-024 Cross-User-Inference).

*Schema:*
- §2.9 — Boot-Time-Assertion `knowledge_app` ≠ BYPASSRLS.
- §3.6 / §3.8 — Erase-Receipt-Binding + ALLOWED_EMAILS-Whitelist (falls noch
  nicht abgedeckt).

**P1 — Vor zweitem User schreiben:**
- §4.7 — Hard-Cap 1000 Grants.
- §6.8 — Sub-Doc-`used_by[]` Annotation + score-penalty.
- §6.10 — `composeEmbedSource()` determinism.
- §6.15 / §14.9 — FTS-Query-Escape / SQL-Injection-Probe.
- §7d.2 — 47-Wrapper-Count-Assertion (Drift-Wächter).
- §7d.10 — `isError:true` vs JSON-RPC-Envelope-Error Konsistenz.
- §7d.12 — `memorize.search` hits+items Dual-Output Runtime-Test.
- §7e.* — CallToolResult-Content-Types (resource_link, image, structuredContent).
- §7f.6 / §7f.7 — Display-Template-Mustache-Render + Drift gegen Audit-Log.
- §8.7 — OpenAPI-Drift-Check.
- §15b.* — Quota-Limits.

**P2 — Nach erstem Daten-Tag, vor Skalierung:**
- §6.9 — Embed-Retry/Backoff bei Provider-5xx.
- §6.14 — tsvector-Sprach-Config bei DE-Content.
- §9.6 — Orphan-Blob-Cleanup-Cron Negativ-Pfad.
- §12.5 — OTEL-Tracing-Verifikation.
- §14.6 — INET-CSV malformed.
- §7g.5 – §7g.7 — MCP-Inspector + Multi-Client-Parallelität.

Reihenfolge zur Bearbeitung **P0**: zuerst `tests/contract/mcp-transport.test.ts`
+ `mcp-lifecycle.test.ts` + `mcp-service-mode.test.ts` (~1 Tag zusammen,
freezed das MCP-Wire-Format). Dann §5.4 (Idempotency), §6.6 (Salt), §1.9
(Crypto-Blob-Path), §2.9 (BYPASSRLS-Assertion). Das ist die Mindest-Linie,
die das Go-Live-Gate (Block A–E oben) tatsächlich grün bekommt.
