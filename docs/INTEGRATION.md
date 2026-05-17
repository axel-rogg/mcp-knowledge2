# Integration — wie der Service nach Deploy in den eigenen Workflow eingebunden wird

> **Status:** ⚠️ Entwurf 2026-05-16 — beschreibt die drei realistischen Anbindungs-Pfade nach erstem grünem Smoke gegen `https://mcp-knowledge2.fly.dev`. Komplement zu [STRATEGIE-pilot.md](./STRATEGIE-pilot.md) (Deploy-Linie) und [PILOT-READINESS.md](./PILOT-READINESS.md) (Sign-off-Checkliste).
> **Owner:** Axel
> **Voraussetzung:** Pilot-Sign-off-Punkte gegen Fly grün, Doppler-Secrets gefüllt, OAuth-Facade-Discovery erreichbar.

## 1. Drei Anbindungs-Pfade

Nach AS-3 ist mcp-knowledge2 autonomer MCP- und REST-Server. Es gibt drei legitime Wege, ihn in den eigenen Workflow zu integrieren — der erste ist der Default für Solo-Pilot, der zweite für die Kopplung an die existierende Approval-PWA, der dritte für lokales Scripting / Tests.

| Pfad | Wer ruft auf | Wie | Wann nutzen |
|---|---|---|---|
| **A — claude.ai direct (DCR)** | claude.ai / Claude Code | Browser-OAuth-Flow gegen KC2's eigene Facade, Google-Login dazwischen | Default für Solo-Pilot — minimaler Setup-Aufwand |
| **B — mcp-approval2 als Proxy (OBO)** | mcp-approval2 im Auftrag des Users | S2S-Call mit `Authorization: Bearer <SERVICE_TOKEN>` + `X-On-Behalf-Of: <jwt>` | Wenn die Approval-PWA bereits aktiv ist und Write-Approvals zentral durch sie sollen |
| **C — direkter HTTP-Call (Bearer)** | lokales Skript, CI-Smoke, manuelles `curl` | JWT aus KC2-Facade einmal manuell ziehen + als Bearer setzen | Test, Debug, Smoke gegen produktive Instanz |

## 2. Pfad A — claude.ai direct (DCR + OAuth-2.1)

**Voraussetzung:** Fly-Deploy abgeschlossen, `https://mcp-knowledge2.fly.dev/.well-known/oauth-authorization-server` antwortet 200 JSON, `ALLOWED_EMAILS=axelrogg@gmail.com` ist in Doppler gesetzt.

### Setup in claude.ai

1. claude.ai → Settings → Connectors → Add custom connector
2. **MCP-Server-URL:** `https://mcp-knowledge2.fly.dev/mcp`
3. claude.ai löst die OAuth-Facade konventionsbasiert auf — der MCP-Server selbst sendet **keinen** `WWW-Authenticate`-Header (im Code aktuell nicht implementiert; verifiziert 2026-05-16). claude.ai probiert pro Anbindung den OAuth-2.1-Standard-Pfad:
   - GET `/.well-known/oauth-authorization-server` → liefert `registration_endpoint`, `authorization_endpoint`, `token_endpoint`, `jwks_uri`
   - POST `/oauth/register` (DCR/RFC 7591) → `client_id` + ggf. `client_secret`
4. claude.ai redirected den Browser zu `/oauth/authorize?response_type=code&client_id=…&code_challenge=…&code_challenge_method=S256`
5. KC2 redirected weiter zu Google OAuth-Consent (Google-Account des Users)
6. Google redirected zurück zu `/auth/google/callback` → KC2 prüft `id_token.email ∈ ALLOWED_EMAILS` (wenn die Liste nicht leer ist) → 302 zurück zu claude.ai mit `?code=…`
7. claude.ai tauscht den Code via `POST /oauth/token` (mit PKCE-Verifier) gegen einen KC2-Access-Token (EdDSA-signiert, `iss = SELF_OAUTH_ISSUER`, `aud = mcp-knowledge2`)
8. Token wird im claude.ai-Vault gespeichert. Ab jetzt: `Authorization: Bearer <kc2-access-token>` an jedem MCP-Call.

> **Erstmaliger Anbindungs-Test ist Reality-Check:** Wenn claude.ai die Discovery nicht automatisch findet (möglich, weil der MCP-OAuth-Spec sich entwickelt), Pfad C als Workaround nutzen (Token manuell über lokalen Mini-Skript-DCR-Flow ziehen). Resultat in dieser Datei ergänzen, sobald empirisch gemessen.

### Refresh + Lifespan

- Access-Token-TTL: ca. 1 Stunde (siehe `src/auth/oauth_facade/token.ts`)
- Refresh-Token rotiert bei jedem Use (Rotation-on-Use)
- Wenn `ALLOWED_EMAILS` später eingeschränkt wird und der gespeicherte Refresh-Token einem nicht mehr gelisteten User gehört: nächster Refresh schlägt fehl, claude.ai macht den OAuth-Flow neu

### Test direkt am Browser

```bash
# Discovery
curl -s https://mcp-knowledge2.fly.dev/.well-known/oauth-authorization-server | jq

# JWKS (sollte mindestens einen EdDSA-Key liefern)
curl -s https://mcp-knowledge2.fly.dev/.well-known/jwks.json | jq

# DCR-Smoke (öffentlich, kein Auth)
curl -s -X POST https://mcp-knowledge2.fly.dev/oauth/register \
  -H 'content-type: application/json' \
  -d '{"redirect_uris":["http://localhost/cb"],"client_name":"smoke"}' | jq
```

## 3. Pfad B — mcp-approval2 als Proxy (OBO)

**Voraussetzung:** mcp-approval2 läuft (Cloudflare Worker oder eigene Fly-Instanz), beide Services teilen einen frischen `SERVICE_TOKEN`, und `MCP_APPROVAL_JWKS_URL` in Doppler verweist auf den JWKS-Endpoint der laufenden approval2-Instanz.

### Wann sinnvoll

- Du nutzt schon die [mcp-approval](https://github.com/axel-rogg/mcp-approval)-PWA für andere Tools und willst die write-Approvals auch für mcp-knowledge2 zentral dort sehen.
- Ein Pilot-Kunde hat seine eigene Approval-Instanz, die als einziger Caller für mcp-knowledge2 dienen soll.

### Setup-Schritte

1. In Doppler-Config `mcp-knowledge2 / privat` setzen:
   - `MCP_APPROVAL_JWKS_URL=https://mcp.ai-toolhub.org/.well-known/jwks.json` (oder die URL der relevanten approval2-Instanz)
   - `MCP_APPROVAL_ISSUER=mcp-approval2` (oder welcher `iss`-Claim die OBO-Tokens haben)
   - `SERVICE_TOKEN=…` (derselbe Wert wie in approval2's eigenem Secret-Store für den Outbound-Adapter)
2. `bash deploy/fly/sync-secrets.sh && fly deploy -a mcp-knowledge2` — Pickup-Trigger.
3. In approval2 einen Gateway-Server-Eintrag anlegen mit URL `https://mcp-knowledge2.fly.dev/mcp` und `auth_type=obo` (Approval-Wrapper-Pattern, siehe `mcp-approval`-Repo).
4. approval2's tool-Aufruf sendet:
   ```
   POST /mcp HTTP/1.1
   Host: mcp-knowledge2.fly.dev
   Authorization: Bearer <SERVICE_TOKEN>
   X-On-Behalf-Of: <kurz-lebiger user-jwt aus approval2-facade>
   Content-Type: application/json
   …
   ```
5. KC2 prüft beides (Constant-Time-Vergleich + JWKS-Verify), resolved `sub` → `current_user`, propagiert in RLS.

### Risiken (Cross-Provider-Hops)

Wenn approval2 auf Cloudflare Workers und mcp-knowledge2 auf Fly läuft, gibt es zwei TLS-Terminationen: die OBO-JWTs durchlaufen beide Provider. Siehe [SECURITY.md §"Cross-provider deployment"](./SECURITY.md#cross-provider-deployment-mcp-approval2-on-cloudflare-mcp-knowledge2-on-flyhetzner). Für privaten Pilot acceptable, für Customer-Pilot vorher DPA-Klauseln + Hardening (JWE-on-DEK) prüfen.

## 4. Pfad C — direkter HTTP-Call (Bearer)

Für Smoke-Skripte, Debug-Sessions und Migrations-Trockenläufe — keine Browser-Magie, ein einmal gezogener Token in der Shell.

### Token einmalig ziehen

Easiest path: claude.ai macht den OAuth-Flow für dich (Pfad A oben), du holst dann den Access-Token aus den DevTools / aus claude.ai-Connector-Logs. Lebensdauer ~1h, nur für Tests.

Alternativ: lokales Mini-Skript, das den DCR + Auth-Code + Token-Exchange-Flow programmatisch durchläuft. Würde gegen einen lokalen `http://localhost:8080`-Listener für den Callback bauen. Nicht im Pilot-Scope — wenn du das brauchst, ist es ein eigenes Tool.

### Direkter Call

```bash
TOKEN="<paste-kc2-access-token>"
curl -sf https://mcp-knowledge2.fly.dev/v1/objects \
  -H "Authorization: Bearer $TOKEN" | jq

# Object anlegen
curl -sf -X POST https://mcp-knowledge2.fly.dev/v1/objects \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"subtype":"doc","body_b64":"aGVsbG8=","title":"smoke"}' | jq
```

Für die Service-Routen (`/v1/internal/*`) reicht der `SERVICE_TOKEN` direkt — kein JWT nötig:

```bash
curl -sf -X POST https://mcp-knowledge2.fly.dev/v1/internal/erase-user \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"<uuid>"}' | jq
```

## 5. Einbindung in Claude Code (CLI)

Claude Code unterstützt MCP-Server mit OAuth-Discovery. Setup:

```bash
claude mcp add mcp-knowledge2 https://mcp-knowledge2.fly.dev/mcp
```

Claude Code öffnet beim ersten Call einen Browser-Tab für den OAuth-Flow (gleich wie Pfad A bei claude.ai). Token wird in `~/.claude/`-Vault gespeichert. Ab dann sind alle 17 Tools (`objects.create`, `search`, `shares.create`, …) im Tool-Inventar von Claude Code verfügbar.

Hinweis: Streamable-HTTP-Transport (per [memory: mcp-streamable-http-gotchas](../../home/node/.claude/projects/-workspaces-mcp-approval/memory/feedback_mcp_streamable_http_gotchas.md) für mich relevant) — Accept-Header muss `application/json` oder `*/*` sein. Claude Code setzt das automatisch korrekt; bei `curl` manuell beachten.

## 6. Empfehlung für Solo-Pilot axelrogg@gmail.com

**Default: Pfad A.** Direkte Anbindung an claude.ai über die OAuth-Facade von KC2.

Konkret:
1. `ALLOWED_EMAILS=axelrogg@gmail.com` bleibt in Doppler — schützt vor versehentlichem Fremd-Login wenn die Google-Cloud-Console-OAuth-App im falschen Modus läuft.
2. Pfad B aktiviert nicht im ersten Schritt — Doppler-Keys `MCP_APPROVAL_JWKS_URL` + `MCP_APPROVAL_ISSUER` bleiben leer. Pfad B wird erst dann eingeschaltet, wenn ein konkretes Approval-PWA-Szenario es verlangt.
3. Pfad C nur für `scripts/smoke.sh` und Debug-Curls. Token aus claude.ai-DevTools, kein eigener Mini-Issuer.

## 7. Was nach Anbindung getestet wird

Smoke-Reihenfolge nach erstem Anbindungs-Setup (idealer-Weise auch in `scripts/smoke.sh` automatisiert, aber manuell wenn der Service-Token-Pfad gewählt wird):

1. `objects.create` (subtype=doc, body="hello") → 200 + `id`
2. `objects.get` mit `include_body=true` → 200 + decoded body matches "hello"
3. `objects.list` → 200 + Entry enthält den frisch angelegten Object
4. `search` mit Query="hello" → 200 + Top-Hit ist der angelegte Object
5. `objects.update` mit neuen Keywords → 200 + Version-Bump
6. `shares.create` (geht nur, wenn zweiter Test-User existiert; sonst skippen)
7. `objects.delete` (soft) → 200
8. `objects.restore` → 200
9. (Optional) `objects.delete` zweimal — zweiter Call gibt 404

## 8. Was als Nächstes ansteht

- [PILOT-READINESS.md](./PILOT-READINESS.md) Sign-off-Checklist Punkt für Punkt abarbeiten
- Diese Datei nach erstem End-to-End-Test der Anbindung schärfen — speziell wenn claude.ai-Discovery Edge-Cases zeigt, die hier noch fehlen
- Pfad B aufnehmen sobald ein zweiter Caller (Approval-PWA oder Customer) ihn braucht

## 9. Referenzen

- [STRATEGIE-pilot.md](./STRATEGIE-pilot.md) — aktive Deploy-Linie
- [PILOT-READINESS.md](./PILOT-READINESS.md) — Sign-off-Checkliste mit Doppler-Stand
- [SECURITY.md](./SECURITY.md) — Threat-Model + Cross-Provider-Risiken
- [CROSS-SERVICE-CONTRACT.md](./CROSS-SERVICE-CONTRACT.md) — Wire-Format für Pfad B (OBO)
- `src/auth/oauth_facade/` — OAuth-Facade-Implementation
- `src/mcp/server.ts` — Streamable-HTTP-Transport
- [mcp-approval](https://github.com/axel-rogg/mcp-approval) — Schwester-Repo, Approval-Proxy mit Gateway-Pattern
