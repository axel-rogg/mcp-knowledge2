# PLAN — Multi-User-Readiness für mcp-knowledge2

> **Status:** ⚠️ **Entwurf 2026-05-17** (basierend auf 4-parallelem-Subagent-Audit). Wartet auf User-Review, dann Implementation als zusammenhängender Sprint.
> **Auslöser:** Solo-Pilot heute live; Multi-User-Erweiterung auf 2-5 Family-User geplant. Audit `docs/security/SECURITY_ISSUES.md` identifizierte 3 echte Multi-User-Blocker; Subagent-Review fand 9 zusätzliche Hintertürchen + Test-Gaps.
> **Geschätzter Aufwand:** **6-9h Code-Sprint** + **30min User-Hand** + **30min Verification**. Realistisch ein Halbtag plus Pufferzeit.

## Executive Summary (Layman-Version)

Heute ist KC2 für **1 User** sicher. Wenn ein 2. User dazukommt, gibt es **3 große Probleme** + **6 kleinere Hintertürchen**, die Daten zwischen Usern leaken oder beide gefährden könnten.

**Die 3 großen:**
1. **Crypto-Schlüssel-Ableitung** — Alle DEKs (per-User-Schlüssel) leiten sich heute aus EINEM Master + der öffentlich-sichtbaren User-ID ab. Wer den Master klaut, kann jeden User entschlüsseln. **Fix:** Pro User einen zufälligen Salt zusätzlich.
2. **Internal-Token-Macht** — Es gibt EINEN Token zwischen approval2 und KC2, mit dem man (a) im Namen jedes Users handeln + (b) jeden User löschen kann. **Fix:** Token splitten — ein OBO-Token + ein Admin-Token + HMAC-signierte Lösch-Quittungen.
3. **Embedding-Side-Channel** — maskPII ersetzt Emails durch "[EMAIL]" — IDENTISCH für alle User. Zwei semantisch ähnliche Sätze unterschiedlicher User produzieren ähnliche Vektoren → cross-user-Inferenz möglich (auch wenn der Audit das durch RLS-Fix SEC-K-023 schon teilweise blockt; AI-Gateway-Cache + Backup-Stream sehen die Maske aber weiterhin gleich). **Fix:** Salt pro User in den embed-Text mischen.

**Die 9 kleineren Hintertürchen** (alle vom Subagent-Audit gefunden) sind in §6 detailliert.

---

## 1. SEC-K-005 — Per-User-Salt für HKDF

### 1.1 Was wir bauen

**Migration `0015_users_dek_salt.sql`:**
```sql
ALTER TABLE users ADD COLUMN dek_salt BYTEA NOT NULL DEFAULT gen_random_bytes(32)
  CHECK (octet_length(dek_salt) = 32);
ALTER TABLE users ADD COLUMN dek_salt_version INTEGER NOT NULL DEFAULT 1;
```

Plus `dek_salt_version` (1 zukünftiges Free-Slot für DEK-Rotation als bonus-future-feature).

**Code-Change in `hkdf_local.ts` + `cloud_kms.ts`:**
```ts
async resolveUserDek(userId: string, dekSalt: Uint8Array, _requestId: string): Promise<Uint8Array> {
  // Salt = userId || dek_salt (32 zufällige bytes). Auch bei Master-Leak +
  // public userId kann ein Angreifer ohne dek_salt aus der DB keinen DEK
  // ableiten.
  const userBytes = new TextEncoder().encode(userId);
  const salt = new Uint8Array(userBytes.length + dekSalt.length);
  salt.set(userBytes, 0);
  salt.set(dekSalt, userBytes.length);
  return new Uint8Array(await hkdfAsync('sha256', this.masterKey, salt, HKDF_INFO, DEK_LENGTH_BYTES));
}
```

**Caller-Wiring:** `dek_salt` aus `users`-Row beim Auth-Middleware-Pass ziehen (analog `external_id`) + in `ctx.userDekSalt` ablegen. Alle 7 `resolveUserDek`-Callsites in [storage/objects.ts:149/342/421](src/storage/objects.ts), [storage/uploads.ts:129](src/storage/uploads.ts), [storage/revisions.ts:67](src/storage/revisions.ts), [middleware/idempotency.ts:74/104](src/middleware/idempotency.ts) bekommen das Argument durchgereicht.

### 1.2 Re-Encrypt-Strategie: Big-Bang (single-shot Migration-Script)

**Begründung:** Pilot hat ~0 Daten (1 User, kaum Inhalte). Lazy-pattern (`tryOldHkdf || tryNewHkdf`) wäre fragiler weil im Hot-Path. Subagent-A bestätigt: `dek_salt`-aware-resolveUserDek mit per-request-cache = zero-overhead.

**Script `scripts/migrate-dek-salt.ts`:**
1. ALTER TABLE läuft (Migration 0015) → jeder User-Row hat random `dek_salt`
2. Pro User:
   - Lade alle Objekt-IDs unter `owner_id = userId` (admin-tx, BYPASSRLS)
   - Pro Objekt: decrypt mit OLD-HKDF (salt=userId), re-encrypt mit NEW-HKDF (salt=userId||dek_salt), UPDATE inline OR R2-PUT (gleicher key, atomic-overwrite)
   - Inkludiere: `objects` (body_inline + R2-blob), `object_revisions` (JOIN parent.owner), `uploads WHERE status='finalized'`, `idempotency_records WHERE user_id=u.id`
   - Pro Objekt single tx — kein "Halb-migriert-State" möglich
3. Beim Abschluss: `body_hash`-Vergleich (Soll == Ist) für jede Row, sonst rollback

**Lock-Strategy:** Während Migration läuft → KC2 in Read-Only-Mode (env-flag `READ_ONLY=true` im Boot-Pfad; alle Write-Routes 503). Solo-Pilot = ~30 Sekunden Ausfall, akzeptabel.

### 1.3 Hintertürchen (Subagent-A gefunden)

1. **Idempotency-Records mit re-encrypten** — sonst stale-cache nach Rollout (Logs-Müll, kein Daten-Verlust).
2. **R2-Blobs atomic** — PUT überschreibt selben Key; Crash mid-flight = stale cipher in R2. Mitigation: DB-TX commitet erst NACH erfolgreichem R2-PUT.
3. **`dek_salt`-Read im Hot-Path** — load once in Auth-middleware, stash in `ctx`. NICHT pro DEK-Call SELECT (= +1 DB-RTT pro CRUD-Call).
4. **OpenBao-Pfad unbeeinflusst** — Transit-API hat eigene per-userId-DEKs, kein HKDF. KMS-Provider-Selection muss klären welcher Pfad aktiv ist (heute Cloud-KMS).
5. **Backup-Recovery-Gap** — pre-Migration-Backup nach Migration nicht restore-bar. Mitigation: vor Migration einen "frozen Snapshot" der `users.dek_salt`=NULL-State als separate R2-File (encrypted mit BACKUP_MASTER_KEY) ablegen.
6. **GDPR-Erase + DEK-Tombstone** (future): heute macht `erase-user` hard-DELETE, kein Crypto-Shredding. Mit Salt-Migration **könnten** wir später `dek_salt` overwriten als crypto-shred → alle Bodies un-decryptable selbst wenn Master+Backup-Restore zurückläuft.

### 1.4 Tests

- **Unit:** Verify `same userId + different dek_salt → different DEK → AES-GCM-Tag-Fail bei Cross-Verwendung`.
- **Integration:** seed 2 user-rows mit verschiedenen `dek_salt`. UserA tries readObject(userB-row) → 404 (decrypt-fail aus SEC-K-034) ODER 501 (shared-body-not-impl). Beide Pfade beweisen Cross-User-Isolation auch bei Master-Leak.
- **Migration-Test:** seed mit altem HKDF, run Migration + Re-Encrypt-Script, verify `body_hash` unchanged + read returns identical plaintext.
- **Hot-Path-Perf:** 1000 reads vor/nach Migration, p99-Latenz ≤ +5ms.

### 1.5 Aufwand
- Migration + KMS-Adapter-Update + Caller-Wiring: ~2h
- Re-Encrypt-Script + Tests: ~1.5h
- **Total: ~3.5h**

---

## 2. SEC-K-009 + 016 — Service-Token-Split + HMAC-Erase

### 2.1 Routes-Inventar (Subagent-B)

**KC2 `/v1/internal/*`** (alle hinter SERVICE_TOKEN):

| Route | Klasse | Bisher | Nach Split |
|---|---|---|---|
| `POST /users/sync` | OBO-flow | SERVICE_TOKEN | `SERVICE_TOKEN_OBO` |
| `POST /erase-user` | **ADMIN** | SERVICE_TOKEN + `confirmation_token.length>=16` | `SERVICE_TOKEN_ADMIN` + HMAC-signed `(user_id, nonce, exp)` |
| `POST /health-deep` | observability | SERVICE_TOKEN | `SERVICE_TOKEN_OBO` |
| `/bulk-embed` (Phase 5+) | ADMIN | — | `SERVICE_TOKEN_ADMIN` |

**approval2-eigene `/internal/v1/*`** sind **separater Token** (`MCP_APPROVAL_INTERNAL_TOKEN`) — NICHT betroffen vom Split.

### 2.2 Architektur

**KC2-Side** ([src/types/env.ts](src/types/env.ts) + [src/auth/service_token.ts](src/auth/service_token.ts)):
- `SERVICE_TOKEN_OBO` (≥32 chars) — daily-ops
- `SERVICE_TOKEN_ADMIN` (≥32 chars, eigene Rotation, ggf nur in approval2's Admin-Doppler-Bucket)
- `ERASE_HMAC_KEY` (≥32 bytes) — HMAC-SHA256 über `${user_id}|${nonce(16B)}|${exp(unix-s)}`. Validation: exp ≤ +60s, replay-block via existing `idempotency_records`-Tabelle (Token-Hash als idem_key, 5min TTL).

**approval2-Side** ([packages/adapters/src/knowledge/http-client.ts](https://github.com/axel-rogg/mcp-approval2/blob/main/packages/adapters/src/knowledge/http-client.ts) + [apps/server/src/services/gdpr.ts](https://github.com/axel-rogg/mcp-approval2/blob/main/apps/server/src/services/gdpr.ts)):
- `HttpKnowledgeAdapter.serviceToken` → bleibt für OBO
- `HttpKnowledgeAdapter.adminToken` neu (für eraseUser)
- `makeEraseConfirmation(userId, eraseHmacKey, now)` Helper in gdpr.ts erzeugt den HMAC-Token
- **Cron-Job NEU**: `cron/purge-due-erases.ts` läuft auf existierendem cron-Pfad, ruft `eraseUser(userId, confirmationToken)`

### 2.3 Migration: Coexistence (5 Schritte, Subagent-B-Vorschlag)

1. **T+0 KC2-Code:** beide Env-Vars optional + Fallback `SERVICE_TOKEN_ADMIN || SERVICE_TOKEN` für BC. Wenn `ERASE_HMAC_KEY` gesetzt → HMAC-Validate; wenn nicht → length-only-Check (heutige BC).
2. **T+1 approval2-Code:** `adminToken?:` in `HttpKnowledgeAdapterOptions`, fallback auf `serviceToken`. `gdpr.ts` baut HMAC wenn `ERASE_HMAC_KEY` env-da. Cron-Job (`cron/purge-due-erases.ts`) wired.
3. **T+2 Terraform:** Doppler-Secrets in beiden Projects (`SERVICE_TOKEN_ADMIN`, `ERASE_HMAC_KEY`) als TF-`random_password`. Beide Werte landen via TF-Pipe automatisch in Fly-Secrets.
4. **T+3 Cutover-Deploy:** beide Services gleichzeitig. Smoke: `/internal/users/sync` mit `OBO` ok, mit `ADMIN` 403. `/erase-user` ohne HMAC → 400, mit valid HMAC → 200.
5. **T+7 Hardening:** Fallback in (1) entfernen → `/erase-user` akzeptiert nur noch `SERVICE_TOKEN_ADMIN` + valid HMAC. `SERVICE_TOKEN` env-var rename → `SERVICE_TOKEN_OBO` mit BC-Alias 1 weiterer Release.

### 2.4 Hintertürchen (Subagent-B)
1. Cron-Job für `hardEraseUser` existiert noch nicht (approval2). Heißt: HMAC + Cron werden zusammen gebaut, **keine Live-Migration-Race**.
2. KC2-inbound (`MCP_APPROVAL_INTERNAL_TOKEN` für DEK-resolve) ≠ KC2-outbound (`SERVICE_TOKEN`). Audit nur outbound-Pfad.
3. OBO-Pfad ([on_behalf_of.ts:103](src/auth/on_behalf_of.ts)) compared gegen `SERVICE_TOKEN`. Nach Split muss OBO `SERVICE_TOKEN_OBO` validieren, NICHT Admin-Token.
4. Doppler-Setup ist heute beidseitig identisch (gleicher Wert). Split = 2 neue TF-Resources + alter deprecated.
5. `http-client.test.ts:979` deckt eraseUser-401-Pfad — Test muss admin-token-mismatch-Pfad dazu.

### 2.5 Aufwand
- KC2-Code + Tests: ~1.5h
- approval2-Code + Cron + Tests: ~1.5h
- TF + Doppler-Pipe: ~0.5h
- **Total: ~3.5h**

---

## 3. SEC-K-024 — Embedding-Salt für maskPII

### 3.1 Wichtige Vorabklärung (Subagent-C)

**SEC-K-023 (vec_owner_only RLS) hat den Hauptpfad bereits geschlossen** — Cross-User-Vector-Search ist physisch unmöglich (RLS blockt B's read auf A's Vektoren). Aber SEC-K-024-Risiko **verlagert sich**:

| Restkanal | Risk-Level | Mitigation |
|---|---|---|
| **Cloudflare AI Gateway Cache** | 🟡 sichtbar im CF-Dashboard cross-user-cache-hit-rate | Per-User-Salt invalidiert Cache automatisch |
| **Backup-Stream** (pg_dump enthält `title`/`description` plaintext) | 🟡 wer Backup-Key hat sieht masked-Strings cross-user-gleich | Per-User-Salt + opt-in-encrypted `description` (future) |
| **DSGVO-Audit-Extract** | 🟢 RLS-bound, kein Issue heute | — |

### 3.2 Salt-Design (Subagent-C)

**Wiederverwendung des HKDF-Pfads, NICHT neue Column:**
```ts
embedSalt = HKDF(master, salt=userId, info='embed-salt-v1', length=16)
```
- Reuse existing `master` aus KMS
- Andere `info`-Tag → domain-separation vom DEK
- 16 Bytes als Hex (32 Zeichen) reicht

**Anwendung — Postfix (nicht Prefix!):**
```ts
const masked = maskPII(text);
const embedSource = `${masked} §${embedSaltHex}`;
```
**Begründung:** bge-m3 + Vertex sind Transformer mit Position-Embeddings. Prefix dominiert [CLS]-Pool und überlagert semantischen Inhalt (Retrieval-Qualität sinkt). Postfix verändert L2-Norm minimal aber Vektor-Wert komplett. Sigil `§` als Tokenizer-Boundary.

**Search-Query-Path** ([hybrid.ts:107](src/search/hybrid.ts)): query bekommt denselben Postfix wie der user's embeds. Sonst search-irrelevance.

### 3.3 DE-Regex-Erweiterung (Subagent-C, verifiziert)

```ts
// Order matters — längere/spezifischere zuerst
const DE_TAX_ID_RE = /\b\d{11}\b/g;                                    // [TAXID]
const DE_PERSO_RE  = /\b[A-Z]\d{8}\b/g;                                // [PERSO]
const DE_PLZ_RE    = /\b\d{5}\s+[A-ZÄÖÜ][a-zäöüß-]+\b/g;                // [ADDR]
const DE_PHONE_RE  = /(?:\+49|0049|\b0)[\s\/-]?\(?\d{2,5}\)?[\s\/-]?\d{3,12}/g; // [PHONE]
```
Apply-Order: TAX_ID → PERSO → PLZ → existing (EMAIL/UUID/IBAN/CC) → DE_PHONE → existing PHONE → IP.

### 3.4 Hintertürchen (Subagent-C)
1. **`description` ist plaintext seit Migration 0003** — Backup-Stream sieht alle User-Descriptions cross-user. Salt schützt Vektoren, nicht Klartext selbst. Echtes Multi-User braucht `description` opt-in-encrypted oder Backup-Pipeline mit Per-User-Split (Defer).
2. **`embeddingAdapter()` ist process-global cached** ohne User-Context. Salt-Injection muss EXPLIZIT pro-Call vom Caller mitgegeben werden (`composeEmbedSource(..., salt)` Signatur). Sonst ein vergessener Code-Pfad → un-gesalteter Vektor → Oracle-Restore.
3. **AI-Gateway-Cache-Hit-Rate** sinkt von ~80% → ~0% nach Salt-Rollout. Embed-Calls ×5. `EMBED_QUOTA_PER_DAY` (5000) muss vor Multi-User auf z.B. 20000 hoch, sonst rate-limited der erste aktive User die anderen aus.

### 3.5 Aufwand
- maskPII + DE-Entities + Salt-Wiring: ~1h
- Tests + Suchpfad-Anpassung: ~0.5h
- AI-Gateway Quota-Bump in Doppler/Migration: ~0.25h
- **Total: ~1.75h**

---

## 4. Zusätzliche Findings vom Cross-Cutting-Subagent

### 4.1 MUSS-Items vor Multi-User

1. **Audit-Pseudonymisation-Strip-Liste erweitern** ([routes/internal.ts:85-90](src/routes/internal.ts)) — heute nur `granted_to`, `target_user_id`, `shared_with`. **Fehlt:** `to`, `from_id`, `to_id`, `resource_id`. Sonst sieht User B nach Erase-von-A noch A's Object-IDs in seinen audit-rows (DSGVO-Verstoß).
2. **`hardDeleteByOwner` per signed-approval-receipt gaten** ([routes/internal.ts:57](src/routes/internal.ts)) — heute nur `confirmation_token.length>=16`. JWS aus approval2's signing-key mit `(user_id, approval_id, exp)` analog OBO.
3. **`syncFromApproval2`-displayName sanitisation** ([users/api.ts:308+](src/users/api.ts)) — heute write-through ohne escape. Storage-XSS-Vector wenn KC2 jemals HTML rendert.

### 4.2 SOLLTE-Items (nice-to-have, kein Blocker)

4. **`oauth_clients.created_by_user`** ([oauth_facade/dcr.ts](src/auth/oauth_facade/dcr.ts)) — DCR-Clients sind heute user-agnostisch beim Register.
5. **`finalizeUpload` Plaintext-Window** ([storage/uploads.ts:116-138](src/storage/uploads.ts)) — 10min Window wo plaintext im Bucket sichtbar für Operator. Tenant-vs-Operator-Boundary, nicht User-vs-User.
6. **`revokeShare` ownership-explicit-check** ([storage/shares.ts:94-105](src/storage/shares.ts)) — heute "trust caller" plus RLS-defense. Defense-in-Depth nachziehen.

### 4.3 Test-Coverage-Lücken (vor Activation Pflicht)

`tests/integration/rls.test.ts` deckt nur `objects`. **Fehlt komplett:**
- `object_vectors` (post-0014)
- `audit_log` cross-user (audit_own_select)
- `idempotency_records` cross-user-replay
- `user_quotas` cross-user-leak
- `uploads` per-user
- `object_refs/tags/revisions` post-F-6-tightening
- `share_grants` insert-by-owner-only

**Plus** keine Tests für:
- `syncFromApproval2` external_id-collision, status-state-machine, suspended→active block
- OBO `payload.sub != user.externalId` rejection (SEC-K-001)
- Refresh-token family-revoke (SEC-K-013)
- Embedding-inversion shared-vector leak (SEC-K-023)
- Invite-issue → accept E2E

### 4.4 Aufwand
- 3 MUSS-Items: ~1.5h
- 3 SOLLTE-Items: ~1h (kann auch in Defense-in-Depth-Backlog)
- Test-Coverage-Erweiterung: ~2h

---

## 5. Reihenfolge / Sequenzierung

```
┌──────────────────────────────────────────────────────────────────┐
│ DAY 0 (vorab): User-Hand                                         │
│  → GCP-Console knowledge2-fly.dev redirect raus (today's open)   │
│  → BACKUP_MASTER_KEY rotation falls fällig                       │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│ HOUR 1-3: Phase 1 — Tests-First                                  │
│  → Extend tests/integration/rls.test.ts auf alle 9 Tabellen      │
│  → Test für external_id-collision + state-machine                │
│  → Test für OBO sub-check (SEC-K-001) Multi-Setup                │
│  → Tests laufen alle ROT (geht ok, wir bauen die Fixes danach)   │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│ HOUR 3-6.5: Phase 2 — Code (3 Hauptfindings)                     │
│  → SEC-K-005 dek_salt (3.5h)                                     │
│  → parallel: SEC-K-024 embedding-salt (1.75h)                    │
│  → SEC-K-009/016 token-split (3.5h)                              │
│  Reihenfolge: 005 → 024 → 009/016 (005 stellt Crypto-Foundation, │
│   024 hängt am HKDF-pattern, 009/016 ist orthogonal aber           │
│   abhängig vom DB-Migration-Pfad)                                │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│ HOUR 6.5-8: Phase 3 — MUSS-Items §4.1                            │
│  → Audit-pseudo-strip-Liste                                      │
│  → hardDeleteByOwner JWS-Gate                                    │
│  → syncFromApproval2 displayName sanitise                        │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│ HOUR 8: Phase 4 — Migration-Run                                  │
│  → READ_ONLY=true env flag deployen                              │
│  → Migration 0015 + 0016 (re-encrypt + token-split)              │
│  → scripts/migrate-dek-salt.ts run                               │
│  → body_hash-Verify                                              │
│  → READ_ONLY=false, deploy                                       │
│  → Smoke gegen Solo-State                                        │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│ HOUR 8.5-9: Phase 5 — Activation                                 │
│  → User-Hand: approval2 invitet manuelrogg1@gmail.com            │
│  → manuel logged sich first time → external_id wird gesetzt      │
│  → manuel webauthn-enroll auf seinem device                      │
│  → User-A schreibt notiz, User-B sieht sie NICHT (cross-user-    │
│    smoke), User-B schreibt notiz, User-A sieht sie NICHT         │
│  → opt: User-A teilt notiz mit B via share_grants (UX wenn       │
│    nicht da: SQL direkt)                                         │
│  → Audit-log-Spalten checken: KEINE PII-Spuren von A in B's rows │
└──────────────────────────────────────────────────────────────────┘
```

---

## 6. Rollback-Plan

| Phase | Rollback |
|---|---|
| Phase 1 (Tests) | Nichts deployed — keine Action nötig |
| Phase 2 Code | git revert + redeploy (zwei BC-Phasen via env-flags `SERVICE_TOKEN_ADMIN || SERVICE_TOKEN`-fallback ist Pflicht) |
| Phase 3 MUSS-Items | git revert pro Item — alle isoliert |
| Phase 4 Migration | **Härtester Punkt.** Backup VOR Migration in R2 mit Tag `pre-dek-salt-2026-MM-DD`. Restore-Pfad: `terraform destroy`/recreate DB → `pg_restore` aus diesem Snapshot. Salt-Daten gehen verloren, alte DEKs funktionieren wieder. |
| Phase 5 Activation | manuelrogg-Row löschen, ALLOWED_EMAILS zurück auf single-user |

---

## 7. Open Questions vor Sprint-Start

1. **Re-Encrypt-Script:** läuft das im Codespace per `tsx` oder als Fly-Job (`fly machine exec`)?
2. **READ_ONLY env-flag:** akzeptabel für ~5 min Pilot-Downtime oder brauchen wir Zero-Downtime-Strategie?
3. **manuelrogg-Onboarding:** wann + welcher Browser? Webauthn-Enroll braucht Touch-ID/PIN.
4. **DCR-Client-Visibility:** soll DCR-Clients per-User-tagged werden (created_by) oder weiter user-agnostic bleiben? — Audit-Empfehlung ja, aber kein Blocker.
5. **Share-Body-Encryption** (501-block): heute disabled. Multi-User-Pilot ohne shared-Body ok? Oder Future-Item parallel anpacken?

---

## 8. Referenzen

- Audit-Master: [docs/security/SECURITY_ISSUES.md](../../security/SECURITY_ISSUES.md)
- Subagent-Investigations heute 2026-05-17:
  - SEC-K-005 Deep-Dive (HKDF + KMS-Adapter)
  - SEC-K-009/016 Cross-Repo-Tokens
  - SEC-K-024 Embedding-Privacy
  - Cross-Cutting Backdoor-Sweep
- Migration-Pattern: [drizzle/migrations/0012_users_external_id.sql](../../../drizzle/migrations/0012_users_external_id.sql) (Vorbild für 0015)
- HMAC-Pattern: [src/middleware/idempotency.ts](../../../src/middleware/idempotency.ts) (analog für ERASE-HMAC reuse)
- Approval2-Side-Counterpart: [mcp-approval2/packages/adapters/src/knowledge/http-client.ts](https://github.com/axel-rogg/mcp-approval2/blob/main/packages/adapters/src/knowledge/http-client.ts)
