-- Initial schema for mcp-knowledge2 (PLAN-architecture-v2 §2.1)
-- Generated manually to keep RLS-Policies + extension installs in lockstep.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- ─── objects ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS objects (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id                   UUID NOT NULL,
  kind                       TEXT NOT NULL CHECK (kind IN ('doc','skill','app','memo')),
  subtype                    TEXT,

  title                      TEXT,
  description                TEXT,
  keywords_json              TEXT,
  trigger_hints              TEXT,
  meta_json                  JSONB,

  body_inline                BYTEA,
  blob_key                   TEXT,
  body_size                  BIGINT NOT NULL,
  body_hash                  TEXT,
  mime_type                  TEXT,
  filename                   TEXT,

  visibility                 TEXT NOT NULL DEFAULT 'private'
                             CHECK (visibility IN ('private','shared')),
  pinned                     BOOLEAN NOT NULL DEFAULT FALSE,
  archived                   BOOLEAN NOT NULL DEFAULT FALSE,
  archived_at                BIGINT,
  expires_at                 BIGINT,
  deleted_at                 BIGINT,
  refcount                   INTEGER NOT NULL DEFAULT 0,
  current_version            INTEGER NOT NULL DEFAULT 1,

  nonce                      BYTEA NOT NULL,
  key_version                INTEGER NOT NULL DEFAULT 1,

  description_enc            BYTEA,
  description_nonce          BYTEA,
  description_key_version    INTEGER,

  quality_score              INTEGER,
  quality_checked_at         BIGINT,
  quality_rubric_version     INTEGER,

  created_at                 BIGINT NOT NULL,
  updated_at                 BIGINT NOT NULL,
  last_used_at               BIGINT,

  CHECK ((body_inline IS NOT NULL) OR (blob_key IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_objects_owner_kind   ON objects (owner_id, kind, subtype) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_objects_updated      ON objects (updated_at DESC)         WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_objects_owner_hash   ON objects (owner_id, kind, body_hash) WHERE body_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_objects_deleted_at   ON objects (deleted_at) WHERE deleted_at IS NOT NULL;

-- FTS column (generated, GIN-indexed)
ALTER TABLE objects ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(description, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(trigger_hints, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(keywords_json, '')), 'D')
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_objects_tsv ON objects USING GIN (search_tsv);

-- ─── object_refs (knowledge graph) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS object_refs (
  from_id     UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  to_id       UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  meta_json   JSONB,
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (from_id, to_id, role)
);
CREATE INDEX IF NOT EXISTS idx_refs_to   ON object_refs (to_id);
CREATE INDEX IF NOT EXISTS idx_refs_role ON object_refs (role);

-- ─── object_tags ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS object_tags (
  object_id   UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  tag         TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'manual',
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (object_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON object_tags (tag);

-- ─── object_revisions ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS object_revisions (
  object_id   UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  body_inline BYTEA,
  blob_key    TEXT,
  meta_json   JSONB,
  nonce       BYTEA,
  key_version INTEGER,
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (object_id, version)
);

-- ─── share_grants ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS share_grants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('doc','skill','app')),
  resource_id   UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  granted_to    UUID NOT NULL,
  granted_by    UUID NOT NULL,
  scope         TEXT NOT NULL CHECK (scope IN ('read','write')),
  granted_at    BIGINT NOT NULL,
  expires_at    BIGINT,
  revoked_at    BIGINT
);
CREATE INDEX IF NOT EXISTS idx_grants_lookup   ON share_grants (granted_to, revoked_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_grants_resource ON share_grants (resource_id, revoked_at) WHERE revoked_at IS NULL;

-- ─── object_vectors (pgvector, dim=768 for text-embedding-005) ────────────
CREATE TABLE IF NOT EXISTS object_vectors (
  object_id   UUID PRIMARY KEY REFERENCES objects(id) ON DELETE CASCADE,
  embedding   vector(768),
  model       TEXT NOT NULL,
  embedded_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_objects_vec ON object_vectors
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ─── audit_log (append-only via revoked GRANT) ────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts            BIGINT NOT NULL,
  actor_user_id UUID NOT NULL,
  action        TEXT NOT NULL,
  resource_kind TEXT,
  resource_id   UUID,
  request_id    UUID,
  result        TEXT NOT NULL CHECK (result IN ('success','denied','error')),
  details       JSONB
);
CREATE INDEX IF NOT EXISTS idx_audit_actor_ts   ON audit_log (actor_user_id, ts);
CREATE INDEX IF NOT EXISTS idx_audit_action_ts  ON audit_log (action, ts);
CREATE INDEX IF NOT EXISTS idx_audit_request_id ON audit_log (request_id);

-- ─── idempotency_records ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idempotency_records (
  user_id         UUID NOT NULL,
  idem_key        TEXT NOT NULL,
  response_body   BYTEA,
  response_status INTEGER,
  created_at      BIGINT NOT NULL,
  expires_at      BIGINT NOT NULL,
  PRIMARY KEY (user_id, idem_key)
);
CREATE INDEX IF NOT EXISTS idx_idem_expires ON idempotency_records (expires_at);

-- ─── uploads ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS uploads (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       UUID NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending','finalized','expired','hard_deleted')),
  blob_key       TEXT NOT NULL,
  body_size      BIGINT,
  body_hash      TEXT,
  meta_json      JSONB,
  created_at     BIGINT NOT NULL,
  finalized_at   BIGINT,
  expires_at     BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uploads_owner ON uploads (owner_id);
CREATE INDEX IF NOT EXISTS idx_uploads_expires ON uploads (expires_at) WHERE status IN ('pending','expired');

-- ─── user_quotas ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_quotas (
  user_id              UUID PRIMARY KEY,
  object_count_max     INTEGER NOT NULL DEFAULT 10000,
  storage_bytes_max    BIGINT  NOT NULL DEFAULT 5368709120,
  embed_calls_per_day  INTEGER NOT NULL DEFAULT 1000,
  search_qps_burst     INTEGER NOT NULL DEFAULT 30,
  object_count_used    INTEGER NOT NULL DEFAULT 0,
  storage_bytes_used   BIGINT  NOT NULL DEFAULT 0,
  embed_calls_today    INTEGER NOT NULL DEFAULT 0,
  embed_calls_resetat  BIGINT  NOT NULL,
  created_at           BIGINT NOT NULL,
  updated_at           BIGINT NOT NULL
);
