-- PLAN-document-linking §10.5 R2 + R4 + R11:
--   R2: refs_via_object RLS-Policy prüfte nur from_id → Existence-Leak
--       wenn Share-Feature kommt. Beide Endpoints policy-checken.
--   R4: ON DELETE CASCADE für object_refs.from_id + to_id. Orphan-Refs
--       nach hard-delete (z.B. user-erase) verschwinden automatisch.
--   R11: idx_refs_role (Single-Column auf role) ist tot — keine Query
--        filtert nur auf role. Drop saving disk + write-amplification.
--   Plus: idx_refs_to_role(to_id, role) für is_subdoc-EXISTS-Check in
--   0018, und für used_by[]-Batch-Query in P3 (Group-by-Parent).

-- ── R4: FK-CASCADE auf object_refs ────────────────────────────────────────
-- Aktueller Stand: object_refs hat KEINE Foreign-Keys (Schema 0000 nur
-- primary-key(from_id,to_id,role)). Hinzufügen — Postgres validiert dabei
-- existing-rows, also vor Add: orphan-rows aufräumen.

DELETE FROM object_refs r
WHERE NOT EXISTS (SELECT 1 FROM objects o WHERE o.id = r.from_id)
   OR NOT EXISTS (SELECT 1 FROM objects o WHERE o.id = r.to_id);

ALTER TABLE object_refs
  ADD CONSTRAINT object_refs_from_fk
    FOREIGN KEY (from_id) REFERENCES objects(id) ON DELETE CASCADE,
  ADD CONSTRAINT object_refs_to_fk
    FOREIGN KEY (to_id) REFERENCES objects(id) ON DELETE CASCADE;

-- ── R11: idx_refs_role wegwerfen, idx_refs_to_role hinzufügen ─────────────
DROP INDEX IF EXISTS idx_refs_role;
CREATE INDEX IF NOT EXISTS idx_refs_to_role ON object_refs(to_id, role);

-- ── R2: RLS-Policy auf object_refs beide Endpoints prüfen ─────────────────
-- Pre-Share-Feature kein User-facing Bug, post-Share load-bearing.
DROP POLICY IF EXISTS refs_via_object ON object_refs;
CREATE POLICY refs_via_object ON object_refs
  USING (
    EXISTS (SELECT 1 FROM objects WHERE objects.id = object_refs.from_id)
    AND EXISTS (SELECT 1 FROM objects WHERE objects.id = object_refs.to_id)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM objects WHERE objects.id = object_refs.from_id)
    AND EXISTS (SELECT 1 FROM objects WHERE objects.id = object_refs.to_id)
  );
