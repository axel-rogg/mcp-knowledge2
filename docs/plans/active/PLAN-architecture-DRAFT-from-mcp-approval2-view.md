# PLAN — mcp-knowledge2 Architektur (DRAFT aus mcp-approval2-Sicht)

> **Status: ✅ KONSOLIDIERT in [PLAN-architecture-v2.md](./PLAN-architecture-v2.md) (2026-05-13)**
>
> **OBSOLET seit 2026-05-15 — ADR-0004 / GENERIC-DATA-MODEL.md v3 hat das
> `kind`-Diskriminator-Modell entfernt.** Das `kind`-Column-+-Index-Schema in
> §§2.1 unten ist veraltet. Authoritative Spec: PLAN-architecture-v2 §2.1
> (v3-Revision) + GENERIC-DATA-MODEL.md.
>
> Dieses DRAFT-File bleibt als Input-Trail. Authoritative Implementation-
> Spec ist v2. NICHT PUSHEN (lokal-only, war Input für die Konsolidierung).
>
> **Original-Status (vor Konsolidierung):** DRAFT — NICHT PUSHEN, ZUR
> KONSOLIDIERUNG MIT PARALLELEM AGENT
>
> Erstellt: 2026-05-13. Dieses File ist die Sicht auf mcp-knowledge2 **aus
> der Perspektive der mcp-approval2-Decision-Session**. Es gibt einen
> parallel arbeitenden Agent, der einen eigenen Plan fuer mcp-knowledge2
> erstellt.
>
> **Zweck dieses Files:**
> - Service-Boundary-Anforderungen (JWT-Pattern, Endpoints, GDPR-Cascade)
>   aus mcp-approval2-Sicht dokumentieren
> - Input fuer die Konsolidierung mit dem anderen Agent-Plan
> - **Nicht als Master-Plan fuer mcp-knowledge2 zu verstehen**
>
> **Verwendung:**
> - Lokal bleiben, NICHT auf mcp-knowledge2-Remote pushen
> - Wenn beide Plaene (dieser + paralleler Agent) vorliegen, in Decision-
>   Session abgleichen und konsolidierten v1 erstellen
> - Service-Boundary §1 ist der wichtigste Abschnitt — alles andere ist
>   diskutierbar
>
> Begleitfile: [mcp-approval2 PLAN-architecture-v1](https://github.com/axel-rogg/mcp-approval2/blob/main/docs/plans/active/PLAN-architecture-v1.md)

---

## 0. Service-Rolle

mcp-knowledge2 ist der **Storage- und Sharing-Service** im Zwei-Repo-Setup.

| Repo | Verantwortung |
|---|---|
| **mcp-approval2** | Auth, Sessions, Approval-Flow, Tool-Surface, Credential-Vault |
| **mcp-knowledge2** | Storage fuer Docs/Skills/Apps/Memos, Sharing-Grants, Hybrid-Search, Vector-Embeddings |

**Trennung-Begruendung:**
- Storage-Layer ist ohnehin lange-lebig (Backup-Lifecycle, Schema-Migrationen
  unabhaengig von Tool-Layer)
- Sharing-Logik lebt natuerlicherweise dort wo die Objekte sind (RLS-
  Policies)
- mcp-approval2 kann anders deployt werden (z.B. CF Workers fuer Privat)
  als mcp-knowledge2 (Self-Host Postgres). Service-Boundary erlaubt
  unterschiedliche Runtimes.

---

## 1. Service-Boundary

**Auth-Pattern:** mcp-approval2 signiert per Request einen kurzlebigen JWT,
mcp-knowledge2 validiert via JWKS.

```ts
// JWT-Format (signed by mcp-approval2):
{
  iss: 'mcp-approval2',
  aud: 'mcp-knowledge2',
  sub: <user_id>,                 // owner-identity, kryptografisch durchgereicht
  scope: 'docs:write skills:read', // optional fine-grained
  exp: now + 60                    // 60s lifetime, einmalig per Operation
}
```

mcp-knowledge2:
- Cached JWKS 24h, refresh-on-miss via `/.well-known/jwks.json`
- Validiert iss/aud/exp/signature
- Extrahiert `sub` als `owner_id` fuer alle Operations
- Setzt `SET LOCAL app.current_user = '...'` fuer RLS

---

## 2. Schema (Postgres + pgvector)

### 2.1 Core-Tabellen

```sql
CREATE TABLE objects (
  id            UUID PRIMARY KEY,
  owner_id      UUID NOT NULL,
  kind          TEXT NOT NULL,         -- 'doc' | 'skill' | 'app' | 'memo'
  subtype       TEXT,

  title         TEXT,
  description   TEXT,
  keywords_json TEXT,
  trigger_hints TEXT,
  meta_json     JSONB,

  body_inline   BYTEA,                 -- <=16 KB encrypted
  r2_key        TEXT,                  -- 'objects/<id>' im Blob-Storage
  body_hash     TEXT,
  mime_type     TEXT,
  filename      TEXT,

  visibility    TEXT NOT NULL DEFAULT 'private',  -- 'private' | 'shared'

  pinned        BOOLEAN NOT NULL DEFAULT FALSE,
  archived      BOOLEAN NOT NULL DEFAULT FALSE,

  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER,

  -- Body-Crypto
  nonce         BYTEA NOT NULL,
  key_version   INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_objects_owner_kind ON objects(owner_id, kind);
CREATE INDEX idx_objects_updated ON objects(updated_at DESC);

CREATE TABLE share_grants (
  id            UUID PRIMARY KEY,
  resource_kind TEXT NOT NULL,
  resource_id   UUID NOT NULL,
  granted_to    UUID NOT NULL,
  granted_by    UUID NOT NULL,
  scope         TEXT NOT NULL DEFAULT 'read',  -- 'read' | 'write'
  granted_at    INTEGER NOT NULL,
  expires_at    INTEGER,
  revoked_at    INTEGER
);

CREATE INDEX idx_grants_lookup
  ON share_grants(granted_to, revoked_at)
  WHERE revoked_at IS NULL;
```

### 2.2 RLS-Policies (DB-seitig Defense)

```sql
ALTER TABLE objects ENABLE ROW LEVEL SECURITY;

CREATE POLICY owner_or_shared ON objects
  USING (
    owner_id = current_setting('app.current_user')::uuid
    OR id IN (
      SELECT resource_id FROM share_grants
      WHERE granted_to = current_setting('app.current_user')::uuid
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > extract(epoch from now()))
    )
  );

CREATE POLICY owner_modify ON objects
  FOR UPDATE
  USING (owner_id = current_setting('app.current_user')::uuid);

CREATE POLICY owner_delete ON objects
  FOR DELETE
  USING (owner_id = current_setting('app.current_user')::uuid);
```

### 2.3 Vector-Storage (pgvector)

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE object_vectors (
  object_id   UUID PRIMARY KEY REFERENCES objects(id) ON DELETE CASCADE,
  embedding   vector(768),               -- Vertex text-embedding-005 dimension
  embedded_at INTEGER NOT NULL,
  model       TEXT NOT NULL              -- 'text-embedding-005'
);

CREATE INDEX idx_objects_vec ON object_vectors
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- RLS via JOIN auf objects (Cascade durch FK)
ALTER TABLE object_vectors ENABLE ROW LEVEL SECURITY;

CREATE POLICY vec_via_object ON object_vectors
  USING (object_id IN (SELECT id FROM objects));
```

### 2.4 Audit-Log (eigene Tabelle)

mcp-knowledge2 hat sein eigenes Audit-Log fuer Storage-Operations.
mcp-approval2 hat ein zweites, getrennt. Korreliert ueber `request_id`.

```sql
CREATE TABLE audit_log (
  id            UUID PRIMARY KEY,
  ts            INTEGER NOT NULL,
  actor_user_id UUID NOT NULL,           -- aus JWT sub
  action        TEXT NOT NULL,           -- 'object.read', 'object.write', 'share.grant', ...
  resource_kind TEXT,
  resource_id   UUID,
  request_id    UUID,                    -- Cross-Service-Korrelation
  result        TEXT NOT NULL,
  details       JSONB
);
```

---

## 3. HTTP-API

### 3.1 Endpoints (REST)

```
Objects:
  GET    /v1/objects                — list (owner + shared)
  POST   /v1/objects                — create
  GET    /v1/objects/{id}           — read
  PATCH  /v1/objects/{id}           — update (owner-only)
  DELETE /v1/objects/{id}           — soft-delete (owner-only)

Sharing:
  POST   /v1/objects/{id}/shares    — share with user
  GET    /v1/objects/{id}/shares    — list shares
  DELETE /v1/shares/{share_id}      — revoke

Search:
  POST   /v1/search                 — hybrid FTS + Vektor
  GET    /v1/search/usages/{id}     — incoming refs

Internal (only mcp-approval2):
  POST   /v1/internal/erase-user    — cascade-delete bei GDPR
  POST   /v1/internal/embed         — bulk embed (cron)
```

### 3.2 Auth-Middleware

```ts
app.use('/v1/*', async (c, next) => {
  const token = extractBearer(c.req);
  const claims = await verifyJwt(token, jwks);
  if (claims.aud !== 'mcp-knowledge2') throw new Error('wrong audience');
  
  const userId = claims.sub;
  c.set('userId', userId);
  
  // Postgres-Session-Setup fuer RLS
  await c.var.db.execute(`SET LOCAL app.current_user = '${userId}'`);
  
  await next();
});
```

---

## 4. Hybrid-Search

Pattern uebernommen aus mcp-approval/knowledge-core:

1. **FTS** auf title/description/keywords/body-plain (wenn unencrypted)
2. **Vector-Similarity** via pgvector + Vertex-Embeddings
3. **RRF-Fusion** (Reciprocal Rank Fusion, k=60) zwischen beiden Listen
4. **Post-Filter** auf RLS-erlaubte Rows (RLS macht's auto via Policy)

```ts
async function search(query: string, userId: string, limit = 10) {
  const [ftsHits, vecHits] = await Promise.all([
    db.execute(`SELECT id, ts_rank(...) AS score FROM objects WHERE ...`),
    embedAndQuery(query)  // vertex.embed + pgvector-cosine
  ]);
  
  return rrfFuse(ftsHits, vecHits, { k: 60 }).slice(0, limit);
}
```

---

## 5. GDPR-Erase-Cascade

Wenn mcp-approval2 einen User loescht, callt es:

```
POST /v1/internal/erase-user
  Body: { user_id: '...', confirmation_token: '...' }

mcp-knowledge2:
  1. DELETE FROM objects WHERE owner_id = ... CASCADE
     → object_vectors auto-deletes via FK
  2. DELETE FROM share_grants WHERE granted_to = ... OR granted_by = ...
  3. Audit-Log Entry: 'user.erased' mit pseudonymisierter ID
  4. R2-Blobs unter 'objects/...' deleten
  5. Returns { status: 'ok', deleted_rows: N }
```

---

## 6. Phasen (synchron zu mcp-approval2)

| Phase | mcp-knowledge2-Scope |
|---|---|
| 0 (Wo 1-2) | Repo-Skeleton, Hono.js, Drizzle-Schema, Docker-Compose-Setup, JWKS-Stub |
| 1 (Wo 3-4) | Auth-Middleware mit JWKS, RLS-Policies, Audit-Schema |
| 2 (Wo 5-7) | parallel mcp-approval2 baut Credentials |
| 3 (Wo 8-9) | Objects-CRUD + Sharing-API + Hybrid-Search (Vertex-Embeddings) |
| 4 (Wo 10-11) | parallel mcp-approval2 baut Tool-Surface |
| 5 (Wo 11-12) | parallel mcp-approval2 baut Sub-MCP |
| 6 (Wo 13-14) | Smoke gegen mcp-approval2, GDPR-Erase-Endpoint |

---

## 7. Tech-Stack

- **Hono.js** (HTTP-Framework)
- **TypeScript strict + noUncheckedIndexedAccess**
- **Drizzle ORM** mit Postgres-Adapter (kein SQLite-Path im v1 — Service
  laeuft nur als Self-Host)
- **Postgres 16+** mit pgvector
- **R2 (S3-API)** fuer Blob-Storage (oder GCS bei GCP-Deploy)
- **Google Vertex AI** fuer Embeddings (text-embedding-005)
- **jose** fuer JWT-Validation

---

## 8. Referenzen

- Schwester-Plan: [mcp-approval2 PLAN-architecture-v1](https://github.com/axel-rogg/mcp-approval2/blob/main/docs/plans/active/PLAN-architecture-v1.md)
- Bestand-Vorlaufer: knowledge-core in mcp-approval-Repo
  ([Repo](https://github.com/axel-rogg/mcp-approval))

---

**Naechster Schritt:** Phase 0 (Repo-Skeleton) parallel zu mcp-approval2 starten.
