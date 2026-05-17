-- AS-3 K1: OAuth-facade signing keys.
--
-- Spec: docs/plans/active/PLAN-as3-autonomous.md §1.2 (signing_keys table).
--
-- (K2 follow-up migration 0006 adds users + invites.)
--
-- Owned by knowledge_admin (no RLS) — read by the auth-layer before any
-- user-context exists. App role has SELECT only; rotation is admin task.

CREATE TABLE IF NOT EXISTS signing_keys (
  kid          TEXT PRIMARY KEY,
  alg          TEXT NOT NULL,
  public_jwk   JSONB NOT NULL,
  private_pem  TEXT NOT NULL,                    -- AES-GCM-encrypted via BACKUP_MASTER_KEY (base64)
  private_nonce BYTEA NOT NULL,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  rotated_at   BIGINT,
  created_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signing_keys_active ON signing_keys (active) WHERE active = TRUE;

REVOKE ALL ON signing_keys FROM knowledge_app;
GRANT SELECT                         ON signing_keys TO knowledge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON signing_keys TO knowledge_admin;
