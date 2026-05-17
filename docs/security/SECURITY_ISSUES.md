# Security Issues — mcp-knowledge2

**Stand:** 2026-05-17
**Auditor:** Claude (Opus 4.7), user-initiated review pre-cutover
**Branch:** `feat/as3-cutover` (Schwester-Repo) / `main`
**Scope:** Access-Control / Auth / Crypto / RLS / Trust-Boundary — keine reine Code-Quality

> Lebende Findings-Liste. Komplementär zu [`SECURITY.md`](./SECURITY.md) (Threat-Model).
> Jeder CRITICAL/HIGH-Befund wurde direkt am Code (file:line) verifiziert.

---

## Inhalt

- [Top-Recommendation: Lockdown auf Fly Private Network](#lockdown)
- [Legende](#legende)
- [CRITICAL](#critical)
- [HIGH](#high)
- [MEDIUM](#medium)
- [Verified Safe](#verified-safe)
- [Audit-Methodik](#audit-methodik)
- [Follow-up-Plan](#follow-up-plan)

---

## Top-Recommendation: Lockdown auf Fly Private Network <a id="lockdown"></a>

**Kontext:** KC2 ist heute öffentlich erreichbar auf `https://mcp-knowledge2.fly.dev` und (via CF-Proxy) `https://knowledge2.ai-toolhub.org`. Das exposed das gesamte Route-Set: `/oauth/{register,authorize,callback,token}`, `/.well-known/{oauth-authorization-server,jwks.json}`, `/v1/*`, `/v1/internal/*`, `/mcp`, `/health/*`, `/metrics`.

**Befund:** Pfad-A (direkter Claude.ai MCP-Client → KC2 mit eigenem DCR-OAuth-Token) ist **nie real-world getestet worden** — `MCP_APPROVAL_JWKS_URL` ist in Doppler nur ein Placeholder, `docs/INTEGRATION.md:34` nennt diesen Pfad selbst "Reality-Check noch offen", kein Integration-Test in `tests/` exerciert einen non-approval2-Client. approval2 ist der einzige tatsächliche Konsument. Damit ist die komplette DCR-Facade in KC2 (`src/auth/oauth_facade/`) Dead-Weight.

**Empfehlung:** Option A — **Fly Private Network (`.flycast` / 6PN-only)**. Beide Fly-Apps liegen in derselben Org (`var.fly_org`), `.flycast` greift ohne Paid-Plan.

**Was zu tun ist (Detail-Plan):**
1. `fly.toml`: `[http_service]` → `[[services]]` mit `internal_port=8080`, `auto_stop_machines='off'`.
2. `flyctl ips release <v4> && flyctl ips release <v6>` — Public-IPs entfernen.
3. TF: `fly_ip "knowledge2_v6"` aus [terraform/environments/privat/knowledge2-fly.tf:66-69](../../../mcp-approval2/terraform/environments/privat/knowledge2-fly.tf#L66) entfernen. `knowledge2-fly-cf.tf` deaktivieren (CF-Proxy + Cert + WAF).
4. Doppler: approval2's `MCP_KNOWLEDGE_URL` von `https://knowledge2.ai-toolhub.org` auf `http://mcp-knowledge2.flycast:8080` flippen.
5. Google-Console: `https://mcp-knowledge2.fly.dev/auth/google/callback` aus den OAuth-Redirect-URIs entfernen.
6. `scripts/smoke.sh` umbauen — von public-URL auf `flyctl ssh console` + interner curl.
7. PWA `/admin/kc-proxy/*`-Route in approval2 spricht KC2 weiterhin über `MCP_KNOWLEDGE_URL` — kein PWA-Change.

**Was das eliminiert (siehe Findings unten):**
- SEC-K-003 (DCR-Endpoint offen) — Route nicht mehr erreichbar
- SEC-K-009 (CORS `*` auf `/v1/internal/*`) — Internet-Caller können das nicht mehr triggern
- Hälfte des Blast-Radius von SEC-K-002 (JWKS-URL-Allowlist)
- M-13 (well-known reveals registration_endpoint) — kein well-known mehr public
- Reduziert SEC-K-006 (SERVICE_TOKEN admin-equivalent) drastisch — Token-Leak ohne Network-Access wirkungslos

**Was es NICHT fixt** — diese Findings sind code-level und bleiben:
- SEC-K-001 (OBO-`on_behalf_of` ungebunden)
- SEC-K-002 (`MCP_APPROVAL_JWKS_URL` no host-allowlist)
- SEC-K-004 (object_revisions AAD-mismatch)
- SEC-K-005 (HKDF-Salt = plain userId)
- SEC-K-006 (UserSync-Email-key trust)
- alle Crypto/AAD-Befunde
- alle Refresh/Auth-Code-Race-Befunde

**Effort:** ~2 Stunden inkl. Rollback-Plan. Existing Plan-Doku: [`docs/plans/active/PLAN-hardening.md §6 H7`](../plans/active/PLAN-hardening.md).

**Reversibel:** Falls Pfad-A je real wird, Doppler-Wert zurückflippen + neue Public-Service-Definition deployen.

---

## Legende <a id="legende"></a>

- **CRITICAL** — direkter unauth-Access, kompletter Account-Takeover, kompromittierter Trust-Boundary, oder gebrochene Crypto-Invariante.
- **HIGH** — authenticated bypass, Secret-Exposure, Privilege-Escalation, oder massive DoS-Surface. Vor Cutover fixen.
- **MEDIUM** — Defense-in-Depth-Schwäche, alleinstehend nicht ausnutzbar, in Kombination gefährlich.

---

## CRITICAL <a id="critical"></a>

### SEC-K-001 — OBO `on_behalf_of` ist ungebunden zum JWT-`sub` → approval2 kann jeden User impersonieren

- **File:** [src/auth/on_behalf_of.ts:108-127](../../src/auth/on_behalf_of.ts#L108-L127)
- **Symptom:** Der OBO-Header wird über `jwtVerify` korrekt signature-validiert (Issuer, Audience, Algorithmus). Anschließend wird `payload.on_behalf_of` als **alleinige Wahrheit** für die KC2-User-Identität genommen:
  ```ts
  const subject = typeof payload.on_behalf_of === 'string' ? payload.on_behalf_of : '';
  if (!subject) throw errUnauthorized('OBO jwt missing on_behalf_of');
  const user = subject.includes('@')
    ? await resolveByEmail(subject)
    : await resolveByGoogleSub(subject);
  ```
- Es gibt **keinen Cross-Check** zwischen `payload.sub` (approval2-interne User-ID) und der über `on_behalf_of` aufgelösten KC2-User-Row.
- **Exploit:** Jeder, der die approval2-RS256-Signing-Key kontrolliert (oder approval2 selbst kompromittiert), kann OBO-Tokens mit beliebigem `on_behalf_of: ceo@firma.de` ausstellen. KC2 setzt `ctx.userId = user.id` aus dem Email-Lookup und exekutiert mit voller CEO-RLS-Scope. Im Single-User-Pilot heute toleriebar; im Multi-User-Pilot ein totaler Compromise-Pfad.
- **Fix:**
  - Variante A (strikt): `payload.sub` muss zu einer `users.approval2_user_id`-Spalte (Migration: ALTER TABLE) mappen, und der `(approval2_user_id → kc2_user_id)`-Mapping muss matchen mit `resolveByEmail(on_behalf_of)`.
  - Variante B (light): explizit dokumentieren "approval2-as-IdP, Facade-Key-Compromise = full take-over" und das Trust-Model in `SECURITY.md` schärfen.
- **Status:** ❌ OPEN — **Cutover-Blocker** vor Multi-User.

### SEC-K-002 — `MCP_APPROVAL_JWKS_URL` akzeptiert jede HTTPS-URL → Operator-Misconfig = forge-all

- **File:** [src/types/env.ts:79](../../src/types/env.ts#L79)
- **Symptom:**
  ```ts
  MCP_APPROVAL_JWKS_URL: z.string().url().optional(),
  GOOGLE_JWKS_URL: z.string().url().default('https://www.googleapis.com/oauth2/v3/certs'),
  ```
  Beide JWKS-URLs sind ohne Host-Allowlist. `z.string().url()` lässt jede HTTPS-URL durch.
- **Exploit:** Ein Angreifer mit `fly secrets set`-Pfad (leaked Doppler-Token, MR auf `fly.toml`, kompromittierte CI) setzt `MCP_APPROVAL_JWKS_URL=https://attacker.com/jwks.json` und ist ab dem nächsten Cache-Refresh in der Lage, OBO-Tokens beliebig zu fälschen. `SERVICE_TOKEN` reicht für den Bearer-Check.
- **Fix:**
  ```ts
  MCP_APPROVAL_JWKS_URL: z.string().url().refine(
    (u) => {
      const allowed = ['mcp-approval2.fly.dev', 'mcp-approval2.flycast', 'approval2.ai-toolhub.org'];
      return allowed.includes(new URL(u).hostname) && new URL(u).protocol === 'https:';
    },
    'JWKS URL host not in allowlist',
  ).optional()
  ```
  Analog für `GOOGLE_JWKS_URL`. Zusätzlich Path-Check auf `/.well-known/jwks.json`.
- **Status:** ❌ OPEN — Cutover-Blocker.

### SEC-K-003 — DCR `/oauth/register` komplett unauthentifiziert, Internet-public

- **Files:** [src/auth/oauth_facade/dcr.ts:26-57](../../src/auth/oauth_facade/dcr.ts#L26-L57), [src/auth/oauth_facade/index.ts:23-26](../../src/auth/oauth_facade/index.ts#L23-L26)
- **Symptom:** Endpoint öffentlich, nur 10 Reg/min/IP rate-limited (Bot-IP-Rotation trivial umgeht das). Kein `initial_access_token` (RFC 7591 §3), kein Service-Token-Gate, keine Allowlist.
- **Exploit-Chain:**
  1. Angreifer DCR-registriert sich mit beliebigem `redirect_uri`.
  2. `provisionFromGoogleLogin` in [src/users/api.ts:60-112](../../src/users/api.ts#L60-L112) macht den ersten Google-Authentifizierten Login zum Admin (`isBootstrap → role:'admin'`). Wenn `ALLOWED_EMAILS` + `GOOGLE_HD_ALLOWLIST` leer sind, wird jeder Google-User akzeptiert.
  3. Frische Deployment-Phase: Angreifer registriert + loggt sich ein, BEVOR der Operator → Admin.
- Plus: das DCR-Endpoint lässt unbounded `oauth_clients`-Wachstum zu (DB-Storage-DoS).
- **Fix:**
  1. **Sofort via Lockdown:** Option A oben — Endpoint nicht mehr public. Bleibt dann nur für den `.flycast`-Egress von approval2 erreichbar, was approval2 ohnehin nicht braucht (es nutzt OBO).
  2. **Code-Level (Cutover-Pflicht):** assert `env.ALLOWED_EMAILS.length > 0 || env.GOOGLE_HD_ALLOWLIST.length > 0` beim Boot in `NODE_ENV=production`. `provisionFromGoogleLogin` first-login-admin nur wenn `BOOTSTRAP_ADMIN_EMAIL` env-var matcht.
  3. **Auch bei Lockdown:** `/oauth/register` mit Service-Token oder Admin-issued Initial-Access-Token gaten — Defense-in-Depth.
- **Status:** ❌ OPEN — Lockdown ist der primäre Hebel; Code-Fix für `provisionFromGoogleLogin` muss trotzdem.

### SEC-K-004 — `object_revisions` sind NICHT entschlüsselbar (AAD-recordType-Mismatch)

- **Files:** [src/storage/objects.ts:424-433](../../src/storage/objects.ts#L424-L433) (write), [src/storage/revisions.ts:69-73](../../src/storage/revisions.ts#L69-L73) (read)
- **Symptom:**
  - Write (`updateObject`): kopiert die alte Live-Row-Ciphertext (`row.bodyInline`, `row.nonce`) **verbatim** in `object_revisions`. Diese Ciphertext wurde unter AAD `recordType='objects'` authentifiziert.
  - Read (`readRevision`): baut AAD mit `recordType='object-revisions'`.
  - Resultat: GCM-Tag-Verify scheitert auf jeder rotated Body-Revision. Die History-Funktion ist **dead-on-arrival**.
- Der Kommentar in `objects.ts:420-423` behauptet das Gegenteil — also unbemerkte Drift zwischen Code und Doku.
- **Security-Aspekt:** ein naiver "Fix" (read-side auf `recordType='objects'` umstellen) öffnet **Cross-Record-Replay**: dieselbe `(owner_id, object_id, DEK)`-Kombination würde dann sowohl Live-Row als auch Revision-Rows authentifizieren. Eine historische Ciphertext-Row könnte in die Live-Body-Spalte injiziert werden und GCM-verify würde greifen.
- **Fix:**
  - Write-Side fixen: `updateObject` muss die alte Plaintext **decrypten** (mit Live-AAD `'objects'`), dann **re-encrypten** unter Revision-AAD `'object-revisions'`, bevor sie in `object_revisions` geschrieben wird. Kosten: eine Crypto-Op extra pro Update. Read-Side bleibt unverändert.
- **Status:** ❌ OPEN — funktionaler Bug UND Security-Issue.

### SEC-K-005 — HKDF-Salt = plain userId → leaked Master + bekannte User-IDs = alle DEKs

- **Files:** [src/adapters/kms/hkdf_local.ts:38-42](../../src/adapters/kms/hkdf_local.ts#L38-L42), [src/adapters/kms/cloud_kms.ts:131-135](../../src/adapters/kms/cloud_kms.ts#L131-L135)
- **Symptom:**
  ```ts
  const salt = new TextEncoder().encode(userId);
  const derived = await hkdfAsync('sha256', this.masterKey, salt, HKDF_INFO, DEK_LENGTH_BYTES);
  ```
  `userId` ist UUIDv4, in `audit_log.actor_user_id`, in `share_grants.grantee_user_id`, in `invites.invited_user_id` öffentlich. HKDF-`info` ist fixe Konstante `'dek-v1'`. Pro-User-Salting bringt damit **keine Trennung** — wer den Master kennt, derivt jeden DEK aus dem Public-User-ID-Set.
- Gilt für `hkdf_local` (Master direkt im env) und für `cloud_kms` (Master nach Boot in-process, dann selber HKDF-Pfad).
- **Konsequenz:** kein Crypto-Shredding pro User möglich. Bei GDPR-Erase bleibt der DEK theoretisch herleitbar; die "Erase" reduziert sich auf Tombstone + Ciphertext-Delete, nicht echtes Key-Erase.
- **Fix:**
  1. Migration: ALTER TABLE `users` ADD COLUMN `dek_salt BYTEA NOT NULL DEFAULT gen_random_bytes(32)`.
  2. HKDF-Salt: `salt = userId || dek_salt`.
  3. Bei GDPR-Erase: `UPDATE users SET dek_salt = '\x00...' WHERE id = $1` UND alle existierenden DEK-encrypted Bodies neu-encrypten ist unnötig — Tombstone reicht, weil ohne Salt der DEK nicht mehr derivierbar ist.
  4. Backward-Compat: bei NULL/zero-Salt-Rows alten HKDF-Pfad als Fallback; Migration cron-job re-encryptet schrittweise.
- **Status:** ❌ OPEN — Cutover-Pflicht für Multi-User; Single-User-Pilot toleriebar.

### SEC-K-006 — `/v1/internal/users/sync` trusts every claim from approval2 → privilege channel via Email-collision

- **Files:** [src/routes/internal.ts:165-192](../../src/routes/internal.ts#L165-L192), [src/users/api.ts:279-336](../../src/users/api.ts#L279-L336)
- **Symptom:**
  - `syncFromApproval2` keyed solely auf `email` (Line 281-285).
  - `external_id` ist im Schema (internal.ts:39), aber wird **nie persistiert** (dead code in api.ts).
  - `if (existing.status !== input.status) patch.status = input.status` (Line 317) — akzeptiert **jede** Status-Transition außer `erased → *`. Das bedeutet `suspended → active` wird respektiert ohne Audit-Trail / Admin-Approval.
- **Exploit:** SERVICE_TOKEN-Kompromiss oder approval2-Compromise → `POST /v1/internal/users/sync {email:'admin@firma.de', status:'active'}` → resurrected jeden suspended Admin oder fuses Mallorys Session in die existing-admin-Row (wenn `external_id` Bind später nachgeholt wird).
- **Fix:**
  1. `external_id`-Column zu `users` hinzufügen und im Sync **persistieren** + UNIQUE-Constraint.
  2. Bei mid-flight Email-Collision: refuse wenn `existing.external_id IS NOT NULL && existing.external_id != input.external_id`.
  3. `suspended → active`-Transition aus Sync blocken — nur via dediziertem Admin-Endpoint mit Audit-Event.
  4. `role`-Spalte explizit gegen Sync-Override schützen (NOT IN sync schema, gut so — aber DB-Constraint als Defense-in-Depth).
- **Status:** ❌ OPEN — Cutover-Pflicht.

---

## HIGH <a id="high"></a>

### SEC-K-007 — DCR auto-issues `token_endpoint_auth_method='none'` (Public-Client) ohne Per-Client-Gate

- **Files:** [src/auth/oauth_facade/storage.ts:69-71](../../src/auth/oauth_facade/storage.ts#L69-L71), [src/auth/oauth_facade/token.ts:62-72](../../src/auth/oauth_facade/token.ts#L62-L72)
- Caller registriert mit `token_endpoint_auth_method='none'` → kein Client-Secret nötig; allein PKCE + redirect_uri. Combined mit dem permissiven `redirect_uris`-Schema in SEC-K-003 erlaubt das beliebige Public-Clients zu mintern.
- **Fix:** reject `none` mode (Confidential-Clients erzwingen), ODER Hostname-Allowlist pro Environment (`claude.ai`, `app.ai-toolhub.org`).

### SEC-K-008 — DCR redirect-URI erlaubt `http://localhost:*` mit beliebigem Port/Path → Phishing-Pivot

- **File:** [src/auth/oauth_facade/storage.ts:55-68](../../src/auth/oauth_facade/storage.ts#L55-L68)
- Kein Port-Restriction, kein Path-Restriction. `http://localhost:31337/steal` ist akzeptiert. Auf shared dev-Hosts (Codespaces, Devcontainer) ein realistischer Token-Theft-Pivot.
- **Fix:** für `localhost`/`127.0.0.1`/`[::1]` zulassen, aber Path auf `/oauth/callback` oder `/callback` festlegen; für `none`-Auth-Method `client_uri` als Same-Origin-Pflicht.

### SEC-K-009 — `SERVICE_TOKEN` ist admin-equivalent für alle `/v1/internal/*` inklusive `erase-user`

- **Files:** [src/auth/service_token.ts:50-55](../../src/auth/service_token.ts#L50-L55), [src/routes/internal.ts:43-49](../../src/routes/internal.ts#L43-L49)
- Ein einziger 32-Byte-Hex-`SERVICE_TOKEN` confers (a) OBO-Authority für jeden User (mit OBO-Header), (b) hard-delete eines beliebigen Users via `/internal/erase-user`. `confirmation_token` ist nur length-checked (`>= 16`), nicht gegen einen server-side-Wert validiert.
- **Fix:** Split-Token (`KC2_SVC_TOKEN_OBO` + `KC2_SVC_TOKEN_ADMIN`). `/internal/erase-user` auf den Admin-Token. `confirmation_token` als HMAC über `user_id|nonce|exp` mit separat-rotiertem `ERASE_HMAC_KEY`, replay-blockiert via `idempotency_records`. Oder: erase-call als signiertes JWT von approval2 (analog OBO) mit `target=user_id, exp=60s, jti`.

### SEC-K-010 — OBO hat kein `jti`-Replay-Protection im 120s-Window

- **File:** [src/auth/on_behalf_of.ts:108-119](../../src/auth/on_behalf_of.ts#L108-L119)
- TLS-MITM, Log-Leak, Proxy-Cache lassen Replay innerhalb von ~120s zu. Für Writes mitigiert `approval_id` partial, aber `approval_id` wird hier nicht auf Single-Use geprüft.
- **Fix:** `jti` (und/oder `approval_id`) in Short-lived Postgres-Dedup-Set (TTL=`exp+60s`). Zweite Verwendung → 401.

### SEC-K-011 — JWKS-Cache-TTL 24h → revoked Google-Key oder approval2-Key bleibt 24h trusted

- **Files:** [src/types/env.ts:41](../../src/types/env.ts#L41), [src/auth/jwt.ts:69-73](../../src/auth/jwt.ts#L69-L73)
- Google rotiert ~wöchentlich, KC2 cached 24h. Bei Key-Compromise + Revoke laufen alte Tokens 24h weiter.
- **Fix:** Default-TTL auf 600s reduzieren (Google's eigene Cache-Control-Empfehlung).

### SEC-K-012 — `consumeAuthCode` UPDATE-Result wird verworfen → double-issue-Race

- **File:** [src/auth/oauth_facade/storage.ts:184-191](../../src/auth/oauth_facade/storage.ts#L184-L191)
- Kommentar gesteht den Bug zu: *"best-effort race detection: ... we used UPDATE without RETURNING so check that a row was actually matched — fallback re-read."* Aber **es gibt keinen fallback re-read**. `void upd`. Zwei parallele Token-Exchanges mit demselben Code passieren beide den `consumedAt`-Check, beide UPDATEn, beide bekommen Token-Paare.
- **Fix:** `.returning({id:oauthAuthCodes.codeHash})`, dann `if (upd.length !== 1) throw errUnauthorized('code already consumed')`.

### SEC-K-013 — Refresh-Token-Rotation nicht atomar → double-chain after leak

- **File:** [src/auth/oauth_facade/storage.ts:243-288](../../src/auth/oauth_facade/storage.ts#L243-L288)
- Read → if not revoked → INSERT new + UPDATE old, in READ COMMITTED. Zwei parallele Rotations mit demselben Token: beide Reads sehen `revokedAt=null`, beide INSERTen, beide UPDATEn (last write wins). RFC 6749 §10.4 / OAuth 2.1 §4.13 verlangen Family-Revocation auf Replay-Detection — KC2 hat weder Family-Traversal noch `SELECT ... FOR UPDATE` / `SERIALIZABLE`.
- **Fix:** `SELECT ... FOR UPDATE` + family-traverse `rotatedTo`-Chain bei Replay.

### SEC-K-014 — `finalizeUpload` buffert untrusted Blob in RAM → OOM-DoS

- **File:** [src/storage/uploads.ts:105-109](../../src/storage/uploads.ts#L105-L109)
- Presigned PUT erzwingt kein `Content-Length`. Caller PUTs 5 GB, ruft finalize → KC2 lädt 5 GB in V8-Heap → OOM-kill auf shared-cpu-1x (512 MB). Eine Request killt die Instance für alle Tenants.
- **Fix:** `headObject` zuerst — reject by `ContentLength` vor Download. Dann streaming `getObjectStream` durch `crypto.createCipheriv('aes-256-gcm')` mit chunked-AAD. ODER `MAX_UPLOAD_BYTES` von 5 GB auf ~64 MB reduzieren bis Streaming implementiert ist.

### SEC-K-015 — `/metrics` ist anonymous-public

- **File:** [src/routes/health.ts](../../src/routes/health.ts) gemountet via [src/server.ts:79](../../src/server.ts#L79) VOR jeglicher Auth-Chain.
- Exposed Prometheus-Counters: `knowledge_dek_resolve_total{result}` (KMS-Adapter-Verhalten), Latenz-Histogramme, Status-Codes pro Route. Bei 404-Path-Fallback landet die rohe URL mit IDs als Label-Wert.
- **Fix:** `/metrics` hinter `requireServiceToken` (oder separater `requireMetricsToken`-Env). Alternativ: separater Port nur intern. Wird mit Lockdown via Option A automatisch unreachable.

### SEC-K-016 — `/v1/internal/erase-user` akzeptiert beliebige `user_id` ohne Actor-Binding

- **File:** [src/routes/internal.ts:43-49](../../src/routes/internal.ts#L43-L49)
- Service-Token-Compromise → unbounded GDPR-Erase jedes Users. `confirmation_token` ist nur length-validated, nicht an `user_id` oder Replay-Token gebunden.
- Überlappt mit SEC-K-009, hier separat weil's um Actor-Binding geht.
- **Fix:** HMAC(`user_id|nonce|exp`)-token, replay-blockiert via `idempotency_records`.

### SEC-K-017 — First-Login-First-Admin schnappt sich Preexisting-Email-Row mit `role='admin'`

- **File:** [src/users/api.ts:46-56](../../src/users/api.ts#L46-L56)
- Wenn eine User-Row existiert (z.B. via `syncFromApproval2` Email-only-Sync, siehe SEC-K-006) OHNE `googleSub`, claimed der erste Google-Login mit dieser Email die Row inklusive der `role`.
- **Exploit:** Kompromittierte approval2 syncht admin-Row für Mallorys Email; Mallory loggt sich via Google ein, übernimmt Admin.
- **Fix:** Wenn `existing.googleSub === null && existing.role === 'admin'` → 403, erzwinge explicit `/admin/claim-row`-Flow. Alternativ: `external_id` aus Sync schreiben (SEC-K-006-Fix), dann ist Email-Match nicht mehr genug.

### SEC-K-018 — Keine Per-User-Rate-Limits auf `/v1/*` und `/mcp`

- **Files:** [src/server.ts:108-109](../../src/server.ts#L108-L109), [src/mcp/server.ts](../../src/mcp/server.ts)
- Alle OBO-Calls teilen sich die approval2-Egress-IP — per-IP-RateLimit no-op. Plus: MCP-Transport akzeptiert batched-Requests ohne Per-Batch-Length-Cap. Single POST mit 10 000 `tools/call` items → 10 000 Embedding-API-Calls sequentiell.
- **Fix:** `rateLimit({windowMs:60_000, max:120})` keyed auf `ctx.userId`. `raw.length` in `handleRpcBody` auf z.B. 50 capped.

### SEC-K-019 — `BACKUP_MASTER_KEY` Rotation hat kein Dual-Key-Window → rotate breaks restore

- **Files:** [src/crons/backup.ts:85-93](../../src/crons/backup.ts#L85-L93), [src/types/env.ts:168-177](../../src/types/env.ts#L168-L177)
- Single Env-Var. Kein `BACKUP_MASTER_KEY_PREVIOUS`, kein Key-ID im File-Format. Rotation in Doppler → 30 Tage Retention-Window verloren.
- **Fix:** 4-Byte-Key-ID (SHA-256(key)[:4]) als Prefix im serialized backup. Restore akzeptiert bis zu N keys. Rotation-Runbook mit Overlap-Window.

### SEC-K-020 — Backup-AAD bindet bucket/target_key nicht

- **File:** [src/crons/backup.ts:62,92](../../src/crons/backup.ts#L62)
- ```ts
  const aad = new TextEncoder().encode(`backup|${ts}`);
  ```
  Wenn zwei Services dasselbe Bucket teilen (`BACKUP_BUCKET`-Fallback existiert), kann ein Backup unter anderem Prefix GCM-replayed werden in eine Restore-Path.
- **Fix:** `aad = `backup|${bucket}|${targetKey}``.

### SEC-K-021 — Backup enthält PII-Plaintext-Spalten (title, description, email, audit_log)

- **File:** [src/crons/backup.ts:65](../../src/crons/backup.ts#L65)
- ADR-0004 + Migration 0003 entfernten `description_enc` (plaintext-by-design für FTS/Embeddings). Plus `title`, `keywords_json`, `meta_json`, `users.email`, `users.display_name`, `audit_log.details`, `signing_keys.private_jwk`, `oauth_*`-Tokens (Verschlüsselungs-Status zu prüfen) landen alle im Backup. Ein einziger `BACKUP_MASTER_KEY` schützt damit **alle User-PII**.
- **Fix:** Threat-Model in `SECURITY.md` ehrlich dokumentieren. Erwägen: Backup-Key envelope-verschlüsseln mit derselben Cloud-KMS-Key wie der DEK-Master.

### SEC-K-022 — `pg_dump` Connection-String als CLI-argv → `/proc/<pid>/cmdline`-Leak

- **File:** [src/crons/backup.ts:65](../../src/crons/backup.ts#L65)
- ```ts
  spawn('pg_dump', ['--format=custom', '--no-owner', env.DATABASE_ADMIN_URL]);
  ```
  `DATABASE_ADMIN_URL` enthält BYPASSRLS-Password in der URI. Sichtbar in `ps`/`/proc/<pid>/cmdline` für jeden Prozess im selben VM-Namespace.
- **Fix:** `PGPASSWORD` env oder `~/.pgpass`, nie argv.

### SEC-K-023 — Embedding-Inversion-Surface auf shared Objects

- **File:** [drizzle/migrations/0001_rls.sql:82-85](../../drizzle/migrations/0001_rls.sql#L82-L85)
- ```sql
  CREATE POLICY vec_via_object ON object_vectors
    USING (EXISTS (SELECT 1 FROM objects WHERE objects.id = object_vectors.object_id))
  ```
  Jeder Share-Grantee kann `SELECT embedding FROM object_vectors WHERE object_id IN (shared_ids)`. Mit bge-m3 (1024d) oder Vertex (768d) erlaubt Morris-2023-Inversion partielle Recovery — Grantee war zu Title/Description authorisiert, nicht zu inferred-Body-Fragmenten.
- **Fix:** Policy auf `share.scope IN ('read','write')` einschränken. Oder Vectors mit `(object_id, owner_id)`-Composite-Key + Share-Vector-Drop.

### SEC-K-024 — Deterministic `maskPII` erzeugt Cross-User-Inference-Oracle

- **File:** [src/lib/pii/mask.ts:16-25](../../src/lib/pii/mask.ts#L16-L25)
- Replacement-Funktion deterministic + content-blind → identische Eingaben aus zwei Usern produzieren identische masked-Strings → identische Embeddings.
- **Exploit:** A craftet "axelrogg@gmail.com lives in Berlin", pgvector-search liefert Nearest-Neighbours. Wenn dieselbe masked-Form in B's Data clustert, hat A signal über B's Content.
- Außerdem fehlen DE-spezifische Entities: PLZ + Ort, Steuer-ID, Personalausweis-Nr, deutsche Telefonformate.
- **Fix:** Per-Tenant random Salt prepended vor Embedding (destroys cross-tenant Equality). Regex erweitern: `\b\d{5}\s+[A-ZÄÖÜ][a-zäöüß]+\b` für DE PLZ+Ort, DE Phone, Name-Dictionary-Tier.

### SEC-K-025 — `objects.get` mit `include_body=true` lädt bis 5 GB in RAM → Self-DoS

- **Files:** [src/mcp/register_tools.ts:133-156](../../src/mcp/register_tools.ts#L133-L156), [src/storage/objects.ts:293-348](../../src/storage/objects.ts#L293-L348)
- `readObject` lädt komplette Ciphertext als `Uint8Array`, decrypted, returnt. User mit 5 GB Body in MCP `tools/call` → 5 GB cipher + 5 GB plaintext → OOM-kill.
- **Fix:** `include_body=true` auf `bodySize <= 64 KB` capped. Für größer: `objects.presign_get`-Tool mit signed-URL.

### SEC-K-026 — `assertBlobKeyShape` nicht angewendet auf `updateObject`-Writes

- **File:** [src/storage/objects.ts:407-410](../../src/storage/objects.ts#L407-L410)
- Read-Path hat `assertBlobKeyShape` (objects.ts:334), Write-Path nicht. Heute gut, weil `id` als UUID typisiert ist. Aber: defense-in-depth gegen künftige Wrapper, die `id` aus Request-Body ohne UUID-Check übernehmen.
- **Fix:** `assertBlobKeyShape(blobKey, 'updateObject')` und `assertBlobKeyShape(blobKey, 'createObject')` vor jedem `blobStore().put`.

### SEC-K-027 — Vector-Search-Score wird im Response geleaked

- **File:** [src/search/hybrid.ts:124-167](../../src/search/hybrid.ts#L124-L167)
- `vectorScore` + `ftsRank` werden returnt. Triangulation-Side-Channel: Angreifer mit Write-Surface kann Object-Erstellung + Score-Drift korrelieren, um Existenz/Content privater Rows zu inferieren.
- **Fix:** Scores aus Response strippen außer im Debug-Modus. Optional differential-privacy-Noise auf returned Scores.

### SEC-K-028 — CORS `origin: '*'` auch auf `/v1/internal/*` und `/mcp`

- **File:** [src/server.ts:41](../../src/server.ts#L41)
- `credentials:false` blockt Cookie-CSRF, aber MCP-Bearer-Tokens würden bei Leak in JS-fähige Browser-Pages durchgereicht.
- **Fix:** restrict CORS to known PWA-Origins + Lockdown via Option A entfernt das Public-Surface ganz.

### SEC-K-029 — `idempotency`-Middleware abusiert `recordType='object-revisions'`

- **File:** [src/middleware/idempotency.ts:32-37](../../src/middleware/idempotency.ts#L32-L37)
- Kommentar gesteht ein: *"closest neutral existing record type"*. `objectId='idempotency:<key>'` als String-Prefix-Invariant nicht enforced — wenn ein zukünftiger `aad.ts`-Change `objectId`-Type lockerer macht, kollabiert die AAD-Separation.
- **Fix:** `recordType: 'idempotency'` zur Union hinzufügen, Literal umstellen.

### SEC-K-030 — `/mcp` POST hat keine Idempotency-Middleware

- **File:** [src/server.ts:90](../../src/server.ts#L90)
- Idempotency greift nur auf `/v1/*`. MCP-Calls können bei Network-Retry double-execute (zwei `objects.create`-Rows).
- **Fix:** Idempotency basiert auf JSON-RPC `id` oder explicit-Header.

---

## MEDIUM <a id="medium"></a>

### SEC-K-031 — `cloud_kms` Master nie zeroed, lebt auf Heap bis Process-Exit

- **File:** [src/adapters/kms/cloud_kms.ts:41, 126](../../src/adapters/kms/cloud_kms.ts#L41-L126)
- `cachedMasterKey: Uint8Array | null` einmal gesetzt, gehalten bis Exit. Heap-Dump (Fly OOM-Kill, Sentry-Capture, V8-Inspector) leakt Master.
- **Fix:** Master im `ArrayBuffer` via `Buffer.allocUnsafeSlow` (off-pool); best-effort `.fill(0)` on SIGTERM. Residual-Risk in `cloud_kms.ts`-Header dokumentieren + in `SECURITY.md`.

### SEC-K-032 — JWKS-Rotation-Cleanup ist Follow-up → old Keys forever in `/.well-known/jwks.json`

- **File:** [src/auth/signing_keys.ts:152-173](../../src/auth/signing_keys.ts#L152-L173)
- Code-Kommentar: *"K-D3 retention: keys older than ~90d ... Cleanup is a follow-up cron — for now this returns all rows."* Ein Key kompromittiert vor 2 Jahren ist trotzdem in JWKS. Tokens signed by old key verify forever (bis token-`exp`).
- **Fix:** Query um `WHERE rotated_at IS NULL OR rotated_at > now() - 30 days` erweitern. Cron-Job für Hard-Delete > 90d.

### SEC-K-033 — Boot-time KMS-Error leakt `kmsKey`-Name zu Logs

- **File:** [src/adapters/kms/cloud_kms.ts:110](../../src/adapters/kms/cloud_kms.ts#L110)
- Full-resource-Name `projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>` landet in Logs/Sentry. Hilft Angreifer beim GCP-Project-Enum.
- **Fix:** Nur KeyRing- oder Final-Segment loggen.

### SEC-K-034 — Decrypt-Failure-Observability leakt success/fail-Discrimination

- **File:** [src/storage/objects.ts:341](../../src/storage/objects.ts#L341), [src/storage/revisions.ts:90](../../src/storage/revisions.ts#L90)
- Web-Crypto `decrypt` throws `OperationError` → Hono-default → 500. Vs 404-on-not-found. Discriminator: existiert das Object aber nicht entschlüsselbar.
- **Fix:** `try/catch` um `decrypt(...)`, beide auf 404 mappen.

### SEC-K-035 — S3-Presign-GET caller-controlled lifetime, kein Per-Object-Scope-Enforcement

- **File:** [src/adapters/blob/s3.ts:95-99](../../src/adapters/blob/s3.ts#L95-L99)
- Interface exposes `presignGet` mit caller-supplied `expiresInSeconds` (max 7d für SigV4). Aktuell nur `presignPut` genutzt. Künftiger Misuse → 7d-Public-URL auf Plaintext-Window während Upload.
- **Fix:** `expiresInSeconds` auf 600s cap'n. `presignGet` für `uploads/*`-Keys im pending-State rejecten.

### SEC-K-036 — `setUserRole` / `setUserStatus` ohne Admin-Audit-Gate

- **File:** [src/users/api.ts:154-173](../../src/users/api.ts#L154-L173)
- Internal Helpers via `withAdminTx` (BYPASSRLS). Aktuell keine HTTP-Route — aber `syncFromApproval2` exposed Status-Transitions over Sync (siehe SEC-K-006).
- **Fix:** Status-Transitions als audit-emittend; `erased` aus Sync ablehnen (nur via `/internal/erase-user`).

### SEC-K-037 — `authorize`-State ist self-signed-but-not-verified base64-blob

- **File:** [src/auth/oauth_facade/authorize.ts:38-60](../../src/auth/oauth_facade/authorize.ts#L38-L60), [src/auth/oauth_facade/callback.ts:103](../../src/auth/oauth_facade/callback.ts#L103)
- Plain base64(JSON), kein HMAC, kein DB-stored row. `state.redirectUri` wird in `oauthAuthCodes` gespeichert. Heute gemitigt weil `authorize.ts:72` schon allowlist-checked. Defense-in-Depth-Lücke.
- **Fix:** HMAC den State-Payload mit Server-Secret, verify in callback.ts vor Trust.

### SEC-K-038 — Filename/Content-Type from caller propagiert zu R2 unsanitized

- **Files:** [src/storage/objects.ts:199](../../src/storage/objects.ts#L199), [src/storage/uploads.ts:44-47](../../src/storage/uploads.ts#L44-L47)
- `presignPut` setzt `ContentType` direkt aus caller-input. `finalizeUpload` überschreibt auf `application/octet-stream`, aber Window zwischen PUT und finalize ist offen. Future-Misuse: `text/html`+JS-Body + presign-GET → Browser executes.
- **Fix:** `ContentType` aus `presignPut` droppen, force `application/octet-stream` at presign.

### SEC-K-039 — Search-Audit-Event leakt `result_count`

- **Files:** [src/routes/search.ts:35](../../src/routes/search.ts#L35), [src/mcp/register_tools.ts:484](../../src/mcp/register_tools.ts#L484)
- `result_count: hits.length` als audit-detail. Admin mit Audit-Read kann Search-Patterns deanonymisieren.
- **Fix:** Bucket: `<=10` / `<=50` / `many` statt rohem Integer.

### SEC-K-040 — `audit_log` admin-erase pseudonymisation incomplete

- **File:** [src/routes/internal.ts:81-92](../../src/routes/internal.ts#L81-L92)
- Strippt `granted_to`/`target_user_id`/`shared_with` aus `details`, aber nicht `resource_id` (UUID referenziert erased-User-Data-Lineage). Denylist statt Allowlist.
- **Fix:** Allowlist — nur `{action, result, ts}` für pseudonymised Rows. `resource_id` hashen.

### SEC-K-041 — Idempotency-Middleware ohne Body-Hash-Bind

- **File:** [src/middleware/idempotency.ts:58-65](../../src/middleware/idempotency.ts#L58-L65)
- Client reuses Idempotency-Key mit anderem Body → cached response statt 409. Stripe-Style-Behavior wäre `409 Conflict` bei Mismatch.
- **Fix:** SHA-256(method+path+body) in cache-key, 409 on mismatch.

### SEC-K-042 — `presignPut` ohne SHA-256-Content-Bind, kein Per-Object-Checksum

- **File:** [src/storage/uploads.ts:44-47](../../src/storage/uploads.ts#L44-L47)
- Acceptable single-tenant. Würde für Multi-Tenant SigV4-with-body-hash brauchen.

### SEC-K-043 — `listSharesForObject` Comment/Code-Drift

- **File:** [src/storage/shares.ts:77-81](../../src/storage/shares.ts#L77-L81)
- Comment sagt "owner-only viewing", RLS macht aber `granted_to OR granted_by = me`-Filter. Shared User sieht eigene Grant-Row. Confidentiality OK, aber Doc/Code-Drift triggert future-reviewer Bug.
- **Fix:** Explicit owner-gate ODER Comment anpassen.

### SEC-K-044 — `revisions.readRevision` ohne explicit Owner-Pre-Flight

- **File:** [src/storage/revisions.ts:50-90](../../src/storage/revisions.ts#L50-L90)
- RLS mitigiert heute; wenn RLS je gelockert wird, schweigt der Decrypt-Failure mit cryptic GCM-error. Defense-in-Depth.
- **Fix:** `if (parent.ownerId !== ctx.userId) throw 501` analog `readObject:314`.

---

## Verified Safe <a id="verified-safe"></a>

Geprüft und für korrekt befunden:

- **RLS-Architektur:** `FORCE RLS`, `SET LOCAL` in Transaction, `BYPASSRLS` nur via separater Admin-Pool (`withAdminTx`). Plumbing korrekt — `withUserTx` macht `BEGIN → set_config(...,true) → fn → COMMIT/ROLLBACK → release`. Pool-Checkout startet unset → policies fail-closed.
- **SQL-Layer:** keine `db.unsafe()`-Bypasses außer in expliziten admin-Pfaden. `db.execute(sql\`...\`)` in `search/hybrid.ts` ist parametrisiert + RLS-bound durch das umschließende `withUserTx`.
- **Cross-User-Share-Body-Leak:** `readObject:314` returnt 501 BEVOR mit caller-DEK decryptet wird. Metadata visible (intended), Body fenced. ✅
- **Search-Negative-Space-Oracle:** Vector- und FTS-Branches joinen/filtern auf `objects` mit RLS-Scope owner-or-shared. Private Rows erscheinen in keinem Result-Set. ✅
- **Path-Traversal in `blob_key`:** `assertBlobKeyShape` (objects.ts:34) + inline-Regex in revisions.ts. Upload-blob_keys sind server-minted UUIDs. ✅ (write-path siehe SEC-K-026 für Defense-in-Depth)
- **OBO-Writes ohne approval_id:** korrekt gated in `require_jwt_or_obo.ts:30-32` via HTTP-Method-Heuristik (K-D4 enforced). ✅
- **`audit_log` actor-pinning:** F-11 INSERT-Trigger forciert `actor=current_user OR sentinel`. ✅
- **`alg=none`-Confusion:** `peekHeader` rejected; `jwtVerify` mit explicit `algorithms: [...ALLOWED_JWT_ALGORITHMS]`. ✅
- **Issuer-Trie:** Dispatch per `payload.iss`, dann `jwtVerify` re-asserts `issuer:` constraint with matching JWKS. Google-signed-mit-falschem-iss = rejected. ✅
- **PKCE:** `S256` required, `plain` rejected (oauth_facade-Schema). ✅
- **Idempotency-Key:** scoped (user, idem_key) — collision-safe across users. (Body-Hash-Bind fehlt → siehe SEC-K-041.)
- **`presignGet`** für Plaintext-Bodies: nirgends aufgerufen heute. (Future-Risk → siehe SEC-K-035.)

---

## Audit-Methodik <a id="audit-methodik"></a>

- 5 parallele Subagent-Audits über disjunkte Surfaces:
  1. OAuth-Facade + JWKS + OBO + service_token
  2. Routes + RLS + Cross-Tenant-Isolation
  3. Crypto + KMS + Blob + Backups
  4. Network/Infra-Exposure + Lockdown-Feasibility
  5. MCP + DCR + Search + Uploads + Shares + UserSync
- Jeder vom Subagent gemeldete CRITICAL/HIGH-Befund wurde direkt am Code (file:line) verifiziert. Befunde die nicht reproduzierbar waren wurden ausgelassen.
- Cross-Reference zur bestehenden [`SECURITY.md`](./SECURITY.md): die dortigen F-1 bis F-22 sind das Threat-Model + bekannte Residual-Risks. Die SEC-K-* hier sind **konkrete neue Befunde** aus dem Pre-Cutover-Audit.

---

## Follow-up-Plan <a id="follow-up-plan"></a>

### Phase 1 — Lockdown (Infra, ~2h)

- [ ] Option A umsetzen — `fly.toml` auf `[[services]]`, IPs releasen, Doppler `MCP_KNOWLEDGE_URL` flippen, CF-Stack entsorgen, Google-Redirect-URI entfernen, smoke.sh anpassen.
- [ ] Verify: `curl https://mcp-knowledge2.fly.dev/health` → connection refused. approval2 → KC2 funktioniert über `.flycast`.

Eliminiert: SEC-K-003-Internet-Surface, SEC-K-015, SEC-K-028 + reduziert SEC-K-006-Blast-Radius.

### Phase 2 — Cutover-Blocker (CRITICAL, vor Multi-User-Pilot)

- [ ] **SEC-K-001** OBO sub↔on_behalf_of Binding (`users.approval2_user_id` column + map-check).
- [ ] **SEC-K-002** JWKS-URL Host-Allowlist + Path-Check.
- [ ] **SEC-K-003 (code-level)** `provisionFromGoogleLogin` mit `BOOTSTRAP_ADMIN_EMAIL`-env-Gate. `ALLOWED_EMAILS.length > 0`-Boot-Assertion in prod.
- [ ] **SEC-K-004** `object_revisions` Write-Side decrypt-then-reencrypt unter `recordType='object-revisions'`.
- [ ] **SEC-K-005** `users.dek_salt`-Column + HKDF-Salt-Mix + Migration.
- [ ] **SEC-K-006** `external_id`-Persistence im UserSync + Status-Transition-Block.

### Phase 3 — Pre-Cutover-HIGH

- [ ] SEC-K-007 DCR-Public-Client-Mode rejecten.
- [ ] SEC-K-008 redirect-URI Path-Restriction.
- [ ] SEC-K-009 Split-Token (OBO vs Admin).
- [ ] SEC-K-010 OBO-jti-Replay-Protection.
- [ ] SEC-K-011 JWKS-Cache-TTL auf 600s.
- [ ] SEC-K-012 `consumeAuthCode` mit `.returning()` + Row-Count-Check.
- [ ] SEC-K-013 Refresh-Rotation `SELECT FOR UPDATE` + Family-Revoke.
- [ ] SEC-K-014 finalizeUpload streaming + headObject-Pre-Check.
- [ ] SEC-K-016 erase-user HMAC-Token.
- [ ] SEC-K-017 Admin-Row-Auto-Claim blocken.
- [ ] SEC-K-018 Per-User-RateLimit auf /v1/* und /mcp.
- [ ] SEC-K-019 Backup-Key-ID + Dual-Key-Window.
- [ ] SEC-K-020 Backup-AAD bucket/target_key bind.
- [ ] SEC-K-021 Backup-Threat-Model in SECURITY.md.
- [ ] SEC-K-022 pg_dump PGPASSWORD statt argv.
- [ ] SEC-K-023 Vector-RLS auf scope-spezifisches Share-Predikat.
- [ ] SEC-K-024 maskPII Per-Tenant-Salt + DE-Entities.
- [ ] SEC-K-025 include_body=true Size-Cap + presign_get-Tool.
- [ ] SEC-K-026 `assertBlobKeyShape` auf Write-Path.
- [ ] SEC-K-027 Vector-Score aus Response strippen.
- [ ] SEC-K-029 `idempotency` recordType.
- [ ] SEC-K-030 Idempotency auf /mcp.

### Phase 4 — Defense-in-Depth (MEDIUM, ~2 Sprints)

SEC-K-031 bis SEC-K-044.

### Prozess

- Pro Finding ein Commit `fix(security): SEC-K-XXX <kurz>`.
- Regression-Tests für jeden CRITICAL-Fix (Smoke-Level minimum).
- Penetration-Re-Test (Subagent-Audit-Sweep V2) nach den CRITICAL-Fixes.
- Threat-Model in [`SECURITY.md`](./SECURITY.md) entsprechend updaten — die "operator-bypass = full-take-over"-Claim braucht eine zweite Ebene "approval2-bypass = full-take-over" bis SEC-K-001 gefixt ist.
