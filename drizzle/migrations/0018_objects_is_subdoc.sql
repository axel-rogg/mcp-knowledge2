-- PLAN-document-linking §10.5 D2:
--   Cached column `is_subdoc` auf `objects`. true ⟺ mindestens ein
--   `object_refs(to_id=this.id, role='resource')` existiert. Spart
--   für jeden Search-Hit eine RLS-Subquery — Performance-load-bearing
--   bei Group-by-Parent (P3) und Penalty-Read.
--
--   Toggle-Semantik M:N-safe (mehrere Skills können dasselbe Doc als
--   resource haben). Logic in src/storage/refs.ts:
--     addRef(role='resource')  → SET is_subdoc=true   (idempotent)
--     removeRef(role='resource') → IF NOT EXISTS (...andere resource-refs)
--                                  THEN SET is_subdoc=false.

ALTER TABLE objects
  ADD COLUMN IF NOT EXISTS is_subdoc boolean NOT NULL DEFAULT false;

-- Partial-Index — nur is_subdoc=true wird indexed (~1% der Rows erwartet).
CREATE INDEX IF NOT EXISTS idx_objects_is_subdoc
  ON objects(is_subdoc) WHERE is_subdoc = true;

-- ── Backfill (idempotent) ─────────────────────────────────────────────────
-- Setze is_subdoc=true für alle objects die als to_id eines role='resource'-
-- Refs vorkommen. Single UPDATE-Statement, läuft in einer Transaction.
-- Bei 0 Refs (clean install) macht das NO-OP.
UPDATE objects o
SET is_subdoc = true
WHERE is_subdoc = false
  AND EXISTS (
    SELECT 1 FROM object_refs r
    WHERE r.to_id = o.id AND r.role = 'resource'
  );
