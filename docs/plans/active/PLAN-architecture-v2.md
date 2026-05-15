# PLAN — mcp-knowledge2 Architektur v2 (Konsolidierte Implementation-Spec)

> **Status: ⚠️ DRAFT — Baseline für Phase 0-6, §1 Auth-Boundary durch AS-3 abgelöst (2026-05-15)**
>
> ⚠️ **AS-3-Hinweis (2026-05-15):** Der hier in §1 + §3.3 (KMS-Variante-B)
> beschriebene Trust-Mechanismus (`JWT signed by mcp-approval2 → JWKS-verify`)
> ist durch die AS-3-Migration ersetzt. Authoritativ ist jetzt:
> - [PLAN-as3-autonomous.md](./PLAN-as3-autonomous.md) für die Auth-Schicht
>   (Google OIDC + Self-Facade + OBO via approval2)
> - [PLAN-as3-bigbang.md](./PLAN-as3-bigbang.md) für die Cross-Repo-Cutover-Reihenfolge
>
> Die übrigen Sektionen dieses Plans (Schema, Embedding, Sharing, RLS,
> Audit, Quota, Threat-Model) bleiben gültig und sind die Baseline für die
> AS-3-Erweiterung.
>
> Erstellt: 2026-05-13. Dieses File ist die **autoritative Implementation-
> Spec** fuer mcp-knowledge2. Es baut auf:
>
> - **DRAFT aus mcp-approval2-Sicht:** [PLAN-architecture-DRAFT-from-mcp-approval2-view.md](./PLAN-architecture-DRAFT-from-mcp-approval2-view.md) —
>   Storage-Service-Anforderungen aus Caller-Perspektive (kompakt, 305
>   Zeilen). Bleibt lokal, NICHT pushen — Input für diese Konsolidierung.
> - **mcp-approval2 v1:** [github.com/axel-rogg/mcp-approval2 PLAN-architecture-v1](https://github.com/axel-rogg/mcp-approval2/blob/main/docs/plans/active/PLAN-architecture-v1.md) —
>   die 22 Decisions aus Decision-Session 2026-05-13. Decisions hier
>   übernommen, NICHT überschrieben.
> - **Externer Detail-Entwurf** (vormals `PLAN-knowledge-platform-v2.md` im
>   alten mcp-knowledge-Repo) — Detail-Sektionen Encryption-Stufen,
>   Embedding-Leak, Deploy-Configs, Threat-Model, Quota-System.
>
> **Architektur-Setup (final, aus mcp-approval2 v1 §0):**
> - Single-Tenant strikt: 1 Firma = 1 Instance. Kein `tenant_id`-Schema.
> - Zwei-Repo-Setup: mcp-approval2 (Auth/Approval/Tools) +
>   **mcp-knowledge2 (THIS REPO: Storage/Sharing/Search)**.
> - Auth-Boundary: JWT signed by mcp-approval2, validated by
>   mcp-knowledge2 via JWKS.
> - Embedding-Provider: Google Vertex AI (EU), `text-embedding-005`, dim=768.
> - Datenbank: Postgres 16+ mit pgvector, Adapter-Schicht.
> - Crypto: AES-GCM + KEK via OpenBao (mcp-approval2-Vault).
> - Vector-Index: `ivfflat lists=100` (v1-Decision, HNSW als Phase-5+-Option).
> - Object-ID: UUID (v1-Decision, gegen ULID-Vorschlag).
> - Timestamps: INTEGER ms (v1-Decision, Postgres-EXTRACT-Konversion bei Bedarf).
>
> ⚠️-Marker bedeuten: offene Sub-Entscheidung, nicht Decision-Überlauf.

---

## 0. Service-Rolle (autoritativ)

mcp-knowledge2 ist der **Storage- und Sharing-Service** im Zwei-Repo-Setup.

| Repo | Verantwortung |
|---|---|
| `mcp-approval2` | Auth, Sessions, Approval-Flow, Tool-Surface, Credential-Vault, OpenBao-Integration |
| **`mcp-knowledge2` (THIS)** | Objects (docs / skills / apps / memos), Sharing-Grants, Hybrid-Search, Vector-Embeddings, Audit-Log fuer Storage-Operations |

**Was mcp-knowledge2 NICHT macht:**
- Auth (vertraut JWT von mcp-approval2)
- Credential-Storage (lebt in mcp-approval2)
- OpenBao-Aufruf direkt (mcp-approval2 unwrappt DEKs vorab, KEINE Cred-Crypto hier)
- Approval-Flow / WYSIWYS / PRF (lebt in mcp-approval2)
- IPI-Output-Filter (mcp-approval2)
- MCP-Protocol-Server (mcp-approval2)
- Tool-Dispatch / Tool-Registry (mcp-approval2)

**Was mcp-knowledge2 SCHON macht:**
- Eigenes Audit-Log (Storage-Operations) mit `request_id` für Cross-Service-Korrelation
- Eigene Postgres-DB (separate Connection-String, separater DB-User)
- Eigenes Blob-Backend (S3-API: R2 / GCS / B2 / MinIO)
- Body-Encryption mit pro-User-DEK (vom Caller mitgeschickt oder von eigenem KMS)
- pgvector-Index (in eigener Postgres-DB)

---

## 1. Service-Boundary mcp-approval2 ↔ mcp-knowledge2

### 1.1 JWT-Pattern

mcp-approval2 signiert pro Storage-Operation einen kurzlebigen JWT,
mcp-knowledge2 validiert via JWKS.

```ts
// JWT-Format (signed by mcp-approval2):
{
  iss: 'mcp-approval2',
  aud: 'mcp-knowledge2',
  sub: '<user-uuid>',                   // owner-identity
  scope: 'docs:write skills:read',      // optional fine-grained (Phase 4+)
  request_id: '<uuid>',                 // für Cross-Service-Audit-Korrelation
  exp: now + 60                         // 60s lifetime, einmalig per Operation
}
```

mcp-knowledge2 Validierungs-Pipeline:

```
1. Bearer-Token aus Authorization-Header extrahieren
2. JWKS abrufen (cached 24h, refresh-on-miss via /.well-known/jwks.json)
3. Signature + iss + aud + exp prüfen
4. claims.sub → app.current_user (RLS-Setting)
5. claims.request_id → Audit-Korrelations-Key
6. SET LOCAL app.current_user = '<sub>' in Postgres-TX
7. SET LOCAL app.request_id = '<request_id>' (für Audit-Trigger)
```

### 1.2 Internal-Endpoints (Service-zu-Service)

Endpoints unter `/v1/internal/*` werden **NICHT** von externen Clients
aufgerufen, nur von mcp-approval2. Auth: zusätzlich zur JWT-Validation
ein **Service-Account-Bearer** im `X-Service-Token`-Header (statischer
Token, rotated via deploy):

```
POST /v1/internal/erase-user        — Cascade-Delete bei GDPR-Erase
POST /v1/internal/health-deep       — DB+R2+Vector-Check für mcp-approval2-Healthcheck
POST /v1/internal/bulk-embed        — Batch-Embedding für Backfill (Cron)
```

⚠️ **Vor Umsetzung prüfen:**
- Service-Account-Bearer-Rotation: monatlich? Bei jedem Deploy? Pattern aus
  mcp-approval2 prüfen wenn der dort sein OpenBao-Pattern ausarbeitet.
- Network-Level-Boundary: Cloud Run Internal Ingress + IAM oder
  Caddy-`@internal`-IP-Allowlist auf Hetzner.

### 1.3 Service-Discovery

Keine — mcp-knowledge2-URL ist eine env-Var (`KNOWLEDGE_BASE_URL`) in
mcp-approval2. Single-Tenant → kein Service-Mesh nötig.

---

## 2. Datenmodell

### 2.1 Schema-Overview

Konsolidiert aus v1 §2 + knowledge-core-Vorlage. Single-Tenant: kein
`tenant_id`-Column. Multi-User-Isolation via `owner_id` + RLS.

```sql
-- Phase 0 init
CREATE EXTENSION IF NOT EXISTS pgcrypto;          -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS vector;            -- pgvector

-- ─── Core: Objects ─────────────────────────────────────────────────────
CREATE TABLE objects (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          UUID NOT NULL,                -- aus JWT sub, KEIN FK (users
                                                  -- table lebt in mcp-approval2)
  kind              TEXT NOT NULL CHECK (kind IN ('doc','skill','app','memo')),
  subtype           TEXT,

  -- Discovery (plaintext; sensitiver Content gehört in body)
  title             TEXT,
  description       TEXT,
  keywords_json     TEXT,                          -- JSON array
  trigger_hints     TEXT,                          -- skills: when-to-use
  meta_json         JSONB,

  -- Body (encrypted ciphertext, AES-GCM)
  body_inline       BYTEA,                         -- <= 16 KB
  blob_key          TEXT,                          -- 'objects/<id>' im Blob-Storage
  body_size         BIGINT NOT NULL,               -- decoded plaintext size
  body_hash         TEXT,                          -- sha256(plaintext)
  mime_type         TEXT,
  filename          TEXT,

  -- Lifecycle
  visibility        TEXT NOT NULL DEFAULT 'private'
                    CHECK (visibility IN ('private','shared')),
  pinned            BOOLEAN NOT NULL DEFAULT false,
  archived          BOOLEAN NOT NULL DEFAULT false,
  archived_at       INTEGER,                       -- Unix-ms (v1-Decision)
  expires_at        INTEGER,
  deleted_at        INTEGER,                       -- soft-delete; hard via /admin
  refcount          INTEGER NOT NULL DEFAULT 0,    -- via object_refs
  current_version   INTEGER NOT NULL DEFAULT 1,    -- via object_revisions

  -- Body-Crypto (AES-GCM)
  nonce             BYTEA NOT NULL,
  key_version       INTEGER NOT NULL DEFAULT 1,

  -- Encrypted Description (separater AEAD-Blob)
  description_enc          BYTEA,
  description_nonce        BYTEA,
  description_key_version  INTEGER,

  -- Quality-Gate (Schema-ready, Phase 5+)
  quality_score              INTEGER,              -- 0-18
  quality_checked_at         INTEGER,
  quality_rubric_version     INTEGER,
  quality_report_enc         BYTEA,
  quality_report_nonce       BYTEA,
  quality_report_key_version INTEGER,

  -- Timestamps (alle INTEGER ms — v1-Decision)
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_used_at      INTEGER,

  CHECK ((body_inline IS NOT NULL) OR (blob_key IS NOT NULL))
);

CREATE INDEX idx_objects_owner_kind   ON objects (owner_id, kind, subtype) WHERE deleted_at IS NULL;
CREATE INDEX idx_objects_updated      ON objects (updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_objects_owner_hash   ON objects (owner_id, kind, body_hash) WHERE body_hash IS NOT NULL;
CREATE INDEX idx_objects_deleted_at   ON objects (deleted_at) WHERE deleted_at IS NOT NULL;

-- ─── Knowledge-Graph: Refs zwischen Objects ────────────────────────────
CREATE TABLE object_refs (
  from_id     UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  to_id       UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,                       -- 'skill_resource', 'app_doc', ...
  meta_json   JSONB,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id, role)
);
CREATE INDEX idx_refs_to   ON object_refs (to_id);
CREATE INDEX idx_refs_role ON object_refs (role);

-- ─── Tags ──────────────────────────────────────────────────────────────
CREATE TABLE object_tags (
  object_id   UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  tag         TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'manual',
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (object_id, tag)
);
CREATE INDEX idx_tags_tag ON object_tags (tag);

-- ─── Revisions ─────────────────────────────────────────────────────────
CREATE TABLE object_revisions (
  object_id   UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  body_inline BYTEA,
  blob_key    TEXT,
  meta_json   JSONB,
  nonce       BYTEA,
  key_version INTEGER,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (object_id, version)
);

-- ─── Sharing-Grants (aus v1 §2) ────────────────────────────────────────
CREATE TABLE share_grants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('doc','skill','app')),
                                                    -- memo NICHT teilbar (v1-Decision)
  resource_id   UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  granted_to    UUID NOT NULL,                     -- empfaenger-user-id
  granted_by    UUID NOT NULL,                     -- muss owner sein (App-Check)
  scope         TEXT NOT NULL CHECK (scope IN ('read','write')),
  granted_at    INTEGER NOT NULL,
  expires_at    INTEGER,
  revoked_at    INTEGER                            -- soft-revoke (Audit erhalten)
);

CREATE INDEX idx_grants_lookup
  ON share_grants (granted_to, revoked_at)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_grants_resource
  ON share_grants (resource_id, revoked_at)
  WHERE revoked_at IS NULL;

-- ─── Vector-Storage (pgvector, dim=768 für Vertex text-embedding-005) ──
CREATE TABLE object_vectors (
  object_id   UUID PRIMARY KEY REFERENCES objects(id) ON DELETE CASCADE,
  embedding   vector(768),
  model       TEXT NOT NULL,                       -- 'text-embedding-005'
  embedded_at INTEGER NOT NULL
);

CREATE INDEX idx_objects_vec
  ON object_vectors
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- ─── FTS-Spalte (Generated, GIN-Index) ─────────────────────────────────
-- Phase-1-Erweiterung: tsvector pro objects-Row + GIN. NICHT in initial init
-- damit Re-Encrypt-Migrations einfacher.
ALTER TABLE objects ADD COLUMN search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(description, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(trigger_hints, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(keywords_json, '')), 'D')
  ) STORED;
CREATE INDEX idx_objects_tsv ON objects USING GIN (search_tsv);

-- ─── Audit-Log (mcp-knowledge2-eigen) ──────────────────────────────────
CREATE TABLE audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts            INTEGER NOT NULL,
  actor_user_id UUID NOT NULL,                     -- aus JWT sub
  action        TEXT NOT NULL,                     -- 'object.read'|'object.create'|'share.grant'|...
  resource_kind TEXT,
  resource_id   UUID,
  request_id    UUID,                              -- Cross-Service-Korrelation
  result        TEXT NOT NULL,                     -- 'success'|'denied'|'error'
  details       JSONB
);

CREATE INDEX idx_audit_actor_ts    ON audit_log (actor_user_id, ts DESC);
CREATE INDEX idx_audit_action_ts   ON audit_log (action, ts DESC);
CREATE INDEX idx_audit_request_id  ON audit_log (request_id);

-- Append-only enforcen: App-User hat nur INSERT
REVOKE UPDATE, DELETE ON audit_log FROM knowledge_app;

-- ─── Idempotency-Records (Pattern D aus knowledge-core) ────────────────
CREATE TABLE idempotency_records (
  user_id         UUID NOT NULL,
  idem_key        TEXT NOT NULL,
  response_body   BYTEA,
  response_status INTEGER,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, idem_key)
);
CREATE INDEX idx_idem_expires ON idempotency_records (expires_at);

-- ─── Uploads-Lifecycle (presigned-upload-Pattern) ──────────────────────
CREATE TABLE uploads (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       UUID NOT NULL,
  status         TEXT NOT NULL                     -- 'pending'|'finalized'|'expired'|'hard_deleted'
                 CHECK (status IN ('pending','finalized','expired','hard_deleted')),
  blob_key       TEXT NOT NULL,
  body_size      BIGINT,
  body_hash      TEXT,
  meta_json      JSONB,
  created_at     INTEGER NOT NULL,
  finalized_at   INTEGER,
  expires_at     INTEGER NOT NULL
);
```

### 2.2 RLS-Policies

```sql
ALTER TABLE objects             ENABLE ROW LEVEL SECURITY;
ALTER TABLE object_refs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE object_tags         ENABLE ROW LEVEL SECURITY;
ALTER TABLE object_revisions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE share_grants        ENABLE ROW LEVEL SECURITY;
ALTER TABLE object_vectors      ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log           ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE uploads             ENABLE ROW LEVEL SECURITY;

-- Objects: Owner ODER via share_grants
CREATE POLICY owner_or_shared_read ON objects FOR SELECT
  USING (
    owner_id = current_setting('app.current_user')::uuid
    OR id IN (
      SELECT resource_id FROM share_grants
      WHERE granted_to = current_setting('app.current_user')::uuid
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > extract(epoch from now())*1000)
    )
  );

-- UPDATE/DELETE: nur Owner ODER share_grants mit scope='write'
CREATE POLICY owner_or_writer_modify ON objects FOR UPDATE
  USING (
    owner_id = current_setting('app.current_user')::uuid
    OR id IN (
      SELECT resource_id FROM share_grants
      WHERE granted_to = current_setting('app.current_user')::uuid
        AND revoked_at IS NULL
        AND scope = 'write'
        AND (expires_at IS NULL OR expires_at > extract(epoch from now())*1000)
    )
  );

CREATE POLICY owner_only_delete ON objects FOR DELETE
  USING (owner_id = current_setting('app.current_user')::uuid);

-- Refs / Tags / Revisions: sichtbar wenn Parent-Object sichtbar (delegate)
CREATE POLICY refs_via_object ON object_refs
  USING (EXISTS (SELECT 1 FROM objects WHERE objects.id = object_refs.from_id));

CREATE POLICY tags_via_object ON object_tags
  USING (EXISTS (SELECT 1 FROM objects WHERE objects.id = object_tags.object_id));

CREATE POLICY revs_via_object ON object_revisions
  USING (EXISTS (SELECT 1 FROM objects WHERE objects.id = object_revisions.object_id));

-- Vectors: analog
CREATE POLICY vec_via_object ON object_vectors
  USING (EXISTS (SELECT 1 FROM objects WHERE objects.id = object_vectors.object_id));

-- Share-Grants: sichtbar wenn Empfänger ODER Granter
CREATE POLICY grants_self ON share_grants
  USING (
    granted_to = current_setting('app.current_user')::uuid
    OR granted_by = current_setting('app.current_user')::uuid
  );

-- Audit: eigene Events lesbar (admin via separate Route, BYPASSRLS)
CREATE POLICY audit_own ON audit_log FOR SELECT
  USING (actor_user_id = current_setting('app.current_user')::uuid);

-- Idempotency / Uploads: per-User-Scope
CREATE POLICY idem_own ON idempotency_records
  USING (user_id = current_setting('app.current_user')::uuid);

CREATE POLICY uploads_own ON uploads
  USING (owner_id = current_setting('app.current_user')::uuid);
```

**App-Role** (kein BYPASSRLS):

```sql
CREATE ROLE knowledge_app WITH LOGIN PASSWORD '<secret>';
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO knowledge_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO knowledge_app;
REVOKE UPDATE, DELETE ON audit_log FROM knowledge_app;        -- audit append-only
```

**Admin-Role** (BYPASSRLS, separater DB-User, nur fuer
`/v1/internal/erase-user` + Audit-Reports):

```sql
CREATE ROLE knowledge_admin WITH LOGIN PASSWORD '<secret>' BYPASSRLS;
GRANT SELECT, DELETE ON ALL TABLES IN SCHEMA public TO knowledge_admin;
```

### 2.3 Connection-Pool-Setup

Pro Request startet die App eine **Transaction**, setzt zwei `SET LOCAL`-
Settings, führt Queries aus, committed:

```ts
await pool.transaction(async (tx) => {
  await tx.execute(`SET LOCAL app.current_user = '${userId}'`);
  await tx.execute(`SET LOCAL app.request_id  = '${requestId}'`);
  return await handler(tx);
});
```

`SET LOCAL` ist transaction-scoped — leakt nicht zur nächsten Connection
nach Release. `pg`-Pool default: connection-reset on release.

⚠️ **Vor Umsetzung prüfen:**
- HNSW als Phase-5+-Migration vorgesehen: `ivfflat lists=100` reicht für
  Pilot-Volumen (≤ 100k Vektoren). Ab dort spürbarer Recall-Vorteil von
  HNSW. Migration via `DROP INDEX + CREATE INDEX ... USING hnsw`.
- INTEGER-ms für Timestamps: v1-Decision. Postgres-native Date-Funktionen
  brauchen `to_timestamp(ts/1000)`-Wrap. Bewusster Trade-Off für JSON-
  Wire-Format-Konsistenz mit knowledge-core-Legacy.
- `object_vectors` separate Tabelle (statt embedding-Column inline):
  v1-Decision, ermöglicht später Multi-Model-Embedding (z.B. zweite
  Vektor-Spalte für anderes Modell parallel).

---

## 3. Encryption-Modell (ehrliche Trade-Offs)

### 3.1 Was Encryption realistisch schützt

Encryption in mcp-knowledge2 ist **kein Schutz gegen den Operator** und
nicht gegen RCE auf der laufenden App — Klartext liegt zur Request-Zeit
im RAM. Encryption schützt gegen **Cold-Reads**: Backup-Diebstahl,
S3-Provider-Insider, Disk-Diebstahl, fehlkonfigurierter Bucket-Public-Read.

| Bedrohung | Schutz durch At-Rest-Encryption |
|---|---|
| Backup-Tape geklaut | ✅ |
| DB-Dump leaked | ✅ |
| S3-Provider-Insider liest Bucket ohne App | ✅ |
| Stolen Disk aus Hetzner-VPS | ✅ |
| **Operator-Bypass** (DB-Admin direkt) | ❌ — OpenBao-Audit zeigt's |
| **Memory-Compromise** (RCE) | ❌ — Klartext im RAM |
| **Embedding-Inversion-Attack** | ❌ — siehe §3.4 |
| **Search-Query-Logging** | ❌ — Pflicht no-log-policy |

Dokumentiert im `docs/SECURITY.md` damit nicht jemand „verschlüsselt" =
„Operator-Zero-Knowledge" missversteht.

### 3.2 KEK-Provider: OpenBao (Transit-Engine)

Crypto-Setup übernommen aus mcp-approval2 §5.2. mcp-knowledge2 **selbst
hat keinen OpenBao-Zugang** — DEK-Unwrap macht mcp-approval2 vor dem
Storage-Call und schickt das **rohe DEK** im JWT-Body-Encrypted-Header
mit (oder mcp-knowledge2 holt DEK über Internal-API). Variante steht
in §3.3.

**Pro-User-Transit-Key in OpenBao:** `transit/keys/user-<user_id>`.
Crypto-Shredding bei User-Delete via `vault.destroyKey('transit/keys/user-<id>')` —
alle wrapped_deks für diesen User werden unrecoverable.

### 3.3 DEK-Übergabe — drei Varianten zur Wahl

⚠️ **Architektur-Entscheidung offen**, drei Varianten:

| Variante | DEK-Übergabe | Komplexität | Operator-Bypass-Resistant |
|---|---|---|---|
| **A) DEK im JWT** | mcp-approval2 unwrappt DEK aus OpenBao, packt es base64-encrypted in `claims.dek` | Niedrig — ein Round-Trip | Mid: mcp-knowledge2 sieht DEK, Audit-Log zeigt's |
| **B) DEK via Internal-API** | mcp-knowledge2 callt `POST mcp-approval2/internal/dek-resolve` mit user_id + object_id | Mid — zwei Round-Trips, aber DEK kann gecached werden (request-scoped) | Mid: zentrales DEK-Logging |
| **C) Pro-Object DEK in OpenBao** | Object hat `wrapped_dek` Spalte; mcp-knowledge2 ruft OpenBao direkt | Hoch — mcp-knowledge2 braucht Vault-AppRole | High: Vault sieht alle Decrypts pro Object |

**Empfehlung:** **Variante B** (Internal-API). Trade-Off-Argumente:
- A leakt DEK im JWT-Audit-Log (selbst encrypted: mcp-knowledge2 hat den
  JWT-Body in seinem Audit, also den DEK)
- C verteilt OpenBao-Auth auf zwei Services → erhöht Operator-Surface
- B konzentriert Crypto in mcp-approval2 (OpenBao-Audit ist Single-
  Source-of-Truth), mcp-knowledge2 hat DEK nur kurzfristig im Memory,
  request-scoped, niemals persisted

### 3.4 Embeddings als Leak-Surface (oft übersehen)

**Embedding-Inversion-Attacks** (Morris et al. 2023; Song & Raghunathan
IEEE S&P 2020): dichte Vektor-Embeddings ab ~768 dim können mit
Inversion-LLM teilweise auf den Original-Text rückgeführt werden. Wer
DB-Read auf `object_vectors.embedding` hat, hat einen **partiellen
Klartext-Leak** — auch bei verschlüsselten bodies.

| Mitigation | Effekt | Trade-Off |
|---|---|---|
| Embeddings verschlüsseln | hoch | bricht Vector-Search; HE/FE nicht prod-ready |
| **PII-Masking VOR Embed-Generierung** | mid | knowledge-core-Pattern (`maskPII`) — übernehmen + verschärfen |
| RLS auf object_vectors-Tabelle | low (gegen Cross-User) | reduziert Surface |
| Im DPA / SECURITY.md transparent dokumentieren | — | Restrisiko explizit benannt |

**v2-Pflicht:** PII-Masking vor Embedding-Call. `maskPII(text)` als
pure-TS-Function aus knowledge-core 1:1 portiert in
`packages/lib/src/pii/mask.ts`. Threat-Model in `docs/SECURITY.md`
listet Embedding-Inversion als bewusst akzeptiertes Restrisiko.

### 3.5 AAD-Pattern

```
AAD = '<recordType>|<owner_id>|<object_id>|<kind>:<subtype>'

recordType:
  - 'objects'              — body
  - 'objects-desc'         — description_enc
  - 'objects-quality'      — quality_report_enc
  - 'object-revisions'     — revision-bodies
```

Cross-Object-Replay blockiert (owner_id + object_id im AAD).
Cross-User-Replay blockiert (owner_id im AAD). **Owner-Transfer**
(Phase 5+) erfordert Re-Encrypt, weil owner_id im AAD ist.

### 3.6 Key-Rotation

Pro Object: `key_version` INTEGER. Bei Master-Rotation in mcp-approval2:
- pg-boss-Job `reencrypt-objects` läuft batch-weise
- Pro Batch: alte DEK unwrap, neu wrap, `key_version++`
- Schema-vorbereitet, Operations-Workflow Phase 5+

---

## 4. Blob-Storage (S3-Interface)

### 4.1 Interface

```typescript
// packages/adapters/blob/interface.ts
export interface BlobStore {
  put(key: string, body: Uint8Array, opts?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  presignPut(key: string, opts: { expiresInSeconds: number }): Promise<string>;
  presignGet(key: string, opts: { expiresInSeconds: number }): Promise<string>;
}
```

Implementation via `@aws-sdk/client-s3` v3. Funktioniert mit:

- **AWS S3** (native)
- **Cloudflare R2** (`endpoint=https://<acc>.r2.cloudflarestorage.com`)
- **Backblaze B2** (`endpoint=https://s3.<region>.backblazeb2.com`)
- **Google Cloud Storage** (Interop-Mode mit HMAC-Keys)
- **MinIO** (Self-Host: `endpoint=http://minio:9000`)

### 4.2 Key-Schema

```
objects/<uuid>            — Object-Body (encrypted)
objects/<uuid>@v<n>       — Object-Revision-Body (encrypted)
backup/<ts>.dump.enc      — pg_dump-Backups, encrypted mit separatem
                            Backup-Key (nicht der OpenBao-DEK, eigener
                            Backup-Master)
```

Single-Tenant → kein per-Tenant-Prefix nötig. Per-User-Bulk-Delete bei
GDPR-Erase via App-Loop (S3-API hat kein „delete by prefix"-Server-Side,
also list+delete im Loop).

### 4.3 Bucket-Policy

Bucket ist **nicht public**. Presigned-URLs (TTL ≤ 1h) sind die einzige
Lese-Form von außen. Direct-Access nur via App + JWT.

---

## 5. Hybrid-Search (FTS + Vector)

### 5.1 RRF-Fusion (aus knowledge-core)

```typescript
// POST /v1/search
// Body: { query: string, kind?: string, limit?: number }

async function hybridSearch(query: string, opts: SearchOpts) {
  // Parallel: FTS + Vector
  const [ftsHits, vecHits] = await Promise.all([
    ftsSearch(query, opts),                          // tsvector + ts_rank
    vectorSearch(query, opts),                       // pgvector cosine via Vertex
  ]);

  // RRF k=60
  return rrfFuse(ftsHits, vecHits, { k: 60 }).slice(0, opts.limit ?? 10);
}
```

### 5.2 FTS-Query

```sql
SELECT id, kind, subtype, title,
       ts_rank_cd(search_tsv, websearch_to_tsquery($1)) AS score
FROM objects
WHERE search_tsv @@ websearch_to_tsquery($1)
  AND deleted_at IS NULL
  AND archived = false
  AND ($2::text IS NULL OR kind = $2)
-- RLS-Policy filtert automatisch auf Owner-or-Shared
ORDER BY score DESC
LIMIT $3;
```

`websearch_to_tsquery` erlaubt google-style queries (`"phrase"`, `or`,
`-not`). `'simple'`-Config — kein Stemming (bewusst für mehrsprachige
Daten).

### 5.3 Vector-Query

```sql
SELECT o.id, o.kind, o.subtype, o.title,
       1 - (v.embedding <=> $1::vector) AS score
FROM object_vectors v
JOIN objects o ON o.id = v.object_id
WHERE o.deleted_at IS NULL
  AND o.archived = false
  AND ($2::text IS NULL OR o.kind = $2)
-- RLS filtert via JOIN auf objects
ORDER BY v.embedding <=> $1::vector
LIMIT $3;
```

Cosine-Distance (`<=>`) ist Default für `text-embedding-005`.

### 5.4 Search-Privacy

**Query-Text wird an Vertex AI geschickt** (zum Embedding-Berechnen) —
Drittland-Datenexport (US-Edge auch wenn Vertex EU-Region, weil Google
Quanten-Routing). DPA-Hinweis Pflicht.

**Application-Logging:** Search-Queries werden NICHT geloggt (auch nicht
gehashed). Nur `search_count{kind}` als Counter-Metric. Sensitive
Begriffe sollen nicht in Logs landen.

⚠️ **Vor Umsetzung prüfen:**
- Embedding-Cache: ein und derselbe Query mehrfach kostet
  Vertex-API-Calls. Cache mit Hash-Key (`sha256(query)`) + TTL 1h in
  Postgres-`embedding_cache`-Tabelle? Trade-Off: Cache leakt
  Query-Pattern. **Vorschlag:** nein, kein Cache; Vertex-Quota reicht.
- `websearch_to_tsquery` ist tolerant aber kann komische Queries
  generieren. Empty-query-Schutz via App-Layer-Check.

---

## 6. Embedding-Provider: Google Vertex AI (EU)

### 6.1 Konfiguration

- **Region:** `europe-west4` (Niederlande) ODER `europe-west3` (Frankfurt) —
  je nach Service-Availability für `text-embedding-005`
- **Model:** `text-embedding-005` (dim=768)
- **Auth:** Service-Account-JSON (Self-Host) ODER Workload-Identity
  (Cloud Run / GKE)
- **Rate-Limit:** Vertex Default 600 RPM / 30k TPM — Phase-1-OK

### 6.2 AdapterImpl

```ts
// packages/adapters/embed/vertex.ts
export class VertexAiEmbedder implements EmbeddingAdapter {
  model = 'text-embedding-005';
  dimensions = 768;

  async embed(texts: string[]): Promise<Float32Array[]> {
    // POST /v1/projects/{p}/locations/{r}/publishers/google/models/text-embedding-005:predict
    const masked = texts.map(maskPII);              // PII-Masking PFLICHT (§3.4)
    const resp = await this.client.predict({
      endpoint: this.endpoint,
      instances: masked.map((t) => ({ content: t, task_type: 'RETRIEVAL_DOCUMENT' })),
    });
    return resp.predictions.map((p) => new Float32Array(p.embeddings.values));
  }
}
```

⚠️ **Vor Umsetzung prüfen:**
- `task_type`: `RETRIEVAL_DOCUMENT` für gespeicherte Embeddings,
  `RETRIEVAL_QUERY` für Search-Queries. Asymmetric — verbessert Recall.
- Service-Account-JSON-Storage: liegt in mcp-approval2 als `credentials`-
  Row (Vault-encrypted, owner-only). mcp-knowledge2 holt JIT via Internal-
  API `POST mcp-approval2/internal/v1/credentials/resolve`. **Bootstrap-
  Sonderfall:** Vertex-Service-Account ist „Founder-Credential", muss
  initial via env-Var konfiguriert werden.

### 6.3 Cost-Controls

- Token-Counting pre-call (Embeddings sind input-only)
- Pro User Tages-USD-Budget (Default $5/Tag — siehe Quota-System §11)
- Pre-call-Check gegen `user_quotas.embed_calls_used_today` + 429 wenn
  exhausted

---

## 7. HTTP-API

### 7.1 Endpoints (REST, OpenAPI-validiert)

```
Public (JWT-Auth):
  GET    /v1/objects                 — list (owner + shared)
  POST   /v1/objects                 — create
  GET    /v1/objects/{id}            — read (?expand=refs,tags,body)
  PATCH  /v1/objects/{id}            — update (owner OR shared-with-write)
  DELETE /v1/objects/{id}            — soft-delete (owner-only)
  POST   /v1/objects/{id}/restore    — undelete

  POST   /v1/objects/{id}/refs       — add ref
  DELETE /v1/objects/{id}/refs       — remove ref
  GET    /v1/objects/{id}/usages     — incoming + outgoing refs

  POST   /v1/objects/{id}/tags       — add tag
  DELETE /v1/objects/{id}/tags       — remove tag

  POST   /v1/objects/{id}/shares     — share with user
  GET    /v1/objects/{id}/shares     — list shares (owner only)
  DELETE /v1/shares/{share_id}       — revoke (owner only)
  GET    /v1/shared-with-me          — list shared-incoming

  POST   /v1/search                  — hybrid FTS + vector

  POST   /v1/uploads/init            — presigned upload init
  PUT    /v1/uploads/{id}?sig=...    — HMAC-auth, no JWT
  GET    /v1/uploads/{id}/status     — lifecycle probe

Health/Meta:
  GET    /health                     — liveness
  GET    /health/ready               — readiness (DB+Blob+JWKS)
  GET    /metrics                    — Prometheus
  GET    /version                    — build-info

Internal (Service-Account-Bearer + JWT):
  POST   /v1/internal/erase-user     — GDPR-Erase-Cascade
  POST   /v1/internal/bulk-embed     — Cron-Backfill
  POST   /v1/internal/health-deep    — deep health for mcp-approval2
```

### 7.2 OpenAPI

`docs/openapi.yaml` als kanonische Spec. Validation via
`@hono/zod-openapi` an Request-Boundary. Generated Client-SDK Phase 5+.

### 7.3 Permission-Matrix

| Endpoint | Owner | Shared-Read | Shared-Write | Admin |
|---|---|---|---|---|
| GET /v1/objects/{id} | ✅ | ✅ | ✅ | — |
| PATCH /v1/objects/{id} | ✅ | ❌ | ✅ | — |
| DELETE /v1/objects/{id} | ✅ | ❌ | ❌ | — |
| POST shares/revoke | ✅ | ❌ | ❌ | — |
| GET /v1/shared-with-me | self | self | self | — |
| /v1/internal/* | — | — | — | service-account |

Admin macht **keinen** direkten Storage-Zugriff (v1-Decision: kein
Impersonation). Admin nutzt mcp-approval2-Routes für User-Verwaltung +
Audit-View; mcp-knowledge2 ist Admin-View nur via `/v1/internal/*`-
Endpoints (export, erase).

---

## 8. GDPR-Erase-Cascade

### 8.1 Trigger

mcp-approval2 löscht einen User (siehe mcp-approval2 §5.5). Vor dem
finalen Vault-Key-Destroy callt mcp-approval2:

```
POST /v1/internal/erase-user
Authorization: Bearer <service-account-token>
X-Service-Token: <static-token>
Body: { user_id: '<uuid>', confirmation_token: '<one-time-token>' }
```

### 8.2 Cascade-Pfad

```
1. Verify confirmation_token (one-time, expires 5 min)
2. Begin Transaction:
   a. SELECT id, blob_key FROM objects WHERE owner_id = $1
      → Liste für Blob-Cleanup
   b. DELETE FROM objects WHERE owner_id = $1
      → cascade via FK auf object_refs, object_tags, object_revisions,
        object_vectors
   c. DELETE FROM share_grants WHERE granted_to = $1 OR granted_by = $1
   d. DELETE FROM idempotency_records WHERE user_id = $1
   e. DELETE FROM uploads WHERE owner_id = $1
   f. Audit-Log: 'user.erased' { actor_user_id: system, target: $1,
                                  rows_deleted: <count> }
3. Commit Transaction
4. Blob-Cleanup (async, pg-boss):
   - DELETE jeden blob_key aus Schritt 2a aus S3
   - Audit pro Blob-Delete

5. Returns { status: 'ok', deleted_rows: N, blobs_queued: M }
```

### 8.3 EDPB-Konformitaet

- Crypto-Shredding macht mcp-approval2 (Vault-Key-Destroy) — ALLE
  wrapped_deks für den User werden unrecoverable
- mcp-knowledge2 löscht zusätzlich die Ciphertexte
- Audit-Log behält die User-ID NICHT — wird pseudonymisiert
  (`user_id`-Column im Audit bleibt UUID, aber kein FK auf
  jetzt-nicht-mehr-existierende User-Identity in mcp-approval2)

⚠️ **Vor Umsetzung prüfen:**
- 30-Tage-Karenz: macht mcp-approval2 (markiert User als 'deleted',
  Hard-Delete-Cron nach 30 Tagen). mcp-knowledge2 wird erst beim
  Hard-Delete called.
- Falls User-Owner-Objekte mit anderen geteilt sind: Decision §6.5
  Account-Deletion-Kaskade (siehe externer Detail-Entwurf §6.5
  ⚠️-Block). **Vorschlag:** Anonymize-Owner-Pattern: vor Delete
  Objects an einen `system-owner` übergeben + im UI als „von einem
  ehemaligen User geteilt" anzeigen. Phase 5+ Operations.

---

## 9. Operations

### 9.1 Cron-Jobs (pg-boss)

```typescript
// src/crons/runner.ts
await boss.schedule('uploads.sweep_expired',    '*/30 * * * *');
await boss.schedule('uploads.purge_expired',    '0 * * * *');
await boss.schedule('idempotency.gc',           '0 * * * *');
await boss.schedule('audit.archive_old',        '0 2 * * *');         // > 90 Tage → cold storage
await boss.schedule('backup.daily',             '0 3 * * *');
await boss.schedule('backup.weekly',            '0 4 * * SUN');
await boss.schedule('reencrypt.batch',          '0 5 * * *');         // Phase 5+
await boss.schedule('blobs.cleanup_orphans',    '0 6 * * SUN');       // wöchentlich
```

pg-boss handled Multi-Replica via `SELECT ... FOR UPDATE SKIP LOCKED`.

### 9.2 Backup-Strategie

- **`pg_dump --format=custom` täglich** via pg-boss-Cron, encrypted mit
  separatem Backup-Master-Key (`BACKUP_MASTER_KEY` env, separate von DEK-
  KEK), upload zu S3 unter `backup/<ts>.dump.enc`
- **Retention:** 30 Tages-Backups + 12 Monats-Backups
- **Hetzner-VPS:** zusätzlich Hetzner-Snapshot wöchentlich
- **S3-Versioning** auf Blob-Bucket aktivieren (30 Tage Retention)
- **Restore-Dry-Run** monatlich via `scripts/restore-dry-run.sh` (analog
  knowledge-core)

**RPO/RTO:**
- **RPO** (Recovery Point Objective): 24h (Tages-Backup-Frequenz)
- **RTO** (Recovery Time Objective): 4h (pg_restore + Blob-Re-Sync auf
  CX22-Klasse-Hardware)

Per-User-Restore ist **nicht trivial** (monolithischer pg_dump). Workflow:
1. Full-Restore in Side-DB
2. SELECT betroffener User
3. Cross-Insert in Production-DB nach Schema-Konflikt-Check
4. Manueller Ops-Vorgang, nicht automatisiert

### 9.3 Monitoring

- `/health` — Liveness (200 wenn App lebt)
- `/health/ready` — Readiness (DB-Connect + Blob-PUT-Test + JWKS-Cache
  valid)
- `/metrics` — Prometheus-Format via `prom-client`:
  - `http_requests_total{method, path, status, user_id_hash}`
  - `http_request_duration_seconds`
  - `db_pool_size`, `db_pool_idle`, `db_pool_waiting`
  - `vertex_embedding_calls{result}`, `vertex_embedding_tokens`
  - `audit_events_total{action, result}`

### 9.4 Logs

`pino` mit JSON-Output. Pro Request:

```json
{
  "level": "info",
  "ts": 1747158234000,
  "request_id": "<uuid>",
  "user_id": "<uuid>",
  "path": "/v1/objects",
  "method": "POST",
  "status": 200,
  "duration_ms": 124
}
```

**Niemals loggen:** Authorization-Header, Body-Content, Search-Queries,
Embeddings.

---

## 10. Deploy-Targets

### 10.1 Hetzner-VPS (Primary für Pilot)

CX22 (€6/Monat, 2 vCPU, 4 GB RAM, 40 GB SSD, 20 TB Traffic) ist
Sweet-Spot. CX11 (€5) reicht für 5 User Pilot; CX22 ab 10 User oder
Embedding-Backfill-Last.

`docker-compose.yml` Auszug:

```yaml
services:
  app:
    image: ghcr.io/axel-rogg/mcp-knowledge2:latest
    environment:
      DATABASE_URL: postgres://knowledge_app:${DB_PASSWORD}@postgres:5432/knowledge
      BLOB_ENDPOINT: ${BLOB_ENDPOINT}     # MinIO oder externes B2/R2
      BLOB_ACCESS_KEY: ${BLOB_ACCESS_KEY}
      BLOB_SECRET_KEY: ${BLOB_SECRET_KEY}
      BLOB_BUCKET: knowledge
      JWKS_URL: https://approval.firma.com/.well-known/jwks.json
      JWT_ISSUER: mcp-approval2
      JWT_AUDIENCE: mcp-knowledge2
      VERTEX_PROJECT: ${VERTEX_PROJECT}
      VERTEX_LOCATION: europe-west4
      VERTEX_SERVICE_ACCOUNT_JSON_PATH: /etc/vertex-sa.json
      MCP_APPROVAL_INTERNAL_URL: https://approval.firma.com/internal
      MCP_APPROVAL_SERVICE_TOKEN: ${SERVICE_TOKEN}
    secrets: [vertex_sa]
    depends_on:
      postgres: { condition: service_healthy }
    restart: unless-stopped

  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: knowledge
    volumes: [pg_data:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
    restart: unless-stopped

  minio:                  # nur wenn Self-Hosted-Blob, sonst externes B2/R2
    image: minio/minio
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
    volumes: [minio_data:/data]
    restart: unless-stopped

  caddy:
    image: caddy:2-alpine
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data

secrets:
  vertex_sa:
    file: ./secrets/vertex-sa.json

volumes:
  pg_data:
  minio_data:
  caddy_data:
```

### 10.2 Cloud Run + Cloud SQL (Phase 5+)

Für Produktiv-Skalierung. Cloud SQL Postgres 16 + pgvector, Cloud Run
Container, GCS für Blobs (S3-Interop), Vertex AI nativ. Cloud-SQL-
Auth-Proxy als Sidecar.

`deployments/cloud-run/service.yaml`:

```yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: mcp-knowledge2
spec:
  template:
    metadata:
      annotations:
        run.googleapis.com/cloudsql-instances: project:europe-west4:knowledge
        autoscaling.knative.dev/minScale: "1"     # min=1 statt 0 wegen Cold-Start
        autoscaling.knative.dev/maxScale: "10"
    spec:
      serviceAccountName: knowledge@project.iam
      containers:
        - image: europe-docker.pkg.dev/project/mcp-knowledge2:latest
          env:
            - name: DATABASE_URL
              value: "postgres:///knowledge?host=/cloudsql/project:europe-west4:knowledge"
```

**Cost Cloud-Run-Variante:** ~€30-80/Monat (Cloud SQL db-custom-2-7680
für 10-User-Pilot). Hetzner ist 6-10× billiger für gleichen Use-Case.

### 10.3 Fly.io (Privat-Testbed, optional)

App auf Fly, Postgres bei Neon (3GB free), Blob bei B2 (10GB free).
Vertex-AI-Endpoint braucht trotzdem GCP-Account. Cost: $0-5/Monat
Privat-Volumen.

### 10.4 Lokal-Dev

`docker-compose.dev.yml`: Postgres + MinIO + Mock-JWKS-Server. Vertex
durch ein lokales Embedding-Mock ersetzen (deterministische Pseudo-
Embeddings basierend auf Text-Hash) oder Echt-Vertex-Calls mit
Dev-Service-Account.

```bash
scripts/dev.sh                # docker-compose up + tsx watch
```

---

## 11. Quota-System (pro User)

Aus externem Detail-Entwurf §22 Subagent-Review (war Lücke).

### 11.1 Schema

```sql
CREATE TABLE user_quotas (
  user_id              UUID PRIMARY KEY,
  object_count_max     INTEGER NOT NULL DEFAULT 10000,
  storage_bytes_max    BIGINT  NOT NULL DEFAULT 5368709120,    -- 5 GB
  embed_calls_per_day  INTEGER NOT NULL DEFAULT 1000,
  search_qps_burst     INTEGER NOT NULL DEFAULT 30,

  -- Counters (reset via Cron)
  object_count_used    INTEGER NOT NULL DEFAULT 0,
  storage_bytes_used   BIGINT  NOT NULL DEFAULT 0,
  embed_calls_today    INTEGER NOT NULL DEFAULT 0,
  embed_calls_resetat  INTEGER NOT NULL,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE POLICY quota_own ON user_quotas
  USING (user_id = current_setting('app.current_user')::uuid);
```

### 11.2 Enforcement

- **Pre-Insert-Check** in Application: `if (quota.object_count_used >=
  quota.object_count_max) → 429 Quota Exceeded`
- **Per-Hour Cron** resetet `embed_calls_today` wenn `now > resetat`
- **Admin via mcp-approval2** kann Quotas hochsetzen (BYPASSRLS-Route)

Default-Werte Pilot: 10k Objects / 5 GB / 1000 Embed-Calls/Tag / 30 RPS
Burst. Anpassbar pro User.

⚠️ **Vor Umsetzung prüfen:**
- Quota-Defaults für 5-User-Pilot: realistisch zu schwach oder zu großzügig?
- Quota-Exceeded: hartes 429 oder soft (warning + grace period)?
- USD-Budget statt Token-Count für Vertex-Calls?

---

## 12. Threat-Model

### 12.1 Vertrauensgrenzen

| Akteur | Vertrauen | Zugriff auf mcp-knowledge2 |
|---|---|---|
| Operator (Engineer/Admin) | Voll | DB-Owner, Backup-Master, Hetzner-Root |
| mcp-approval2 (per JWT signed) | Voll als Caller | alle Endpoints via JWT-aud-Check |
| End-User via mcp-approval2 | Voll auf eigene Daten + Shares | indirekt über JWT |
| User A auf User B | Kein | RLS + Share-Grant-Check |
| Postgres-Admin (DBA-Role) | Voll | RLS-bypass — Trusted-Plattform |
| Externer Angreifer | Kein | JWKS-Verify + Service-Token Hürden |

### 12.2 Schutz-Mechanismen

1. **Cross-User-Read** — RLS-Policy `owner_or_shared_read` ist Boundary.
   Plus App-Layer-Check (defense-in-depth).
2. **Cross-User-Ciphertext-Replay** — AAD enthält owner_id + object_id.
   Replay zwischen Usern blockt am AAD-Check.
3. **Direct-Blob-Access** — Bucket nicht public. Presigned-URLs sind
   kurz-TTL und tenant-scoped (egal — Single-Tenant).
4. **JWT-Replay** — `aud=mcp-knowledge2` enforced, `exp=60s` macht
   Replay-Window minimal. JWKS-Cache 24h mit refresh-on-miss.
5. **Service-Account-Bearer-Bruteforce** — constant-time-compare,
   Rate-Limit auf failed-auth.
6. **SQL-Injection** — Drizzle parametrisiert; raw `pg.query` ebenfalls
   parametrisiert. Lint-Rule: keine `string-concat in SQL`.
7. **Idempotency-Replay** — Idem-Key + User-Scope.
8. **Embedding-Inversion** — PII-Masking + DPA-Hinweis (§3.4).

### 12.3 Was NICHT geschützt

- Operator-Compromise → alle Daten weg (Trusted-Party)
- RCE auf der App → Memory-Klartext → alle Daten zur Request-Zeit weg
- Plattform-Breakout (Hetzner-Hypervisor, Cloud-Run-Container-Escape) —
  out-of-scope
- Side-Channel (Timing, Volumen) — out-of-scope Phase 1

### 12.4 Rate-Limit + Anti-Abuse

Phase 1: Reverse-Proxy (Caddy/Cloud-Run-Throttling) macht's. Phase 5+:
in-app pro User (siehe Quota §11) + per-IP-Fallback.

---

## 13. Test-Strategie

### 13.1 Layer 1 — Unit (vitest)

- Crypto: encrypt-decrypt round-trip, AAD-Mismatch failt
- AAD-Builder: User-Replay-Schutz (owner_a + cipher → owner_b → fail)
- PII-Mask: bekannte Patterns
- RRF-Fusion: deterministischer Tie-Break

### 13.2 Layer 2 — Integration (testcontainers)

Postgres + MinIO als Testcontainer pro Test-Suite.

- CRUD round-trip
- **RLS-Test:** User A's Object ist für User B unsichtbar
- **Sharing-Test:** User A teilt mit B → B sieht, C nicht
- **Revoke-Test:** Share-Revoke macht Object für B sofort unsichtbar
- pgvector: Query liefert eingefügten Vektor
- FTS: Query liefert eingefügten Text
- Idempotency: zweimal mit gleichem Key → identische Response
- GDPR-Erase: alle Tabellen für User leer + Blobs gelöscht

### 13.3 Layer 3 — E2E

`docker compose up -d && bash scripts/smoke.sh` — komplettes Stack
plus Mock-JWKS-Server. ~30 Endpoints exercised.

### 13.4 Layer 4 — Production-Smoke

`scripts/smoke-prod.sh` analog mcp-approval. GH-Actions
`smoke.yml`-Workflow post-deploy.

---

## 14. Tech-Stack-Confirmation

Konsistent mit v1 §7 + mcp-approval2 v1 §13.

| Layer | Wahl | Begründung |
|---|---|---|
| Runtime | Node 22 LTS im Container | LTS bis 2027-04, async-context-tracking |
| Container-Base | `node:22-alpine` | klein (~50 MB) |
| HTTP-Framework | **Hono.js** | konsistent mit mcp-approval2 |
| Language | TypeScript strict + `noUncheckedIndexedAccess` | konsistent mit mcp-approval2 |
| ORM | **Drizzle** (Postgres-Adapter) | konsistent, RLS-Konform |
| Migrations | `drizzle-kit` + raw-SQL für RLS-Policies | Drizzle-kit unterstützt raw-SQL-Migrations |
| Database | **Postgres 16+ mit pgvector 0.7+** | Single-Tenant, RLS, Vector mature |
| Vector-Index | **ivfflat lists=100** (Phase 1-3), HNSW (Phase 5+ wenn nötig) | v1-Decision |
| DB-Client | `pg` (node-postgres) Pool | TX-Setup für `SET LOCAL` |
| JWT-Validation | **`jose`** | JWKS-Support, mature |
| OpenAPI-Validation | `@hono/zod-openapi` | Schema-First |
| Blob | **`@aws-sdk/client-s3` v3** | alle S3-kompatiblen Backends |
| Embedding-Provider | **Google Vertex AI** (EU, text-embedding-005) | v1-Decision |
| Crons | **pg-boss** | Postgres-basiert, kein Redis |
| Logs | **pino** | strukturiert, schnell |
| Metrics | **`prom-client`** | Prometheus-Standard |
| Tests | **vitest** + **testcontainers** | Integration mit Postgres-Container |
| Build | `tsx` (dev) + `tsc` + `esbuild` (prod) | single-file-output für Container |

---

## 15. Phasen-Roadmap (synchron zu mcp-approval2)

Aus mcp-approval2 v1 §11 — diese Tabelle zeigt nur mcp-knowledge2-Scope.

| Phase | Woche | mcp-knowledge2-Scope |
|---|---|---|
| **0 Skeleton** | 1-2 | Repo-Bootstrap (package.json, Dockerfile, docker-compose.dev.yml, CI), Hono-Server, JWKS-Stub, leeres Drizzle-Schema, `/health` + `/metrics` |
| **1 Auth + Schema** | 3-4 | JWKS-Validation-Middleware, Postgres-Schema (objects + share_grants + audit_log + …), RLS-Policies, Smoke-Test gegen Mock-JWKS |
| **2 Stand-by** | 5-7 | parallel mcp-approval2 baut Credentials + Vault |
| **3 Storage-Core + Search** | 8-9 | Objects-CRUD, BlobStore, Encryption-Layer mit DEK-via-Internal-API (Variante B), Sharing-API, pgvector + Vertex-Embedding, Hybrid-Search |
| **4 Stand-by** | 10-11 | parallel mcp-approval2 baut Tool-Surface |
| **5 Sub-MCP-Stand-by** | 11-12 | parallel mcp-approval2 baut Sub-MCP-Integration |
| **6 Pilot-Hardening** | 13-14 | GDPR-Erase-Endpoint, Quota-System, Cost-Controls, Audit-Sink-Switch, Production-Deploy + Pilot-Start |

**Phase-2/4/5-Stand-by** heißt: aktiv nichts neues bauen, aber:
- Bug-Fixes wenn Smoke-Tests durch mcp-approval2 was decken
- Doku-Verbesserung
- Performance-Benchmarks gegen Echtdaten (Vertex-Calls, pgvector-Latenz)
- Backup/Restore-Drills

### 15.1 Phase 0 Deliverable

```
mcp-knowledge2/
├── src/
│   ├── server.ts                # Hono boot
│   ├── routes/
│   │   ├── health.ts
│   │   └── meta.ts              # /metrics, /version
│   └── adapters/                # leer, Phase 1+
├── tests/
│   ├── unit/
│   └── integration/             # leer, Phase 1+
├── deployments/
│   ├── docker-compose.dev.yml   # Postgres + MinIO + Mock-JWKS
│   ├── docker-compose.yml       # Hetzner-Prod
│   └── caddy/Caddyfile
├── docs/
│   ├── adr/                     # Decision-Records aus mcp-approval2 §0
│   ├── openapi.yaml             # Stub
│   ├── SECURITY.md              # Threat-Model (siehe §12)
│   └── runbooks/                # leer, Phase 5+
├── scripts/
│   ├── dev.sh
│   └── smoke.sh                 # Phase 1+
├── Dockerfile                   # multi-stage
├── .dockerignore
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── vitest.config.ts
└── README.md
```

**Acceptance:** `git clone && bash scripts/dev.sh` → `curl
http://localhost:8080/health` returns 200.

### 15.2 Phase 1 Deliverable

- Postgres-Schema deployt via drizzle-kit
- JWKS-Validation läuft gegen Mock-JWKS-Server
- 5+ RLS-Tests grün
- Smoke-Test: gefakter JWT mit user_a kann nicht user_b's Objects sehen

---

## 16. Open Decisions (Status nach Bundle 1-6 + Konsolidierung)

Aus mcp-approval2 v1 §10 + neue Knowledge-spezifische Punkte.

### 16.1 Aus mcp-approval2 §10 übernommen

| # | Decision | Status |
|---|---|---|
| Tenancy | Strikt Single-Tenant | ✅ |
| Sharing-Modell | Docs+Skills+Apps in mcp-knowledge2 | ✅ |
| Memos teilbar | Nein, owner-only | ✅ |
| Storage-Service-Auth | JWT signed by mcp-approval2 | ✅ |
| AI-Provider | Google Vertex AI (EU) | ✅ |

### 16.2 mcp-knowledge2-spezifisch (neu konsolidiert)

| # | Decision | Status |
|---|---|---|
| DEK-Übergabe | **Variante B (Internal-API)** vorgeschlagen | ⏳ Phase-1-Confirm |
| HNSW vs ivfflat | ivfflat lists=100 Phase 1-3, HNSW als Phase-5+-Migration | ✅ |
| Object-ID | UUID (nicht ULID) | ✅ |
| Timestamps | INTEGER ms (nicht TIMESTAMPTZ) | ✅ |
| Embedding-Dim | 768 (Vertex text-embedding-005) | ✅ |
| Quota-Defaults | 10k Objects / 5 GB / 1000 Embed/Tag | ⏳ Phase-1-Confirm |
| Quality-Gate aktiv | Schema-ready, nicht Phase 1-3 | ✅ |
| Owner-Transfer (Re-Encrypt) | Phase 5+ | ✅ |
| Knowledge-Graph-Permission-Vererbung | NEIN (Skill→Doc) | ✅ |
| Account-Deletion-Kaskade | Anonymize-Owner-Pattern | ⏳ Phase-5-Confirm |
| Audit-Sink | Postgres-only Phase 1, OTel/SIEM Phase 5+ | ✅ |

### 16.3 Offene Sub-Entscheidungen für Phase 0/1

- [ ] Service-Account-Bearer-Rotation (monatlich / per-Deploy / OpenBao-AppRole)
- [ ] Quota-Defaults-Werte für 5-User-Pilot finalisieren
- [ ] Embedding-Cache: ja/nein (Default: nein)
- [ ] `task_type=RETRIEVAL_DOCUMENT` vs symmetric — Phase 1 Benchmark
- [ ] OpenAPI-Style: lowercase-paths oder camelCase
- [ ] Error-Response-Format: RFC 7807 (Problem Details) oder eigenes Format
- [ ] OpenTelemetry-Tracing: Phase 1 stub oder Phase 5+
- [ ] Multi-Region-Read-Replica Phase 5+: ja/nein (Cost-Argument)

---

## 17. Referenzen

- **v1-Vorgänger (Decisions):** [PLAN-architecture-DRAFT-from-mcp-approval2-view.md](./PLAN-architecture-DRAFT-from-mcp-approval2-view.md)
- **mcp-approval2 Architektur:** [github.com/axel-rogg/mcp-approval2/.../PLAN-architecture-v1.md](https://github.com/axel-rogg/mcp-approval2/blob/main/docs/plans/active/PLAN-architecture-v1.md)
- **Externer Detail-Entwurf:** war
  `/workspaces/mcp-knowledge/docs/plans/PLAN-knowledge-platform-v2.md` —
  jetzt obsolete, dieser v2-Plan ersetzt ihn. Material aus §8, §12, §13,
  §18, §20, §22 hier integriert.
- **knowledge-core (v1, CF):** [github.com/axel-rogg/mcp-approval](https://github.com/axel-rogg/mcp-approval)
  (knowledge-core ist subdirectory)
- **Pattern-Vorlagen:**
  - [mcp-utils](https://github.com/axel-rogg/mcp-utils) — Satellite-Service-Skeleton
  - [mcp-gws](https://github.com/axel-rogg/mcp-gws) — Multi-User-fähiges Gateway
- **External:**
  - Postgres RLS: https://www.postgresql.org/docs/16/ddl-rowsecurity.html
  - pgvector: https://github.com/pgvector/pgvector
  - Hono: https://hono.dev/
  - Drizzle ORM: https://orm.drizzle.team/
  - pg-boss: https://github.com/timgit/pg-boss
  - Morris et al. 2023 — Text Embeddings Reveal Almost As Much As Text
    (Embedding-Inversion-Attack)
  - Song & Raghunathan, IEEE S&P 2020 — Information Leakage in Embedding
    Models

---

## 18. Architecture-Review-Befunde

Aus Plan-Agent-Review 2026-05-13 + Konsolidierung gegen mcp-approval2 v1.

### 18.1 Integrierte Befunde

| Befund | Wo integriert |
|---|---|
| Owner-Column im Objects-Schema | §2.1 `owner_id` |
| User-Identity in JWT durchgereicht | §1.1 + §2.3 |
| Sharing-Audit-Log | §2.1 `audit_log` mit `action='share.grant'`/`'share.revoke'` |
| Quota-System pro User | §11 |
| Embedding-Inversion-Risk | §3.4 + DPA-Hinweis |
| GDPR-Erase-Cascade | §8 |
| Per-User-Export | §16.3 offen (Tool im mcp-approval2 Phase 5+) |
| Search-Privacy / Vertex-Outbound | §5.4 |
| Disaster-Recovery RPO/RTO | §9.2 |
| Backup-Encryption | §9.2 (separater BACKUP_MASTER_KEY) |
| Supply-Chain-Härtung (npm audit, Renovate) | §15.1 (Phase 0 CI-Gate) |

### 18.2 Explizit deferred (Phase 5+ oder Non-Goal)

- **Cross-Tenant-Sharing** — Non-Goal (Single-Tenant strikt)
- **True E2EE / Client-Crypto** — Non-Goal (bricht Server-Side-Search)
- **Searchable-Encryption-Schemes** — Non-Goal (Research-Stage)
- **SOC2/ISO27001-Zertifizierung** — erst wenn commercial Kunde es fordert
- **Webhook-System für Integrations** — Phase 5+, nur Email Phase 5
- **Multi-Region-Replication** — bei realer Mehr-Region-Anforderung
- **Owner-Transfer + Re-Encrypt** — Phase 5+ Operations
- **HNSW Vector-Index** — Phase 5+ wenn ivfflat-Recall-Probleme

### 18.3 Wenn Bedarf später entsteht

- **Multi-Org-Hosting:** zweite Instance forken (B-Pattern), kein
  Multi-Tenant-Refactor in dieser Codebase
- **OAuth-Scopes statt scope-string:** `scope: 'docs:write skills:read'`
  ist bereits im JWT-Format vorgesehen (§1.1), Application-Layer-Check
  Phase 4+
- **Sharing-Granularität pro Resource-Type** (z.B. apps mit
  read-only-shared-edit): Phase 5+ via `share_grants.scope`-Enum-Erweiterung

---

**Nächster Schritt:** Phase 0 Skeleton starten (Repo-Bootstrap). Erste
Acceptance-Kriterium: `docker compose up` + `curl localhost:8080/health`.
