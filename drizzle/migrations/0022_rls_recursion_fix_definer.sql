-- 0022_rls_recursion_fix_definer.sql
--
-- Mig 0021 hat group_members-Policy auf "owner-or-self" vereinfacht, aber
-- die Recursion blieb: groups_owner_or_member referenziert group_members
-- (member-of-lookup), das triggert group_members_visibility, die referenziert
-- groups (owner-of-lookup), das triggert groups_owner_or_member → SCHLEIFE.
--
-- Echte Loesung: SECURITY DEFINER-Helper-Functions die RLS-bypassen.
-- Function-Body laeuft mit Owner-Rechten (postgres = superuser =
-- effective-BYPASSRLS). Innerhalb der Function-Body wird die Policy
-- NICHT rekursiv ausgewertet, weil postgres ueber RLS hinwegsieht.
--
-- Policies nutzen dann is_member_of/owns_group statt direkte Sub-Queries
-- — keine Cross-Policy-Referenz mehr.
--
-- Pflicht: GRANT EXECUTE an knowledge_app + knowledge_admin sonst koennen
-- die Policies die Function nicht aufrufen.

-- ── Helper-Functions (SECURITY DEFINER) ────────────────────────────────────

CREATE OR REPLACE FUNCTION is_active_member_of(g UUID, u UUID)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM group_members
    WHERE group_id = g
      AND user_id = u
      AND removed_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION owns_group(g UUID, u UUID)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM groups
    WHERE id = g AND owner_id = u
  );
$$;

CREATE OR REPLACE FUNCTION owns_object(o UUID, u UUID)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM objects
    WHERE id = o AND owner_id = u
  );
$$;

-- Grant Execute fuer beide App-Rollen (knowledge_app ist RLS-bound,
-- knowledge_admin ist BYPASSRLS — beide nutzen den Helper als Cache).
GRANT EXECUTE ON FUNCTION is_active_member_of(UUID, UUID) TO knowledge_app, knowledge_admin;
GRANT EXECUTE ON FUNCTION owns_group(UUID, UUID) TO knowledge_app, knowledge_admin;
GRANT EXECUTE ON FUNCTION owns_object(UUID, UUID) TO knowledge_app, knowledge_admin;

-- ── groups: Policy nutzt is_active_member_of statt direct-Subquery ─────────

DROP POLICY IF EXISTS groups_owner_or_member ON groups;
CREATE POLICY groups_owner_or_member ON groups FOR SELECT
  USING (
    owner_id = current_setting('app.current_user', true)::uuid
    OR is_active_member_of(id, current_setting('app.current_user', true)::uuid)
  );

-- groups_owner_modify bleibt (unrekursiv, owner-only) — keine Aenderung.

-- ── group_members: Policy nutzt owns_group statt direct-Subquery ──────────

DROP POLICY IF EXISTS group_members_visibility ON group_members;
CREATE POLICY group_members_visibility ON group_members FOR SELECT
  USING (
    user_id = current_setting('app.current_user', true)::uuid
    OR owns_group(group_id, current_setting('app.current_user', true)::uuid)
  );

DROP POLICY IF EXISTS group_members_owner_modify ON group_members;
CREATE POLICY group_members_owner_modify ON group_members FOR ALL
  USING (
    owns_group(group_id, current_setting('app.current_user', true)::uuid)
  )
  WITH CHECK (
    owns_group(group_id, current_setting('app.current_user', true)::uuid)
  );

-- ── objects.owner_or_shared_read: Policy nutzt is_active_member_of ─────────
-- Vorher: JOIN share_grants + group_members → triggert group_members-RLS →
-- rekursiv. Jetzt: WHERE share_grants.granted_to_group_id IN (SELECT group_id
-- FROM group_members WHERE user_id = current ...) ersetzt durch
-- WHERE is_active_member_of(share_grants.granted_to_group_id, current).
-- → kein group_members-Policy-Trigger mehr.

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
    OR EXISTS (
      SELECT 1 FROM share_grants sg
      WHERE sg.resource_id = objects.id
        AND sg.granted_to_group_id IS NOT NULL
        AND sg.revoked_at IS NULL
        AND (sg.expires_at IS NULL OR sg.expires_at > (EXTRACT(epoch FROM now()) * 1000)::bigint)
        AND is_active_member_of(sg.granted_to_group_id, current_setting('app.current_user', true)::uuid)
    )
  );

-- ── share_grants.grants_self: Policy nutzt is_active_member_of + owns_group

DROP POLICY IF EXISTS grants_self ON share_grants;
CREATE POLICY grants_self ON share_grants
  USING (
    granted_to = current_setting('app.current_user', true)::uuid
    OR granted_by = current_setting('app.current_user', true)::uuid
    OR (
      granted_to_group_id IS NOT NULL
      AND is_active_member_of(granted_to_group_id, current_setting('app.current_user', true)::uuid)
    )
    OR (
      granted_to_group_id IS NOT NULL
      AND owns_group(granted_to_group_id, current_setting('app.current_user', true)::uuid)
    )
  );

-- grants_insert_group_owner_required (RESTRICTIVE) — nutzt jetzt auch
-- owns_object + owns_group statt direct-Subquery um Recursion zu vermeiden.

DROP POLICY IF EXISTS grants_insert_group_owner_required ON share_grants;
CREATE POLICY grants_insert_group_owner_required ON share_grants
  AS RESTRICTIVE
  FOR INSERT
  WITH CHECK (
    -- legacy User-Grant
    (
      granted_to IS NOT NULL
      AND granted_by = current_setting('app.current_user', true)::uuid
      AND owns_object(resource_id, current_setting('app.current_user', true)::uuid)
    )
    OR
    -- Group-Grant: granted_by = owner-of-resource = owner-of-target-group
    (
      granted_to_group_id IS NOT NULL
      AND granted_by = current_setting('app.current_user', true)::uuid
      AND owns_object(resource_id, current_setting('app.current_user', true)::uuid)
      AND owns_group(granted_to_group_id, current_setting('app.current_user', true)::uuid)
    )
  );
