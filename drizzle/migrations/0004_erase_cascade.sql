-- F-7 + F-8 from 2026-05-13 audit.
--
-- Adds:
--   - blob_deletion_queue: retries failed blob deletes on the
--     blobs.cleanup_orphans cron. Without this, GDPR erase-user could
--     return success while leaving plaintext-equivalent blobs at rest.
--
-- Note: pseudonymising audit_log is a runtime operation done by the
-- erase-user handler with the admin DB role, not a schema change.

CREATE TABLE IF NOT EXISTS blob_deletion_queue (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blob_key      TEXT NOT NULL,
  reason        TEXT NOT NULL,                -- 'erase-user' | 'upload-purge' | 'object-delete'
  enqueued_at   BIGINT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  next_attempt_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blob_queue_next ON blob_deletion_queue (next_attempt_at);

-- Admin-only table — no RLS needed, but lock down by GRANTs.
REVOKE ALL ON blob_deletion_queue FROM knowledge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON blob_deletion_queue TO knowledge_admin;
