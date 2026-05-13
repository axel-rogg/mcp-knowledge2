-- Security hardening from 2026-05-13 audit (F-10, F-6, F-11).
--
-- F-10: FORCE ROW LEVEL SECURITY — defends against future migrations
--       that accidentally run as the table owner (which would otherwise
--       bypass RLS policies). With FORCE, even the owner is policy-bound,
--       except for our `knowledge_admin` BYPASSRLS role used for
--       /v1/internal/erase-user.
--
-- F-6:  refs / tags / revisions visibility was delegating to objects RLS
--       — but objects-RLS allows shared rows through. That meant a
--       shared user could read OLD revisions (revealing pre-share
--       content) and ALL tags (revealing private labels). Tighten to
--       owner-only on these three tables.
--
-- F-11: audit_log insert policy was WITH CHECK (true) — the application
--       could insert with any actor_user_id. Pin to current user
--       (or the well-known system sentinel UUID).

-- ─── F-10: FORCE RLS ──────────────────────────────────────────────────────
ALTER TABLE objects             FORCE ROW LEVEL SECURITY;
ALTER TABLE object_refs         FORCE ROW LEVEL SECURITY;
ALTER TABLE object_tags         FORCE ROW LEVEL SECURITY;
ALTER TABLE object_revisions    FORCE ROW LEVEL SECURITY;
ALTER TABLE share_grants        FORCE ROW LEVEL SECURITY;
ALTER TABLE object_vectors      FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log           FORCE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records FORCE ROW LEVEL SECURITY;
ALTER TABLE uploads             FORCE ROW LEVEL SECURITY;
ALTER TABLE user_quotas         FORCE ROW LEVEL SECURITY;

-- ─── F-6: refs / tags / revisions tightened to owner-only ─────────────────

DROP POLICY IF EXISTS refs_via_object ON object_refs;
CREATE POLICY refs_via_object ON object_refs
  USING (EXISTS (
    SELECT 1 FROM objects
    WHERE objects.id = object_refs.from_id
      AND objects.owner_id = current_setting('app.current_user', true)::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM objects
    WHERE objects.id = object_refs.from_id
      AND objects.owner_id = current_setting('app.current_user', true)::uuid
  ));

DROP POLICY IF EXISTS tags_via_object ON object_tags;
CREATE POLICY tags_via_object ON object_tags
  USING (EXISTS (
    SELECT 1 FROM objects
    WHERE objects.id = object_tags.object_id
      AND objects.owner_id = current_setting('app.current_user', true)::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM objects
    WHERE objects.id = object_tags.object_id
      AND objects.owner_id = current_setting('app.current_user', true)::uuid
  ));

DROP POLICY IF EXISTS revs_via_object ON object_revisions;
CREATE POLICY revs_via_object ON object_revisions
  USING (EXISTS (
    SELECT 1 FROM objects
    WHERE objects.id = object_revisions.object_id
      AND objects.owner_id = current_setting('app.current_user', true)::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM objects
    WHERE objects.id = object_revisions.object_id
      AND objects.owner_id = current_setting('app.current_user', true)::uuid
  ));

-- ─── F-11: audit_log insert pins actor to current user ───────────────────
DROP POLICY IF EXISTS audit_app_insert ON audit_log;
CREATE POLICY audit_app_insert ON audit_log FOR INSERT
  WITH CHECK (
    actor_user_id = current_setting('app.current_user', true)::uuid
    OR actor_user_id = '00000000-0000-0000-0000-000000000000'::uuid
  );
