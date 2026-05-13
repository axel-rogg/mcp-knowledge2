-- Row-Level Security Policies (PLAN-architecture-v2 §2.2).
-- App-Role `knowledge_app` is *not* BYPASSRLS; admin actions use
-- `knowledge_admin` (which is BYPASSRLS) via DATABASE_ADMIN_URL.

ALTER TABLE objects             ENABLE ROW LEVEL SECURITY;
ALTER TABLE object_refs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE object_tags         ENABLE ROW LEVEL SECURITY;
ALTER TABLE object_revisions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE share_grants        ENABLE ROW LEVEL SECURITY;
ALTER TABLE object_vectors      ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log           ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE uploads             ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_quotas         ENABLE ROW LEVEL SECURITY;

-- ─── objects ──────────────────────────────────────────────────────────────
-- SELECT: owner OR shared (any scope)
DROP POLICY IF EXISTS owner_or_shared_read ON objects;
CREATE POLICY owner_or_shared_read ON objects FOR SELECT
  USING (
    owner_id = current_setting('app.current_user', true)::uuid
    OR id IN (
      SELECT resource_id FROM share_grants
      WHERE granted_to = current_setting('app.current_user', true)::uuid
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > (EXTRACT(epoch FROM now()) * 1000)::bigint)
    )
  );

-- INSERT: owner must match current user
DROP POLICY IF EXISTS owner_insert ON objects;
CREATE POLICY owner_insert ON objects FOR INSERT
  WITH CHECK (owner_id = current_setting('app.current_user', true)::uuid);

-- UPDATE: owner OR share with scope='write'
DROP POLICY IF EXISTS owner_or_writer_modify ON objects;
CREATE POLICY owner_or_writer_modify ON objects FOR UPDATE
  USING (
    owner_id = current_setting('app.current_user', true)::uuid
    OR id IN (
      SELECT resource_id FROM share_grants
      WHERE granted_to = current_setting('app.current_user', true)::uuid
        AND revoked_at IS NULL
        AND scope = 'write'
        AND (expires_at IS NULL OR expires_at > (EXTRACT(epoch FROM now()) * 1000)::bigint)
    )
  )
  WITH CHECK (
    owner_id = current_setting('app.current_user', true)::uuid
    OR id IN (
      SELECT resource_id FROM share_grants
      WHERE granted_to = current_setting('app.current_user', true)::uuid
        AND revoked_at IS NULL
        AND scope = 'write'
        AND (expires_at IS NULL OR expires_at > (EXTRACT(epoch FROM now()) * 1000)::bigint)
    )
  );

-- DELETE: owner only
DROP POLICY IF EXISTS owner_only_delete ON objects;
CREATE POLICY owner_only_delete ON objects FOR DELETE
  USING (owner_id = current_setting('app.current_user', true)::uuid);

-- ─── object_refs / tags / revisions ───────────────────────────────────────
-- Visibility delegates to the parent object row.
DROP POLICY IF EXISTS refs_via_object ON object_refs;
CREATE POLICY refs_via_object ON object_refs
  USING (EXISTS (SELECT 1 FROM objects WHERE objects.id = object_refs.from_id))
  WITH CHECK (EXISTS (SELECT 1 FROM objects WHERE objects.id = object_refs.from_id));

DROP POLICY IF EXISTS tags_via_object ON object_tags;
CREATE POLICY tags_via_object ON object_tags
  USING (EXISTS (SELECT 1 FROM objects WHERE objects.id = object_tags.object_id))
  WITH CHECK (EXISTS (SELECT 1 FROM objects WHERE objects.id = object_tags.object_id));

DROP POLICY IF EXISTS revs_via_object ON object_revisions;
CREATE POLICY revs_via_object ON object_revisions
  USING (EXISTS (SELECT 1 FROM objects WHERE objects.id = object_revisions.object_id))
  WITH CHECK (EXISTS (SELECT 1 FROM objects WHERE objects.id = object_revisions.object_id));

-- ─── object_vectors ───────────────────────────────────────────────────────
DROP POLICY IF EXISTS vec_via_object ON object_vectors;
CREATE POLICY vec_via_object ON object_vectors
  USING (EXISTS (SELECT 1 FROM objects WHERE objects.id = object_vectors.object_id))
  WITH CHECK (EXISTS (SELECT 1 FROM objects WHERE objects.id = object_vectors.object_id));

-- ─── share_grants ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS grants_self ON share_grants;
CREATE POLICY grants_self ON share_grants
  USING (
    granted_to = current_setting('app.current_user', true)::uuid
    OR granted_by = current_setting('app.current_user', true)::uuid
  );

DROP POLICY IF EXISTS grants_insert_by_owner ON share_grants;
CREATE POLICY grants_insert_by_owner ON share_grants FOR INSERT
  WITH CHECK (
    granted_by = current_setting('app.current_user', true)::uuid
    AND EXISTS (
      SELECT 1 FROM objects
      WHERE objects.id = share_grants.resource_id
        AND objects.owner_id = current_setting('app.current_user', true)::uuid
    )
  );

DROP POLICY IF EXISTS grants_update_by_owner ON share_grants;
CREATE POLICY grants_update_by_owner ON share_grants FOR UPDATE
  USING (granted_by = current_setting('app.current_user', true)::uuid)
  WITH CHECK (granted_by = current_setting('app.current_user', true)::uuid);

-- ─── audit_log (own events readable; insert app-emitted) ──────────────────
DROP POLICY IF EXISTS audit_own_select ON audit_log;
CREATE POLICY audit_own_select ON audit_log FOR SELECT
  USING (actor_user_id = current_setting('app.current_user', true)::uuid);

DROP POLICY IF EXISTS audit_app_insert ON audit_log;
CREATE POLICY audit_app_insert ON audit_log FOR INSERT
  WITH CHECK (true); -- application enforces actor

-- Append-only enforced at GRANT level: knowledge_app has no UPDATE/DELETE
REVOKE UPDATE, DELETE ON audit_log FROM knowledge_app;

-- ─── idempotency_records ──────────────────────────────────────────────────
DROP POLICY IF EXISTS idem_own ON idempotency_records;
CREATE POLICY idem_own ON idempotency_records
  USING (user_id = current_setting('app.current_user', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user', true)::uuid);

-- ─── uploads ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS uploads_own ON uploads;
CREATE POLICY uploads_own ON uploads
  USING (owner_id = current_setting('app.current_user', true)::uuid)
  WITH CHECK (owner_id = current_setting('app.current_user', true)::uuid);

-- ─── user_quotas ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS quota_own ON user_quotas;
CREATE POLICY quota_own ON user_quotas
  USING (user_id = current_setting('app.current_user', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user', true)::uuid);
