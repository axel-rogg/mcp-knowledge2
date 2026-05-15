# PLAN — AS-3 Big-Bang-Cutover (Cross-Repo)

> **Status: ⚠️ SPEC (2026-05-15) — pre-implementation, "ein Wurf"**
>
> Master-Orchestrierung für die AS-3-Umstellung beider Repos in einem Cutover.
> Die per-Repo-Specs sind die Detailebene — dieses Dokument koordiniert.
>
> Per-Repo-Specs:
> - mcp-knowledge2 (this repo): [PLAN-as3-autonomous.md](./PLAN-as3-autonomous.md)
> - mcp-approval2: [github.com/axel-rogg/mcp-approval2/.../PLAN-as3-autonomous.md](https://github.com/axel-rogg/mcp-approval2/blob/main/docs/plans/active/PLAN-as3-autonomous.md)

---

## 0. Warum Big-Bang (und nicht Phased)?

Drei Eigenschaften des heutigen Zustands erlauben den Big-Bang:

1. **Pre-Pilot, kein Live-Traffic.** Beide Services sind im Pilot-Stage. mcp-approval2-Pilot lief 1x live (3/3 Smoke 2026-05-14), wurde danach via `vm-destroy-only.sh` heruntergefahren. mcp-knowledge2 noch nie produktiv. Niemand stirbt wenn beide Services für 2 Stunden offline sind.
2. **Keine User-Daten in Produktion.** RLS + crypto-shredding sind getestet, aber leer. Keine Migration laufender Daten nötig.
3. **Beide Repos atomar deployable.** Docker-Compose + Fly/Hetzner = ein `terraform apply` pro Service. Cutover-Risiko ist Code-Bug, nicht Daten-Verlust.

Phased-Migration würde Trust-Bridge-Code brauchen (alte und neue Auth parallel akzeptieren), zusätzlich Tests für beide Modi, Cutover-Gate-Flags. Bei Pre-Pilot-Status ist das ROI-negativ.

**Risiken die wir akzeptieren:**
- Wenn Cutover-Tag schief geht: 2-4h Downtime im Pilot. Akzeptabel.
- Wenn ein versteckter Bug erst Wochen später auffällt: Hotfix vorwärts, kein Rollback auf alte Auth-Schicht möglich.
- Wenn Google-OAuth-Setup nicht klappt: Direkt-Pfad und Proxy-Pfad beide tot bis Setup steht.

---

## 1. End-Zustand (was am Cutover-Tag-Ende läuft)

```
   Google OIDC ◄─── PWA-Session-Login (via approval2)
                    ◄─── Claude.ai-MCP-Auth (via approval2 ODER KC2)
        ▲
        │
        │ ID-Token verify
        │
        ├──── mcp-approval2 ◄─── Browser-PWA (Cookie-Session)
        │           │
        │           │ S2S: X-On-Behalf-Of + SERVICE_TOKEN
        │           ▼
        └──── mcp-knowledge2 ◄─── Claude.ai-MCP (direkt, autonom)
              │
              ├── /v1/* REST
              └── /mcp Streamable-HTTP
```

Akzeptanzkriterien am Cutover-Ende:
- [ ] Google-OAuth-Login in PWA funktioniert
- [ ] PWA Storage-Tab listet KC2-Objects über `/admin/kc-proxy/*`
- [ ] Claude.ai kann sich gegen approval2 anmelden (DCR), `tools/list` enthält KC-Wrappers + native Tools
- [ ] Claude.ai kann sich gegen KC2 direkt anmelden, `tools/list` enthält nur KC-Tools
- [ ] Approval-Flow läuft End-to-End: write-Tool → PWA-Approve → KC2-Audit zeigt `via_proxy=true, approval_id=<...>`
- [ ] KC2 läuft ohne approval2 erreichbar (Sanity: stop approval2 → KC2-Direkt-Pfad bleibt funktional)
- [ ] approval2 läuft ohne KC2 erreichbar (Sanity: stop KC2 → approval2-native-Tools + Gateways funktional, KC-Wrappers fehlen graceful)

---

## 2. Pre-Cutover-Vorbereitung (asynchron, kann Wochen vorher)

Diese Dinge sind nicht "Code schreiben", sondern Setup das Sukunden vor dem Cutover-Tag steht.

### 2.1 Google-OAuth-Projekt

- [ ] Google-Cloud-Console: OAuth-2.0-Client-ID erstellen für approval2 (Web-App)
  - Authorized JS Origins: `https://approval2.<domain>`, `http://localhost:5173` (dev)
  - Redirect-URIs: `https://approval2.<domain>/auth/google/callback`, `http://localhost:8787/auth/google/callback`
- [ ] Zweite OAuth-2.0-Client-ID für KC2 (Web-App)
  - Authorized JS Origins: `https://knowledge.<domain>`, `http://localhost:5173` (dev)
  - Redirect-URIs: `https://knowledge.<domain>/auth/google/callback`, `http://localhost:8080/auth/google/callback`
- [ ] OAuth-Consent-Screen konfiguriert (Scopes: `openid email profile`, ggf. `hd` constrained)
- [ ] Client-ID + Secret für beide in Doppler / Secret-Store ablegen

### 2.2 OpenBao-Setup (KC2-Side, KMS)

- [ ] Pilot: shared OpenBao-Instance mit approval2 (1 OpenBao-Container, 2 transit-mounts).
- [ ] Transit-Engine-Mount `knowledge-dek` aktivieren neben approval2's `transit`.
- [ ] AppRole-Auth für KC2 anlegen, `role_id` + `secret_id` in Doppler.
- [ ] Alternativ: für dev `KMS_PROVIDER=hkdf_local` + `KMS_MASTER_KEY_B64`.

### 2.3 Domains + TLS

- [ ] `knowledge.<domain>` muss DNS + TLS haben.
- [ ] `approval2.<domain>` muss DNS + TLS haben (bei Pilot eventuell schon da).
- [ ] CORS-Listen in beiden Services konfigurieren (`approval2.<domain>` → KC2, `app.<domain>` falls split PWA-domain).

### 2.4 Secrets-Inventar

| Secret | approval2 | knowledge2 | Owner |
|---|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | ✓ | ✓ (separate ID) | Operator |
| `GOOGLE_OAUTH_CLIENT_SECRET` | ✓ | ✓ (separate Secret) | Operator |
| `SELF_OAUTH_ISSUER` | ✓ (`https://approval2.<domain>`) | ✓ (`https://knowledge.<domain>`) | Config |
| `MCP_APPROVAL_JWKS_URL` | – | ✓ (Optional, nur Proxy-Mode) | Config |
| `MCP_KNOWLEDGE_URL` | ✓ | – | Config |
| `MCP_KNOWLEDGE_SERVICE_TOKEN` | ✓ | ✓ (matched) | Operator (rotate together) |
| `OPENBAO_TOKEN` / AppRole | ✓ | ✓ (separate role) | Operator |
| `KMS_MASTER_KEY_B64` (dev only) | – | ✓ | Operator |
| `JWT_SIGNING_KEY` (legacy) | bisher: approval2 generated | bisher: shared via JWKS | **wird abgelöst** durch eigene per-service Keys |

---

## 3. Branch-Strategie

| Repo | Branch | Inhalt |
|---|---|---|
| mcp-knowledge2 | `feat/as3-cutover` | K1-K15 aus per-Repo-Spec |
| mcp-approval2 | `feat/as3-cutover` | A1-A15 aus per-Repo-Spec |

**Regel:** Beide Branches bleiben offen bis Cutover. Kein vorzeitiges Mergen einzelner Tasks nach `main`, weil partielle Merges das alte System zerschießen (z.B. wenn approval2-`KnowledgeAdapter` schon OBO sendet aber KC2-Side noch keinen OBO-Verifier hat).

Ausnahmen die nach `main` mergen dürfen (keine Breaking-Changes für laufenden Pilot):
- Test-Fixes
- Doc-Updates (auch dieses Plan-File darf nach `main`)
- Strikt additive Migrations (`0005_users_table.sql` darf rein, aber Code der `users.id` als Trust-Quelle nimmt nicht)

---

## 4. Implementations-Reihenfolge (Cross-Repo)

Tasks sind nach **Dependency** geordnet, nicht nach Wallclock. Innerhalb eines Tier kann parallel gearbeitet werden.

### Tier 0 — Independent prep (Tag 1-3, parallel)

- **KC2 K1**: `signing_keys`-Tabelle + Bootstrap-Generator
- **KC2 K2**: `users` + `invites`-Migrations
- **KC2 K9**: KMS-Adapter-Replace (`openbao.ts` + `hkdf_local.ts`)
- **KC2 K12**: `audit_log` Schema-Erweiterung
- **KC2 K13**: env-Schema + `.env.example`
- **A1**: `JwtSigner.signOBO()` Implementation
- **A12**: env-Schema + `.env.example`

Keine Cross-Dependencies. Alles parallel schreibbar.

### Tier 1 — Auth foundation (Tag 4-7, parallel)

Depends on Tier 0.

- **KC2 K3**: OAuth-Facade Discovery + DCR + JWKS (depends on K1)
- **KC2 K4**: OAuth-Facade `/authorize` + Google-Callback + `/token` (depends on K3)
- **KC2 K5**: Multi-Issuer-JWT-Verifier (depends on K3)
- **KC2 K6**: `users/api.ts` Auto-Provision (depends on K2)
- **KC2 K7**: OBO-Verifier (depends on K5)
- **A5**: OAuth-Facade `token.ts` `idp=google`-Claims
- **A6**: OAuth-Facade `authorize.ts` Google-Redirect (depends on A5)
- **A7**: Google-Callback-Handler erweitern (depends on A6)

### Tier 2 — Service integration (Tag 8-11, parallel)

Depends on Tier 1.

- **KC2 K8**: `requireJwtOrOnBehalfOf`-Middleware in `/v1/*` einhängen (depends on K7)
- **KC2 K10**: MCP-Server `/mcp` + Transport (depends on K5)
- **KC2 K11**: MCP-Tool-Wrapper für REST-Endpoints (depends on K10)
- **A2**: `KnowledgeAdapter` HTTP-Client → OBO-Pattern (depends on A1)
- **A3**: KnowledgeAdapter-Tests anpassen (depends on A2)
- **A4**: `kc-proxy.ts` Route (depends on A1)
- **A8**: `kc_wrappers/` Auto-Generator (depends on A2 + KC2 K11)
- **A9**: KC2-Manifest-Refresh-Cron (depends on A8)
- **A10**: Approval-Handler `approval_id`-OBO-Erweiterung (depends on A1)
- **A11**: User-State-Sync to KC2 (depends on KC2 K6, K8)

### Tier 3 — Integration tests (Tag 12-13)

Depends on Tier 2 — both sides.

- **KC2 K14**: Google-OIDC-Mock + Facade-Roundtrip + OBO-Flow-Tests
- **A13**: E2E PWA → kc-proxy → KC2 mit echtem User-Token
- **A14**: E2E Claude.ai → approval2 → KC2 mit Approval-Flow
- **A15**: E2E Claude.ai → KC2 direkt
- **KC2 K15**: E2E-Smoke parallel

### Tier 4 — Cutover (Tag 14, "Big-Bang-Tag")

Siehe §5.

**Gesamt-Wallclock-Schätzung:** 14 Werktage bei einem Vollzeit-Engineer pro Repo (parallel). Mit Tests-Iteration und Setup-Reibung realistisch 18-20 Werktage.

---

## 5. Cutover-Tag (Day 0)

### 5.1 Vorab-Check (Vortag, T-1)

- [ ] Beide Branches grün in CI (alle Tests, alle Typechecks, alle Lints)
- [ ] Smoke-Tests laufen in beiden Repos lokal mit docker-compose
- [ ] Google-OAuth-Setup verifiziert (Manual: Browser-Login funktioniert in dev)
- [ ] OpenBao-Setup verifiziert (KC2 kann DEK resolven)
- [ ] Secrets in Doppler aktualisiert für Pilot-Stage
- [ ] PR-Approvals oder Solo-Review-Pass für beide Branches
- [ ] Rollback-Snapshot: aktueller `main`-State beider Repos getagged als `pre-as3-cutover`

### 5.2 Cutover-Window (Day 0)

**Reihenfolge: KC2 zuerst, weil approval2 ohne KC2 graceful läuft, aber nicht umgekehrt.**

| Zeit | Schritt | Erwartung |
|---|---|---|
| T+0 | Cutover-Window start, beide Services in Pilot-Stage anhalten | Services off |
| T+5min | `feat/as3-cutover` → `main` merge in mcp-knowledge2 | branch up-to-date |
| T+10min | KC2 Migration 0005 (users + invites + signing_keys) anwenden | migration applied |
| T+15min | KC2 Service deployen (Hetzner/Fly/Cloud-Run) | `/health` 200 |
| T+20min | KC2 Smoke: `GET /.well-known/oauth-authorization-server` | 200 + RFC-konform |
| T+25min | KC2 Bootstrap: First-Login als Admin (Operator login via Google) | `users` row mit `role='admin'` |
| T+30min | KC2 Smoke: Claude.ai DCR + Auth-Code-Flow + `tools/list` | tools list grün |
| T+40min | `feat/as3-cutover` → `main` merge in mcp-approval2 | branch up-to-date |
| T+45min | approval2 Service deployen mit `MCP_KNOWLEDGE_URL` + `MCP_KNOWLEDGE_SERVICE_TOKEN` gesetzt | `/health` 200 |
| T+50min | approval2 Smoke: Login via Google, Session-Cookie da | login ok |
| T+55min | approval2 → KC2 OBO-Smoke: User-Sync rüber, KC2 sieht den User | sync ok |
| T+60min | PWA-Smoke: Storage-Tab listet Objects (alle 0 in frischer DB) | empty list ok |
| T+65min | Claude.ai → approval2 Smoke: DCR + Auth + `tools/list` enthält KC-Wrappers | wrapper visible |
| T+70min | Approval-E2E: Test-Tool `objects.create` mit Approval-Flow → Approve → KC2-Audit zeigt `via_proxy=true` | audit row visible |
| T+80min | Direkt-Pfad-Sanity: Claude.ai stop approval2, KC2 direkt erreichbar | direct path works |
| T+85min | Restore approval2, finaler Smoke | both paths green |
| T+90min | Cutover-Window-Ende, beide Services live | done |

**Total Window: ~90 min** bei klarem Setup. +30-60 min Puffer für Debugging.

### 5.3 Rollback-Trigger

Rollback ist **destruktiv** (DB-Schema-Migrations sind addive aber Code-Pfade nicht). Trigger:

- KC2 startet nicht nach Migration → `git checkout pre-as3-cutover` + redeploy
- KC2 Google-OAuth-Flow blockiert (Redirect-Loop, JWT-verify fail) → rollback
- approval2 KnowledgeAdapter wirft 401/403 in allen Calls → rollback approval2 ONLY (KC2 kann bleiben für Direkt-Pfad-Test)
- Approval-Flow setzt nicht `approval_id` → kein Rollback, Hotfix-Forward (kosmetisch)

**Rollback-Reihenfolge:** approval2 first, KC2 second. Migrations werden NICHT zurückgerollt — `users`-Tabelle bleibt leer in der alten Welt, schadet nicht.

### 5.4 Post-Cutover (T+1 bis T+7)

- [ ] Audit-Log über erste 24h prüfen — keine "anonymous" oder fehlgeschlagene Auth-Calls
- [ ] CORS-Errors in PWA-Browser-Console → 0
- [ ] KC2 + approval2 Memory + DB-Connections stabil
- [ ] Token-Refresh-Flow getestet (Token läuft nach 1h ab, Refresh greift)
- [ ] User-Sync-Race-Conditions: 2 Logins gleichzeitig → keine Duplicate-key-Fehler
- [ ] Documentation-Sync: per-Repo-Spec auf "✅ DEPLOYED" Status setzen

---

## 6. Parallelisierungs-Matrix (wer macht was wann)

Wenn 2 Engineers verfügbar (1 pro Repo):

| Tag | KC2-Engineer | approval2-Engineer |
|---|---|---|
| 1 | K1 (signing_keys) + K2 (users-migration) | A1 (signOBO) |
| 2 | K9 (KMS-replace) + K12 (audit_log) + K13 (env) | A12 (env) + A5 (token-claims) |
| 3 | K3 (Discovery+DCR+JWKS) | A6 (authorize Google-redirect) |
| 4 | K4 (authorize + Google-callback + token) | A7 (Google-callback handler) |
| 5 | K5 (Multi-Issuer-JWT) + K6 (users-api) | A2 (KnowledgeAdapter switch) |
| 6 | K7 (OBO-verifier) + K8 (middleware-mount) | A3 (Adapter-Tests adapt) |
| 7 | K10 (MCP-server + transport) | A4 (kc-proxy route) |
| 8 | K11 (MCP-tool-wrappers) | A8 (kc_wrappers auto-generator) |
| 9 | K14 (Integration-Tests) | A9 (refresh-cron) + A10 (approval_id-obo) |
| 10 | K14 cont. + K15 (E2E-Smoke) | A11 (user-sync) |
| 11 | Buffer / Bugfixes | A13 (PWA-E2E) |
| 12 | Buffer / Bugfixes | A14 (Approval-E2E) + A15 (Direct-E2E) |
| 13 | Cross-team-test-day (gegen sich gegenseitig deployen) | Cross-team-test-day |
| 14 | **Cutover-Tag** | **Cutover-Tag** |

Wenn 1 Engineer für beide Repos: ~25-30 Werktage seriell.

---

## 7. Risiken + Mitigation

| Risiko | Wahrscheinlichkeit | Impact | Mitigation |
|---|---|---|---|
| Google-OAuth-Consent-Screen-Approval verzögert | mittel | 1d Slip | OAuth-Client-IDs Tage vorher anlegen, Test-User-Allowlist nutzen bis Consent-Screen approved |
| OpenBao-AppRole-Auth bricht in KC2 | niedrig | 1d Slip | Pre-Test mit hkdf_local-Fallback, OpenBao als Tier-1-Task |
| MCP-Streamable-HTTP-Quirks (Initialize-Handshake, Accept-Header) | mittel | 2h Debug | Existierende approval2-MCP-Impl als Referenz, gleiche Library |
| OBO-JWT JWKS-Lookup race (approval2 deployed bevor KC2 die JWKS cached) | niedrig | 5min retry | JWKS-Cache cooldown 30s, KC2 vor approval2 deployen |
| User-Sync race (zwei gleichzeitige Logins) | niedrig | Duplicate row | UNIQUE-constraint auf `users.email` + ON CONFLICT DO UPDATE |
| PWA-Cookie-Domain-Mismatch beim Subdomain-Split | mittel | PWA stuck-login | Cookie-Domain auf root-Domain setzen, vorab in dev verifizieren |
| Approval-Flow setzt `approval_id` nicht in OBO | mittel | Audit-Trail-Gap | Test-Case explizit in Tier-3, Cutover-Smoke checked es |
| Claude.ai-Client-Cache mit alter DCR-Registrierung | hoch | User-confusion | Pilot-User vorab info'en alte Registrierung zu löschen |

---

## 8. Done-Definition

AS-3-Cutover gilt als done wenn:

- [ ] Beide Branches in `main` gemergt
- [ ] Beide Services live in Pilot-Stage
- [ ] §1 Akzeptanzkriterien alle grün
- [ ] §5.4 Post-Cutover-Checks 7d ohne Regression
- [ ] CLAUDE.md beider Repos auf "AS-3 live" aktualisiert (Status-Banner umstellen)
- [ ] Per-Repo-Specs auf "✅ DEPLOYED" Status, dieses Doc auch
- [ ] `pre-as3-cutover`-Tag in beiden Repos archiviert (Rollback-Möglichkeit für 30d)

---

## 9. Was NACH dem Cutover offen bleibt

Diese Sachen sind NICHT im Cutover, kommen als Follow-ups:

- **SCIM-User-Sync** statt push-pattern (Phase 5+)
- **Token-Exchange (RFC 8693)** statt OBO (wenn Enterprise-Kunde fragt)
- **Refresh-Token-Rotation single-use** (heute: long-lived)
- **OAuth-Facade-Signing-Key-Rotation-Automation** (heute: manuell)
- **KC2 ohne approval2 als Default-Setup** (Documentation, Quickstart, Self-Hosted-Guide)
- **PWA in KC2** (heute: PWA nur in approval2) — falls KC2-Standalone-Usecase relevant wird
- **Multi-IdP** (Microsoft, Okta, GitHub) — heute nur Google
- **Removal von approval2's `KnowledgeAdapter`** falls Setups ohne approval2 dominieren (sehr Late-Phase)
