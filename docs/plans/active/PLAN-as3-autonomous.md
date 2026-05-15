# PLAN — mcp-knowledge2 AS-3 Autonom-Migration

> **Status: ⚠️ SPEC — pre-implementation, 2026-05-15**
>
> Dieses Dokument beschreibt **was in mcp-knowledge2 umgestellt werden muss**, damit
> der Service autonom als MCP-Server mit eigenem OAuth-Login betrieben werden kann.
> mcp-approval2 bleibt **optional als vorgeschalteter Approval-Proxy** verfügbar.
>
> Schwester-Dokument: [mcp-approval2/docs/plans/active/PLAN-as3-autonomous.md](https://github.com/axel-rogg/mcp-approval2/blob/main/docs/plans/active/PLAN-as3-autonomous.md)
>
> Master-Implementations-Plan (Ein-Wurf-Cutover): [PLAN-as3-bigbang.md](./PLAN-as3-bigbang.md)
>
> Vorgänger / Baseline: [PLAN-architecture-v2.md](./PLAN-architecture-v2.md) (§1 JWT-Pattern wird durch dieses Doc abgelöst)

---

## 0. Ziel-Architektur (AS-3)

```
                        Google OIDC (Authoritative IdP, Multi-User)
                              ▲              ▲
                              │              │  ID-Token-Verify gegen Google-JWKS
                              │              │  (cache 24h, refresh-on-miss)
                              │              │
              ┌───────────────┴───┐   ┌──────┴──────────┐
              │  mcp-approval2    │   │  mcp-knowledge2 │   ← THIS REPO
              │  (Approval-Proxy, │   │  (autonomer     │
              │   Tool-Surface,   │   │   MCP+REST-     │
              │   Credentials,    │   │   Service mit
              │   Gateways)       │   │   eigener DCR-  │
              │                   │   │   OAuth-Facade) │
              │  DCR-OAuth-Facade │   │                 │
              │  (für Claude.ai-  │   │  DCR-OAuth-     │
              │   MCP-Clients)    │   │   Facade        │
              └─────┬─────────┬───┘   └────────┬────────┘
                    │         │                │
              Cookie│         │ S2S            │
              (PWA) │         │ X-On-Behalf-Of │ Bearer
                    │         │ + signiert     │ (User-Token)
                    │         │                │
                    └────────►┴────────────────┘
                          mcp-knowledge2 REST + MCP
                          (RLS via current_user)
                                  ▲
                                  │ Direkt-Pfad (autonom)
                                  │ Bearer (User-Token, aud=knowledge2)
                                  │
                              Claude.ai
                              (MCP-Client)
```

**Schlüssel-Entscheidung AS-3:** Google OIDC ist der einzige **Identity-Provider** für menschliche User. Beide Services sind **Resource-Server gegen Google**, betreiben aber jeweils eine **eigene kleine DCR-OAuth-2.1-Facade** für MCP-Clients (weil MCP-Spec DCR vorschreibt, Google das nicht anbietet).

| Aspekt | Heute (v2-baseline) | AS-3 (Ziel) |
|---|---|---|
| Identity-Provider | mcp-approval2 (eigene Signing-Key) | Google OIDC (extern) |
| KC2 vertraut JWTs von | mcp-approval2 (env.JWKS_URL) | Google OIDC + eigener Facade |
| User-Identität in KC2 | `sub` aus approval2-JWT | `sub` aus Google-ID-Token, gemappt auf interne `users.id` |
| KMS / DEK-Resolver | approval2 internal API (Variante B) | self-managed (OpenBao oder Cloud-KMS in KC2-Stack) |
| MCP-Transport | keiner (nur REST) | Streamable-HTTP unter `/mcp`, Tool-Surface über REST gewrapped |
| Browser-PWA-Pfad | n/a | bleibt in approval2, spricht via `/admin/kc-proxy/*` mit signed-on-behalf-of |
| approval2 vor KC2 | hart erforderlich | **optional** als Approval-Proxy |

---

## 1. Was sich konkret ändert (file-by-file)

### 1.1 Auth-Schicht

#### `src/auth/jwt.ts` (existierend, umstellen)

Heute: validiert mcp-approval2-signed JWTs via einer einzigen `JWKS_URL`.

Neu: **Multi-Issuer-Verifier**. Akzeptiert Tokens von zwei Quellen:

1. **Google OIDC** (für PWA-Login-Sessions via approval2-PWA, falls Google-ID-Token durchgereicht wird — siehe §2.2)
2. **mcp-knowledge2's eigene Facade** (`/oauth/token`-issued Tokens für MCP-Clients, `aud=mcp-knowledge2`)

Pseudo-Code:
```ts
const ISSUERS = {
  'https://accounts.google.com': { jwks: GOOGLE_JWKS_URL, expectedAud: GOOGLE_OAUTH_CLIENT_ID },
  'https://knowledge.<domain>':  { jwks: 'self', expectedAud: 'mcp-knowledge2' },
};
```

`ALLOWED_JWT_ALGORITHMS` bleibt asymmetric-only. Pin Issuer-Map an env-Werte (kein Wildcard).

#### `src/auth/oauth_facade.ts` (NEU)

DCR-OAuth-2.1-Facade für MCP-Clients. Endpoints:

| Endpoint | Zweck |
|---|---|
| `GET  /.well-known/oauth-authorization-server` | RFC 8414 Metadata (Discovery für Claude.ai) |
| `POST /oauth/register` | RFC 7591 DCR — Claude.ai registriert sich, kriegt `client_id` |
| `GET  /oauth/authorize` | PKCE-Auth-Code-Flow Init. Redirected User zum Google-Login (interner Step). |
| `GET  /auth/google/callback` | Google liefert ID-Token, Facade tauscht in eigenen Authorization-Code |
| `POST /oauth/token` | Code/Refresh → eigener Access-Token mit `aud=mcp-knowledge2`, `sub=<users.id>`, `idp_sub=<google-sub>` |
| `GET  /.well-known/jwks.json` | Eigene Signing-Key publiziert |

Token-Format:
```ts
{
  iss: 'https://knowledge.<domain>',
  aud: 'mcp-knowledge2',
  sub: '<internal-users.id-uuid>',
  idp:     'google',
  idp_sub: '<google-sub>',
  scope:   'objects:read objects:write search shares ...',
  request_id: '<uuid>',
  exp: now + 3600,
}
```

Signing-Key: lokal generierter EdDSA-Key, in eigener `signing_keys`-Tabelle gespeichert (rotation-tauglich). JWKS dynamisch aus DB gerendert.

#### `src/auth/on_behalf_of.ts` (NEU)

Verifier für S2S-Calls von mcp-approval2 (Proxy-Pfad). Header `X-On-Behalf-Of` enthält ein **signiertes JWT** mit:

```ts
{
  iss: 'mcp-approval2',
  aud: 'mcp-knowledge2',
  sub: '<approval2-internal-users.id>',
  on_behalf_of: '<email-or-google-sub>',  // wer hat triggered
  approval_id: '<uuid>',                  // nachvollziehbare Approval-Referenz (optional)
  request_id: '<uuid>',
  exp: now + 120,
}
```

Verify gegen approval2's published JWKS (`MCP_APPROVAL_JWKS_URL`). Wenn valide: User-Lookup über `users.email` oder `users.google_sub`, `app.current_user` setzen, Audit-Log markiert `via_proxy=true` + `approval_id`.

Akzeptiert NUR wenn `Authorization: Bearer <SERVICE_TOKEN>` zusätzlich gesetzt ist (Zwei-Faktor: shared-secret + signed-assertion). Verhindert dass leaked-JWKS allein KC kompromittiert.

#### `src/auth/service_token.ts` (existierend)

Bleibt für interne Routes (`/v1/internal/erase-user`, cron-triggers). Keine Änderung.

### 1.2 User-Registry

#### `drizzle/migrations/0005_users_table.sql` (NEU)

```sql
CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       citext UNIQUE NOT NULL,
  google_sub  text   UNIQUE,                -- NULL bis erster Google-Login
  display_name text,
  role        text   NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  status      text   NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','erased')),
  created_at  bigint NOT NULL DEFAULT (extract(epoch from now())*1000)::bigint,
  last_seen_at bigint,
  invited_by  uuid REFERENCES users(id),
  invite_token text  UNIQUE                  -- NULL nach Acceptance
);

CREATE TABLE invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       citext NOT NULL,
  token       text   UNIQUE NOT NULL,
  invited_by  uuid REFERENCES users(id) NOT NULL,
  expires_at  bigint NOT NULL,
  used_at     bigint,
  created_at  bigint NOT NULL DEFAULT (extract(epoch from now())*1000)::bigint
);

CREATE TABLE signing_keys (
  kid         text PRIMARY KEY,
  alg         text NOT NULL,        -- 'EdDSA' | 'RS256'
  public_jwk  jsonb NOT NULL,
  private_pem text  NOT NULL,        -- AES-GCM-encrypted at rest via BACKUP_MASTER_KEY
  active      boolean NOT NULL DEFAULT true,
  rotated_at  bigint,
  created_at  bigint NOT NULL DEFAULT (extract(epoch from now())*1000)::bigint
);
```

**Bootstrap-Pattern:** First-Login-First-Admin (analog zu approval2 v1 §0). Beim ersten Login mit Google: User wird mit `role='admin'` angelegt, alle weiteren Logins ohne `invite_token` werden mit HTTP 403 abgelehnt.

#### `src/users/api.ts` (NEU)

- `provisionFromGoogleLogin(idToken)` — Auto-Provision mit Invite-Check
- `resolveByGoogleSub(sub)` — Lookup für Token-Validation
- `resolveByEmail(email)` — Lookup für on-behalf-of-Calls
- `listUsers()` — Admin-only (Sharing-Picker-Backend)
- `inviteUser(email)` — Admin-only
- `eraseUser(id)` — bestehende `/v1/internal/erase-user` ruft das auf

### 1.3 KMS-Adapter

#### `src/adapters/kms/internal_api.ts` (LÖSCHEN)

Komplett raus. Approval2 ist nicht mehr load-bearing für DEK-Resolution.

#### `src/adapters/kms/openbao.ts` (NEU, default)

Eigener OpenBao-Adapter im KC2-Stack. KC2-Container kommt mit eigener OpenBao-Instance (oder shared mit approval2 im gleichen docker-compose, aber separate transit-mount). Per-User-DEK via Transit-Engine `data-key/<users.id>`.

#### `src/adapters/kms/hkdf_local.ts` (NEU, dev/cheap-fallback)

Für Solo-Setups: Master-Key in env, per-user-DEK = `HKDF(master, salt=user.id, info='dek-v1')`. Kein OpenBao nötig. Sicherheits-Eigenschaften schwächer (master-leak → alle DEKs leak, keine Crypto-Shredding-Garantie). Default für `NODE_ENV=development`, explizit aktivierbar via `KMS_PROVIDER=hkdf_local`.

#### `src/types/env.ts` (umstellen)

```ts
KMS_PROVIDER: z.enum(['openbao', 'hkdf_local']).default('openbao'),
// openbao
OPENBAO_ADDR?: z.string().url(),
OPENBAO_TOKEN?: z.string(),
OPENBAO_TRANSIT_PATH?: z.string().default('transit'),
// hkdf_local
KMS_MASTER_KEY_B64?: z.string(),  // 32-byte base64, dev only

// Auth (NEW)
GOOGLE_OAUTH_CLIENT_ID: z.string(),
GOOGLE_OAUTH_CLIENT_SECRET: z.string(),
GOOGLE_OAUTH_REDIRECT_URI: z.string().url(),
SELF_OAUTH_ISSUER: z.string().url(),  // 'https://knowledge.<domain>'
MCP_APPROVAL_JWKS_URL: z.string().url().optional(),  // wenn nicht gesetzt: kein Proxy-Mode

// REMOVED
// MCP_APPROVAL_BASE_URL
// MCP_APPROVAL_INTERNAL_TOKEN  (Service-Token bleibt aber als SERVICE_TOKEN)
// JWKS_URL                      (durch ISSUERS-Map ersetzt)
// JWT_ISSUER, JWT_AUDIENCE      (in ISSUERS-Map encoded)
```

### 1.4 MCP-Transport

#### `src/mcp/server.ts` (NEU)

Streamable-HTTP-MCP-Server unter `POST /mcp`. Wrapped die existierenden REST-Endpoints in MCP-Tool-Definitions.

Tool-Surface (gewrapped aus `/v1/*`):

| MCP-Tool | REST-Backing |
|---|---|
| `objects.create` | `POST /v1/objects` |
| `objects.get` | `GET /v1/objects/{id}` |
| `objects.list` | `GET /v1/objects` |
| `objects.update` | `PATCH /v1/objects/{id}` |
| `objects.delete` | `DELETE /v1/objects/{id}` |
| `objects.usages` | `GET /v1/objects/{id}/refs` |
| `shares.create` | `POST /v1/objects/{id}/shares` |
| `shares.list` | `GET /v1/objects/{id}/shares` |
| `shares.revoke` | `DELETE /v1/shares/{id}` |
| `search` | `POST /v1/search` |
| `uploads.init` | `POST /v1/uploads/init` |
| `uploads.complete` | `POST /v1/uploads/complete` |

Auth: gleicher `requireJwt`-Middleware wie REST, akzeptiert Tokens von der eigenen Facade. Identical claims, identical RLS-Setup.

Tool-Manifest implementiert `annotations.wysiwys.display_template` (kompatibel zu approval2's Welle-3-Pattern), damit approval2 sie ohne manuelles Mapping in seine eigene Tool-Surface übernehmen kann.

#### `src/mcp/transport.ts` (NEU)

Hono-Adapter für JSON-RPC + SSE-Streamable-HTTP. `Accept: application/json, text/event-stream` Pflicht. Initialize-Handshake validieren.

### 1.5 PWA-Sonderpfad (approval2-Proxy → KC2)

#### `src/routes/objects.ts` u.a. (Änderung Middleware-Stack)

Bisheriger Middleware-Stack: `requireJwt → installContext → idempotency → handler`.

Neuer Stack: zusätzlich akzeptiert `requireOnBehalfOf` als Alternative zu `requireJwt`:

```ts
v1.use('*', requireJwtOrOnBehalfOf);  // tries jwt, falls back to OBO
```

Wenn `X-On-Behalf-Of`-Header + `Authorization: Bearer <SERVICE_TOKEN>` gesetzt: OBO-Pfad. Sonst: regulärer User-JWT-Pfad.

#### `src/observability/audit.ts` (erweitern)

Audit-Log-Row kriegt zwei neue Spalten:
```sql
ALTER TABLE audit_log ADD COLUMN via_proxy boolean NOT NULL DEFAULT false;
ALTER TABLE audit_log ADD COLUMN approval_id uuid;  -- NULL wenn nicht via approval2
```

Damit ist im Audit nachvollziehbar ob ein Call direkt von Claude.ai kam oder durch approval2 mit Approval-Trail.

### 1.6 Was BLEIBT (Sicherheit gegen Scope-Creep)

- **Crypto-Shredding über per-user-DEK** — bleibt, AAD-Pattern unverändert
- **RLS auf objects/shares/audit** — bleibt, nur Context-Source ändert sich (jetzt aus eigenem JWT-`sub` oder OBO-Lookup)
- **REST `/v1/*` Endpoints** — bleiben 1:1, MCP wrapped sie
- **Sharing-Modell (share_grants, owner_or_shared)** — bleibt
- **Hybrid-Search (FTS + pgvector + RRF)** — bleibt
- **GDPR-Erase + cascade** — bleibt, nur Trigger-Auth-Pfad ändert sich
- **Audit-Log, Idempotency, Rate-Limits, Quotas** — bleibt

---

## 2. Cross-Service-Verträge

### 2.1 Discovery für Claude.ai (Direkt-Pfad)

Claude.ai macht:
1. `GET https://knowledge.<domain>/.well-known/oauth-authorization-server`
2. `POST /oauth/register` → kriegt `client_id`
3. `GET /oauth/authorize?response_type=code&code_challenge=...` → User wird via Google geredirected
4. `POST /oauth/token` → Access-Token + Refresh-Token
5. `POST /mcp` mit Bearer-Token

### 2.2 OBO-Flow für approval2 (Proxy-Pfad)

approval2 erhält Claude.ai's MCP-Call mit seinem eigenen Token (`aud=mcp-approval2`).

Für jeden Call den approval2 an KC2 weiterreicht:
1. approval2 generiert OBO-JWT mit `iss=mcp-approval2`, `aud=mcp-knowledge2`, `on_behalf_of=<user-email>`, `approval_id=<...>`, kurz lebig (120s)
2. approval2 callt KC2 mit Headers:
   - `Authorization: Bearer <SERVICE_TOKEN>` (shared secret)
   - `X-On-Behalf-Of: <OBO-JWT>`
   - `X-Request-Id: <korrelation>`
3. KC2 verifiziert beide, mappt OBO-`on_behalf_of` → `users.id`, setzt RLS-Context

**Warum nicht reines Token-Forwarding?** approval2 hat einen Token mit `aud=mcp-approval2`. KC2 würde den rejecten. Token-Exchange (RFC 8693) wäre die OAuth-saubere Alternative, aber zusätzlicher Round-Trip per Call. OBO-Pattern ist pragmatischer und in Enterprise-Setups üblich (vgl. Azure AD `urn:ietf:params:oauth:grant-type:jwt-bearer`).

### 2.3 PWA-Sonderpfad

PWA in approval2 spricht weiter `/admin/kc-proxy/api/objects` same-origin.
approval2 baut OBO-JWT aus Session-Cookie-User-ID + ruft KC2 mit OBO-Header.
Kein Token im Browser-JS.

---

## 3. Migrations-Tasks (Code, in Reihenfolge)

> Detaillierte Reihenfolge im Big-Bang-Plan: [PLAN-as3-bigbang.md](./PLAN-as3-bigbang.md). Hier nur die Repo-internen Tasks.

| # | Task | Estimate | Blocker? |
|---|---|---|---|
| K1 | `signing_keys`-Tabelle + Bootstrap-Key generieren beim ersten Start | 2h | nein |
| K2 | `users` + `invites`-Tabelle + Migrations + Indexes | 3h | nein |
| K3 | `src/auth/oauth_facade.ts` — Discovery-Endpoint + DCR + JWKS publiziert | 1d | K1 |
| K4 | OAuth-Facade: `/authorize` + Google-Callback + `/token` mit PKCE | 2d | K3, GOOGLE_OAUTH_* env |
| K5 | `src/auth/jwt.ts` umstellen auf Multi-Issuer (self-issued + Google) | 4h | K3 |
| K6 | `src/users/api.ts` + Auto-Provision-on-First-Login | 1d | K2 |
| K7 | `src/auth/on_behalf_of.ts` — OBO-Verifier | 4h | K5 |
| K8 | `requireJwtOrOnBehalfOf`-Middleware in alle `/v1/*` einhängen | 2h | K7 |
| K9 | KMS: `internal_api.ts` raus, `openbao.ts` + `hkdf_local.ts` rein | 1d | nein, parallel |
| K10 | `src/mcp/server.ts` + `transport.ts` — Streamable-HTTP-MCP | 2d | K5 |
| K11 | MCP-Tool-Wrapper für alle `/v1/*` Endpoints, mit `display_template` | 1d | K10 |
| K12 | `audit_log` Schema-Erweiterung (`via_proxy`, `approval_id`) | 1h | nein |
| K13 | `.env.example` + `src/types/env.ts` umstellen | 2h | parallel |
| K14 | Integration-Tests: Google-OIDC-Mock + Facade-Roundtrip + OBO-Flow | 2d | K8, K11 |
| K15 | E2E-Smoke: PWA-Flow + Claude.ai-Direct + approval2-Proxy parallel | 1d | K14, approval2-Seite ready |

**Summe:** ~14-16 Personen-Tage.

---

## 4. Open Decisions

| ID | Frage | Default-Vorschlag |
|---|---|---|
| K-D1 | Google-Workspace-Domain-Allowlist erzwingen (`hd=<domain>` claim)? | Ja für Pilot-Setups, optional (`GOOGLE_HD_ALLOWLIST` env) |
| K-D2 | Refresh-Token-Rotation (Single-Use vs. Long-Lived)? | Single-Use mit 14d-Inactivity-Expiry |
| K-D3 | OAuth-Facade-Signing-Key-Rotation Frequency? | 90d, alte Keys 30d in JWKS für Token-Replay-Window |
| K-D4 | OBO-JWT `approval_id` Pflicht oder optional? | Optional (NULL erlaubt für Non-State-Changing-Reads), aber für write-Ops Pflicht |
| K-D5 | DCR-Client-Lifetime + auto-cleanup? | 90d Inactivity → cleanup-cron räumt auf |
| K-D6 | MCP-`tools/list` Output: alle 30+ Tools oder Subset für sensitive? | Alle, mit `annotations.sensitivity` für approval2-Filter |
| K-D7 | OpenBao im KC2-Container oder shared mit approval2? | Pilot: shared (1 OpenBao, 2 transit-mounts). Prod: separat. |

---

## 5. Akzeptanz-Kriterien

- [ ] `GET /.well-known/oauth-authorization-server` liefert RFC-8414-konformes JSON
- [ ] `POST /oauth/register` erlaubt DCR ohne Pre-Approval, gibt `client_id` zurück
- [ ] Vollständiger Auth-Code-Flow mit Google als IdP, ohne approval2 involviert
- [ ] Claude.ai kann KC2 als MCP-Server registrieren und `tools/list` + `tools/call` durchführen
- [ ] approval2-OBO-Pfad funktioniert: signed-JWT-Header + Service-Token zusammen authentifizieren als User, RLS greift
- [ ] Audit-Log markiert proxy-vs-direkt sauber
- [ ] KMS funktioniert ohne approval2-Callback (OpenBao oder hkdf_local)
- [ ] First-Login-Admin-Bootstrap funktioniert
- [ ] PWA-`/admin/kc-proxy/*`-Flow weiter grün (approval2-side spec)
- [ ] alle existierenden Integration-Tests grün (Sharing, Search, RLS, GDPR-Erase)
- [ ] Neue Tests: 30+ Tests für OAuth-Facade, OBO, Multi-Issuer-JWT, Auto-Provision

---

## 6. Was NICHT Teil von AS-3 ist (Scope-Fence)

- Multi-Tenant-Support (bleibt strikt Single-Tenant)
- Eigene OpenBao-Cluster-Setups (Pilot teilt mit approval2)
- Custom-IdP-Support neben Google (Phase 5+)
- WebAuthn / Passkey (lebt komplett in approval2)
- Approval-Flow / WYSIWYS / IPI-Filter (lebt in approval2)
- Sub-MCP-Gateway-Pattern (lebt in approval2 als Tool-Hub)
